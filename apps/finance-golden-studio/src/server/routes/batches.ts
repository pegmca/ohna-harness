import { listBatches, listDrafts } from "../../core/drafts.js";
import { HttpError } from "../errors.js";
import type { RequestContext, RouteResult } from "../types.js";
import { readBatchSegment } from "../paths.js";

/**
 * 处理批次与批次内草稿列表。
 *
 * @param context 请求上下文。
 * @param segments API 路径段。
 * @returns 路由响应；未匹配时为 undefined。
 */
export async function handleBatches(
  context: RequestContext,
  segments: readonly string[]
): Promise<RouteResult> {
  if (segments.length === 1 && segments[0] === "batches") {
    assertMethod(context, "GET");
    return { kind: "json", status: 200, body: { ok: true, data: await listBatches(context.config) } };
  }
  if (
    segments.length === 3 &&
    segments[0] === "batches" &&
    segments[2] === "drafts"
  ) {
    assertMethod(context, "GET");
    const batch = readBatchSegment(segments[1]);
    return {
      kind: "json",
      status: 200,
      body: { ok: true, data: await listDrafts(context.config, batch) }
    };
  }
  return undefined;
}

/**
 * 断言当前请求使用指定方法。
 *
 * @param context 请求上下文。
 * @param method 预期方法。
 * @throws {HttpError} 方法不一致时抛出。
 */
function assertMethod(context: RequestContext, method: string): void {
  if (context.request.method !== method) {
    throw new HttpError(405, "method_not_allowed", `Use ${method} for this route.`, {
      allowed: method
    });
  }
}
