import type { ISODateTimeString } from "./primitives.js";

export type ResearchMode = "chat" | "report";

export type ConversationStatusDto = "active" | "archived";
export type ConversationMessageStatusDto = "completed" | "failed";

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

/** Web 历史时间线使用的消息 DTO；pending/streaming 仍由 live Run 表达。 */
export interface ConversationMessageDto {
  messageId: string;
  conversationId: string;
  runId?: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  status: ConversationMessageStatusDto;
  sequence: number;
  createdAt: ISODateTimeString;
  completedAt?: ISODateTimeString;
}

export interface CreateConversationRequestDto {
  title: string;
}

export type UpdateConversationRequestDto =
  | { title: string; archive?: never }
  | { archive: true; title?: never };

export interface ChatMessageDto {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: ISODateTimeString;
}
