import { resolve } from "node:path";
import { defineConfig } from "vite";

const appRoot = import.meta.dirname;

export default defineConfig({
  build: {
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(appRoot, "src/utility/worker.ts"),
      output: {
        entryFileNames: "worker.js",
        format: "es"
      }
    },
    outDir: resolve(appRoot, "dist/utility"),
    ssr: true,
    target: "node22"
  }
});
