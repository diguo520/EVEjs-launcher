#!/usr/bin/env node
/**
 * 生成 parity 用的「仓库根目录」fixture（S5 / L2）。
 *
 * 为什么需要它：跨实现比对如果不给两边**同一个仓库根目录**，得到的差异全是
 * 环境差异（路径、版本、有没有 server/node_modules…），真正的实现差异会被淹掉。
 * 这里按现役安装目录（只读）镜像出启动器真正会读的那几个文件：
 *   server/autostart.js       ← 两边判定「这是仓库根」的唯一标记
 *   server/package.json       ← 版本探测的第三顺位
 *   config/server.json        ← 端口配置
 *   config/version.json       ← 版本探测的第一顺位
 *   package.json              ← 版本探测的第二顺位
 *   tools/ClientSETUP/scripts/EvEJSConfig.bat ← 客户端配置（bat 解析）
 *   server/node_modules/      ← env:check 的存在性检查（空目录占位）
 *   launcher.config.json      ← 指向自己，保证两边 deterministic 解析到同一目录
 *
 * 用法：
 *   node tests/parity/make-repo-fixture.mjs                     # 默认 ./ 输出 .parity-out/parity-repo
 *   node tests/parity/make-repo-fixture.mjs --source "E:/Games/EveJS-v0.12.8" --out .parity-out/parity-repo
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const DEFAULT_SOURCE = "E:/Games/EveJS-v0.12.8";
export const DEFAULT_FIXTURE = path.join(ROOT, ".parity-out", "parity-repo");

/** 现役安装目录里「启动器会读」的文件 → fixture 内的相对路径 */
const MIRROR = [
  ["server/autostart.js", null], // null = 生成占位内容
  ["server/package.json", "server/package.json"],
  ["package.json", "package.json"],
  ["config/server.json", "config/server.json"],
  ["config/version.json", "config/version.json"],
  ["tools/ClientSETUP/scripts/EvEJSConfig.bat", "tools/ClientSETUP/scripts/EvEJSConfig.bat"],
];
const EMPTY_DIRS = ["server/node_modules"];

const PLACEHOLDER_AUTOSTART = [
  "// parity fixture：仅作为「这是 EveJS 服务端根目录」的标记，永远不会被执行。",
  "module.exports = {};",
  "",
].join("\n");

/** 兜底内容：现役安装目录里缺某个文件时也能自洽（两边读到同样的东西即可） */
const FALLBACK = {
  "config/server.json": JSON.stringify({ port: 26000 }, null, 2) + "\n",
  "config/version.json": JSON.stringify({ evejsVersion: "0.12.8", configSchemaVersion: 1 }, null, 2) + "\n",
  "server/package.json": JSON.stringify({ name: "evejs-server", version: "0.12.8" }, null, 2) + "\n",
  "package.json": JSON.stringify({ name: "evejs", version: "0.12.8" }, null, 2) + "\n",
  "tools/ClientSETUP/scripts/EvEJSConfig.bat": [
    '@echo off',
    'set "EVEJS_REPO_ROOT=%~dp0..\\..\\.."',
    'set "EVEJS_CLIENT_PATH=%EVEJS_REPO_ROOT%\\client"',
    'set "EVEJS_CLIENT_EXE=eve.exe"',
    'set "EVEJS_CA_PEM=%EVEJS_REPO_ROOT%\\server\\certs\\ca.pem"',
    'set "EVEJS_PROXY_URL=http://127.0.0.1:26002/"',
    "",
  ].join("\r\n"),
};

export function ensureRepoFixture({ source = DEFAULT_SOURCE, out = DEFAULT_FIXTURE } = {}) {
  fs.mkdirSync(out, { recursive: true });
  const copied = [];
  const synthesized = [];
  for (const [relative, target] of MIRROR) {
    const dest = path.join(out, target ?? relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (relative === "server/autostart.js") {
      fs.writeFileSync(dest, PLACEHOLDER_AUTOSTART, "utf8");
      synthesized.push(relative);
      continue;
    }
    const src = path.join(source, relative);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      copied.push(relative);
    } else {
      fs.writeFileSync(dest, FALLBACK[relative] ?? "", "utf8");
      synthesized.push(relative);
    }
  }
  for (const dir of EMPTY_DIRS) fs.mkdirSync(path.join(out, dir), { recursive: true });
  fs.writeFileSync(path.join(out, "launcher.config.json"), JSON.stringify({ repoRoot: out }, null, 2) + "\n", "utf8");
  return { out, copied, synthesized };
}

function main() {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const result = ensureRepoFixture({
    source: value("--source", DEFAULT_SOURCE),
    out: path.resolve(ROOT, value("--out", path.relative(ROOT, DEFAULT_FIXTURE))),
  });
  console.log(`fixture 仓库根：${path.relative(ROOT, result.out)}`);
  console.log(`  镜像自现役安装目录：${result.copied.length} 个（${result.copied.join(", ")}）`);
  console.log(`  本地生成：${result.synthesized.length} 个（${result.synthesized.join(", ")}）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();