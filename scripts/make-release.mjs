#!/usr/bin/env node
/**
 * 发版收尾「一条命令」——把打完包之后 GitHub 侧的动作一次做完，只打一个紧凑摘要。
 *
 * 为什么存在：以前这几步是「临时写一个上传脚本 → 建 release → 传资产 → 转正式 →
 * 跑通道 publish → 再 verify → 再 status → 固定 sleep 轮询 CI」，一次发版十来个工具
 * 来回，光重复拉 release 资产列表、倾倒清单正文、空转轮询就白烧 token。这里收成一次。
 *
 * 干的事（顺序）：
 *   1. 建 release（draft=true；tag 已存在就复用，重名资产先删后传）
 *   2. 上传 artifacts/EvEJSLauncher.exe 与 artifacts/EvEJSLauncher-Tauri-<v>-portable.zip
 *   3. draft → 正式发布（正文由 release-notes/v<v>.json 生成，中英各一节）
 *   4. 调 scripts/release-channel.mjs publish（推 stable 签名清单 + Latest 跟随 + 挂旧通道清单）
 *      它结尾自带隔离断言与验签，**不需要**再单独跑 verify / status
 *   5. --watch-ci：等这个 commit 的 CI 跑完，只在结束时报一次结论
 *
 * 不干的事（守 AGENTS.md 的约定）：commit / tag / push 一律不碰。
 *
 * 用法：
 *   node --use-system-ca scripts/make-release.mjs --version 0.4.3
 *   node --use-system-ca scripts/make-release.mjs --version 0.4.3 --watch-ci
 *   node --use-system-ca scripts/make-release.mjs --version 0.4.3 --dry-run   # 只查本地输入
 *
 * 令牌：--token → GH_TOKEN / GITHUB_TOKEN → git credential fill（github.com）
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
function value(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

if (flag("--help") || flag("-h")) {
  console.log(
    "用法：node --use-system-ca scripts/make-release.mjs --version <X.Y.Z> [--watch-ci] [--dry-run] [--repo owner/name]",
  );
  process.exit(0);
}

const DEFAULT_REPO = "diguo520/EVEjs-launcher";
const REPO = (() => {
  const explicit = value("--repo");
  if (explicit) return explicit;
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" }).trim();
    const match = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {
    /* 没有远端就用默认仓库 */
  }
  return DEFAULT_REPO;
})();

const VERSION = (
  value("--version") ?? JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version
).replace(/^v/, "");
const TAG = `v${VERSION}`;
const DRY = flag("--dry-run");

const step = (text) => console.log("  · " + text);
const ok = (text) => console.log("  \u2713 " + text);
function die(text) {
  console.error("  \u2717 " + text);
  process.exit(1);
}

function token() {
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
  return die("没有 GitHub 令牌：传 --token、设 GH_TOKEN，或先让 git 存好 github.com 的凭据");
}

const TOK = DRY ? null : token();
const headers = (json = false) => ({
  Authorization: "Bearer " + TOK,
  "User-Agent": "evejs-release",
  Accept: "application/vnd.github+json",
  ...(json ? { "Content-Type": "application/json" } : {}),
});

