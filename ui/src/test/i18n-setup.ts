import { beforeAll } from "vitest"

import { loadCatalog } from "@/lib/i18n"

/**
 * 生产入口只加载当前语言；测试环境需要验证所有目录，所以统一在这里预加载 7 种外文。
 * 这样各测试文件仍按真实懒加载 API 调用，不会为了让测试通过退回静态全量 import。
 */
beforeAll(async () => {
  await Promise.all(
    (["en", "ja", "ko", "fr", "de", "nl", "ru"] as const).map(loadCatalog)
  )
})
