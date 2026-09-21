import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { net } from "electron";

/**
 * 把模组发布到**作者自己的 GitHub 仓库**（不是索引仓库）。
 *
 * 为什么这么设计（社区有成百上千作者时的可扩展性）：
 *  - 每个作者有自己的仓库与 Release，ZIP 由作者自己托管 —— 维护者不承担存储/带宽；
 *  - 启动器只帮作者做两件重复劳动：写 `evejs-mod.json`（索引用的"上架清单"）+ 传 Release 资源；
 *  - **版本更新完全不需要向索引仓库提 PR** —— 作者推自己的仓库即可；
 *  - 只有"第一次被收录"需要往索引仓库的 `sources.json` 加一行（一次性的 PR）；
 *  - 索引仓库的 CI 定时抓所有 `sources.json` 里的 `evejs-mod.json`，聚合成一份签名过的
 *    `mod-index.json`，客户端只拉这一个文件。
 */

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const UA = "EveJS-Launcher";
const TIMEOUT_MS = 30000;

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  reason?: string;
}

async function call<T>(token: string, method: string, apiPath: string, body?: unknown): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await net.fetch(API + apiPath, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": UA,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    let data: unknown;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (!res.ok) {
      const message =
        data && typeof data === "object" && typeof (data as Record<string, unknown>).message === "string"
          ? String((data as Record<string, unknown>).message)
          : text.slice(0, 200) || res.statusText;
      return {
        ok: false,
        status: res.status,
        data: data as T,
        reason: "GitHub " + res.status + "：" + message + " [" + method + " " + apiPath + "]" + permissionHint(res.status)
      };
    }
    return { ok: true, status: res.status, data: data as T };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, reason: message.includes("aborted") ? "请求超时（" + TIMEOUT_MS / 1000 + "s）" : message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把 GitHub 的 403 / 404 翻译成「到底缺哪一项令牌权限」。
 * fine-grained 令牌的权限在 Repository permissions 里：
 *   Contents      = Read and write —— 写文件 / 建分支 / 建 Release / 传资产
 *   Pull requests = Read and write —— 开 PR
 *   Administration= Read and write —— 自动建仓库
 *   Metadata      = Read-only（自动）
 */
function permissionHint(status: number): string {
  if (status === 403) {
    return "（令牌权限不足：fine-grained 令牌要在 Repository permissions 里给 Contents = Read and write；自动建仓库还要 Administration = Read and write；并且 Repository access 必须覆盖这个仓库）";
  }
  if (status === 404) {
    return "（仓库或文件不存在，或者令牌的 Repository access 没有覆盖这个仓库）";
  }
  return "";
}

interface UserInfo {
  login: string;
}

export async function whoami(token: string): Promise<{ ok: boolean; login?: string; reason?: string }> {
  const res = await call<UserInfo>(token, "GET", "/user");
  if (!res.ok || !res.data?.login) return { ok: false, reason: res.reason || "令牌无效" };
  return { ok: true, login: res.data.login };
}

interface RepoInfo {
  full_name: string;
  html_url?: string;
  default_branch?: string;
}

/** 确保作者自己的仓库存在；不存在就建一个公开仓库 */
export async function ensureOwnRepo(
  token: string,
  owner: string,
  repoName: string,
  description: string
): Promise<{ ok: boolean; repo?: RepoInfo; created?: boolean; reason?: string }> {
  const existing = await call<RepoInfo>(token, "GET", "/repos/" + owner + "/" + repoName);
  if (existing.ok && existing.data?.full_name) return { ok: true, repo: existing.data, created: false };
  if (existing.status !== 404) return { ok: false, reason: existing.reason || "查询仓库失败" };

  const created = await call<RepoInfo>(token, "POST", "/user/repos", {
    name: repoName,
    description: description.slice(0, 300),
    private: false,
    auto_init: true
  });
  if (!created.ok || !created.data?.full_name) {
    if (created.status === 403) {
      return {
        ok: false,
        reason:
          "创建仓库被拒绝（403）：当前令牌缺少 Administration: Read and write。两个解法 —— " +
          "① 到 GitHub 打开这个令牌，Repository permissions 里把 Administration 设为 Read and write（Repository access 选 All repositories）后重试；" +
          "② 先在 GitHub 手动建好仓库，再把 owner/repo 填进「我的仓库」——手动建仓库时只需要 Contents = Read and write。" +
          (created.reason ? " 原始错误：" + created.reason : "")
      };
    }
    return { ok: false, reason: created.reason || "创建仓库失败" };
  }
  return { ok: true, repo: created.data, created: true };
}

