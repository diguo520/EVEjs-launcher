#!/usr/bin/env node
/**
 * 生成国家旗子资源：`ui/public/flags/<code>.svg` + 一份轻量索引 `ui/src/lib/flags.generated.ts`。
 *
 * 为什么不把 SVG 内联进 JS（试过，571 KB → 压到 440 KB，还是砍掉了）：
 *   启动器最在意的是**冷启动**。几百 KB 的字符串字面量进了主 bundle，等于每次开窗都要多解析一遍，
 *   而这些旗子绝大多数在当次会话里根本不会显示。放进 `ui/public/` 就变成普通静态资源：
 *   JS 里只剩一张「有哪些码」的表，真正显示哪面才去取哪个文件（浏览器自己还会缓存）。
 *
 * 数据源：flag-icons（MIT）的 `flags/4x3/*.svg`，只取下面 COUNTRY 里列的那些。
 * 想加国家就往数组里加一个码，然后重跑本脚本。
 *
 * 用法：node scripts/gen-country-flags.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "ui", "public", "flags");
const OUT_TS = path.join(ROOT, "ui", "src", "lib", "flags.generated.ts");

/** 覆盖绝大多数 EVE 玩家来源地；界面上认不出的国家会退化成地球图标，不是错误 */
const COUNTRY = [
  "cn", "tw", "hk", "jp", "kr", "sg", "my", "th", "vn", "id", "ph", "in",
  "gb", "ie", "fr", "de", "nl", "be", "lu", "at", "ch", "it", "es", "pt",
  "se", "no", "dk", "fi", "is", "pl", "cz", "sk", "hu", "ro", "bg", "gr",
  "hr", "si", "rs", "ua", "ru", "tr", "il", "sa", "ae", "za", "eg",
  "br", "ar", "cl", "co", "pe", "mx", "us", "ca", "au", "nz",
];

const MIRRORS = [
  (code) => `https://cdn.jsdelivr.net/npm/flag-icons@7/flags/4x3/${code}.svg`,
  (code) => `https://unpkg.com/flag-icons@7/flags/4x3/${code}.svg`,
];

async function fetchFlag(code) {
  const failures = [];
  for (const mirror of MIRRORS) {
    const url = mirror(code);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        failures.push(`${url} → HTTP ${response.status}`);
        continue;
      }
      const svg = (await response.text()).trim();
      if (!svg.startsWith("<svg")) {
        failures.push(`${url} → 不是 SVG`);
        continue;
      }
      return svg;
    } catch (error) {
      failures.push(`${url} → ${error?.message ?? error}`);
    }
  }
  throw new Error(`取不到 ${code} 的旗子：${failures.join("；")}`);
}

/**
 * 去掉换行与标签之间的缩进，并把坐标收到 1 位小数。
 * flag-icons 的路径精度到 6 位，而界面上这面旗子只有十几像素宽 —— 多出来的位数纯属浪费字节。
 */
function compactSvg(svg) {
  return svg
    .replace(/\s*\n\s*/g, "")
    .replace(/>\s+</g, "><")
    .replace(/(\d+)\.(\d{2,})/g, (_, whole, frac) => `${whole}.${frac[0]}`);
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const codes = [];
let bytes = 0;
for (const code of COUNTRY) {
  const svg = compactSvg(await fetchFlag(code));
  fs.writeFileSync(path.join(OUT_DIR, `${code}.svg`), svg, "utf8");
  bytes += Buffer.byteLength(svg, "utf8");
  codes.push(code.toUpperCase());
}

const lines = [
  "/* 本文件由 scripts/gen-country-flags.mjs 生成，不要手改。",
  " *",
  " * 国旗图形来自 flag-icons（MIT）：https://github.com/lipis/flag-icons",
  " * 这里只登记「有哪些码」，真正的 SVG 在 ui/public/flags/ 下按需加载 ——",
  " * 内联进 bundle 会让每次冷启动都多解析几百 KB，而这些旗子大多数会话里根本不会显示。",
  " * 清单外的国家码界面退化成地球图标，不是错误。",
  " */",
  "",
  "export const COUNTRY_FLAG_CODES: readonly string[] = [",
  ...codes.map((code) => `  "${code}",`),
  "]",
  "",
  "/** 国家码 → 资源路径；清单里没有就返回空串（调用方据此退化） */",
  "export function countryFlagUrl(code: string): string {",
  "  const upper = String(code || \"\").toUpperCase()",
  "  return COUNTRY_FLAG_CODES.includes(upper) ? `./flags/${upper.toLowerCase()}.svg` : \"\"",
  "}",
  "",
];

fs.writeFileSync(OUT_TS, lines.join("\n"), "utf8");
console.log(
  `已生成 ${codes.length} 面旗子 → ${path.relative(ROOT, OUT_DIR)}（${(bytes / 1024).toFixed(1)} KB）` +
    ` + ${path.relative(ROOT, OUT_TS)}（${(fs.statSync(OUT_TS).size / 1024).toFixed(1)} KB）`
);