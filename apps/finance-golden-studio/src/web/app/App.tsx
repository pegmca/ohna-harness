import { Award, Layers, Settings } from "lucide-react";
import { NavLink } from "react-router-dom";
import { BrowserRouter } from "react-router-dom";
import { MemoryRouter } from "react-router-dom";
import type { GoldenStudioClient } from "../shared/api/client.js";
import { AppProvider } from "./context.js";
import { GoldenStudioRoutes } from "./router.js";
import { ThemeProvider } from "./theme.js";

/** App 组合属性。 */
export interface AppProps {
  /** 注入的数据客户端；生产入口传同源客户端。 */
  client?: GoldenStudioClient;
  /** MemoryRouter 的初始路由；仅供测试使用。 */
  initialEntries?: string[];
}

/**
 * 渲染固定侧栏与主工作区。
 *
 * @param props App 属性。
 * @returns 应用外壳内容。
 */
function Shell({ client }: { client: GoldenStudioClient }) {
  return (
    <AppProvider client={client}>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-identity">
            <span className="product-name">Golden Studio</span>
            <span className="product-subtitle">Finance data workbench</span>
          </div>
          <nav aria-label="Primary" className="sidebar-nav">
            <NavLink className="nav-item" to="/">
              <Layers aria-hidden="true" size={16} />
              Batches
            </NavLink>
            <NavLink className="nav-item" to="/golden">
              <Award aria-hidden="true" size={16} />
              Golden
            </NavLink>
            <NavLink className="nav-item" to="/settings">
              <Settings aria-hidden="true" size={16} />
              Settings
            </NavLink>
          </nav>
        </aside>
        <main className="main-area">
          <GoldenStudioRoutes />
        </main>
      </div>
    </AppProvider>
  );
}

/**
 * Golden Studio Web 工作台外壳；测试可注入 MemoryRouter 初始路由。
 *
 * @param props App 属性。
 * @returns 完整应用外壳。
 */
export function App({ client, initialEntries }: AppProps) {
  const injectedClient = client as GoldenStudioClient;
  return (
    <ThemeProvider>
      {initialEntries ? (
        <MemoryRouter initialEntries={initialEntries}>
          <Shell client={injectedClient} />
        </MemoryRouter>
      ) : (
        <BrowserRouter>
          <Shell client={injectedClient} />
        </BrowserRouter>
      )}
    </ThemeProvider>
  );
}
