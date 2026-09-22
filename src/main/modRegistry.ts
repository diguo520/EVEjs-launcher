import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { net } from "electron";
import { ensureLauncherRuntimePaths, launcherTempDir } from "./runtimePaths";
import { readSettings } from "./configStore";
import { importModZip, scanMods, updateMod, type ModRecord } from "./modManager";
import { verifyIndexSignature, trustPublicKey } from "./modSigner";

/**
 * 模组市场索引：拉取 → 验签 → 缓存 → 比对更新 → 下载安装。
 * 见 docs/mod-signing-and-marketplace-plan.md §7。
 *
 * 免服务器模型：
 *  - 索引是**静态 JSON**，托管在 GitHub Pages（+ jsDelivr 镜像），本地还有缓存兜底；
 *  - ZIP 由**作者自己的仓库**托管（GitHub / Gitee Releases），启动器按 downloadUrls 的 priority 回退；
 *  - 索引本身由维护者私钥签名，客户端**先验签再信任里面的 sha256 与下载地址**。
 */

export const DEFAULT_INDEX_URLS = [
  "https://diguo520.github.io/EVEjs-mods/mod-index.json",
  "https://cdn.jsdelivr.net/gh/diguo520/EVEjs-mods@main/mod-index.json"
];

const CACHE_FILE = "mod-index.json";
const TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const TOTAL_BUDGET_MS = 12000;

/** 维护者审核给出的原因（索引里同时带中英两版，客户端按当前语言选） */
export interface ModerationReason {
  zh?: string;
  en?: string;
}

/** 索引里的审核记录：action=reject 表示拒绝收录，action=delist 表示已下架 */
export interface ModerationRecord {
  id?: string;
  source?: string;
  authorId?: string;
  action?: "reject" | "delist";
  reason?: ModerationReason;
  at?: string;
  by?: string;
}

export interface MarketDownloadUrl {
  mirror: string;
  url: string;
  priority: number;
}

export interface MarketEntry {
  id: string;
  displayName: string;
  version: string;
  author?: { id?: string; name?: string; keyId?: string; publicKey?: string };
  description?: string;
  category?: string;
  tags?: string[];
  readme?: string[];
  highlights?: string[];
  conflicts?: string[];
  requiresRestart?: boolean;
  evejsVersions?: string[];
  sizeBytes?: number;
  /** 下载次数：索引构建时从 GitHub Release 资产 + jsDelivr CDN 命中汇总，未统计到则为 undefined */
  downloads?: number;
  sha256?: string;
  downloadUrls?: MarketDownloadUrl[];
  changelog?: string;
  history?: { version?: string; changelog?: string; at?: number }[];
  repo?: string;
  featured?: boolean;
  delisted?: boolean;
  publishedAt?: string;
  /** 条目最近更新时间（ISO 字符串），索引没有该字段时回退到 publishedAt */
  updatedAt?: string;
  /** 维护者下架原因（delisted=true 时由索引带上） */
  delistReason?: ModerationReason;
  moderatedAt?: string;
  moderatedBy?: string;
}

export interface MarketIndex {
  schemaVersion?: number;
  publishedAt?: string;
  mods?: MarketEntry[];
  /** 审核结果表：key 是模组 id 或 owner/repo；被拒绝收录的条目不在 mods[] 里，只能从这里查到原因 */
  moderation?: Record<string, ModerationRecord>;
  signature?: unknown;
}

export interface MarketListResult {
  ok: boolean;
  index?: MarketIndex;
  source?: string;
  fetchedAt?: number;
  cached?: boolean;
  reason?: string;
}

export interface UpdateInfo {
  id: string;
  displayName: string;
  localVersion: string;
  remoteVersion: string;
  entry: MarketEntry;
}

function cachePath(): string {
  return path.join(ensureLauncherRuntimePaths().cache, CACHE_FILE);
}

export function indexUrls(): string[] {
  try {
    const settings = readSettings();
    const list = settings.modIndexUrls;
    if (Array.isArray(list)) {
      const urls = list.filter((v) => typeof v === "string" && /^https?:\/\//i.test(v)) as string[];
      if (urls.length) return urls;
    }
  } catch {
    /* 读设置失败就用默认 */
  }
  return DEFAULT_INDEX_URLS;
}

/**
 * 只读本地缓存的索引（**绝不联网**）。
 * 「我创建的」这类要立刻出结果的调用必须用这个 —— 否则索引地址不可达时会白等 8~12 秒，
 * 用户会以为点了没反应。真正的联网刷新交给「模组市场」页签的 fetchModIndex。
 */
export function readIndexCache(): MarketIndex | null {
  const hit = readCache();
  if (!hit) return null;
  const verdict = verifyIndexSignature(hit.index as Record<string, unknown>);
  if (!verdict.ok) return null;   // 缓存被改过就当没有
  trustAuthorsFromIndex(hit.index);
  return hit.index;
}

function readCache(): { index: MarketIndex; fetchedAt: number } | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const holder = parsed as { index?: MarketIndex; fetchedAt?: number };
    if (!holder.index || typeof holder.index !== "object") return null;
    return { index: holder.index, fetchedAt: typeof holder.fetchedAt === "number" ? holder.fetchedAt : 0 };
  } catch {
    return null;
  }
}

