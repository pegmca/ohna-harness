import { resolve } from "node:path";
import { defineConfig } from "vite";

const appRoot = import.meta.dirname;

/**
 * 测试用 ESM 构建：把 main / preload / utility 按模块原样（preserveModules）编译到 `dist/`，
 * 供 `node --test` 在纯 Node 下直接 import 子模块（不依赖 Electron 运行时）。
 *
 * 与 electron-vite 的产品构建互补：产品构建把 main 打包成单文件 `index.js`、preload 打包成
 * `index.cjs`；本构建保留模块边界，使 `RuntimeHost` / `validateEnvelope` / `createOhnaSdk` 等
 * 纯逻辑可在无 Electron 的 node 里断言。Electron 与 @aiagent/* 标记为外部依赖，运行时经
 * node_modules 解析。
 */
export default defineConfig({
  build: {
    emptyOutDir: false,
    rollupOptions: {
      input: [
        resolve(appRoot, "src/main/envelope.ts"),
        resolve(appRoot, "src/main/runtime-host.ts"),
        resolve(appRoot, "src/preload/contract.ts"),
        resolve(appRoot, "src/preload/sdk.ts"),
        resolve(appRoot, "src/utility/routing.ts"),
      ],
      output: {
        preserveModules: true,
        preserveModulesRoot: resolve(appRoot, "src"),
        entryFileNames: "[name].js",
        format: "es",
      },
      external: [
        "electron",
        /^node:/,
        /^@aiagent\//,
      ],
    },
    outDir: resolve(appRoot, "dist"),
    ssr: true,
    target: "node22",
  },
});
