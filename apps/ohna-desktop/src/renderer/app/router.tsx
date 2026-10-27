import { createHashRouter } from "react-router-dom";

/**
 * 应用路由以 lazy feature 为代码分割边界；后续工作区可独立增加 loader/action。
 *
 * 路由面刻意保持极小，只有一个入口：
 * 桌面端无 HTTP server：用 hash 路由（`createHashRouter`）承载唯一的 `*` 兜底，
 * 避免浏览器对 file:// 加载的页面发起 history API 的同源改写。
 * Trace 是 chat 页右侧抽屉（03 D6 删除了 `/trace`），
 *   设置是 chat 页内就地弹窗（docs/v1.4/05 FR-001 删除了 `/settings`），
 *   因此已删除的深链（含旧的 `/settings`）都直接落到工作台，不做重定向。
 */
export const router = createHashRouter([
  {
    path: "*",
    lazy: async () => {
      const module = await import("../features/workbench/Workbench");
      return { Component: module.Workbench };
    }
  }
]);