function writeCache(index: MarketIndex): number {
  const fetchedAt = Date.now();
  try {
    const dir = path.dirname(cachePath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify({ fetchedAt, index }, null, 2) + "\n", "utf8");
  } catch {
    /* 缓存写不进去不影响本次结果 */
  }
  return fetchedAt;
}

/** 验签通过后，把索引里登记的作者公钥注入信任表（模组签名校验就能认他们） */
function trustAuthorsFromIndex(index: MarketIndex): void {
  const mods = Array.isArray(index.mods) ? index.mods : [];
  for (const entry of mods) {
    const author = entry && entry.author;
    if (!author) continue;
    if (typeof author.keyId === "string" && typeof author.publicKey === "string" && author.publicKey) {
      trustPublicKey(author.keyId, author.publicKey);
    }
  }
}

async function fetchOne(url: string, signal: AbortSignal): Promise<{ ok: boolean; index?: MarketIndex; reason?: string }> {
  try {
    const res = await net.fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), {
      headers: { "User-Agent": "EveJS-Launcher", Accept: "application/json" },
      signal
    });
    if (!res.ok) return { ok: false, reason: "HTTP " + res.status };
    const text = await res.text();
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return { ok: false, reason: "不是合法的 JSON 对象" };
    const index = parsed as MarketIndex;
    const verdict = verifyIndexSignature(index as Record<string, unknown>);
    if (!verdict.ok) return { ok: false, reason: "索引签名校验失败：" + (verdict.reason || "") };
    trustAuthorsFromIndex(index);
    return { ok: true, index };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: message.includes("aborted") ? "超时" : message };
  }
}

/**
 * 拉索引：TTL 内直接用缓存；超过 TTL 才联网。
 * force=true 忽略 TTL。全部镜像失败时回退到最后一份缓存（并标注 cached）。
 */
export async function fetchModIndex(force = false): Promise<MarketListResult> {
  const cached = readCache();
  if (!force && cached && Date.now() - cached.fetchedAt < TTL_MS) {
    trustAuthorsFromIndex(cached.index);
    return { ok: true, index: cached.index, source: "cache", fetchedAt: cached.fetchedAt, cached: true };
  }

  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), TOTAL_BUDGET_MS);
  const failures: string[] = [];
  try {
    for (const url of indexUrls()) {
      const single = new AbortController();
      const timer = setTimeout(() => single.abort(), FETCH_TIMEOUT_MS);
      const linked = () => single.abort();
      controller.signal.addEventListener("abort", linked, { once: true });
      try {
        const res = await fetchOne(url, single.signal);
        if (res.ok && res.index) {
          const fetchedAt = writeCache(res.index);
          return { ok: true, index: res.index, source: url, fetchedAt, cached: false };
        }
        failures.push(url + " → " + (res.reason || "失败"));
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", linked);
      }
    }
  } finally {
    clearTimeout(budget);
  }

  if (cached) {
    trustAuthorsFromIndex(cached.index);
    return {
      ok: true,
      index: cached.index,
      source: "cache",
      fetchedAt: cached.fetchedAt,
      cached: true,
      reason: "网络不可用，已回退到本地缓存（" + failures.join("；") + "）"
    };
  }
  return { ok: false, reason: failures.join("；") || "没有配置索引地址" };
}

