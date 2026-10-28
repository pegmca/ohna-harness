import { readDraft, saveDraft } from "../../core/drafts.js";
import { readJsonBody } from "../body.js";
import { HttpError } from "../errors.js";
import { readBatchSegment, readDraftBody, readDraftSegment } from "../paths.js";
import type { RequestContext, RouteResult } from "../types.js";

/**
 * 处理单草稿读取与保存。
 *
 * @param context 请求上下文。
 * @param segments API 路径段。
 * @returns 路由响应；未匹配时为 undefined。
 */
export async function handleDrafts(
  context: RequestContext,
  segments: readonly string[]
): Promise<RouteResult> {
  if (
    segments.length !== 4 ||
    segments[0] !== "batches" ||
    segments[2] !== "drafts"
  ) {
    return undefined;
  }
  const batch = readBatchSegment(segments[1]);
  const id = readDraftSegment(segments[3]);

  if (context.request.method === "GET") {
    return {
      kind: "json",
      status: 200,
      body: { ok: true, data: await readDraft(context.config, batch, id) }
    };
  }
  if (context.request.method === "PUT") {
    const body = await readJsonBody(context.request, context.maxBodyBytes);
    const draft = readDraftBody(body);
    const saved = await saveDraft(context.config, batch, id, draft);
    return {
      kind: "json",
      status: 200,
      body: { ok: true, data: saved.draft }
    };
  }
  throw new HttpError(405, "method_not_allowed", "Use GET or PUT for this route.", {
    allowed: "GET, PUT"
  });
}
