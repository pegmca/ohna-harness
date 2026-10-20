import { createBrowserRouter } from "react-router-dom";

/**
 * 应用路由以 lazy feature 为代码分割边界；后续工作区可独立增加 loader/action。
 *
 * `/trace` 是 W4 引入的只读观测台；其余路径仍由对话工作台承接（保持既有深链语义）。
 */
export const router = createBrowserRouter([
  {
    path: "/trace",
    lazy: async () => {
      const module = await import("../features/trace/TracePage");
      return { Component: module.TracePage };
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
