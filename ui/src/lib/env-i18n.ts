/**
 * 环境自检项的界面多语言。
 *
 * 自检项的名字与读数由 Rust 侧拼好（`src-tauri/src/env.rs`），里面既有**纯静态**文案，
 * 也有**带变量**的读数（Node 版本、安装路径）。静态的那些直接进目录、由翻译桥按文本节点
 * 翻掉；这里只管两件事：
 *   1) 去掉标签里冗余的后缀（「Node.js 运行时」→「Node.js」这类，用户 2026-09-29 要求）；
 *   2) 给**带变量**的读数套上 `t()` 模板，让它跟着语言走。
 *
 * 不改 Rust：IPC 回包是跨实现 parity 的冻结基线，动它会连累 `tests/parity` 的对拍。
 */
import { t } from "@/lib/i18n"
import type { CheckItem } from "@/lib/mock"

/** 标签后缀精简：只认 Rust 侧那几个固定标签，其余原样返回 */
const SHORT_LABEL: Record<string, string> = {
  "Node.js 运行时": "Node.js",
  "Rust / Cargo 工具链": "Rust / Cargo",
  "VS C++ 构建工具": "VS C++",
}

/** 带变量的读数：正则抓出变量 → 按 `t()` 模板回填 */
const DETAIL_RULES: { re: RegExp; key: string }[] = [
  { re: /^Node v(.+)（满足 ≥24）$/, key: "Node v{version}（满足 ≥24）" },
  { re: /^未检测到可用 Node（当前: (.+)）$/, key: "未检测到可用 Node（当前: {version}）" },
  { re: /^工具链不完整（仅检测到 (.+)）$/, key: "工具链不完整（仅检测到 {part}）" },
  { re: /^已安装：(.+)$/, key: "已安装：{path}" },
  { re: /^客户端: (.+)$/, key: "客户端: {path}" },
  { re: /^路径不存在: (.+)$/, key: "路径不存在: {path}" },
]

function localizeDetail(detail: string): string {
  for (const rule of DETAIL_RULES) {
    const hit = rule.re.exec(detail)
    if (!hit) continue
    const vars: Record<string, string> = {}
    hit.slice(1).forEach((group, index) => {
      vars[["version", "part", "path"][index] ?? `v${index}`] = group ?? ""
    })
    return t(rule.key, vars)
  }
  return detail
}

/** 一条自检项 → 当前语言的显示副本（幂等：翻过的文本不再命中规则） */
export function localizeEnvItem(item: CheckItem): CheckItem {
  const label = SHORT_LABEL[item.name]
  const detail = localizeDetail(item.detail)
  if (!label && detail === item.detail) return item
  return { ...item, name: label ?? item.name, detail }
}
