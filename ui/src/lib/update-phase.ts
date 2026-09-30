/**
 * 启动器自更新的界面状态机（纯逻辑，可单测）。
 *
 * 后端（src-tauri/src/updater.rs）的状态取值逐位对齐现役 Electron 0.1.28：
 *   idle / checking / available / downloading / ready / applying / error
 * 老版渲染层（launcher-bridge.js 的 renderUpdateModal）在 ready 那一态给的按钮是
 * 「重启并安装」——下载完成**不等于**已经装好，得再点一次才会拉起 Go 更新器。
 *
 * 2026-09-30 报障：Tauri 版把这一步丢了 —— 界面只有「立即更新」→ update:download，
 * 全仓没有任何地方调 update:apply，于是用户下完包什么都没发生，还继续提示有新版本。
 * 这里把「下载 / 待安装 / 安装中」的判据收成一处，界面与入口都照它画。
 */

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "applying"
  | "error"

const PHASES: readonly string[] = [
  "idle",
  "checking",
  "available",
  "downloading",
  "ready",
  "applying",
  "error",
]

export interface UpdatePhaseView {
  phase: UpdatePhase
  /**
   * 下载中 / 待安装 / 安装中：这段时间界面不该再给「立即更新」，
   * 也不该把弹窗画成「已是最新」。
   */
  busy: boolean
  /** 进度 0–100（安装阶段固定 100） */
  progress: number
  /** 后端给这一态配的说明（失败原因也在里面），拿不到是空串 */
  message: string
}

/** 认不出的状态一律当 idle：宁可什么都不显示，也不要瞎猜一个进度 */
export function updatePhaseView(
  state: string | undefined | null,
  percent?: number | null,
  message?: string | null
): UpdatePhaseView {
  const phase = (PHASES.includes(state ?? "") ? state : "idle") as UpdatePhase
  const raw = Number(percent ?? 0)
  const progress = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0
  return {
    phase,
    busy: phase === "downloading" || phase === "ready" || phase === "applying",
    progress: phase === "applying" ? 100 : progress,
    message: typeof message === "string" ? message : "",
  }
}

/** 自更新弹窗要画哪一种形态，逐态对齐老版的 renderUpdateModal */
export type UpdateDialogMode =
  | "checking"
  | "uptodate"
  | "download"
  | "downloading"
  | "ready"
  | "applying"
  | "failed"

export function updateDialogMode(input: {
  phase: UpdatePhase
  /** 更新通道上确实有比本机新的版本 */
  outdated: boolean
  /** 首屏那次检查还没回来（先别急着说「已是最新」） */
  pending: boolean
  /** 检查本身失败了（update:check 回了 !ok） */
  checkFailed: boolean
}): UpdateDialogMode {
  if (input.pending) return "checking"
  // 下载与安装阶段压过「有没有新版」的判断：这时候界面上必须接着报进度
  if (input.phase === "downloading") return "downloading"
  if (input.phase === "ready") return "ready"
  if (input.phase === "applying") return "applying"
  if (input.phase === "error") return "failed"
  if (input.checkFailed) return "failed"
  if (!input.outdated) return "uptodate"
  return "download"
}
