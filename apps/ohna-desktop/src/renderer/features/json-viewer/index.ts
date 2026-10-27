/**
 * JSON 阅读器公共入口：调用方统一从这里引入，避免依赖内部文件布局。
 */
export { JsonViewer } from "./JsonViewer.js";
export type { JsonViewerProps } from "./JsonViewer.js";
export { buildJsonTree, MAX_BULK_EXPAND_NODES, MAX_RENDER_NODES } from "./json-tree.js";
export type { JsonNode } from "./json-tree.js";