/** 写入/更新仓库里的 evejs-mod.json（索引 CI 就是靠它聚合） */
export async function putListingManifest(
  token: string,
  owner: string,
  repoName: string,
  content: string,
  branch?: string
): Promise<{ ok: boolean; sha?: string; reason?: string }> {
  const filePath = "evejs-mod.json";
  const q = branch ? "?ref=" + encodeURIComponent(branch) : "";
  const existing = await call<{ sha?: string }>(token, "GET", "/repos/" + owner + "/" + repoName + "/contents/" + filePath + q);
  const existingSha = existing.ok ? existing.data?.sha : undefined;
  const put = await call<{ content?: { sha?: string } }>(
    token,
    "PUT",
    "/repos/" + owner + "/" + repoName + "/contents/" + filePath,
    {
      message: "chore: update evejs-mod.json",
      content: Buffer.from(content, "utf8").toString("base64"),
      ...(branch ? { branch } : {}),
      ...(existingSha ? { sha: existingSha } : {})
    }
  );
  if (!put.ok) return { ok: false, reason: put.reason || "写入 evejs-mod.json 失败" };
  return { ok: true, sha: put.data?.content?.sha };
}

interface ReleaseInfo {
  id: number;
  tag_name: string;
  html_url?: string;
}

/** 确保 tag 对应的 Release 存在（已存在则复用） */
export async function ensureRelease(
  token: string,
  owner: string,
  repoName: string,
  tag: string,
  changelog: string
): Promise<{ ok: boolean; release?: ReleaseInfo; reason?: string }> {
  const found = await call<ReleaseInfo>(token, "GET", "/repos/" + owner + "/" + repoName + "/releases/tags/" + encodeURIComponent(tag));
  if (found.ok && found.data?.id) return { ok: true, release: found.data };

  const created = await call<ReleaseInfo>(token, "POST", "/repos/" + owner + "/" + repoName + "/releases", {
    tag_name: tag,
    name: tag,
    body: changelog || "",
    draft: false,
    prerelease: false
  });
  if (!created.ok || !created.data?.id) return { ok: false, reason: created.reason || "创建 Release 失败" };
  return { ok: true, release: created.data };
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * node:https 直传兜底：net.fetch 不能手动设 Content-Length，而大二进制上传手动声明长度最稳。
 * （走不了系统代理，所以只在 net.fetch 失败时使用。）
 */
function uploadAssetViaHttps(
  uploadUrl: string,
  token: string,
  bytes: Buffer,
  assetName: string
): Promise<{ ok: boolean; url?: string; reason?: string }> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(uploadUrl);
    } catch (e) {
      resolve({ ok: false, reason: "上传地址非法：" + (e instanceof Error ? e.message : String(e)) });
      return;
    }
    const req = https.request(
      {
        method: "POST",
        hostname: target.hostname,
        path: target.pathname + target.search,
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/zip",
          "Content-Length": String(bytes.length),
          "User-Agent": UA
        },
        timeout: TIMEOUT_MS * 4
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const data = parseJson(body);
          const status = res.statusCode || 0;
          if (status >= 200 && status < 300) {
            const url = data && typeof data === "object" ? String((data as { browser_download_url?: string }).browser_download_url || "") : "";
            resolve({ ok: true, url });
            return;
          }
          const message =
            data && typeof data === "object" && typeof (data as Record<string, unknown>).message === "string"
              ? String((data as Record<string, unknown>).message)
              : body.slice(0, 200) || String(status);
          resolve({ ok: false, reason: "GitHub " + status + "：" + message + permissionHint(status) });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, reason: "上传超时（" + (TIMEOUT_MS * 4) / 1000 + "s）" });
    });
    req.on("error", (e) => resolve({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
    req.end(bytes);
  });
}

