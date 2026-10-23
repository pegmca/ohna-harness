import type {
  ApiResult,
  WorkspaceConversationDto,
  CreateConversationRequestDto,
  CursorPageDto,
  LinearMessageDto,
  RunSnapshotDtoV2,
  UpdateConversationRequestDto
} from "@aiagent/types";
import { parseApiResult } from "./http-client";

/**
 * 列出会话（按最近更新倒序）。
 *
 * @param cursor 可选游标。
 * @param signal 取消信号。
 * @param workspaceRoot 可选工作区过滤；缺省返回全部工作区会话。web 工作台只走缺省形态
 *   （侧栏分组列表同时是 composer 的会话源，跨工作区会话可直接续写），按工作区过滤的入参
 *   保留给脚本 / 调试调用。
 * @returns 会话页。
 */
export async function listConversations(
  cursor?: string,
  signal?: AbortSignal,
  workspaceRoot?: string
): Promise<ApiResult<CursorPageDto<WorkspaceConversationDto>>> {
  const query = new URLSearchParams({ limit: "30" });
  if (cursor) query.set("cursor", cursor);
  if (workspaceRoot) query.set("workspaceRoot", workspaceRoot);
  return parseApiResult(await fetch(`/api/conversations?${query}`, { signal }));
}

/** @param input 创建输入。 @returns 新会话。 */
export async function createConversation(
  input: CreateConversationRequestDto
): Promise<ApiResult<WorkspaceConversationDto>> {
  return parseApiResult(await fetch("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  }));
}

/** @param conversationId 会话 ID。 @param cursor 可选游标。 @param signal 取消信号。 @returns 线性消息页。 */
export async function listConversationMessages(
  conversationId: string,
  cursor?: string,
  signal?: AbortSignal
): Promise<ApiResult<CursorPageDto<LinearMessageDto>>> {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor) query.set("cursor", cursor);
  return parseApiResult(await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?${query}`,
    { signal }
  ));
}

/** @param runId Run ID。 @param signal 取消信号。 @returns 新协议 Run 快照（无 result 正文）。 */
export async function getRunSnapshot(
  runId: string,
  signal?: AbortSignal
): Promise<ApiResult<RunSnapshotDtoV2>> {
  return parseApiResult(await fetch(`/api/runs/${encodeURIComponent(runId)}`, { signal }));
}

/** @param conversationId 会话 ID。 @param input 标题或归档操作。 @returns 更新后会话。 */
export async function updateConversation(
  conversationId: string,
  input: UpdateConversationRequestDto
): Promise<ApiResult<WorkspaceConversationDto>> {
  return parseApiResult(await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  }));
}

/**
 * 语义化生成会话标题（BUG-002）：异步调用服务端 LLM 把首条消息压成短标题并落盘。
 * 尽力而为——失败时服务端返回现有标题，前端据此保留截断标题。
 *
 * @param conversationId 会话 ID。
 * @param text 首条用户消息。
 * @returns 更新后会话；语义标题未生成时返回现有截断标题。
 */
export async function generateConversationTitle(
  conversationId: string,
  text: string
): Promise<ApiResult<WorkspaceConversationDto>> {
  return parseApiResult(await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/generate-title`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    }
  ));
}
