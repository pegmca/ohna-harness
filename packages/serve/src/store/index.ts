/**
 * JSONL 存储端口集合：会话元数据、线性消息、run 事件。
 *
 * 三个 store 都只依赖 `node:fs` 与 `@aiagent/types` 的线协议 DTO，
 * 不感知 HTTP / SSE / agentLoop，便于单独测试与未来替换为 SQLite 读模型。
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
export { isValidStoreId } from "./jsonl.js";