/** 极简 semver 比较：数字段逐个比，预发布视为小于正式版 */
export function compareVersion(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ""] = String(v || "").trim().replace(/^v/i, "").split("-");
    return { nums: core.split(".").map((x) => Number.parseInt(x, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const l = x.nums[i] || 0;
    const r = y.nums[i] || 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** 当前 EveJS 版本是否满足条目的 evejsVersions 声明（支持 0.12.x 这种通配） */
export function satisfiesEvejs(entry: MarketEntry, evejsVersion: string): boolean {
  const list = Array.isArray(entry.evejsVersions) ? entry.evejsVersions : [];
  if (!list.length) return true;
  const current = String(evejsVersion || "").trim();
  if (!current) return true;
  return list.some((want) => {
    const w = String(want).trim();
    if (!w) return false;
    if (w.toLowerCase() === current.toLowerCase()) return true;
    if (w.endsWith(".x")) return current.startsWith(w.slice(0, -1));
    return false;
  });
}

export function findUpdates(localMods: ModRecord[], index: MarketIndex): UpdateInfo[] {
  const out: UpdateInfo[] = [];
  const entries = Array.isArray(index.mods) ? index.mods : [];
  for (const local of localMods) {
    const entry = entries.find((e) => e && e.id === local.id);
    if (!entry || !entry.version) continue;
    if (entry.delisted) continue;
    if (compareVersion(entry.version, local.version) > 0) {
      out.push({
        id: local.id,
        displayName: local.displayName || local.id,
        localVersion: local.version,
        remoteVersion: entry.version,
        entry
      });
    }
  }
  return out;
}

export interface DownloadProgress {
  id: string;
  downloaded: number;
  total?: number;
  percent?: number;
  mirror?: string;
}

function sha256Of(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 下载条目 ZIP：按 priority 试每个镜像 → 校验 sha256 → 返回本地路径 */
export async function downloadEntry(
  entry: MarketEntry,
  onProgress?: (p: DownloadProgress) => void
): Promise<{ ok: boolean; zipPath?: string; mirror?: string; reason?: string }> {
  const urls = (Array.isArray(entry.downloadUrls) ? entry.downloadUrls : [])
    .filter((u) => u && /^https:\/\//i.test(String(u.url || "")))
    .slice()
    .sort((a, b) => (Number(a.priority) || 99) - (Number(b.priority) || 99));
  if (!urls.length) return { ok: false, reason: "这个条目没有可用的下载地址（作者未提供）" };

  const dest = path.join(launcherTempDir(), "market", entry.id + "-" + (entry.version || "0") + ".zip");
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const failures: string[] = [];
  for (const item of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await net.fetch(item.url, { headers: { "User-Agent": "EveJS-Launcher" }, signal: controller.signal });
      if (!res.ok) {
        failures.push(item.mirror + " → HTTP " + res.status);
        continue;
      }
      const total = Number(res.headers.get("content-length") || 0) || undefined;
      const chunks: Buffer[] = [];
      let downloaded = 0;
      const reader = res.body ? res.body.getReader() : null;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(Buffer.from(value));
            downloaded += value.length;
            if (onProgress) {
              onProgress({
                id: entry.id,
                downloaded,
                total,
                percent: total ? Math.round((downloaded / total) * 100) : undefined,
                mirror: item.mirror
              });
            }
          }
        }
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        chunks.push(buf);
        downloaded = buf.length;
      }
      const buf = Buffer.concat(chunks);
      if (!buf.length) {
        failures.push(item.mirror + " → 空文件");
        continue;
      }
      fs.writeFileSync(dest, buf);

      const want = String(entry.sha256 || "").toLowerCase();
      if (want) {
        const got = sha256Of(dest);
        if (got !== want) {
          failures.push(item.mirror + " → sha256 不匹配（期望 " + want.slice(0, 12) + "… 实际 " + got.slice(0, 12) + "…）");
          continue;
        }
      }
      return { ok: true, zipPath: dest, mirror: item.mirror };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failures.push(item.mirror + " → " + (message.includes("aborted") ? "超时" : message));
    } finally {
      clearTimeout(timer);
    }
  }
  // 全部镜像都 404 = 作者删除/改名了仓库或 Release 资源（索引里还留着旧地址）
  const all404 = failures.length > 0 && failures.every((f) => /HTTP 404/.test(f));
  if (all404) {
    return {
      ok: false,
      reason:
        "下载地址已失效（HTTP 404）：作者可能删除了仓库或 Release 资源。" +
        "请点「检查更新」刷新索引后重试；如果这个模组还在列表里，说明索引尚未更新（可联系维护者下架）。" +
        " 详细信息：" + failures.join("；")
    };
  }
  return { ok: false, reason: "所有镜像都失败了：" + failures.join("；") };
}

export interface InstallOutcome {
  ok: boolean;
  mode?: "install" | "update";
  id?: string;
  folder?: string;
  version?: string;
  previousVersion?: string;
  reason?: string;
}

/** 下载并安装/更新：已装则走 updateMod（保留启用状态与用户数据），否则走 importModZip */
export async function installEntry(
  repoRoot: string,
  entry: MarketEntry,
  onProgress?: (p: DownloadProgress) => void
): Promise<InstallOutcome> {
  const downloaded = await downloadEntry(entry, onProgress);
  if (!downloaded.ok || !downloaded.zipPath) return { ok: false, reason: downloaded.reason || "下载失败" };

  const local = scanMods(repoRoot).mods.find((m) => m.id === entry.id);
  if (local) {
    const updated = await updateMod(repoRoot, downloaded.zipPath);
    return {
      ok: updated.ok,
      mode: "update",
      id: updated.id || entry.id,
      folder: updated.folder,
      version: updated.newVersion || entry.version,
      previousVersion: updated.previousVersion || local.version,
      reason: updated.reason
    };
  }

  const imported = await importModZip(repoRoot, downloaded.zipPath);
  return {
    ok: imported.ok,
    mode: "install",
    id: entry.id,
    folder: imported.folder,
    version: entry.version,
    reason: imported.reason
  };
}