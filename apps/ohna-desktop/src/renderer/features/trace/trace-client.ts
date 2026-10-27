/**
 * Trace 页的数据访问：会话下的 run 列表。
 *
 * 桌面端无 HTTP：经 preload SDK（`shared/sdk/ohna-client` 的 `listConversationRuns`）读取，
 * 事件流由 `use-trace-stream` 复用 SDK 的 `followRunEvents` / `replayRunEvents`，此处只封装
 * 这一个只读列表端点，不新建传输协议（计划 D9）。
 */
import type { ApiResult, RunMetaDtoV2 } from "@aiagent/types";
import { listConversationRuns as sdkListConversationRuns } from "../../shared/sdk/ohna-client";

/**
 * 列出某会话下的 run 摘要（观测台左栏）。
 *
 * @param conversationId 会话 ID。
 * @param signal 取消信号。
 * @returns run 摘要列表（服务端按创建时间倒序）。
 */
/** 复用 SDK 同名函数，转发签名与返回形状，便于本文件作为 Trace 数据层唯一入口。 */
export async function listConversationRuns(
  conversationId: string,
  signal?: AbortSignal
): Promise<ApiResult<RunMetaDtoV2[]>> {
  return sdkListConversationRuns(conversationId, signal);
}
