import * as fs from "fs";
import * as path from "path";
import { ensureLauncherRuntimePaths, launcherTempDir } from "./runtimePaths";
import { modsRoot, readModDir, signModFolder } from "./modManager";
import { packModZip } from "./modPack";
import { getAuthor } from "./authorStore";
import { scanMods } from "./modManager";
import { readIndexCache, compareVersion } from "./modRegistry";
import { readSettings } from "./configStore";
import { getToken, saveToken, clearToken, tokenStatus, type TokenStatus } from "./githubToken";
import { submitFileViaPullRequest, pullRequestCompareUrl, validateToken } from "./githubSubmit";
import { publishToOwnRepo, whoami, assetNameFor, repoUrlFor, defaultRepoNameFor } from "./githubPublish";

/**
 * 提交模组：签名 → 打包 → sha256 → 生成索引分片草稿 →（可选）用 GitHub API 开 PR。
 * 见 docs/mod-signing-and-marketplace-plan.md §5 与 §5.4。
 *
 * 关键约定：
 *  - 索引仓库是**分片**结构：一个模组一个 `mods/<id>.json`，作者只动自己那一个，
 *    避免多人同时改同一个 mod-index.json 造成 PR 互相冲突；
 *  - `mod-index.json` 由 CI 合并 + 签名，作者不直接改；
 *  - ZIP 由作者自己托管（GitHub / Gitee Releases），索引里只登记 URL + sha256。
 */

export const DEFAULT_INDEX_REPO = "diguo520/EVEjs-mods";

export interface DownloadUrl {
  mirror: string;
  url: string;
  priority: number;
}

export type SubmissionStatus = "draft" | "submitted" | "listed" | "delisted";

export interface SubmissionItem {
  id: string;
  version: string;
  displayName: string;
  changelog: string;
  zipPath: string;
  sha256: string;
  sizeBytes: number;
  downloadUrls: DownloadUrl[];
  /** 可直接贴进索引仓库 mods/<id>.json 的完整内容 */
  indexDraft: Record<string, unknown>;
  status: SubmissionStatus;
  prUrl: string;
  branch: string;
  /** 作者自己的仓库（owner/repo）——发布到自己的仓库后才有值 */
  sourceRepo: string;
  /** sources.json 收录 PR 的地址（一次性动作） */
  sourceReviewUrl: string;
  createdAt: number;
}

interface SubmissionFile {
  schemaVersion: number;
  items: SubmissionItem[];
}

export interface PrepareInput {
  folder: string;
  changelog?: string;
  category?: string;
  tags?: string[];
  description?: string;
  readme?: string[];
  highlights?: string[];
  conflicts?: string[];
  requiresRestart?: boolean;
  evejsVersions?: string[];
  repo?: string;
  downloadUrls?: DownloadUrl[];
}

export interface PrepareResult {
  ok: boolean;
  item?: SubmissionItem;
  reason?: string;
}

export function indexRepo(): string {
  try {
    const settings = readSettings();
    const value = settings.modIndexRepo;
    if (typeof value === "string" && /^[\w.-]+\/[\w.-]+$/.test(value.trim())) return value.trim();
  } catch {
    /* 读设置失败就用默认仓库 */
  }
  return DEFAULT_INDEX_REPO;
}

function submissionsPath(): string {
  return path.join(ensureLauncherRuntimePaths().userData, "my-submissions.json");
}

function readSubmissionFile(): SubmissionFile {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(submissionsPath(), "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as SubmissionFile).items)) {
      return { schemaVersion: 1, items: (parsed as SubmissionFile).items };
    }
  } catch {
    /* 没有或损坏都当作空 */
  }
  return { schemaVersion: 1, items: [] };
}

function writeSubmissionFile(file: SubmissionFile): void {
  fs.mkdirSync(path.dirname(submissionsPath()), { recursive: true });
  fs.writeFileSync(submissionsPath(), JSON.stringify(file, null, 2) + "\n", "utf8");
}

export function listSubmissions(): { ok: boolean; items: SubmissionItem[] } {
  return { ok: true, items: readSubmissionFile().items };
}

/** 读缓存里的索引，把同一个模组的历史版本带过来（避免覆盖时丢掉 history） */
function previousHistory(id: string): unknown[] {
  try {
    const file = path.join(ensureLauncherRuntimePaths().cache, "mod-index.json");
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const mods = parsed && typeof parsed === "object" ? (parsed as { mods?: unknown[] }).mods : undefined;
    if (!Array.isArray(mods)) return [];
    const entry = mods.find((m) => m && typeof m === "object" && (m as { id?: string }).id === id) as
      | { history?: unknown[] }
      | undefined;
    return Array.isArray(entry?.history) ? entry.history.slice() : [];
  } catch {
    return [];
  }
}

