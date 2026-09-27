#!/usr/bin/env node
/**
 * L3 端到端沙箱：在 tests/parity/make-repo-fixture.mjs 之上加「快照 → 跑 → 还原」。
 *
 * 为什么需要它：L3 要跑的通道**全部有副作用**（建模组、起服务、改配置、备份/恢复、卸载…），
 * 对着真实仓库跑就是拿用户数据做实验。这里给出可回滚的两份替身：仓库根 + 运行时数据目录
 * （EVEJS_USER_DATA_DIR），并把「跑完之后和跑之前一模一样」变成**可断言**的事实：
 *
 *   snapshot()       记下「相对路径 → 大小 + sha256」清单，并留一份副本；
 *   diffManifests()  把「这一轮到底改了什么」摊开（写通道 golden 缺的就是这半）；
 *   restore()        先整棵删掉再从副本敷回去，digest 必须与快照逐字节一致。
 *
 * 目录约定（默认都在 .parity-out/ 下，已被 gitignore）：
 *   e2e-sandbox/repo/      启动器眼里的仓库根（repoRoot）
 *   e2e-sandbox/cwd/       进程工作目录，放 launcher.config.json 指向 repo/
 *   e2e-sandbox/userdata/  EVEJS_USER_DATA_DIR（运行时 _launcher 目录落在里面）
 *   e2e-sandbox.snapshot/  快照本体：tree/ 副本 + manifest.json
 * 快照放在沙箱**同级**而不是沙箱内，否则清单会把快照自己也算进去。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SOURCE, ensureRepoFixture } from "../parity/make-repo-fixture.mjs";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const DEFAULT_SANDBOX = path.join(ROOT, ".parity-out", "e2e-sandbox");
export const DEFAULT_SNAPSHOT = path.join(ROOT, ".parity-out", "e2e-sandbox.snapshot");
/** L3 比 L2 多需要的空目录：模组目录、运行时数据库、服务端依赖存在性检查、日志 */
const EXTRA_DIRS = ["mods", "_local", "server/node_modules", "logs"];

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 造一份干净的沙箱（先删掉上一轮：重建才算「从零开始」，还原只负责跑完的复原） */
export function buildSandbox({ root = DEFAULT_SANDBOX, source = DEFAULT_SOURCE } = {}) {
  fs.rmSync(root, { recursive: true, force: true });
  const repoDir = path.join(root, "repo");
  const cwdDir = path.join(root, "cwd");
  const userdataDir = path.join(root, "userdata");
  for (const dir of [cwdDir, userdataDir]) fs.mkdirSync(dir, { recursive: true });
  const fixture = ensureRepoFixture({ source, out: repoDir });
  for (const dir of EXTRA_DIRS) fs.mkdirSync(path.join(repoDir, dir), { recursive: true });
  // 预置市场索引缓存：渲染层每次启动都会后台静默出网拉一次索引（见下面的 seedMarketIndexCache）
  seedMarketIndexCache(userdataDir);
  // 启动器按 cwd 找 launcher.config.json；指向沙箱仓库，绝不碰真实安装目录
  fs.writeFileSync(
    path.join(cwdDir, "launcher.config.json"),
    JSON.stringify({ repoRoot: repoDir }, null, 2) + "\n",
    "utf8",
  );
  return { root, repoDir, cwdDir, userdataDir, fixture };
}

/** 市场索引缓存的相对路径（对应 src-tauri::mods::registry::CACHE_FILE） */
const MARKET_CACHE = "cache/mod-index.json";

/**
 * 预置一份「刚取过」的市场索引缓存。
 *
 * 为什么必须预置：渲染层在每次启动都会执行 `void loadMarket(false, true)`
 * （ui/web/launcher-bridge.js，为了页签上的「N 可更新」徽章）—— 也就是**后台静默出网**拉一次真实
 * 索引（两条镜像，单镜像 8s、总预算 12s）。本机实测：连不带任何场景的只读自检都会因此生成
 * userdata/cache/mod-index.json。不预置的话 E2E 就变成「网络相关 + 计时竞态」的测试：索引抢在
 * 进程被杀之前拉到/没拉到，会让沙箱里多/少一个文件，两轮指纹永远对不上。
 * 预置之后命中 30 分钟 TTL 缓存（fetch_mod_index 走 source=cache 分支），全程不出网。
 */
