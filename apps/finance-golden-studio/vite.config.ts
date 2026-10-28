import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { DEV_API_URL } from "./src/web/dev-config.js";

export default defineConfig({
  plugins: [react()],
  root: import.meta.dirname,
  build: {
    outDir: "dist/web",
    emptyOutDir: true
  },
  server: {
    proxy: {
      "/api": {
        target: DEV_API_URL,
        changeOrigin: true
      }
    }
  }
});
