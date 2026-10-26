import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

const outputRoot = resolve(import.meta.dirname, "dist");

export default defineConfig({
  main: {
    build: {
      outDir: resolve(outputRoot, "main")
    }
  },
  preload: {
    build: {
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
    build: {
      outDir: resolve(outputRoot, "renderer")
    }
  }
});
