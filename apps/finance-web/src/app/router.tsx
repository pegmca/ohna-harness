import { createBrowserRouter } from "react-router-dom";

/**
 * 应用路由以 lazy feature 为代码分割边界；后续工作区可独立增加 loader/action。
 */
export const router = createBrowserRouter([
  {
    path: "*",
    lazy: async () => {
      const module = await import("../features/workbench/Workbench");
      return { Component: module.Workbench };
    }
  }
]);
