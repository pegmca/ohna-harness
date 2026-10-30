import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true
      },
      "/health": "http://localhost:3001",
      "/ready": "http://localhost:3001"
    }
  },
  preview: {
    port: 5180,
    strictPort: true,
    host: "0.0.0.0",
    proxy: {
      "/api": "http://localhost:3001",
      "/health": "http://localhost:3001",
      "/ready": "http://localhost:3001"
    }
  }
});
