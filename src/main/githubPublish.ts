import * as fs from "fs";
import * as path from "path";
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
      return { ok: false, status: res.status, data: data as T, reason: "GitHub " + res.status + "：" + message };
    }
    return { ok: true, status: res.status, data: data as T };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, reason: message.includes("aborted") ? "请求超时（" + TIMEOUT_MS / 1000 + "s）" : message };
  } finally {
    clearTimeout(timer);
  }
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
  if (!created.ok || !created.data?.full_name) return { ok: false, reason: created.reason || "创建仓库失败" };
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS * 4);
  try {
    const res = await net.fetch(
      UPLOADS + "/repos/" + owner + "/" + repoName + "/releases/" + releaseId + "/assets?name=" + encodeURIComponent(assetName),
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/zip",
          "Content-Length": String(bytes.length),
          "User-Agent": UA
        },
        body: new Uint8Array(bytes),
        signal: controller.signal
      }
    );
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const message =
        data && typeof data === "object" && typeof (data as Record<string, unknown>).message === "string"
          ? String((data as Record<string, unknown>).message)
          : text.slice(0, 200) || res.statusText;
      return { ok: false, reason: "上传资源失败：GitHub " + res.status + "：" + message };
    }
    const url = data && typeof data === "object" ? String((data as { browser_download_url?: string }).browser_download_url || "") : "";
    return { ok: true, url };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: message.includes("aborted") ? "上传超时" : "上传失败：" + message };
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
  const me = await whoami(input.token);
  if (!me.ok || !me.login) return { ok: false, reason: me.reason || "令牌无效" };

  const raw = String(input.repo || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  const parts = raw.split("/").filter(Boolean);
  const owner = parts.length >= 2 ? parts[0] : me.login;
  const repoName = parts.length >= 2 ? parts[1] : parts[0] || input.defaultRepoName || "evejs-mod";
  if (!repoName || !/^[\w.-]+$/.test(repoName)) {
    return { ok: false, reason: "请填写你自己的仓库名（形如 my-evejs-mod，或 owner/my-evejs-mod）" };
  }

  const repo = await ensureOwnRepo(input.token, owner, repoName, input.description);
  if (!repo.ok || !repo.repo) return { ok: false, reason: repo.reason || "仓库不可用" };

  const listing = await putListingManifest(input.token, owner, repoName, input.listingJson);
  if (!listing.ok) return { ok: false, reason: listing.reason || "写入 evejs-mod.json 失败" };

  const tag = "v" + input.version;
  const release = await ensureRelease(input.token, owner, repoName, tag, input.changelog);
  if (!release.ok || !release.release) return { ok: false, reason: release.reason || "创建 Release 失败" };

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