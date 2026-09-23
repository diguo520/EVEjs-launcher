import { net } from "electron";

/**
 * GitHub 提交（fork → 分支 → 提交分片 → 开 PR）。
 *
 * 为什么必须走 fork：社区作者对索引仓库没有写权限，所以只能用**作者自己的 PAT**
 * 往自己的 fork 上推分支，再向主仓库开 PR（见 docs/mod-signing-and-marketplace-plan.md §5.4）。
 *
 * 全程只用 REST API，失败时由调用方降级为「打开 PR 页面 + 复制草稿」。
 */

const API = "https://api.github.com";
const UA = "EveJS-Launcher";
const TIMEOUT_MS = 20000;

interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  reason?: string;
}

async function call<T>(
  token: string,
  method: string,
  apiPath: string,
  body?: unknown
): Promise<ApiResult<T>> {
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
    let data: unknown = undefined;
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

export interface GitHubUser {
  login: string;
}

export async function validateToken(token: string): Promise<{ ok: boolean; login?: string; reason?: string }> {
  const res = await call<GitHubUser>(token, "GET", "/user");
  if (!res.ok || !res.data || !res.data.login) return { ok: false, reason: res.reason || "令牌无效" };
  return { ok: true, login: res.data.login };
}

interface RepoInfo {
  full_name: string;
  default_branch?: string;
}

/** 确保 fork 存在并可用（已存在则直接复用） */
export async function ensureFork(
  token: string,
  upstream: string
): Promise<{ ok: boolean; repo?: string; reason?: string }> {
  const fork = await call<RepoInfo>(token, "POST", "/repos/" + upstream + "/forks", {});
  if (fork.ok && fork.data && fork.data.full_name) return { ok: true, repo: fork.data.full_name };
  // 409/422：已经有同名 fork 了 —— 属于正常情况
  const user = await validateToken(token);
  if (!user.ok || !user.login) return { ok: false, reason: fork.reason || "拿不到 GitHub 登录名" };
  const repoName = upstream.split("/")[1] || "";
  const mine = await call<RepoInfo>(token, "GET", "/repos/" + user.login + "/" + repoName);
  if (mine.ok && mine.data && mine.data.full_name) return { ok: true, repo: mine.data.full_name };
  return { ok: false, reason: fork.reason || mine.reason || "fork 不可用" };
}

/**
 * 读仓库里的一个文件（优先 Contents API，退回 raw CDN）。返回文本与 sha。
 * 用途：往 sources.json 追加一行前，必须先拿到**当前**内容 —— 读不到就绝不能继续，
 * 否则会拿空列表去覆盖，把别人的收录全删掉（0.1.19 实测踩过）。
 */
export async function readRepoFile(
  token: string,
  repo: string,
  filePath: string,
  baseBranch = "main"
): Promise<{ ok: boolean; text?: string; sha?: string; reason?: string }> {
  const viaApi = await call<{ content?: string; sha?: string; encoding?: string }>(
    token,
    "GET",
    "/repos/" + repo + "/contents/" + filePath + "?ref=" + encodeURIComponent(baseBranch)
  );
  if (viaApi.ok && viaApi.data && typeof viaApi.data.content === "string" && viaApi.data.content) {
    const cleaned = viaApi.data.content.replace(/\n/g, "");
    return { ok: true, text: Buffer.from(cleaned, "base64").toString("utf8"), sha: viaApi.data.sha || "" };
  }
  try {
    const res = await net.fetch("https://raw.githubusercontent.com/" + repo + "/" + baseBranch + "/" + filePath, {
      headers: { "User-Agent": UA }
    });
    if (res.ok) return { ok: true, text: await res.text(), sha: "" };
    return { ok: false, reason: viaApi.reason || ("raw HTTP " + res.status) };
  } catch (e) {
    return { ok: false, reason: viaApi.reason || (e instanceof Error ? e.message : String(e)) };
  }
}

export interface SubmitFileInput {
  token: string;
  upstream: string;
  /** 分片文件在仓库里的路径，例如 mods/welcome-mod.json */
  filePath: string;
  /** 文件内容（纯文本） */
  content: string;
  branch: string;
  baseBranch?: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
}

export interface SubmitFileResult {
  ok: boolean;
  prUrl?: string;
  branch?: string;
  login?: string;
  forkRepo?: string;
  /** 开 PR 失败时给出的「手动开 PR」比较页链接 */
  compareUrl?: string;
  reason?: string;
}

export async function submitFileViaPullRequest(input: SubmitFileInput): Promise<SubmitFileResult> {
  const base = input.baseBranch || "main";
  const user = await validateToken(input.token);
  if (!user.ok || !user.login) return { ok: false, reason: user.reason || "令牌无效" };
  const login = user.login;

  const fork = await ensureFork(input.token, input.upstream);
  if (!fork.ok || !fork.repo) return { ok: false, reason: fork.reason || "fork 失败" };
  const forkRepo = fork.repo;
  const forkName = forkRepo.split("/")[1] || "";

  const headRef = await call<{ object?: { sha?: string } }>(
    input.token,
    "GET",
    "/repos/" + login + "/" + forkName + "/git/ref/heads/" + base
  );
  const baseSha = headRef.data && headRef.data.object && headRef.data.object.sha;
  if (!headRef.ok || !baseSha) {
    return { ok: false, reason: headRef.reason || "拿不到 fork 的 " + base + " 分支（fork 可能还在生成，稍后重试）" };
  }

  // 分支已存在（上次提交过同名分支）时直接复用
  const createRef = await call(
    input.token,
    "POST",
    "/repos/" + login + "/" + forkName + "/git/refs",
    { ref: "refs/heads/" + input.branch, sha: baseSha }
  );
  if (!createRef.ok && createRef.status !== 422) {
    return { ok: false, reason: createRef.reason || "建分支失败" };
  }

  // 文件已存在（更新已有分片）时需要带上它的 blob sha
  const existing = await call<{ sha?: string }>(
    input.token,
    "GET",
    "/repos/" + login + "/" + forkName + "/contents/" + input.filePath + "?ref=" + encodeURIComponent(input.branch)
  );
  const existingSha = existing.ok && existing.data ? existing.data.sha : undefined;

  const put = await call(
    input.token,
    "PUT",
    "/repos/" + login + "/" + forkName + "/contents/" + input.filePath,
    {
      message: input.commitMessage,
      content: Buffer.from(input.content, "utf8").toString("base64"),
      branch: input.branch,
      ...(existingSha ? { sha: existingSha } : {})
    }
  );
  if (!put.ok) return { ok: false, reason: put.reason || "提交文件失败" };

  const pr = await call<{ html_url?: string }>(input.token, "POST", "/repos/" + input.upstream + "/pulls", {
    title: input.prTitle,
    head: login + ":" + input.branch,
    base,
    body: input.prBody
  });
  if (pr.status === 422) {
    // 这个分支已经有 PR 了（重复点「申请收录」）：文件已经更新，直接把已有 PR 找回来，算成功。
    const existingPr = await call<Array<{ html_url?: string }>>(
      input.token,
      "GET",
      "/repos/" + input.upstream + "/pulls?state=all&head=" + encodeURIComponent(login + ":" + input.branch)
    );
    const url = existingPr.ok && Array.isArray(existingPr.data) && existingPr.data[0] ? existingPr.data[0].html_url : "";
    if (url) return { ok: true, prUrl: url, branch: input.branch, login, forkRepo };
  }
  if (!pr.ok) {
    // 分支已推到 fork，但开 PR 失败（多半是令牌缺 Pull requests 写权限）：附带手动开 PR 的比较页链接
    const compareUrl =
      "https://github.com/" + input.upstream + "/compare/" + base + "..." + encodeURIComponent(login + ":" + input.branch) + "?expand=1";
    return {
      ok: false,
      login,
      forkRepo,
      branch: input.branch,
      compareUrl,
      reason: pr.reason || "开 PR 失败（分支已推送，可手动开 PR）"
    };
  }

  return { ok: true, prUrl: pr.data && pr.data.html_url, branch: input.branch, login, forkRepo };
}

/** 降级路径：给出可直接打开的 PR 比较页地址 */
export function pullRequestCompareUrl(upstream: string, branch: string, login?: string): string {
  if (login) return "https://github.com/" + upstream + "/compare/main..." + login + ":" + branch + "?expand=1";
  return "https://github.com/" + upstream + "/compare/main...main?expand=1";
}