// 一次性工具：从现役版 modScaffold.ts 里抽取 loader.js 骨架，生成 Rust 常量文件。
//
// 为什么需要它：骨架是 100+ 行 JS（进程身份校验 / require.cache 等待 / unref），
// 手抄一定会出错，而它又是「模组能不能生效」的关键。这里直接 eval 源文件里的
// 字符串数组，保证两边逐字节一致。
//
// 用法：node scripts/extract-loader-skeleton.mjs [源文件路径] [输出路径]
import * as fs from "node:fs";
import * as path from "node:path";

const source =
  process.argv[2] ??
  "E:\\Games\\EveJS-v0.12.8\\launcher\\launcher\\src\\main\\modScaffold.ts";
const target =
  process.argv[3] ??
  path.join(process.cwd(), "src-tauri", "src", "mods", "scaffold_loader.rs");

const src = fs.readFileSync(source, "utf8").replace(/\r\n/g, "\n").split("\n");
/** 取 1-based 闭区间 */
const take = (from, to) => src.slice(from - 1, to);
/** 把 TS 里 `    "xxx",` 的数组字面量元素还原成 JS 数组 */
const evalArray = (lines) => {
  const body = lines
    .map((line) => (line.startsWith("    ") ? line.slice(4) : line))
    .join("\n");
  // eslint-disable-next-line no-eval
  return eval(`[${body}]`);
};

const draft = { id: "@ID@", displayName: "@DISPLAY_NAME@" };
const tag = "[@ID@]"; // 源里 loaderFrom 用的局部变量，eval 时要在作用域里可见
const biz = "@__BIZ__@"; // 占位：wrapper 里 `biz,` 那一行
const broadcast = evalArray(take(171, 229));
const blank = evalArray(take(162, 168));

// 源里 `biz,` 这一行被 eval 成 undefined，正好当插入哨兵
const wrapper = evalArray(take(233, 336));
const sentinel = wrapper.findIndex((line) => line === "@__BIZ__@");
if (sentinel < 0) throw new Error("没在 wrapper 里找到 biz 插入点");
const head = wrapper.slice(0, sentinel);
const tail = wrapper.slice(sentinel + 1);

const esc = (text) =>
  text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t");
const block = (name, doc, lines) =>
  `${doc}pub const ${name}: &[&str] = &[\n` +
  lines.map((line) => `    "${esc(String(line))}",`).join("\n") +
  "\n];\n";

const out = [
  "//! `loader.js` 骨架文本：从现役版 `modScaffold.ts::loaderFrom` 自动抽取，逐字节一致。",
  "//!",
  "//! 生成方式（一次性，改了现役版骨架才需要重跑）：",
  "//!   `node scripts/extract-loader-skeleton.mjs`",
  "//!",
  "//! 为什么单独一个文件：骨架 100+ 行 JS，混在 `scaffold.rs` 里会把业务逻辑淹掉。",
  "//! `@ID@` / `@DISPLAY_NAME@` 是占位符，由 `scaffold.rs` 按 draft 替换。",
  "",
  "/// 骨架前半（`biz` 之前）",
  block("LOADER_HEAD", "", head),
  "/// `template.id == \"blank\"` 的业务钩子",
  block("LOADER_BIZ_BLANK", "", blank),
  "/// 默认（broadcast）的业务钩子",
  block("LOADER_BIZ_BROADCAST", "", broadcast),
  "/// 骨架后半（`biz` 之后）",
  block("LOADER_TAIL", "", tail),
].join("\n");

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out.replace(/\n\n+/g, "\n\n").trimStart(), "utf8");
console.log(
  `已写出 ${target}：head=${head.length} blank=${blank.length} broadcast=${broadcast.length} tail=${tail.length}`
);