/** 上传 ZIP 到 Release；同名资源已存在时先删掉再传（便于重发同一版本） */
export async function uploadReleaseAsset(
  token: string,
  owner: string,
  repoName: string,
  releaseId: number,
  zipPath: string,
  assetName: string
): Promise<{ ok: boolean; url?: string; reason?: string }> {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(zipPath);
  } catch (e) {
    return { ok: false, reason: "读不到 ZIP：" + (e instanceof Error ? e.message : String(e)) };
  }

  const existing = await call<Array<{ id: number; name: string; browser_download_url?: string }>>(
    token,
    "GET",
    "/repos/" + owner + "/" + repoName + "/releases/" + releaseId + "/assets"
  );
  if (existing.ok && Array.isArray(existing.data)) {
    const same = existing.data.find((a) => a.name === assetName);
    if (same) {
      const del = await call(token, "DELETE", "/repos/" + owner + "/" + repoName + "/releases/assets/" + same.id);
      if (!del.ok) return { ok: false, reason: "同名资源删除失败：" + (del.reason || "") };
    }
  }

  const uploadUrl =
    UPLOADS + "/repos/" + owner + "/" + repoName + "/releases/" + releaseId + "/assets?name=" + encodeURIComponent(assetName);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS * 4);
  try {
    // 注意：这里**不能**手动设置 Content-Length —— Content-Length 属于 fetch 的受限头，
    // Chromium 会直接抛 net::ERR_INVALID_ARGUMENT，用户看到的就是「上传失败：net::ERR_INVALID_ARGUMENT」。
    // 长度交给底层自动算；真要手动控制，只能走下面的 node https 兜底。
    const res = await net.fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/zip",
        "User-Agent": UA
      },
      body: new Uint8Array(bytes),
      signal: controller.signal
    });
    const text = await res.text();
    const data = parseJson(text);
    if (!res.ok) {
      const message =
        data && typeof data === "object" && typeof (data as Record<string, unknown>).message === "string"
          ? String((data as Record<string, unknown>).message)
          : text.slice(0, 200) || res.statusText;
      return { ok: false, reason: "上传资源失败：GitHub " + res.status + "：" + message + permissionHint(res.status) };
    }
    const url = data && typeof data === "object" ? String((data as { browser_download_url?: string }).browser_download_url || "") : "";
    return { ok: true, url };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("aborted")) return { ok: false, reason: "上传超时（" + (TIMEOUT_MS * 4) / 1000 + "s）" };
    // net.fetch 抛错（例如受限头 / 该 Electron 版本不支持二进制 body）→ 用 node https 再传一次
    const fallback = await uploadAssetViaHttps(uploadUrl, token, bytes, assetName);
    if (fallback.ok) return { ok: true, url: fallback.url };
    return { ok: false, reason: "上传失败：" + message + " → 已改用 node https 重试，仍失败：" + (fallback.reason || "") };
  } finally {
    clearTimeout(timer);
  }
}

export interface PublishInput {
  token: string;
  /** 作者自己的仓库，owner/repo；owner 为空时用当前登录账号 */
  repo: string;
  zipPath: string;
  assetName: string;
  /** 进度回调：stage 给用户看的阶段名，percent 0-100 */
  onProgress?: (stage: string, percent: number) => void;
  version: string;
  changelog: string;
  description: string;
  /** 索引用的上架清单内容（evejs-mod.json） */
  listingJson: string;
  /** repo 留空时用这个名字建仓库（形如 evejs-mod-<id>） */
  defaultRepoName?: string;
}

