import { describe, expect, it } from "vitest"

import {
  UPDATE_FIRST_CHECK_MS,
  UPDATE_FOCUS_MIN_INTERVAL_MS,
  UPDATE_INTERVAL_MS,
  isSelfTestSession,
  startUpdateWatch,
  type UpdateWatchEnv,
} from "@/lib/update-watch"

/**
 * 假时钟：只记「排了什么、什么时候排」，由测试自己推进时间。
 *
 * 不依赖 vi.useFakeTimers —— 排班逻辑本来就是纯的，注入环境比接管全局更直白，
 * 也不会因为测试并行跑而互相干扰。
 */
function fakeEnv(startAt = 0) {
  let now = startAt
  let checks = 0
  let seq = 0
  const timeouts = new Map<number, { run: () => void; ms: number }>()
  const intervals = new Map<number, { run: () => void; ms: number }>()
  const focusHandlers: Array<() => void> = []

  const env: UpdateWatchEnv = {
    check: () => {
      checks += 1
    },
    now: () => now,
    setTimeout: (run, ms) => {
      const handle = ++seq
      timeouts.set(handle, { run, ms })
      return handle
    },
    clearTimeout: (handle) => {
      timeouts.delete(handle)
    },
    setInterval: (run, ms) => {
      const handle = ++seq
      intervals.set(handle, { run, ms })
      return handle
    },
    clearInterval: (handle) => {
      intervals.delete(handle)
    },
    addFocusListener: (fn) => {
      focusHandlers.push(fn)
    },
    removeFocusListener: (fn) => {
      const index = focusHandlers.indexOf(fn)
      if (index >= 0) focusHandlers.splice(index, 1)
    },
  }

  return {
    env,
    get checks() {
      return checks
    },
    get timeouts() {
      return [...timeouts.values()]
    },
    get intervals() {
      return [...intervals.values()]
    },
    get focusHandlerCount() {
      return focusHandlers.length
    },
    advance(ms: number) {
      now += ms
    },
    fireFirstTimeout() {
      const entry = [...timeouts.entries()][0]
      if (!entry) throw new Error("没有排定的首次检查")
      timeouts.delete(entry[0])
      entry[1].run()
    },
    fireInterval() {
      for (const entry of [...intervals.values()]) entry.run()
    },
    fireFocus() {
      for (const fn of [...focusHandlers]) fn()
    },
  }
}

describe("更新检查排班", () => {
  it("开机不当场查，到点（5 秒）才查一次", () => {
    const clock = fakeEnv()
    startUpdateWatch(clock.env)

    expect(clock.checks).toBe(0)
    expect(clock.timeouts.map((item) => item.ms)).toEqual([UPDATE_FIRST_CHECK_MS])
    clock.fireFirstTimeout()
    expect(clock.checks).toBe(1)
  })

  it("之后每 30 分钟复查一次", () => {
    const clock = fakeEnv()
    startUpdateWatch(clock.env)

    expect(clock.intervals.map((item) => item.ms)).toEqual([UPDATE_INTERVAL_MS])
    clock.fireInterval()
    clock.fireInterval()
    expect(clock.checks).toBe(2)
  })

  it("窗口重新聚焦会补查，但 5 分钟内不重复", () => {
    const clock = fakeEnv()
    startUpdateWatch(clock.env)

    // 刚开机就聚焦：手上这一次还没查过，节流按开机时刻算，不查
    clock.fireFocus()
    expect(clock.checks).toBe(0)

    // 4 分钟后再聚焦：仍在 5 分钟节流窗口内
    clock.advance(4 * 60 * 1000)
    clock.fireFocus()
    expect(clock.checks).toBe(0)

    // 过了 5 分钟：放行
    clock.advance(2 * 60 * 1000)
    clock.fireFocus()
    expect(clock.checks).toBe(1)
  })

  it("节流基准跟着每一次真查刷新：定时刚查过，紧接着聚焦不再查", () => {
    const clock = fakeEnv()
    startUpdateWatch(clock.env)

    clock.advance(UPDATE_FOCUS_MIN_INTERVAL_MS + 1)
    clock.fireInterval()
    expect(clock.checks).toBe(1)

    clock.advance(UPDATE_FOCUS_MIN_INTERVAL_MS - 1)
    clock.fireFocus()
    expect(clock.checks).toBe(1)

    clock.advance(2)
    clock.fireFocus()
    expect(clock.checks).toBe(2)
  })

  it("停止后三条线全部撤掉，不再有任何检查", () => {
    const clock = fakeEnv()
    const stop = startUpdateWatch(clock.env)
    stop()

    expect(clock.timeouts).toEqual([])
    expect(clock.intervals).toEqual([])
    expect(clock.focusHandlerCount).toBe(0)
    expect(clock.checks).toBe(0)
  })

  it("自检 / 冒烟进程的标记认得出来（宿主只在 --self-test 下打）", () => {
    expect(isSelfTestSession({})).toBe(false)
    expect(isSelfTestSession({ __EVEJS_SELF_TEST__: false })).toBe(false)
    // 只有严格 true 才算：宿主注入的是布尔字面量，别的值一律当没有标记
    expect(isSelfTestSession({ __EVEJS_SELF_TEST__: "true" })).toBe(false)
    expect(isSelfTestSession({ __EVEJS_SELF_TEST__: true })).toBe(true)
  })
})