export function seedMarketIndexCache(userdataDir, now = Date.now()) {
  const file = path.join(userdataDir, ...MARKET_CACHE.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ fetchedAt: now, index: { schemaVersion: 1, mods: [] } }, null, 2) + "\n",
    "utf8",
  );
  return file;
}

/** 市场索引缓存相对沙箱根的路径（编排脚本用它断言「本轮没有出网」） */
export const MARKET_CACHE_PATH = MARKET_CACHE;

/** 场景声明的种子文件：跑之前写进去，因此它们本来就属于「跑之前」的基线 */
export function applySeeds(root, seeds = []) {
  for (const seed of seeds) {
    const target = path.join(root, ...String(seed.path).split("/"));
    if (!inside(root, target)) throw new Error("种子路径逃出沙箱：" + seed.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, seed.content === undefined ? "" : seed.content, "utf8");
  }
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function walk(dir, base, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile())
      out.push({
        path: path.relative(base, full).split(path.sep).join("/"),
        size: fs.statSync(full).size,
        sha256: sha256File(full),
      });
  }
  return out;
}

/** 整棵目录的清单（相对路径按 posix 分隔符，跨机器可比） */
export function listTree(dir) {
  return walk(dir, dir, []).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 清单压成一个指纹：用来一眼判定「逐字节一致」 */
export function treeDigest(manifest) {
  const canonical = manifest.map((e) => e.path + "\u0000" + e.size + "\u0000" + e.sha256).join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function snapshot(root, snapDir = DEFAULT_SNAPSHOT) {
  fs.rmSync(snapDir, { recursive: true, force: true });
  fs.mkdirSync(snapDir, { recursive: true });
  fs.cpSync(root, path.join(snapDir, "tree"), { recursive: true });
  const manifest = listTree(root);
  const digest = treeDigest(manifest);
  fs.writeFileSync(
    path.join(snapDir, "manifest.json"),
    JSON.stringify({ root, digest, entries: manifest }, null, 2) + "\n",
    "utf8",
  );
  return { dir: snapDir, manifest, digest };
}

export function readSnapshot(snapDir = DEFAULT_SNAPSHOT) {
  return JSON.parse(fs.readFileSync(path.join(snapDir, "manifest.json"), "utf8"));
}

/** 还原：整棵删掉再从副本敷回去。返回还原后的清单与指纹，交给调用方比对 */
export function restore(snapDir, root) {
  const tree = path.join(snapDir, "tree");
  if (!fs.existsSync(tree)) throw new Error("快照副本不存在：" + tree);
  fs.rmSync(root, { recursive: true, force: true });
  fs.cpSync(tree, root, { recursive: true });
  const manifest = listTree(root);
  return { manifest, digest: treeDigest(manifest) };
}

export function diffManifests(before, after) {
  const oldMap = new Map(before.map((e) => [e.path, e]));
  const newMap = new Map(after.map((e) => [e.path, e]));
  const added = [...newMap.keys()].filter((key) => !oldMap.has(key)).sort();
  const removed = [...oldMap.keys()].filter((key) => !newMap.has(key)).sort();
  const changed = [...newMap.keys()]
    .filter((key) => oldMap.has(key) && oldMap.get(key).sha256 !== newMap.get(key).sha256)
    .sort();
  return { added, removed, changed, identical: !added.length && !removed.length && !changed.length };
}

function contentTag(item, hashes) {
  return item.startsWith("repo/") ? " " + (hashes.get(item) || "?") : "";
}

/**
 * 两轮之间的可比指纹：仓库内文件比**内容哈希**（确定性要求），
 * userdata 里可能带窗口几何之类的运行时状态，只比路径集合。
 */
export function changeSignature(changes, afterManifest) {
  const hashes = new Map(afterManifest.map((e) => [e.path, e.sha256]));
  const signature = [];
  for (const item of changes.added) signature.push("+ " + item + contentTag(item, hashes));
  for (const item of changes.removed) signature.push("- " + item);
  for (const item of changes.changed) signature.push("~ " + item + contentTag(item, hashes));
  return signature.sort();
}