/**
 * 生成待提交包：重签 → 打包 → sha256 → 组装索引分片 → 写入 my-submissions.json。
 * 前四步完全离线，不碰网络。
 */
export async function prepareSubmission(repoRoot: string, input: PrepareInput): Promise<PrepareResult> {
  const folder = String(input.folder || "").trim();
  if (!folder) return { ok: false, reason: "没有选择模组" };

  const dir = path.join(modsRoot(repoRoot), folder);
  const record = readModDir(folder, dir);
  if (!record.valid) return { ok: false, reason: "清单校验失败：" + record.error };

  let authorId = "";
  let authorName = "";
  let authorKeyId = "";
  try {
    const author = getAuthor().author;
    authorId = author.id;
    authorName = author.name;
    authorKeyId = author.keyId;
  } catch (e) {
    return { ok: false, reason: "读不到本机作者身份：" + (e instanceof Error ? e.message : String(e)) };
  }

  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(fs.readFileSync(record.manifestPath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    /* 前面已校验过清单，这里读不到就按空对象处理 */
  }
  const manifestAuthor =
    manifest.author && typeof manifest.author === "object" ? (manifest.author as Record<string, unknown>) : null;
  const declaredAuthorId = manifestAuthor && typeof manifestAuthor.id === "string" ? manifestAuthor.id : "";
  if (declaredAuthorId && declaredAuthorId !== authorId) {
    return { ok: false, reason: "这个模组的作者标识是 " + declaredAuthorId + "，不是本机作者，不能替别人提交" };
  }

  // 1) 重签（内容变了签名就失效；这里统一重签一次）
  const signed = signModFolder(repoRoot, folder);
  if (!signed.ok) return { ok: false, reason: "签名失败：" + (signed.reason || "") };

  // 2) 打包（.NET ZipFile，避免 Compress-Archive 的分隔符坑）
  const version = String(record.version || "0.0.0");
  const zipPath = path.join(launcherTempDir(), "export-" + record.id + "-" + version + ".zip");
  const packed = await packModZip(record.dir, zipPath);
  if (!packed.ok || !packed.sha256 || packed.sizeBytes === undefined) {
    return { ok: false, reason: packed.reason || "打包失败" };
  }

  // 3) 组装索引分片
  const compat = manifest.compatibility && typeof manifest.compatibility === "object"
    ? (manifest.compatibility as { evejsVersions?: unknown }).evejsVersions
    : undefined;
  const evejsVersions =
    input.evejsVersions && input.evejsVersions.length
      ? input.evejsVersions
      : Array.isArray(compat)
        ? (compat.filter((v) => typeof v === "string") as string[])
        : [];

  const downloadUrls = (input.downloadUrls || [])
    .filter((u) => u && /^https:\/\//i.test(String(u.url || "")))
    .map((u, i) => ({ mirror: String(u.mirror || "custom"), url: String(u.url), priority: Number(u.priority) || i + 1 }));

  const now = Date.now();
  const history = previousHistory(record.id);
  if (history.length) history.push({ version, changelog: input.changelog || "", at: now });

  const indexDraft: Record<string, unknown> = {
    id: record.id,
    displayName: record.displayName,
    version,
    author: { id: authorId, name: authorName, keyId: authorKeyId },
    description: input.description || record.description,
    category: input.category || "玩法",
    tags: input.tags || [],
    readme: input.readme || [],
    highlights: input.highlights || [],
    conflicts: input.conflicts || record.conflicts || [],
    requiresRestart: input.requiresRestart !== false,
    evejsVersions,
    sizeBytes: packed.sizeBytes,
    sha256: packed.sha256,
    downloadUrls,
    changelog: input.changelog || "",
    history,
    repo: input.repo || "",
    featured: false,
    delisted: false,
    publishedAt: new Date(now).toISOString().slice(0, 10)
  };

  const item: SubmissionItem = {
    id: record.id,
    version,
    displayName: record.displayName,
    changelog: input.changelog || "",
    zipPath: packed.zipPath || zipPath,
    sha256: packed.sha256,
    sizeBytes: packed.sizeBytes,
    downloadUrls,
    indexDraft,
    status: "draft",
    prUrl: "",
    branch: "submit/" + record.id + "-" + version,
    sourceRepo: "",
    sourceReviewUrl: "",
    createdAt: now
  };

  const file = readSubmissionFile();
  const idx = file.items.findIndex((x) => x.id === item.id && x.version === item.version);
  if (idx >= 0) {
    item.prUrl = file.items[idx].prUrl;
    item.status = file.items[idx].status;
    item.branch = file.items[idx].branch || item.branch;
    item.sourceRepo = file.items[idx].sourceRepo || "";
    item.sourceReviewUrl = file.items[idx].sourceReviewUrl || "";
    file.items[idx] = item;
  } else {
    file.items.push(item);
  }
  writeSubmissionFile(file);
  return { ok: true, item };
}

export interface PublishOwnResult {
  ok: boolean;
  owner?: string;
  repo?: string;
  repoUrl?: string;
  releaseUrl?: string;
  assetUrl?: string;
  repoCreated?: boolean;
  reason?: string;
}

/** 由索引分片 + 资产地址组装 `evejs-mod.json`（索引仓库 CI 抓取的就是它） */
function buildListingJson(draft: Record<string, unknown>, downloadUrls: DownloadUrl[]): string {
  return JSON.stringify({ ...draft, downloadUrls }, null, 2) + "\n";
}

/**
 * 发布到**作者自己的仓库**：确保仓库 → 写 evejs-mod.json → 建 Release → 传 ZIP。
 * 只动作者自己的仓库，不碰索引仓库；版本更新完全不需要 PR。
 */
export async function publishOwnRepo(
  id: string,
  version: string,
  repoInput: string,
  giteeUrl?: string
): Promise<PublishOwnResult> {
  const file = readSubmissionFile();
  const item = file.items.find((x) => x.id === id && x.version === version);
  if (!item) return { ok: false, reason: "找不到待提交记录（请先执行「① 生成并打包」）" };

  const token = getToken();
  if (!token) return { ok: false, reason: "还没填 GitHub 令牌" };

  const me = await whoami(token);
  if (!me.ok || !me.login) return { ok: false, reason: me.reason || "令牌无效" };

  // 解析 owner/repo，并提前算出确定性的资产地址（tag 与资产名都是确定的）
  const raw = String(repoInput || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  const parts = raw.split("/").filter(Boolean);
  const owner = parts.length >= 2 ? parts[0] : me.login;
  const repoName = parts.length >= 2 ? parts[1] : parts[0] || defaultRepoNameFor(item.id);
  if (!repoName || !/^[\w.-]+$/.test(repoName)) {
    return { ok: false, reason: "请填写你自己的仓库名（形如 my-evejs-mod，或 owner/my-evejs-mod）" };
  }
  const assetName = assetNameFor(item.id, version);
  const assetUrl = repoUrlFor(owner, repoName) + "/releases/download/v" + version + "/" + assetName;

  const downloadUrls: DownloadUrl[] = [];
  downloadUrls.push({ mirror: "github", url: assetUrl, priority: 1 });
  const gitee = String(giteeUrl || "").trim();
  if (/^https:\/\//i.test(gitee)) downloadUrls.push({ mirror: "gitee", url: gitee, priority: 2 });
  for (const extra of item.downloadUrls) {
    if (!extra.url || downloadUrls.some((u) => u.url === extra.url)) continue;
    if (/^https:\/\//i.test(extra.url)) downloadUrls.push({ ...extra, priority: downloadUrls.length + 1 });
  }

  const listing = buildListingJson({ ...item.indexDraft, repo: repoUrlFor(owner, repoName) }, downloadUrls);
  const published = await publishToOwnRepo({
    token,
    repo: owner + "/" + repoName,
    zipPath: item.zipPath,
    assetName,
    version,
    changelog: item.changelog,
    description: item.displayName,
    listingJson: listing,
    defaultRepoName: defaultRepoNameFor(item.id)
  });

  if (!published.ok) {
    return {
      ok: false,
      owner: published.owner,
      repo: published.repo,
      repoUrl: published.repoUrl,
      releaseUrl: published.releaseUrl,
      reason: published.reason
    };
  }

  const idx = file.items.findIndex((x) => x.id === id && x.version === version);
  if (idx >= 0) {
    file.items[idx].sourceRepo = (published.owner || owner) + "/" + (published.repo || repoName);
    file.items[idx].downloadUrls = downloadUrls;
    file.items[idx].indexDraft = { ...item.indexDraft, downloadUrls, repo: repoUrlFor(owner, repoName) };
    writeSubmissionFile(file);
  }

  return {
    ok: true,
    owner: published.owner || owner,
    repo: published.repo || repoName,
    repoUrl: published.repoUrl || repoUrlFor(owner, repoName),
    releaseUrl: published.releaseUrl,
    assetUrl: published.assetUrl || assetUrl,
    repoCreated: published.repoCreated
  };
}

/**
 * 一次性动作：把作者自己的仓库登记进索引仓库的 sources.json（之后版本更新都不用再提 PR）。
 */
export async function registerSource(id: string, version: string): Promise<SubmitResult> {
  const file = readSubmissionFile();
  const item = file.items.find((x) => x.id === id && x.version === version);
  if (!item) return { ok: false, reason: "找不到待提交记录" };
  if (!item.sourceRepo) return { ok: false, reason: "请先执行「② 发布到我的仓库」，拿到仓库地址后再申请收录" };

  const token = getToken();
  if (!token) return { ok: false, reason: "还没填 GitHub 令牌" };
  const upstream = indexRepo();

  // 读上游 sources.json（raw 走 CDN，避免 API 限流）
  let sources: { schemaVersion: number; sources: string[] } = { schemaVersion: 1, sources: [] };
  try {
    const res = await fetch("https://raw.githubusercontent.com/" + upstream + "/main/sources.json");
    if (res.ok) {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { sources?: unknown[] }).sources)) {
        sources = {
          schemaVersion: 1,
          sources: ((parsed as { sources: unknown[] }).sources.filter((v) => typeof v === "string") as string[])
        };
      }
    }
  } catch {
    /* 读不到就当作空列表重建 */
  }

  const already = sources.sources.some((s) => s.toLowerCase() === item.sourceRepo.toLowerCase());
  const next = already ? sources.sources : [...sources.sources, item.sourceRepo];
  const branch = "register/" + item.sourceRepo.replace(/\//g, "-").toLowerCase();

  const result = await submitFileViaPullRequest({
    token,
    upstream,
    filePath: "sources.json",
    content: JSON.stringify({ schemaVersion: 1, sources: next }, null, 2) + "\n",
    branch,
    commitMessage: already ? "chore: refresh " + item.sourceRepo : "Add mod source " + item.sourceRepo,
    prTitle: (already ? "Refresh" : "Add") + " mod source: " + item.sourceRepo,
    prBody: [
      "### 收录社区模组源",
      "",
      "- 仓库：`" + item.sourceRepo + "`",
      "- 上架清单：`evejs-mod.json`（仓库根目录）",
      "- 首次登记：" + (already ? "否（已存在，本次为刷新）" : "是"),
      "",
      "> 登记后，仓库的 `evejs-mod.json` 会被 CI 定时聚合进 `mod-index.json`；之后发新版**不需要**再提 PR。"
    ].join("\n")
  });

  const idx = file.items.findIndex((x) => x.id === id && x.version === version);
  if (idx >= 0 && result.ok) {
    file.items[idx].sourceReviewUrl = result.prUrl || "";
    writeSubmissionFile(file);
  }

  return {
    ok: result.ok,
    prUrl: result.prUrl,
    branch: result.branch || branch,
    compareUrl: pullRequestCompareUrl(upstream, result.branch || branch, result.login),
    reason: result.reason
  };
}

export type MyModStatus = "local" | "draft" | "submitted" | "listed" | "delisted" | "rejected" | "update-pending";

export interface MyModItem {
  id: string;
  displayName: string;
  version: string;
  category: string;
  status: MyModStatus;
  folder: string;
  localVersion: string;
  listedVersion: string;
  signed: boolean;
  sourceRepo: string;
  prUrl: string;
  sizeBytes: number;
  updatedAt: number;
  /** 维护者审核结果：""=无，delist=已下架，reject=拒绝收录 */
  moderationAction?: "" | "delist" | "reject";
  /** 审核原因（索引里带中英两版） */
  moderationReason?: { zh?: string; en?: string } | null;
  moderatedBy?: string;
  moderatedAt?: string;
}

/**
 * 「我创建的」：合并三个来源 —— 本地扫到的（author.id / 签名 keyId 是本机）、索引里的、本机提交台账。
 * 状态优先级：索引已下架 > 索引已上架 > 台账已提交 > 台账草稿 > 仅本地。
 */
export async function listMyMods(repoRoot: string): Promise<{ ok: boolean; items: MyModItem[]; reason?: string }> {
  let authorId = "";
  let keyId = "";
  try {
    const a = getAuthor().author;
    authorId = a.id;
    keyId = a.keyId;
  } catch {
    return { ok: false, items: [], reason: "读不到本机作者身份" };
  }

  const items = new Map<string, MyModItem>();
  const put = (item: MyModItem) => items.set(item.id, item);

  // 1) 本地
  for (const mod of scanMods(repoRoot).mods) {
    const mine = (mod.authorId && mod.authorId === authorId) || (mod.signatureKeyId && mod.signatureKeyId === keyId);
    if (!mine) continue;
    put({
      id: mod.id,
      displayName: mod.displayName || mod.id,
      version: mod.version,
      category: mod.category || "",
      status: "local",
      folder: mod.folder,
      localVersion: mod.version,
      listedVersion: "",
      signed: mod.signatureState === "valid",
      sourceRepo: "",
      prUrl: "",
      sizeBytes: mod.sizeBytes || 0,
      updatedAt: 0
    });
  }

  // 2) 索引只读本地缓存（不联网、不阻塞，详情见 modRegistry.readIndexCache 注释）
  try {
    const cached = readIndexCache();
    const entries = cached && Array.isArray(cached.mods) ? cached.mods : [];
    for (const entry of entries) {
      if (!entry || !entry.author || entry.author.id !== authorId) continue;
      const prev = items.get(entry.id);
      const localVersion = prev ? prev.version : "";
      const listedVersion = String(entry.version || "");
      const needsUpdate = !!localVersion && compareVersion(localVersion, listedVersion) > 0;
      put({
        id: entry.id,
        displayName: entry.displayName || entry.id,
        version: localVersion || listedVersion,
        category: entry.category || (prev ? prev.category : ""),
        status: needsUpdate ? "update-pending" : entry.delisted ? "delisted" : "listed",
        moderationAction: entry.delisted ? "delist" : "",
        moderationReason: entry.delistReason || null,
        moderatedBy: entry.moderatedBy || "",
        moderatedAt: entry.moderatedAt || "",
        folder: prev ? prev.folder : "",
        localVersion,
        listedVersion,
        signed: prev ? prev.signed : false,
        sourceRepo: prev ? prev.sourceRepo : "",
        prUrl: prev ? prev.prUrl : "",
        sizeBytes: Number(entry.sizeBytes) || (prev ? prev.sizeBytes : 0),
        updatedAt: Date.parse(String(entry.publishedAt || "")) || Date.now()
      });
    }
    // 被「拒绝收录」的模组不会出现在 mods[] 里，只登记在 moderation 表 —— 补成一条「已拒绝」给作者看原因
    const moderation = cached && cached.moderation && typeof cached.moderation === "object" ? cached.moderation : {};
    for (const key of Object.keys(moderation)) {
      const rec = moderation[key];
      if (!rec || (rec.action !== "reject" && rec.action !== "delist")) continue;
      const mine = (rec.authorId && rec.authorId === authorId) || (rec.id && items.has(rec.id)) ||
        (rec.source && Array.from(items.values()).some((it) => it.sourceRepo && it.sourceRepo.toLowerCase() === String(rec.source).toLowerCase()));
      if (!mine) continue;
      const prev = (rec.id && items.get(rec.id)) || (rec.source && Array.from(items.values()).find((it) => it.sourceRepo && it.sourceRepo.toLowerCase() === String(rec.source).toLowerCase())) || null;
      const id = (prev && prev.id) || rec.id || String(rec.source || key);
      if (rec.action === "delist" && prev && prev.status === "delisted") continue;   // 上面已经标过
      put({
        id,
        displayName: prev ? prev.displayName : id,
        version: prev ? prev.version : "",
        category: prev ? prev.category : "",
        status: rec.action === "delist" ? "delisted" : "rejected",
        folder: prev ? prev.folder : "",
        localVersion: prev ? prev.localVersion : "",
        listedVersion: "",
        signed: prev ? prev.signed : false,
        sourceRepo: prev ? prev.sourceRepo : String(rec.source || ""),
        prUrl: prev ? prev.prUrl : "",
        sizeBytes: prev ? prev.sizeBytes : 0,
        updatedAt: prev ? prev.updatedAt : Date.parse(String(rec.at || "")) || Date.now(),
        moderationAction: rec.action,
        moderationReason: rec.reason || null,
        moderatedBy: rec.by || "",
        moderatedAt: rec.at || ""
      });
    }
  } catch {
    /* 索引拿不到就只显示本地与台账 */
  }

  // 3) 本机提交台账
  for (const sub of readSubmissionFile().items) {
    const prev = items.get(sub.id);
    const submitted = sub.status === "submitted" || !!sub.prUrl;
    put({
      id: sub.id,
      displayName: sub.displayName || sub.id,
      version: prev && prev.localVersion ? prev.localVersion : sub.version,
      category: prev ? prev.category : "",
      status: prev && prev.status !== "local" ? prev.status : submitted ? "submitted" : "draft",
      moderationAction: prev ? prev.moderationAction : "",
      moderationReason: prev ? prev.moderationReason : null,
      moderatedBy: prev ? prev.moderatedBy : "",
      moderatedAt: prev ? prev.moderatedAt : "",
      folder: prev ? prev.folder : "",
      localVersion: prev ? prev.localVersion : "",
      listedVersion: prev ? prev.listedVersion : "",
      signed: prev ? prev.signed : false,
      sourceRepo: sub.sourceRepo || (prev ? prev.sourceRepo : ""),
      prUrl: sub.sourceReviewUrl || sub.prUrl || (prev ? prev.prUrl : ""),
      sizeBytes: sub.sizeBytes || (prev ? prev.sizeBytes : 0),
      updatedAt: sub.createdAt
    });
  }

  const order: Record<MyModStatus, number> = { rejected: 0, submitted: 1, "update-pending": 2, listed: 3, delisted: 4, draft: 5, local: 6 };
  const list = Array.from(items.values()).sort((a, b) => {
    const r = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    return r !== 0 ? r : (b.updatedAt || 0) - (a.updatedAt || 0) || a.id.localeCompare(b.id);
  });
  return { ok: true, items: list };
}

export interface SubmitResult {
  ok: boolean;
  prUrl?: string;
  branch?: string;
  compareUrl?: string;
  forkRepo?: string;
  login?: string;
  status?: SubmissionStatus;
  reason?: string;
}

export function tokenState(): TokenStatus {
  return tokenStatus();
}

export function setToken(token: string): { ok: boolean; encrypted: boolean; reason?: string } {
  return saveToken(token);
}

export function removeToken(): { ok: boolean; reason?: string } {
  return clearToken();
}

export async function checkToken(token?: string): Promise<{ ok: boolean; login?: string; reason?: string }> {
  const value = token || getToken();
  if (!value) return { ok: false, reason: "还没填 GitHub 令牌" };
  return validateToken(value);
}

/** 用 GitHub API 提 PR；失败时返回 compareUrl 供降级方案使用 */
export async function submitToGitHub(id: string, version: string): Promise<SubmitResult> {
  const file = readSubmissionFile();
  const item = file.items.find((x) => x.id === id && x.version === version);
  if (!item) return { ok: false, reason: "找不到待提交记录（请先执行「生成并打包」）" };

  const token = getToken();
  if (!token) return { ok: false, reason: "还没填 GitHub 令牌" };
  const upstream = indexRepo();

  const result = await submitFileViaPullRequest({
    token,
    upstream,
    filePath: "mods/" + item.id + ".json",
    content: JSON.stringify(item.indexDraft, null, 2) + "\n",
    branch: item.branch,
    commitMessage: "Add " + item.displayName + " " + item.version,
    prTitle: "Add " + item.displayName + " " + item.version,
    prBody: [
      "### " + item.displayName + " `" + item.version + "`",
      "",
      item.changelog ? "**更新说明**\n\n" + item.changelog : "",
      "",
      "| 字段 | 值 |",
      "|---|---|",
      "| id | `" + item.id + "` |",
      "| version | `" + item.version + "` |",
      "| sha256 | `" + item.sha256 + "` |",
      "| size | " + item.sizeBytes + " bytes |",
      "| zip | `" + path.basename(item.zipPath) + "` |",
      "",
      "> 由 EvEJS 启动器提交；ZIP 由作者自行托管，索引里登记 URL 与 sha256。"
    ].join("\n")
  });

  const branch = result.branch || item.branch;
  const idx = file.items.findIndex((x) => x.id === id && x.version === version);
  if (idx >= 0) {
    if (result.ok) {
      file.items[idx].status = "submitted";
      file.items[idx].prUrl = result.prUrl || "";
      file.items[idx].branch = branch;
    }
    writeSubmissionFile(file);
  }

  return {
    ok: result.ok,
    prUrl: result.prUrl,
    branch,
    forkRepo: result.forkRepo,
    login: result.login,
    compareUrl: pullRequestCompareUrl(upstream, branch, result.login),
    status: result.ok ? "submitted" : "draft",
    reason: result.reason
  };
}