export interface PublishResult {
  ok: boolean;
  owner?: string;
  repo?: string;
  repoUrl?: string;
  releaseUrl?: string;
  assetUrl?: string;
  repoCreated?: boolean;
  reason?: string;
}

/**
 * 一次发布：确保仓库 → 写 evejs-mod.json → 建 Release → 上传 ZIP → 回填下载地址。
 * 全程只动作者自己的仓库，**不碰索引仓库**。
 */
export async function publishToOwnRepo(input: PublishInput): Promise<PublishResult> {
  const say = (stage: string, percent: number) => {
    try {
      input.onProgress?.(stage, percent);
    } catch {
      /* 进度回调不该影响发布 */
    }
  };
  say("校验 GitHub 令牌", 5);
  const me = await whoami(input.token);
  if (!me.ok || !me.login) return { ok: false, reason: me.reason || "令牌无效" };

  const raw = String(input.repo || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  const parts = raw.split("/").filter(Boolean);
  const owner = parts.length >= 2 ? parts[0] : me.login;
  const repoName = parts.length >= 2 ? parts[1] : parts[0] || input.defaultRepoName || "evejs-mod";
  if (!repoName || !/^[\w.-]+$/.test(repoName)) {
    return { ok: false, reason: "请填写你自己的仓库名（形如 my-evejs-mod，或 owner/my-evejs-mod）" };
  }

  say("准备仓库", 20);
  const repo = await ensureOwnRepo(input.token, owner, repoName, input.description);
  if (!repo.ok || !repo.repo) return { ok: false, reason: repo.reason || "仓库不可用" };

  say("写入 evejs-mod.json", 40);
  const listing = await putListingManifest(input.token, owner, repoName, input.listingJson);
  if (!listing.ok) return { ok: false, reason: listing.reason || "写入 evejs-mod.json 失败" };

  const tag = "v" + input.version;
  say("创建 Release", 60);
  const release = await ensureRelease(input.token, owner, repoName, tag, input.changelog);
  if (!release.ok || !release.release) return { ok: false, reason: release.reason || "创建 Release 失败" };

  say("上传 ZIP（最慢的一步，请稍候）", 75);
  const asset = await uploadReleaseAsset(input.token, owner, repoName, release.release.id, input.zipPath, input.assetName);
  if (!asset.ok) {
    return {
      ok: false,
      owner,
      repo: repoName,
      repoUrl: repo.repo.html_url,
      releaseUrl: release.release.html_url,
      reason: asset.reason || "上传 ZIP 失败"
    };
  }

  say("完成", 100);
  return {
    ok: true,
    owner,
    repo: repoName,
    repoUrl: repo.repo.html_url,
    releaseUrl: release.release.html_url,
    assetUrl: asset.url,
    repoCreated: !!repo.created
  };
}

/** ZIP 资源名：<id>-<version>.zip（ASCII，避免下载时编码问题） */
export function assetNameFor(id: string, version: string): string {
  const safeId = String(id || "mod").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const safeVer = String(version || "0").replace(/[^A-Za-z0-9._-]+/g, "-");
  return safeId + "-" + safeVer + ".zip";
}

/** 作者仓库地址 → 默认的资产相对路径无关；这里只用于展示 */
export function repoUrlFor(owner: string, repo: string): string {
  return "https://github.com/" + owner + "/" + repo;
}

export function defaultRepoNameFor(id: string): string {
  return "evejs-mod-" + String(id || "mod").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** 便于测试与诊断：导出内部 call（不要在生产代码里直接用） */
export const __internal = { call, API, UPLOADS, fileExists: (p: string) => fs.existsSync(path.resolve(p)) };