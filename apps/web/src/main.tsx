import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BrowserRouter } from "react-router-dom";
import { ThemeProvider, applyInitialTheme } from "./app/theme";
import { IdentityProvider } from "./app/identity";
import "./styles.css";

applyInitialTheme();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <IdentityProvider>
          <App />
        </IdentityProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>
);
