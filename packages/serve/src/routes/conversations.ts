/**
 * 本地会话路由：创建 / 列表 / 改名归档 / 线性消息游标页。
 *
 * 与 finance-api 不同，本地会话没有租户与权限校验；`sessions/index.jsonl` 是列表与标题的
 * 唯一事实源，`conversations/<id>.jsonl` 只存消息。两者用同一个 id 关联。
 */
import type {
  ApiResult,
  WorkspaceConversationDto,
  CursorPageDto,
  LinearMessageDto
} from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import { createRequestId, failure, parseLimit, parseSequenceCursor } from "../errors.js";
import { deriveTitle, type SessionMeta } from "../store/index.js";
import type { RouteDeps } from "./types.js";

/**
 * 把会话元数据映射为 Web DTO。
 *
 * 导出供 server 句柄的 createConversation / listConversations 复用，
 * 保证进程内入口与 HTTP 路由返回同一 DTO 形状。
 *
 * @param meta 会话元数据。
 * @returns 会话 DTO。
 */
export function toConversationDto(meta: SessionMeta): WorkspaceConversationDto {
  return {
    conversationId: meta.id,
    title: meta.title,
    status: meta.status,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    lastMessageAt: meta.updatedAt,
    // 工作区根目录已随会话落盘；DTO 必填透出，供 web 侧栏按工作区分组（D1）。
    workspaceRoot: meta.workspaceRoot,
    ...(meta.status === "archived" ? { archivedAt: meta.archivedAt ?? meta.updatedAt } : {})
  };
}

/**
 * 从请求体读取对象。
 *
 * @param body Fastify 请求体。
 * @returns 普通对象或 null。
 */
function asRecord(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/**
 * 注册会话路由。
 *
 * @param app Fastify 实例。
 * @param deps 装配上下文。
 */
export function registerConversationRoutes(app: FastifyInstance, deps: RouteDeps): void {
  /** 创建会话；标题缺省为「新会话」。 */
  app.post("/api/conversations", async (request, reply): Promise<ApiResult<WorkspaceConversationDto>> => {
    const requestId = createRequestId();
    if (deps.isShuttingDown()) {
      return failure(reply, requestId, 503, "internal_error", "服务正在关闭，暂时无法创建会话。");
    }
    const body = asRecord(request.body);
    const rawTitle = body?.title;
    if (rawTitle !== undefined && typeof rawTitle !== "string") {
      return failure(reply, requestId, 400, "validation_failed", "会话标题格式不正确。");
    }
    const title = deriveTitle(typeof rawTitle === "string" ? rawTitle : "新会话");
    const meta = await deps.sessionStore.create({ title, workspaceRoot: deps.workspaceRoot });
    await deps.messageStore.ensureConversation(meta.id, meta.title);
    reply.code(201);
    return { ok: true, requestId, data: toConversationDto(meta) };
  });

  /**
   * 列出 active 会话；本地规模直接返回全部，nextCursor 缺省。
   *
   * 可选 `workspaceRoot` 查询参数按工作区过滤：web 的 composer 只应看到本工作区的会话
   * （跨工作区会话是只读的，见 03 D2），而侧栏需要全部会话做分组展示，因此过滤是显式可选、
   * 而非默认行为。
   */
  app.get<{ Querystring: { cursor?: string; limit?: string; workspaceRoot?: string } }>(
    "/api/conversations",
    async (request): Promise<ApiResult<CursorPageDto<WorkspaceConversationDto>>> => {
      const requestId = createRequestId();
      const workspaceFilter = request.query.workspaceRoot;
      const items = (await deps.sessionStore.list())
        .filter((meta) => workspaceFilter === undefined || meta.workspaceRoot === workspaceFilter)
        .map(toConversationDto);
      return { ok: true, requestId, data: { items } };
    }
  );

  /** 修改标题或归档。 */
  app.patch<{ Params: { conversationId: string } }>(
    "/api/conversations/:conversationId",
    async (request, reply): Promise<ApiResult<WorkspaceConversationDto>> => {
      const requestId = createRequestId();
      if (deps.isShuttingDown()) {
        return failure(reply, requestId, 503, "internal_error", "服务正在关闭，暂时无法修改会话。");
      }
      const body = asRecord(request.body);
      if (!body) {
        return failure(reply, requestId, 400, "validation_failed", "仅支持修改 title 或 archive。");
      }
      const hasTitle = typeof body.title === "string";
      const archive = body.archive === true;
      if ((hasTitle && body.archive !== undefined) || (!hasTitle && !archive)) {
        return failure(reply, requestId, 400, "validation_failed", "仅支持修改 title 或 archive。");
      }
      const existing = await deps.sessionStore.get(request.params.conversationId);
      if (!existing) {
        return failure(reply, requestId, 404, "not_found", "会话不存在。");
      }
      const updated = await deps.sessionStore.update(existing.id, {
        ...(hasTitle ? { title: body.title as string } : {}),
        ...(archive ? { status: "archived" as const } : {})
      });
      return { ok: true, requestId, data: toConversationDto(updated ?? existing) };
    }
  );

  /**
   * 语义化生成会话标题（BUG-002）：前端在「首条消息发送后」异步调用，用 LLM 把首条
   * 用户消息压成短标题并落盘。尽力而为、失败静默降级——返回 `title: undefined` 表示
   * 未生成（保留现有截断标题），绝不返回 5xx 阻断消息发送。
   */
  app.post<{ Params: { conversationId: string } }>(
    "/api/conversations/:conversationId/generate-title",
    async (request, reply): Promise<ApiResult<WorkspaceConversationDto>> => {
      const requestId = createRequestId();
      if (deps.isShuttingDown()) {
        return failure(reply, requestId, 503, "internal_error", "服务正在关闭，暂时无法生成标题。");
      }
      const existing = await deps.sessionStore.get(request.params.conversationId);
      if (!existing) {
        return failure(reply, requestId, 404, "not_found", "会话不存在。");
      }
      const body = asRecord(request.body);
      const rawText = body?.text;
      if (typeof rawText !== "string" || rawText.trim() === "") {
        return failure(reply, requestId, 400, "validation_failed", "缺少标题生成的用户消息文本。");
      }
      const title = await deps.runManager.generateTitle(rawText);
      if (!title) {
        // 未生成：返回现有标题（不落盘），前端据此保留截断标题。
        return { ok: true, requestId, data: toConversationDto(existing) };
      }
      const updated = await deps.sessionStore.update(existing.id, { title });
      return { ok: true, requestId, data: toConversationDto(updated ?? existing) };
    }
  );

  /** 线性消息游标页：按 sequence 升序，cursor = 已见 sequence。 */
  app.get<{
    Params: { conversationId: string };
    Querystring: { cursor?: string; limit?: string };
  }>(
    "/api/conversations/:conversationId/messages",
    async (request, reply): Promise<ApiResult<CursorPageDto<LinearMessageDto>>> => {
      const requestId = createRequestId();
      const conversation = await deps.sessionStore.get(request.params.conversationId);
      if (!conversation) {
        return failure(reply, requestId, 404, "not_found", "会话不存在。");
      }
      const rawCursor = request.query.cursor;
      if (rawCursor !== undefined && parseSequenceCursor(rawCursor) === undefined) {
        return failure(reply, requestId, 400, "bad_request", "消息分页游标无效。");
      }
      const page = await deps.messageStore.listPage(conversation.id, {
        afterSequence: parseSequenceCursor(rawCursor),
        limit: parseLimit(request.query.limit, 50)
      });
      return { ok: true, requestId, data: page };
    }
  );
}

