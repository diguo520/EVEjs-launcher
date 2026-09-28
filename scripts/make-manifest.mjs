#!/usr/bin/env node
/**
 * 生成 `update-manifest.json`（S4 / A1）：sha256 + 平台 + 体积 + **这一版的更新说明**。
 *
 * 字段名必须与 Rust 侧读取口径一致（`src-tauri/src/updater.rs`：
 * `platforms[<key>].url` / `.sha256` / `.size`，key 见 `platform_keys()`）。
 * 其余字段与现役 Electron 0.1.28 的清单同形（schemaVersion / channel /
 * minimumVersion / publishedAt / changelog），两代启动器读的是同一套结构：
 *   - `changelog` 是 `{ zh: [{ type, text }], en: [...] }`，`type` 只能是
 *     `new` / `fix` / `opt`（见 AGENTS.md「更新日志格式」）；
 *     自更新弹窗按 type 分组渲染（新增 / 优化 / 修复），所以**必须**带上它，
 *     否则用户只看到「有新版本」却不知道改了什么。
 * **本脚本只生成未签名清单**；签名交给 `scripts/gen-update-key.mjs --sign`（私钥只进 CI Secret）。
 *
 * 用法：
 *   node scripts/make-manifest.mjs --asset artifacts/EvEJSLauncher.exe \
 *     --url-base https://github.com/diguo520/EVEjs-launcher/releases/download/v0.2.0 \
 *     --out artifacts/update-manifest.json
 *
 * `--changelog` 省略时自动读 `release-notes/v<version>.json`；读不到就不写 changelog 键。
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

/** 分发包本体：单文件便携版 exe（自更新器会用它替换旧 exe）。`--zip` 是旧参数名，保留兼容。 */
const ASSET = value("--asset", value("--zip"));
if (!ASSET || !fs.existsSync(ASSET)) {
  console.error("用法：node scripts/make-manifest.mjs --asset <便携版 exe> [--url-base <前缀>] [--changelog <json>] [--out <json>]");
  process.exit(2);
}
const version = value("--version", JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
const fileName = path.basename(ASSET);
const urlBase = (value("--url-base", "https://github.com/diguo520/EVEjs-launcher/releases/download/v" + version)).replace(/\/+$/, "");
const OUT = value("--out", path.join(ROOT, "artifacts", "update-manifest.json"));
const channel = value("--channel", "stable");
const minimumVersion = value("--min-version", "");
const assetType = value("--asset-type", "portable-exe");

/** 更新说明：显式指定优先，否则用 release-notes/v<version>.json */
const notesFile = value("--changelog", path.join(ROOT, "release-notes", "v" + version + ".json"));
let changelog = null;
if (fs.existsSync(notesFile)) {
  const parsed = JSON.parse(fs.readFileSync(notesFile, "utf8"));
  const source = parsed.changelog ?? parsed;
  const pick = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((item) => item && typeof item.text === "string" && item.text.trim())
      .map((item) => ({ type: item.type, text: item.text }));
  const zh = pick(source.zh);
  const en = pick(source.en);
  if (zh.length === 0 && en.length === 0) {
    console.error("更新说明为空，已中止：" + path.relative(ROOT, notesFile));
    process.exit(2);
  }
  const bad = [...zh, ...en].find((item) => !["new", "fix", "opt"].includes(item.type));
  if (bad) {
    console.error("更新说明的 type 只能是 new / fix / opt，发现：" + bad.type);
    process.exit(2);
  }
  changelog = { zh, en };
}
else if (value("--changelog")) {
  console.error("找不到更新说明文件：" + notesFile);
  process.exit(2);
}

const bytes = fs.readFileSync(ASSET);
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
const manifest = {
  schemaVersion: 1,
  channel,
  version,
  ...(minimumVersion ? { minimumVersion } : {}),
  publishedAt: new Date().toISOString(),
  ...(changelog ? { changelog } : {}),
  platforms: {
    "win32-x64": {
      type: assetType,
      url: urlBase + "/" + fileName,
      sha256,
      size: bytes.length,
    },
  },
  notes: {
    "zh-CN": value("--notes-zh", "EvEJS 启动器 " + version + "（Tauri 2 便携版）"),
    en: value("--notes-en", "EvEJS Launcher " + version + " (Tauri 2 portable)"),
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log("已生成 " + path.relative(ROOT, OUT));
console.log("  version=" + version + "  asset=" + fileName + "  size=" + bytes.length + "  sha256=" + sha256);
console.log(
  changelog
    ? "  changelog: zh " + changelog.zh.length + " 条 / en " + changelog.en.length + " 条（来自 " + path.relative(ROOT, notesFile) + "）"
    : "  changelog: 无（没有 release-notes/v" + version + ".json）"
);
console.log("  下一步（发布）：node scripts/gen-update-key.mjs --sign <上面这个文件> --key <私钥.pem> --key-id <id>");
