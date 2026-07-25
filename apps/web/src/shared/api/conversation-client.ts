import type {
  ApiResult,
  ConversationDto,
  ConversationMessageDto,
  CreateConversationRequestDto,
  CursorPageDto,
  UpdateConversationRequestDto
} from "@aiagent/types";
import { parseApiResult } from "./http-client";

/** @param cursor 可选游标。 @param signal 取消信号。 @returns 会话页。 */
export async function listConversations(
  cursor?: string,
  signal?: AbortSignal
): Promise<ApiResult<CursorPageDto<ConversationDto>>> {
  const query = new URLSearchParams({ limit: "30" });
  if (cursor) query.set("cursor", cursor);
  return parseApiResult(await fetch(`/api/conversations?${query}`, { signal }));
}

/** @param input 创建输入。 @returns 新会话。 */
export async function createConversation(
  input: CreateConversationRequestDto
): Promise<ApiResult<ConversationDto>> {
  return parseApiResult(await fetch("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  }));
}

/** @param conversationId 会话 ID。 @param cursor 可选游标。 @param signal 取消信号。 @returns 消息页。 */
export async function listConversationMessages(
  conversationId: string,
  cursor?: string,
  signal?: AbortSignal
): Promise<ApiResult<CursorPageDto<ConversationMessageDto>>> {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor) query.set("cursor", cursor);
  return parseApiResult(await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?${query}`,
    { signal }
  ));
}

/** @param conversationId 会话 ID。 @param input 标题或归档操作。 @returns 更新后会话。 */
export async function updateConversation(
  conversationId: string,
  input: UpdateConversationRequestDto
): Promise<ApiResult<ConversationDto>> {
  return parseApiResult(await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  }));
}
