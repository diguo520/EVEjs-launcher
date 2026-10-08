import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config.ts";

/** L1（前端侧）：只跑 node 环境的纯逻辑单测。
 *
 *  为什么不把 `test` 段直接写进 vite.config.ts：那会让 `defineConfig` 从 `vitest/config` 导入，
 *  于是**生产打包也依赖一个测试包**（CI 用 `--omit=dev` 装依赖时会直接炸）。
 *  这里用 mergeConfig 复用 vite 配置里的 `@` 别名，别名仍然只有一处声明。
 *
 *  为什么不上 jsdom / @testing-library：组件的验收归 L3 端到端（真 IPC）与 U5 截图，
 *  这层只锁纯函数 —— 也正是历史上真正出过错的地方（数字格式、时间折算、相对时间分档）。
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
      reporters: ["default"],
      // 生产入口只加载当前语言；测试统一预加载所有目录，供 i18n / 日志 / 环境自检断言。
      setupFiles: ["./src/test/i18n-setup.ts"],
    },
  }),
);
