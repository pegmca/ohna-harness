import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// 本地服务端口：dev/preview 都代理到 ohna-api（packages/serve 装配）监听的 127.0.0.1 端口。
// OHNA_PORT 与 apps/ohna-api 的 --port 语义一致；ohna-api 端口被占用会自动 +1，
// 因此被占用时需显式设置 OHNA_PORT 保持代理与服务一致。
const localApiTarget = `http://127.0.0.1:${process.env.OHNA_PORT ?? 4173}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: localApiTarget,
        changeOrigin: true
      }
    }
  },
  preview: {
    host: "0.0.0.0",
    proxy: {
      "/api": localApiTarget
    }
  }
});
