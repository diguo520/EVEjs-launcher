#!/usr/bin/env node
/**
 * 生成 `update-manifest.json`（S4 / A1）：sha256 + 平台 + 体积。
 *
 * 字段名必须与 Rust 侧读取口径一致（`src-tauri/src/updater.rs`：
 * `platforms[<key>].url` / `.sha256` / `.size`，key 见 `platform_keys()`）。
 * **本脚本只生成未签名清单**；签名交给 `scripts/gen-update-key.mjs --sign`（私钥只进 CI Secret）。
 *
 * 用法：
 *   node scripts/make-manifest.mjs --zip artifacts/EvEJSLauncher-Tauri-0.2.0-portable.zip \
 *     --url-base https://github.com/diguo520/EVEjs-launcher/releases/download/v0.2.0 \
 *     --notes-zh "..." --notes-en "..." --out artifacts/update-manifest.json
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const value = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const ZIP = value("--zip");
if (!ZIP || !fs.existsSync(ZIP)) {
  console.error("用法：node scripts/make-manifest.mjs --zip <便携版 zip> [--url-base <前缀>] [--out <json>]");
  process.exit(2);
}
const version = value("--version", JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
const fileName = path.basename(ZIP);
const urlBase = (value("--url-base", `https://github.com/diguo520/EVEjs-launcher/releases/download/v${version}`)).replace(/\/+$/, "");
const OUT = value("--out", path.join(ROOT, "artifacts", "update-manifest.json"));

const bytes = fs.readFileSync(ZIP);
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
const manifest = {
  version,
  platforms: {
    "win32-x64": {
      url: `${urlBase}/${fileName}`,
      sha256,
      size: bytes.length,
    },
  },
  notes: {
    "zh-CN": value("--notes-zh", `EvEJS 启动器 ${version}（Tauri 2 便携版）`),
    en: value("--notes-en", `EvEJS Launcher ${version} (Tauri 2 portable)`),
  },
  publishedAt: new Date().toISOString(),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`已生成 ${path.relative(ROOT, OUT)}`);
console.log(`  version=${version}  size=${bytes.length}  sha256=${sha256}`);
console.log("  下一步（发布）：node scripts/gen-update-key.mjs --sign <上面这个文件> --key <私钥.pem> --key-id <id>");