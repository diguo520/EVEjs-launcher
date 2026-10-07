/**
 * 环境自检项的界面多语言。
 *
 * 自检项的名字与读数由 Rust 侧拼好（`src-tauri/src/env.rs`），里面既有**纯静态**文案，
 * 也有**带变量**的读数（Node 版本、安装路径）。三条路都得走目录：
 *   1) 标签后缀精简（「Node.js 运行时」→「Node.js」这类，用户 2026-09-29 要求）；
 *   2) 带变量的读数按 `t()` 模板回填（2026-09-30 报障：`{path}` 原样显示出来了）；
 *   3) 名字 / 读数 / 修复指引整体翻一遍 —— 这些文本会被**拼进**别的句子（红条那句
 *      「缺少 {list}」、复制出来的报告、修复按钮的文案），拼进去的文本翻译桥看不见，
 *      只有在这里翻好才不会「法语句子里夹中文项名」（2026-10-01 报障）。
 *
 * 不改 Rust：IPC 回包是跨实现 parity 的冻结基线，动它会连累 `tests/parity` 的对拍。
 */
import { t } from "@/lib/i18n"
import type { CheckFix, CheckItem } from "@/lib/mock"

/** 标签后缀精简：只认 Rust 侧那几个固定标签，其余原样返回 */
const SHORT_LABEL: Record<string, string> = {
  "Node.js 运行时": "Node.js",
  "Rust / Cargo 工具链": "Rust / Cargo",
  "VS C++ 构建工具": "VS C++",
}

/** 带变量的读数：正则抓出变量 → 按 `t()` 模板回填 */
const DETAIL_RULES: { re: RegExp; key: string }[] = [
  { re: /^Node v(.+)（满足 ≥22）$/, key: "Node v{version}（满足 ≥22）" },
  { re: /^未检测到可用 Node（当前: (.+)）$/, key: "未检测到可用 Node（当前: {version}）" },
  { re: /^工具链不完整（仅检测到 (.+)）$/, key: "工具链不完整（仅检测到 {part}）" },
  { re: /^已安装：(.+)$/, key: "已安装：{path}" },
  { re: /^客户端: (.+)$/, key: "客户端: {path}" },
  { re: /^路径不存在: (.+)$/, key: "路径不存在: {path}" },
]

/** 目录里有条目就翻，没有就原样（`t()` 对未知文本是恒等映射，所以这一层可以随手套） */
function localizeText(text: string): string {
  if (!text) return text
  return t(text)
}

function localizeDetail(detail: string): string {
  for (const rule of DETAIL_RULES) {
    const hit = rule.re.exec(detail)
    if (!hit) continue
    // 占位符名字**从模板里现取**（`已安装：{path}` → path）。不能按捕获组下标去猜：`每条规则的组含义都不一样，早先那份 `["version","part","path"][index]` 的表只在第一条`上凑巧对，后面几条变量名全对不上，界面就把 `{part}` / `{path}` 原样显示出来了`（2026-09-30 报障：环境自检里 VS 构建工具与客户端路径两行）。
    const names = Array.from(rule.key.matchAll(/\{(\w+)\}/g), (hit) => hit[1])
    const vars: Record<string, string> = {}
    hit.slice(1).forEach((group, index) => {
      vars[names[index] ?? `v${index}`] = group ?? ""
    })
    return t(rule.key, vars)
  }
  return localizeText(detail)
}

/**
 * 修复指引：hint / okDetail / done 走目录；action 里**含项名**的那条
 * （`执行「{name}」初始化`）要用翻好的名字重拼 —— 否则按钮上会是
 * 「Exécution de «主服务器依赖»」。原型项的 action 里没有项名（「重新签发证书」），原样留着。
 */
function localizeFix(
  fix: CheckFix | undefined,
  rawName: string,
  name: string
): CheckFix | undefined {
  if (!fix) return undefined
  const action = !fix.action
    ? fix.action
    : rawName && fix.action.includes(rawName)
      ? t("执行「{name}」初始化", { name })
      : t(fix.action)
  return {
    ...fix,
    hint: localizeText(fix.hint),
    okDetail: localizeText(fix.okDetail),
    done: localizeText(fix.done),
    action,
  }
}

/** 一条自检项 → 当前语言的显示副本（幂等：翻过的文本不再命中规则） */
export function localizeEnvItem(item: CheckItem): CheckItem {
  const short = SHORT_LABEL[item.name]
  const name = localizeText(short ?? item.name)
  const detail = localizeDetail(item.detail)
  const fix = localizeFix(item.fix, item.name, name)
  return { ...item, name, detail, ...(fix ? { fix } : {}) }
}
