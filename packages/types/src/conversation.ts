import type { ISODateTimeString } from "./primitives.js";

export type ResearchMode = "chat" | "report";

export type ConversationStatusDto = "active" | "archived";
export type ConversationMessageStatusDto = "completed" | "failed";

/** 用户消息关联的私有研究附件摘要；正文仍只存在 RAG 文档版本中。 */
export interface MessageAttachmentDto {
  attachmentId: string;
  documentId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  ordinal: number;
}

/** Web 可见的会话摘要；刻意排除 userId 等持久化内部字段。 */
export interface ConversationDto {
  conversationId: string;
  title: string;
  status: ConversationStatusDto;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  lastMessageAt: ISODateTimeString;
  archivedAt?: ISODateTimeString;
}

/**
 * ohna 本地执行会话摘要（`@aiagent/serve` 的 conversations 路由线格式）。
 *
 * 为什么独立成类型而不是给 `ConversationDto` 加必填字段：该线格式带「产生会话的工作区根目录」，
 * 只有 ohna 本地有「工作区」概念；金融 SaaS（finance-api / finance-web）复用 `ConversationDto`
 * 且没有该概念（产品 A 不随 ohna 演进），因此 ohna 专属字段落在独立的子类型上。
 */
export interface WorkspaceConversationDto extends ConversationDto {
  /**
   * 产生该会话的 serve 实例工作区根目录（绝对路径）。
   * 必填：多 CLI 实例共享 `~/.ohna` dataDir，web 据此按工作区分组；
   * 旧数据中缺失该字段的行在存储层被当作坏行跳过（阻断性升级，无空串兜底）。
   */
  workspaceRoot: string;
}

export interface CreateConversationRequestDto {
  title: string;
}

export type UpdateConversationRequestDto =
  | { title: string; archive?: never }
  | { archive: true; title?: never };

/**
 * 阶段 3 线性消息 DTO：content 块原样透传（pi content JSON），
 * 不再有 status 流式状态机——消息落库即终态，流式中间态只存在于 run 事件流。
 */
export interface LinearMessageDto {
  messageId: string;
  conversationId: string;
  runId?: string;
  role: "user" | "assistant" | "toolResult";
  /** pi content 原样 JSON：user 为文本或块数组，assistant 为块数组，toolResult 为 envelope。 */
  content: unknown;
  /** compaction 行在 UI 渲染为「历史已压缩」分隔条。 */
  messageType: "normal" | "compaction";
  sequence: number;
  usage?: unknown;
  modelId?: string;
  stopReason?: string;
  createdAt: ISODateTimeString;
}
