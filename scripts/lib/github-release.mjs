/**
 * 发版脚本共用的样板：仓库、参数、令牌、API 头（A4，2026-10-29）。
 *
 * 为什么抽出来：`make-release.mjs` 与 `release-channel.mjs` 各自抄了一份逐字相同的
 * `ROOT / args / flag / value / REPO / token`（jscpd 报 3 块 38 行）。这两条是**发版关键路径**，
 * 抄两份意味着「改一处漏一处」—— 换仓库、改令牌取法、改 UA 都可能只改一边。
 *
 * 差异不消灭、只参数化（抄写时它们本就是同义不同名）：
 *   · 报错函数：make-release 叫 `die`、release-channel 叫 `fail` → `readToken(onMissing)`；
 *   · User-Agent：两者不同 → `authHeaders(token, { userAgent })`；
 *   · 默认仓库：两边一致，仍允许调用方覆盖。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

/** 仓库根：本文件在 `scripts/lib/` 下，往上两级 */
export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const DEFAULT_REPO = "diguo520/EVEjs-launcher";

export const args = process.argv.slice(2);
export const flag = (name) => args.includes(name);

/** `--name value` 取值；缺省/空串回 fallback */
export function value(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

/** 仓库：`--repo owner/name` → origin 远端 → 默认仓库 */
export function resolveRepo(fallback = DEFAULT_REPO) {
  const explicit = value("--repo");
  if (explicit) return explicit;
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" }).trim();
    const match = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {
    /* 没有远端就用默认仓库 */
  }
  return fallback;
}

/**
 * 令牌：`--token` → `GH_TOKEN` / `GITHUB_TOKEN` → `git credential fill`（github.com）。
 * 都拿不到就交给调用方的 `onMissing`（各脚本的口吻不同）。
 */
export function readToken(onMissing) {
  const missing =
    onMissing ??
    ((text) => {
      throw new Error(text);
    });
  const explicit = value("--token") ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (explicit && explicit.trim()) return explicit.trim();
  try {
    const out = execFileSync("git", ["credential", "fill"], {
      cwd: ROOT,
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
    });
    const match = out.match(/^password=(.+)$/m);
    if (match && match[1].trim()) return match[1].trim();
  } catch {
    /* 落到下面的报错 */
  }
  return missing("没有 GitHub 令牌：传 --token、设 GH_TOKEN，或先让 git 存好 github.com 的凭据");
}

/** 统一的 GitHub API 头（UA 按脚本给，两个脚本本来就不同） */
export function authHeaders(token, { json = false, userAgent = "evejs-release" } = {}) {
  return {
    Authorization: "Bearer " + token,
    "User-Agent": userAgent,
    Accept: "application/vnd.github+json",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}
