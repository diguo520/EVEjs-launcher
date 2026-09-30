import { describe, expect, it } from "vitest"

import { updateDialogMode, updatePhaseView } from "@/lib/update-phase"

/**
 * 2026-09-30 报障：界面只调 update:download、从不调 update:apply —— 用户下完包
 * 什么都没发生，还继续提示有新版本。这一组用例钉住「下载完 → 待安装 → 安装中」
 * 这条链上的判据（对齐现役 Electron 0.1.28 的 renderUpdateModal）。
 */
describe("updatePhaseView", () => {
  it("后端各态原样认出来，认不出的当 idle", () => {
    for (const phase of [
      "idle",
      "checking",
      "available",
      "downloading",
      "ready",
      "applying",
      "error",
    ] as const) {
      expect(updatePhaseView(phase).phase).toBe(phase)
    }
    expect(updatePhaseView(undefined).phase).toBe("idle")
    expect(updatePhaseView("").phase).toBe("idle")
    // 老版渲染层的显示态名（uptodate / installing）不是后端态，不能当成 downloading 之类
    expect(updatePhaseView("uptodate").phase).toBe("idle")
    expect(updatePhaseView("installing").phase).toBe("idle")
  })

  it("下载中 / 待安装 / 安装中都算「忙」：界面不许再给「立即更新」", () => {
    expect(updatePhaseView("downloading").busy).toBe(true)
    expect(updatePhaseView("ready").busy).toBe(true)
    expect(updatePhaseView("applying").busy).toBe(true)
    expect(updatePhaseView("available").busy).toBe(false)
    expect(updatePhaseView("idle").busy).toBe(false)
    expect(updatePhaseView("error").busy).toBe(false)
  })

  it("进度取值收在 0–100，安装阶段固定 100", () => {
    expect(updatePhaseView("downloading", 42.5).progress).toBe(42.5)
    expect(updatePhaseView("downloading", -5).progress).toBe(0)
    expect(updatePhaseView("downloading", 250).progress).toBe(100)
    expect(updatePhaseView("downloading", Number.NaN).progress).toBe(0)
    expect(updatePhaseView("ready").progress).toBe(0)
    expect(updatePhaseView("ready", 100).progress).toBe(100)
    expect(updatePhaseView("applying", 12).progress).toBe(100)
  })

  it("说明取后端的 message，拿不到就是空串", () => {
    expect(updatePhaseView("error", 0, "更新包 SHA256 校验失败").message).toBe(
      "更新包 SHA256 校验失败"
    )
    expect(updatePhaseView("idle").message).toBe("")
    expect(updatePhaseView("idle", 0, null).message).toBe("")
  })
})

describe("updateDialogMode", () => {
  const base = { phase: "available", outdated: true, pending: false, checkFailed: false } as const

  it("首屏还没查完 → checking（不许先说「已是最新」）", () => {
    expect(updateDialogMode({ ...base, pending: true })).toBe("checking")
  })

  it("有新版 → download（这一步给「立即更新」，只下载）", () => {
    expect(updateDialogMode(base)).toBe("download")
  })

  it("下载完成 → ready：弹窗必须换成「重启并安装」，这是以前丢掉的那一步", () => {
    expect(updateDialogMode({ ...base, phase: "ready" })).toBe("ready")
  })

  it("安装阶段压过版本判断：下载 / 待安装 / 安装中都要继续报进度", () => {
    expect(updateDialogMode({ ...base, phase: "downloading" })).toBe("downloading")
    expect(updateDialogMode({ ...base, phase: "applying" })).toBe("applying")
    // 就算检查结果说「没有新版」（例如装完还没重启），也照样画进度
    expect(updateDialogMode({ ...base, phase: "applying", outdated: false })).toBe("applying")
    expect(updateDialogMode({ ...base, phase: "ready", outdated: false })).toBe("ready")
  })

  it("更新器报错 → failed，不让用户再点一次「立即更新」却什么都不知道", () => {
    expect(updateDialogMode({ ...base, phase: "error" })).toBe("failed")
    expect(updateDialogMode({ ...base, checkFailed: true })).toBe("failed")
  })

  it("没有新版 → uptodate", () => {
    expect(updateDialogMode({ ...base, outdated: false })).toBe("uptodate")
    expect(updateDialogMode({ ...base, outdated: false, phase: "idle" })).toBe("uptodate")
  })
})