async function gh(method, url, body) {
  const res = await fetch(url.startsWith("http") ? url : "https://api.github.com" + url, {
    method,
    headers: headers(Boolean(body)),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) die(`${method} ${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/* ---- 正文：从 release-notes 生成，格式与 v0.4.2 / v0.4.3 / v0.4.4 对齐 ---- */
const LABEL = { new: "\u65b0\u589e / New", fix: "\u4fee\u590d / Fixes", opt: "\u4f18\u5316 / Optimizations" };
const ORDER = ["new", "fix", "opt"];
function section(notes, lang) {
  let out = "";
  for (const type of ORDER) {
    const items = notes[lang].filter((item) => item.type === type);
    if (!items.length) continue;
    out += `### ${LABEL[type]}\n` + items.map((item) => `- ${item.text}`).join("\n") + "\n\n";
  }
  return out.trimEnd();
}

/**
 * 收集本地输入。**所有问题都收集起来再一次性报**，不在第一个问题上就退出 ——
 * 这样 `--dry-run` 能先把完整计划打出来，再告诉你缺什么。
 */
function localInputs() {
  const problems = [];

  const notesPath = path.join(ROOT, "release-notes", `v${VERSION}.json`);
  let notes = null;
  if (!fs.existsSync(notesPath)) {
    problems.push(`缺少 release-notes/v${VERSION}.json（版本号写错？）`);
  } else {
    notes = JSON.parse(fs.readFileSync(notesPath, "utf8")).changelog;
    if (!notes?.zh?.length) problems.push("release-notes 缺 zh 章节");
    if (!notes?.en?.length) problems.push("release-notes 缺 en 章节");
  }

  const exe = path.join(ROOT, "artifacts", "EvEJSLauncher.exe");
  const zip = path.join(ROOT, "artifacts", `EvEJSLauncher-Tauri-${VERSION}-portable.zip`);
  const manifestPath = path.join(ROOT, "artifacts", "update-manifest.json");
  for (const item of [exe, zip, manifestPath]) {
    if (!fs.existsSync(item)) problems.push(`缺少打包产物 ${path.relative(ROOT, item)}`);
  }

  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.version !== VERSION) {
      problems.push(`artifacts/update-manifest.json 是 ${manifest.version}，不是 ${VERSION}`);
    }
    if (!manifest.signature?.sig) {
      problems.push("update-manifest.json 没有签名 —— 打包时漏了 -SignKey，或被一次未签名的重打包覆盖了");
    }
  }

  let sha = null;
  try {
    sha = execFileSync("git", ["rev-parse", `${TAG}^{}`], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    problems.push(`本机没有 tag ${TAG}（先 commit 并 git tag -a ${TAG}）`);
  }

  return { notes, exe, zip, manifest, sha, problems };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等 CI 跑完；全程不打印中间状态，只在有结论时打印一次。 */
async function watchCi(sha) {
  step("等 CI（每 20 秒查一次，只在结束时报结论）");
  const deadline = Date.now() + 30 * 60 * 1000;
  for (;;) {
    const runs = await gh("GET", `/repos/${REPO}/actions/runs?head_sha=${sha}&per_page=5`);
    const list = runs?.workflow_runs ?? [];
    const run = list.find((item) => item.name === "CI") ?? list[0];
    if (run?.status === "completed") {
      const seconds = Math.round((Date.parse(run.updated_at) - Date.parse(run.run_started_at)) / 1000);
      step(`CI ${run.conclusion} · ${seconds}s · ${run.html_url}`);
      return run.conclusion === "success";
    }
    if (Date.now() > deadline) return null;
    await sleep(20000);
  }
}

async function main() {
  const { notes, exe, zip, manifest, sha, problems } = localInputs();

  /* 先摆计划，再报问题 —— dry-run 的价值就在看清这次要发什么 */
  step(`版本 ${VERSION} · tag ${TAG} · commit ${sha ? sha.slice(0, 7) : "（缺 tag）"}`);
  if (fs.existsSync(exe)) step(`资产 EvEJSLauncher.exe（${fs.statSync(exe).size} 字节）`);
  if (fs.existsSync(zip)) step(`资产 ${path.basename(zip)}（${(fs.statSync(zip).size / 1048576).toFixed(2)} MB）`);
  if (manifest) {
    const pinned = manifest.platforms?.["win32-x64"] ?? {};
    step(`清单 v${manifest.version} · ${manifest.signature?.sig ? "已签名 " : "未签名 "}${String(pinned.sha256 ?? "").slice(0, 16)}…`);
  }
  let body = null;
  if (notes?.zh?.length && notes?.en?.length) {
    body = `## \u4e2d\u6587\n\n${section(notes, "zh")}\n\n## English\n\n${section(notes, "en")}\n`;
    step(`Release 正文 中文 ${notes.zh.length} 条 / 英文 ${notes.en.length} 条（${body.length} 字符），格式沿用 v0.4.2 起的中英双节`);
  }

  if (problems.length) {
    die("前置检查未通过：\n    - " + problems.join("\n    - "));
  }

  if (DRY) {
    ok("--dry-run：本地输入齐全，未碰远端");
    return;
  }
  if (!body) die("Release 正文生成失败");

  /* 1) release（幂等：已存在就复用） */
  let release = await gh("GET", `/repos/${REPO}/releases/tags/${TAG}`);
  if (release) {
    step(`复用已存在的 release #${release.id}（draft=${release.draft}）`);
  } else {
    release = await gh("POST", `/repos/${REPO}/releases`, {
      tag_name: TAG,
      name: `EvEJS Launcher ${VERSION}`,
      body,
      draft: true,
      prerelease: false,
    });
    step(`建 release #${release.id}（draft）`);
  }

  /* 2) 资产：重名先删后传，保证线上字节 = 本地刚打的包 */
  const existing = release.assets?.length
    ? release.assets
    : ((await gh("GET", `/repos/${REPO}/releases/${release.id}/assets`)) ?? []);
  const uploads = [
    ["EvEJSLauncher.exe", exe],
    [`EvEJSLauncher-Tauri-${VERSION}-portable.zip`, zip],
  ];
  for (const [name, file] of uploads) {
    for (const asset of existing.filter((item) => item.name === name)) {
      await gh("DELETE", `/repos/${REPO}/releases/assets/${asset.id}`);
      step(`删掉重名的旧 ${name}`);
    }
    const buffer = fs.readFileSync(file);
    const res = await fetch(
      `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + TOK,
          "User-Agent": "evejs-release",
          "Content-Type": "application/octet-stream",
          "Content-Length": String(buffer.length),
        },
        body: buffer,
      },
    );
    if (!res.ok) die(`上传 ${name} 失败：${res.status} ${(await res.text()).slice(0, 200)}`);
    step(`上传 ${name}（${(await res.json()).size} 字节）`);
  }

  /* 3) 转正式 */
  if (release.draft) {
    await gh("PATCH", `/repos/${REPO}/releases/${release.id}`, { draft: false });
    step("draft → 正式发布");
  }

  /* 4) 通道：stable 签名清单 + Latest 隔离（脚本自带验签与隔离断言） */
  execFileSync(process.execPath, ["--use-system-ca", path.join(ROOT, "scripts", "release-channel.mjs"), "publish", "--version", VERSION], {
    cwd: ROOT,
    stdio: "inherit",
  });

  ok(`已发布 https://github.com/${REPO}/releases/tag/${TAG}`);

  /* 5) 可选：等 CI */
  if (flag("--watch-ci")) {
    const green = await watchCi(sha);
    if (green !== true) die(green === false ? "CI 红了" : "等 CI 超时（30 分钟）");
    ok("CI 绿灯");
  }
  console.log(`\n  完成 · https://github.com/${REPO}/commit/${sha}/checks`);
}

await main();
