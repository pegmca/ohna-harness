import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ThemeProvider, applyInitialTheme } from "./app/theme";
import { IdentityProvider } from "./app/identity";
import "./styles.css";

applyInitialTheme();

// 开发期组件定位工具：按住 Cmd(Mac)/Ctrl(Win/Linux) 悬停页面元素，
// 即可浮层显示该元素对应的 React 组件名与源码 file:line。
// 仅在 dev 引入，Vite 会在生产构建中通过条件摇树移除这段动态 import。
if (import.meta.env.DEV) {
  import("react-grep");
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <ThemeProvider>
      <IdentityProvider>
        <App />
      </IdentityProvider>
    </ThemeProvider>
  </StrictMode>
);
