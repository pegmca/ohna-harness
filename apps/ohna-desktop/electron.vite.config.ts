import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** 应用版本：设置页「关于」分区展示，构建期注入，避免为此新增运行时端点。 */
const appVersion = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version?: string;
}).version ?? "0.0.0";

const outputRoot = resolve(import.meta.dirname, "dist");

export default defineConfig({
  main: {
    build: {
      outDir: resolve(outputRoot, "main")
    }
  },
  preload: {
    // sandbox preload 只能 require("electron") 等内置模块；关闭 externalizeDeps
    // 把 `@aiagent/types` 等运行时依赖内联，避免 "module not found" 导致 SDK 未注入。
    build: {
      externalizeDeps: false,
      outDir: resolve(outputRoot, "preload"),
      rollupOptions: {
        output: {
          entryFileNames: "index.cjs",
          format: "cjs"
        }
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    define: {
      __OHNA_WEB_VERSION__: JSON.stringify(appVersion)
    },
    build: {
      outDir: resolve(outputRoot, "renderer")
    }
  }
});
