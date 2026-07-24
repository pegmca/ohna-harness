import { RouterProvider } from "react-router-dom";
import { router } from "./app/router";

/**
 * 应用入口只负责加载工作台边界，具体会话和运行流程留在 feature。
 *
 * @returns 路由工作台。
 */
export function App() {
  return <RouterProvider router={router} />;
}
