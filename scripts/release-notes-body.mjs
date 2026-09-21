#!/usr/bin/env node
/**
 * 把 release-notes/v<version>.json 渲染成 GitHub Release 的正文 —— **英文版**。
 *
 * 为什么只用英文：GitHub Release 页面是面向国外用户的门面；启动器里的更新日志才是
 * 按用户语言显示（中文用户看中文、其它语言看英文）。中文原文保留在 release-notes/*.json 里。
 *
 * 用法：
 *   node scripts/release-notes-body.mjs <version> [--out <file>] [--repo <owner/name>] [--compare-from <tag>]
 *
 * 被这两处使用：
 *   - .github/workflows/release.yml                  打 tag 自动发版时写进 Release 正文
 *   - .github/workflows/backfill-release-notes.yml   给历史版本补写 Release 正文
 */
import fs from "node:fs";
import path from "node:path";

const LABELS = { new: "New", fix: "Fixed", opt: "Improved", other: "Other" };

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const version = String(positional[0] || flags.version || "").trim().replace(/^v/i, "");
if (!version) {
  console.error("用法：node scripts/release-notes-body.mjs <version> [--out <file>] [--repo <owner/name>] [--compare-from <tag>]");
  process.exit(2);
}

const file = path.join(process.cwd(), "release-notes", "v" + version + ".json");
if (!fs.existsSync(file)) {
  console.error("找不到发布说明：" + file);
  process.exit(1);
}

const notes = JSON.parse(fs.readFileSync(file, "utf8"));
const fileVersion = String(notes.version || version).replace(/^v/i, "");
if (fileVersion !== version) {
  console.error("版本号不一致：文件里是 " + fileVersion + "，参数是 " + version);
  process.exit(1);
}

// 英文优先；老条目没有英文就退回中文原文，至少不丢信息
const enList = notes.changelog && Array.isArray(notes.changelog.en) ? notes.changelog.en : [];
const zhList = notes.changelog && Array.isArray(notes.changelog.zh) ? notes.changelog.zh : [];
const raw = enList.length ? enList : zhList;

const items = raw
  .map((it) => {
    const type = String(it && it.type ? it.type : "other").toLowerCase();
    const label = LABELS[type] || LABELS.other;
    const text = String(it && it.text ? it.text : "").trim();
    return text ? "- **" + label + "** " + text : "";
  })
  .filter(Boolean);

const out = [];
out.push("## v" + version);
out.push("");
out.push("### What's changed");
out.push("");
out.push(items.length ? items.join("\n") : "- Maintenance build");
out.push("");

const repo = typeof flags.repo === "string" ? flags.repo.trim().replace(/^\/+|\/+$/g, "") : "";
const compareFrom = typeof flags["compare-from"] === "string" ? flags["compare-from"].trim() : "";

if (repo) {
  const asset = "EvEJS-Launcher-Portable-" + version + ".exe";
  out.push("**Download:** [" + asset + "](https://github.com/" + repo + "/releases/download/v" + version + "/" + asset + ")");
  out.push("");
}
if (repo && compareFrom) {
  out.push("**Full Changelog:** [compare](https://github.com/" + repo + "/compare/" + compareFrom + "...v" + version + ")");
  out.push("");
}
out.push("> The in-launcher update dialog shows the same changelog, localized (Chinese UI shows Chinese, other languages show English).");
out.push("");

const body = out.join("\n");
const outFile = typeof flags.out === "string" ? flags.out : "";
if (outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, body, "utf8");
  console.error("wrote " + outFile + " (" + items.length + " entries)");
} else {
  process.stdout.write(body);
}