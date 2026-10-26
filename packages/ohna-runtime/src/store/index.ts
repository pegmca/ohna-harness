/**
 * JSONL 存储端口集合：会话元数据、线性消息、run 事件。
 *
 * 三个 store 都只依赖 `node:fs` 与 `@aiagent/types` 的线协议 DTO（`@aiagent/trace` 仅
 * `run-store` 做 payload 模式脱敏），不感知 HTTP / SSE / agentLoop，便于单独测试与
 * 未来替换为 SQLite 读模型。本 barrel 是 `@aiagent/ohna-runtime` 的 store 子入口，
 * 从 `packages/serve/src/store` 原样迁入，签名保持一致。
 */
export { LocalSessionStore, deriveTitle, type SessionMeta, type LocalSessionStatus } from "./session-store.js";
export {
  LocalMessageStore,
  type AppendMessageInput,
  type ConversationMeta,
  type MessagePageQuery
} from "./message-store.js";
export {
  LocalRunStore,
  isPersistableRunEvent,
  isTerminalRunStatus,
  type RunMeta
} from "./run-store.js";
export type { RunEventTypeDto } from "./run-store.js";
export {
  isValidStoreId,
  assertStoreId,
  readJsonlLines,
  appendJsonLine,
  ensureDir,
  nowIso,
  jsonlPath,
  serializedWrite
} from "./jsonl.js";
export { SCHEMA_VERSION, schemaLine } from "./schema.js";
