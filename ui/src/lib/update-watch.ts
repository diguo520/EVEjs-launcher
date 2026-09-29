/**
 * 启动器自更新的自动检查节奏。
 *
 * 口径对齐现役 Electron 0.1.28（`launcher-bridge.js` 的 `checkUpdateNotice`）：
 *   · 开机 5 秒后先查一次（避开首屏握手，也不至于晚到用户看不见）
 *   · 之后每 30 分钟复查一次
 *   · 窗口重新获得焦点时补查一次，但 5 分钟内不重复查
 *
 * 只负责「什么时候查」这一件事：查完怎么落到界面上（要不要亮更新入口、要不要提示）
 * 由调用方决定。与 React 无关，注入时钟与定时器，方便用假时钟单独验证。
 */

/** 开机后第一次检查的延时 */
export const UPDATE_FIRST_CHECK_MS = 5_000
/** 定时复查间隔（与老版一致） */
export const UPDATE_INTERVAL_MS = 30 * 60 * 1000
/** 窗口重新聚焦时最多多久查一次：来回切窗口不该刷请求 */
export const UPDATE_FOCUS_MIN_INTERVAL_MS = 5 * 60 * 1000

/**
 * 自检进程的标记名：宿主在 `--self-test` 下用初始化脚本打上（见 src-tauri/src/lib.rs），
 * 生产运行时这个全局根本不存在。
 */
export const SELF_TEST_FLAG = "__EVEJS_SELF_TEST__"

/**
 * 当前是不是自检 / 冒烟进程。
 *
 * 那是无人值守的诊断跑：界面里任何后台网络动作都会真去打 GitHub，还会把瞬时状态
 * （`update:state` 的 checking）留给冻结基线，让同一份二进制两次跑出不同结果。
 * 所以见到这个标记就不排后台检查。
 */
export function isSelfTestSession(
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
): boolean {
  return scope[SELF_TEST_FLAG] === true
}

/** 排班要用到的那点环境：时钟、定时器、聚焦事件（测试里换成假的） */
export interface UpdateWatchEnv {
  /** 真去查一次；结果由调用方自己收，这里不看 */
  check: () => void
  /** 当前时间戳（毫秒） */
  now: () => number
  setTimeout: (fn: () => void, ms: number) => number
  clearTimeout: (handle: number) => void
  setInterval: (fn: () => void, ms: number) => number
  clearInterval: (handle: number) => void
  addFocusListener: (fn: () => void) => void
  removeFocusListener: (fn: () => void) => void
}

/**
 * 排一次班：第一次延时 → 定时复查 → 聚焦补查（带节流）。
 *
 * 返回停止函数，把三条线全部撤干净（effect 卸载时调用）。
 * 节流的基准时间在每次真查之后刷新，所以「计时器刚查过」紧接着的聚焦
 * 不会立刻再查一遍。
 */
export function startUpdateWatch(env: UpdateWatchEnv): () => void {
  let lastAt = env.now()

  const run = () => {
    lastAt = env.now()
    env.check()
  }

  const first = env.setTimeout(run, UPDATE_FIRST_CHECK_MS)
  const interval = env.setInterval(run, UPDATE_INTERVAL_MS)
  const onFocus = () => {
    if (env.now() - lastAt < UPDATE_FOCUS_MIN_INTERVAL_MS) return
    run()
  }
  env.addFocusListener(onFocus)

  return () => {
    env.clearTimeout(first)
    env.clearInterval(interval)
    env.removeFocusListener(onFocus)
  }
}
