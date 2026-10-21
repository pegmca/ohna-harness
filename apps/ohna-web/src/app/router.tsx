import { createBrowserRouter } from "react-router-dom";

/**
 * 应用路由以 lazy feature 为代码分割边界；后续工作区可独立增加 loader/action。
 *
 * 路由面刻意保持极小：
 * - `/` → 对话工作台（Trace 已是其右侧抽屉，不再是独立路由，03 D6 阻断性删除 `/trace`）；
 * - `/settings` → 设置页（本地只读信息 + UI 偏好，03 L3）；
 * - `*` → 对话工作台兜底（含已删除的 `/trace` 深链：直接落到工作台，不做重定向）。
 */
export const router = createBrowserRouter([
  {
    path: "/settings",
    lazy: async () => {
      const module = await import("../features/settings/SettingsPage");
      return { Component: module.SettingsPage };
    }
  },
  {
    path: "*",
    lazy: async () => {
      const module = await import("../features/workbench/Workbench");
      return { Component: module.Workbench };
    }
  }
]);
