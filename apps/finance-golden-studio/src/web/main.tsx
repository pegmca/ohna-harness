import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import { createGoldenStudioClient } from "./shared/api/client.js";
import "./styles.css";

/** 根 DOM 容器。 */
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element.");

/**
 * 挂载 Golden Studio Web 工作台。
 */
createRoot(rootElement).render(
  <StrictMode>
    <App client={createGoldenStudioClient("/")} />
  </StrictMode>
);
