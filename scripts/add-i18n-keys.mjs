#!/usr/bin/env node
/**
 * 往 7 个语言目录里补新键（中文是源语言，不建目录）。
 *
 * 为什么要有这个脚本：`ui/src/lib/i18n.test.ts` 要求 en/ja/ko/fr/de/nl/ru 的**键集完全一致**，
 * 少一条就回退中文；而目录文件是 CRLF + 手工编排顺序，用 `JSON.stringify` 整份重写
 * 会把 3000 多行的行尾与排版全部翻新（一次性 churn 整个文件）。这里改用**行级插入**：
 * 只在末尾 `}` 之前追加，保留原有每一行的字节。
 *
 * 用法：
 *   node scripts/add-i18n-keys.mjs payload.json          # 补键
 *   node scripts/add-i18n-keys.mjs payload.json --check  # 只报告缺哪些，不写
 *
 * payload.json 形状（每条必须给全 7 种语言，缺一个就中止 —— 不允许半成品进仓）：
 *   {
 *     "伊甸币商城": { "en": "PLEX Store", "ja": "…", "ko": "…", "fr": "…", "de": "…", "nl": "…", "ru": "…" }
 *   }
 */
import fs from "node:fs";
import path from "node:path";

const LOCALES = ["en", "ja", "ko", "fr", "de", "nl", "ru"];
const LOCALES_DIR = path.resolve(import.meta.dirname, "..", "ui", "src", "locales");

const payloadPath = process.argv[2];
const CHECK_ONLY = process.argv.includes("--check");
if (!payloadPath) {
  console.error("用法：node scripts/add-i18n-keys.mjs <payload.json> [--check]");
  process.exit(2);
}

const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
const keys = Object.keys(payload);
if (keys.length === 0) {
  console.error("payload 里没有任何键");
  process.exit(2);
}

// 先做完整性检查：宁可一条不写，也不要出现「某几种语言缺这条」
const gaps = [];
for (const key of keys) {
  for (const code of LOCALES) {
    const value = payload[key]?.[code];
    if (typeof value !== "string" || value.trim() === "") gaps.push(`${code} · ${key}`);
  }
}
if (gaps.length > 0) {
  console.error("这些键缺翻译，已中止（不允许半成品进仓）：");
  for (const gap of gaps) console.error("  - " + gap);
  process.exit(1);
}

/** 已存在的键不重复插；返回本次真正要追加的那些（保持 payload 顺序） */
function todoFor(entries, existing) {
  return keys.filter((key) => !existing.has(key) && entries[key] !== undefined);
}

let totalAdded = 0;
const report = [];

for (const code of LOCALES) {
  const file = path.join(LOCALES_DIR, code + ".json");
  const raw = fs.readFileSync(file, "utf8");
  const existing = new Set(Object.keys(JSON.parse(raw)));
  const todo = todoFor(payload, existing);
  if (todo.length === 0) {
    report.push(`${code}: 已是最新`);
    continue;
  }
  if (CHECK_ONLY) {
    report.push(`${code}: 缺 ${todo.length} 条`);
    totalAdded += todo.length;
    continue;
  }

  // 末尾结构固定为 `  "最后一条": "…"` + CRLF + `}` + CRLF
  const marker = "\r\n}\r\n";
  const index = raw.lastIndexOf(marker);
  if (index < 0) {
    console.error(`${code}.json 末尾结构不是预期的 CRLF + } —— 拒绝改动，请人工确认`);
    process.exit(1);
  }
  // 每条一行；行间用 ",\r\n" 连接（最后一条不带逗号，紧跟末尾的 `}`）。
  // 开头那个 "," 是补在**原来最后一条**后面的 —— 它本身没有尾逗号。
  const lines = todo.map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(payload[key][code])}`);
  const next = raw.slice(0, index) + ",\r\n" + lines.join(",\r\n") + raw.slice(index);

  // 写回前先自证：能解析、键变多了、原有键一个没少、行尾仍是 CRLF
  const before = JSON.parse(raw);
  const after = JSON.parse(next);
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  if (afterKeys.length !== beforeKeys.length + todo.length) {
    console.error(`${code}.json 校验失败：键数不对，未写入`);
    process.exit(1);
  }
  for (const key of beforeKeys) {
    if (after[key] !== before[key]) {
      console.error(`${code}.json 校验失败：原有键 ${key} 被改动，未写入`);
      process.exit(1);
    }
  }
  // 行尾结构必须与原文一致：既不能多出裸 LF，也不能丢掉结尾的 CRLF
  const bareLf = (text) => (text.replace(/\r\n/g, "").match(/\n/g) ?? []).length;
  if (bareLf(next) !== bareLf(raw) || !next.endsWith("\r\n")) {
    console.error(`${code}.json 校验失败：行尾结构与原文不一致，未写入`);
    process.exit(1);
  }

  fs.writeFileSync(file, next, "utf8");
  totalAdded += todo.length;
  report.push(`${code}: +${todo.length}`);
}

for (const line of report) console.log("  " + line);
if (CHECK_ONLY) {
  console.log(`  缺 ${totalAdded} 条（每种语言各 ${keys.length} 条以内）`);
} else {
  console.log(`  已写入 ${totalAdded} 条`);
}
