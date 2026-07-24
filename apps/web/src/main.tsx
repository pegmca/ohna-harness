import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ThemeProvider, applyInitialTheme } from "./app/theme";
import { IdentityProvider } from "./app/identity";
import "./styles.css";

applyInitialTheme();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <ThemeProvider>
      <IdentityProvider>
        <App />
      </IdentityProvider>
    </ThemeProvider>
  </StrictMode>
);
