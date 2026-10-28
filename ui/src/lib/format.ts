/**
 * 体积读数（B2，2026-10-29）。
 *
 * 为什么不是一个函数就完事：这不是「复制粘贴」，是**同一概念的多套口径**，各有各的理由 ——
 *
 *   · 0 该写「0 B」还是「—」：`mod-logic` 是下载进度（从 0 起步，画破折号像坏了），
 *     `mock` 是装机包体积（0 视为未知，不能编一个 0.0 出来）；
 *   · MB↔KB 的切换点：`mock` 在 **0.1 MB** 就切 KB（2026-10-16 报障：不足 0.1 MB 按 MB 四舍五入
 *     会写成「0.0 MB」，28 个模组里 22 个读数不对），其余三处在 1 MB 切；
 *   · 字节档：`mod-logic` 四舍五入，存档日志与静态数据页按原样打印；
 *   · KB 档：多数在 ≥100 时取整，静态数据页永远取整（`toFixed(0)`）；
 *   · 非有限数：`mod-logic`/`mock` 兜底画破折号；存档日志与静态数据页**不兜底**，但两者原本也不一样 ——
 *     存档日志旧行为是 `NaN MB`（走 MB 档），静态数据页是 `NaN B`（走字节档）→ 所以默认「非有限数走字节档」，
 *     存档日志用 `nanAsMaxUnit: true` 回到 MB 档（2026-10-29 复核发现的偏差，见下面 `allowBytes`/`nanAsMaxUnit`）。
 *
 * 所以合并的口径是「一个实现 + 显式选项」，**每个默认值都对齐某个调用方原来的行为**；
 * 谁要改口径就在自己那一行改，不会顺手把别处的读数改掉。
 *
 * 2026-10-29 复核修正（B2 的两处越界偏差，已按「保留原行为」补齐）：
 *   · `allowBytes: false`：`mock` 的 KB 档**不设下限** —— 不足 1 KiB 的包原本写 `0.9 KB`，
 *     默认实现会掉到字节档写 `943.7184 B`；
 *   · `nanAsMaxUnit: true`：存档日志的非数值输入原本走 MB 档写 `NaN MB`。
 */

export interface FormatBytesOptions {
  /** 输入量纲（默认 B）：把「已经是 MB 的数」直接喂进来时用 "MB" */
  input?: "B" | "MB"
  /** 能显示到的最大档位（默认 MB；给 "GB" 才会往 GB 折） */
  maxUnit?: "MB" | "GB"
  /** 非有限数 / 负数怎么写；**null = 不兜底**（存档日志与静态数据页原来就是这样） */
  invalid?: string | null
  /** 0 也当无效（默认 false：0 照实写「0 B」） */
  dashZero?: boolean
  /** 小于 1024 B 时四舍五入（默认 false：原样打印） */
  roundBytes?: boolean
  /** KB 档在 ≥100 时取整（默认 true；静态数据页是永远取整） */
  kbRoundAbove100?: boolean
  /** 低于这个 MB 数就改用 KB 读（默认 1；`mock` 是 0.1，见上面的报障） */
  kbBelowMB?: number
  /** 允许退到字节档（默认 true）。`mock` 是 false：它连不足 1 KiB 的包也按 KB 读（原本写 `0.9 KB`） */
  allowBytes?: boolean
  /** 非有限数走最大档位（默认 false）。存档日志是 true：原本 NaN 输入写 `NaN MB` */
  nanAsMaxUnit?: boolean
  kbDigits?: number
  mbDigits?: number
  gbDigits?: number
}

export function formatBytes(value: number, options: FormatBytesOptions = {}): string {
  const {
    input = "B",
    maxUnit = "MB",
    invalid = "—",
    dashZero = false,
    roundBytes = false,
    kbRoundAbove100 = true,
    kbBelowMB = 1,
    allowBytes = true,
    nanAsMaxUnit = false,
    kbDigits = 1,
    mbDigits = 1,
    gbDigits = 2,
  } = options

  const bytes = input === "MB" ? value * 1024 * 1024 : value
  if (invalid !== null && (!Number.isFinite(bytes) || bytes < 0 || (dashZero && bytes === 0))) {
    return invalid
  }

  const kb = bytes / 1024
  const mb = kb / 1024
  // 复核修正：非数值且要「走最大档位」的调用方（存档日志原来写的是 NaN MB 而不是 NaN B）
  if (nanAsMaxUnit && !Number.isFinite(mb)) return `${mb.toFixed(mbDigits)} MB`
  if (maxUnit === "GB" && mb >= 1024) return `${(mb / 1024).toFixed(gbDigits)} GB`
  if (mb >= kbBelowMB) return `${mb.toFixed(mbDigits)} MB`
  if (kb >= 1 || !allowBytes) {
    const digits = kbRoundAbove100 && kb >= 100 ? 0 : kbDigits
    return `${kbRoundAbove100 && kb >= 100 ? Math.round(kb) : kb.toFixed(digits)} KB`
  }
  return `${roundBytes ? Math.round(bytes) : bytes} B`
}

/** 字节 → MB（保留 1 位小数）：`database-page` 那张表要的是数字、不是文案 */
export function toMB(bytes: number | undefined): number {
  if (!bytes || bytes <= 0) return 0
  return Math.round((bytes / (1024 * 1024)) * 10) / 10
}
