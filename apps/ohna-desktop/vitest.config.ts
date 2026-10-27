import { defineConfig } from "vitest/config";

/**
 * 渲染进程单测配置：jsdom 环境 + 既有 setup（主题/字号 localStorage、matchMedia 兜底）。
 * 仅覆盖 `src/renderer/**` 下的 `*.test.{ts,tsx}`，node --test 的 `test/*.test.mjs`
 * 由 `pnpm test` 单独跑（从 `dist/` 加载纯 Node 构建产物，不进 vitest）。
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/renderer/test/setup.ts"],
    include: ["src/renderer/**/*.test.{ts,tsx}"]
  }
});
