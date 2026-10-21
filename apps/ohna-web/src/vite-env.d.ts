/// <reference types="vite/client" />

/**
 * 构建期注入的应用版本（apps/ohna-web/package.json 的 version）。
 * 由 vite.config.ts 的 `define` 替换，避免设置页为版本号新增运行时端点。
 */
declare const __OHNA_WEB_VERSION__: string;
