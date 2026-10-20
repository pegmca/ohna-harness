/**
 * Trace 页的数据访问：会话下的 run 列表。
 *
 * run 事件流复用 `shared/api/run-stream-client`（followRunEvents / replayRunEvents），
 * 这里只补一个「按会话列 run」的只读端点封装，不新建传输协议（计划 D9）。
 */
import type { ApiResult, RunMetaDtoV2 } from "@aiagent/types";
import { parseApiResult } from "../../shared/api/http-client";

/**
 * 列出某会话下的 run 摘要（观测台左栏）。
 *
 * @param conversationId 会话 ID。
 * @param signal 取消信号。
 * @returns run 摘要列表（服务端按创建时间倒序）。
 */
export async function listConversationRuns(
  conversationId: string,
  signal?: AbortSignal
): Promise<ApiResult<RunMetaDtoV2[]>> {
  return parseApiResult(
    await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/runs`, { signal })
  );
}
