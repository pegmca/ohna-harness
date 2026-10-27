/**
 * 渲染端数据访问层（Task 13）：薄封装 `window.ohna` preload SDK。
 *
 * 取代旧 `shared/api/*` 的 fetch/SSE 实现：所有请求与事件都经 preload 暴露的语义化 SDK，
 * 不再有 HTTP/SSE 重连逻辑（runtime 的 `subscribeRun` 已内含 replay+live 合并并终态自动关闭，
 * 见 `packages/ohna-runtime/src/events/replay.ts`）。导出函数名与旧客户端保持一致，consumer
 * 只需把 import 路径从 `../../shared/api/*` 改成 `shared/sdk/ohna-client`。
 *
 * 错误来源：`RuntimeErrorDto`（runtime 归一错误）映射为 `ApiFailure`，沿用旧 `ApiResult<T>` 形状。
 */
import type {
  ApiResult,
  ApiError,
  ApiErrorCode,
  ConversationSummaryDto,
  CursorPageDto,
  LinearMessageDto,
  ModelCatalogDto,
  RuntimeErrorDto,
  RunMetaDtoV2,
  RunSnapshotDtoV2,
  RunStatusDtoV2,
  RunStreamEventDtoV2
} from "@aiagent/types";
import type { OhnaSdk, StartRunInputDto } from "../../../preload/contract";

/** 从 preload 契约取运行事件类型，避免重复引入大对象。 */
export type { RunStreamEventDtoV2 };

/**
 * 读取 `window.ohna` 语义化 SDK，未注入时抛结构化错误（桌面 shell 必装 preload）。
 *
 * @returns 渲染端可用的 OhnaSdk 实例。
 */
function getSdk(): OhnaSdk {
  const sdk = (globalThis as unknown as { window?: { ohna?: OhnaSdk } }).window?.ohna;
  if (!sdk) {
    throw new Error("window.ohna 尚未就绪：预加载脚本未注入 SDK。");
  }
  return sdk;
}

/**
 * 把 runtime 归一错误 `RuntimeErrorDto` 映射成 `ApiFailure`（与旧 `parseApiResult` 失败分支同源）。
 *
 * @param error runtime 归一错误。
 * @returns 渲染端统一的失败结果。
 */
function toFailure<TData>(error: RuntimeErrorDto): ApiResult<TData> {
  return {
    ok: false,
    requestId: error.requestId,
    error: {
      code: (KNOWN_ERROR_CODES.has(error.code) ? error.code : "internal_error") as ApiErrorCode,
      message: error.message,
      requestId: error.requestId,
      details: error.details
    }
  };
}

/**
 * 把 SDK 抛出的异常收窄为结构化失败：runtime 抛 `RuntimeErrorDto` 时映射，否则按内部错误兜底。
 *
 * @param error 任意异常。
 * @returns 渲染端统一失败结果。
 */
function toFailureFromUnknown<TData>(error: unknown): ApiResult<TData> {
  if (isRuntimeError(error)) {
    return toFailure<TData>(error);
  }
  return {
    ok: false,
    requestId: "unknown",
    error: { code: "internal_error", message: error instanceof Error ? error.message : "未知错误。", requestId: "unknown" }
  };
}

/** @param value 待判定对象。 @returns 是否为 RuntimeErrorDto 形状。 */
function isRuntimeError(value: unknown): value is RuntimeErrorDto {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RuntimeErrorDto).code === "string" &&
    typeof (value as RuntimeErrorDto).message === "string" &&
    "requestId" in value
  );
}

/**
 * 列出会话（按最近更新倒序）。runtime 返回 `ConversationSummaryDto[]`，适配成游标分页壳。
 *
 * @param cursor 可选游标（runtime 不分页，仅保留签名兼容）。
 * @param signal 取消信号。
 * @param workspaceId 可选工作区过滤。
 * @returns 会话页（下游只消费 items / nextCursor）。
 */
export async function listConversations(
  cursor?: string,
  signal?: AbortSignal,
  workspaceId?: string
): Promise<ApiResult<CursorPageDto<ConversationSummaryDto>>> {
  void cursor;
  void signal;
  try {
    const items = await getSdk().conversations.list(workspaceId ? { workspaceId } : undefined);
    return { ok: true, requestId: "conversations.list", data: { items, nextCursor: undefined } };
  } catch (error) {
    return toFailureFromUnknown<CursorPageDto<ConversationSummaryDto>>(error);
  }
}

/** @param input 创建输入（仅 title + workspaceId）。 @returns 新会话。 */
export async function createConversation(
  input: { title: string; workspaceId?: string }
): Promise<ApiResult<ConversationSummaryDto>> {
  try {
    const created = await getSdk().conversations.create({ title: input.title, workspaceId: input.workspaceId ?? "default" });
    return { ok: true, requestId: "conversations.create", data: created };
  } catch (error) {
    return toFailureFromUnknown<ConversationSummaryDto>(error);
  }
}

/** @param conversationId 会话 ID。 @param cursor 可选游标。 @param signal 取消信号。 @returns 线性消息页。 */
export async function listConversationMessages(
  conversationId: string,
  cursor?: string,
  signal?: AbortSignal
): Promise<ApiResult<CursorPageDto<LinearMessageDto>>> {
  void signal;
  try {
    const page = await getSdk().conversations.listMessages(conversationId, {
      ...(cursor ? { afterSequence: Number(cursor) || undefined } : {})
    });
    return { ok: true, requestId: "conversations.listMessages", data: page ?? { items: [], nextCursor: undefined } };
  } catch (error) {
    return toFailureFromUnknown<CursorPageDto<LinearMessageDto>>(error);
  }
}

/** @param runId Run ID。 @param signal 取消信号。 @returns 新协议 Run 快照（无 result 正文）。 */
export async function getRunSnapshot(
  runId: string,
  signal?: AbortSignal
): Promise<ApiResult<RunSnapshotDtoV2>> {
  void signal;
  try {
    const snapshot = await getSdk().runs.snapshot(runId);
    if (!snapshot) {
      return { ok: false, requestId: runId, error: { code: "not_found", message: "run 快照不存在。", requestId: runId } };
    }
    return { ok: true, requestId: snapshot.requestId, data: snapshot };
  } catch (error) {
    return toFailureFromUnknown<RunSnapshotDtoV2>(error);
  }
}

/** @param conversationId 会话 ID。 @param input 标题或归档操作。 @returns 更新后会话。 */
export async function updateConversation(
  conversationId: string,
  input: { title?: string; archive?: boolean }
): Promise<ApiResult<ConversationSummaryDto>> {
  try {
    const updated = await getSdk().conversations.update(conversationId, input);
    if (!updated) {
      return { ok: false, requestId: conversationId, error: { code: "not_found", message: "会话不存在。", requestId: conversationId } };
    }
    return { ok: true, requestId: "conversations.update", data: updated };
  } catch (error) {
    return toFailureFromUnknown<ConversationSummaryDto>(error);
  }
}

/**
 * 语义化生成会话标题；失败静默返回现有标题（runtime 未找到会话返回 undefined）。
 *
 * @param conversationId 会话 ID。
 * @param text 首条用户消息。
 * @returns 更新后会话；未生成时返回 undefined。
 */
export async function generateConversationTitle(
  conversationId: string,
  text: string
): Promise<ApiResult<ConversationSummaryDto | undefined>> {
  try {
    const updated = await getSdk().conversations.generateTitle(conversationId, text);
    return { ok: true, requestId: "conversations.generateTitle", data: updated };
  } catch (error) {
    return toFailureFromUnknown<ConversationSummaryDto | undefined>(error);
  }
}

/** @param signal 取消信号。 @returns 模型目录（本地为单模型）。 */
export async function listModels(signal?: AbortSignal): Promise<ApiResult<ModelCatalogDto>> {
  void signal;
  try {
    const catalog = await getSdk().models.list();
    return { ok: true, requestId: "models.list", data: catalog };
  } catch (error) {
    return toFailureFromUnknown<ModelCatalogDto>(error);
  }
}

/** @param conversationId 会话 ID。 @param signal 取消信号。 @returns run 摘要列表（按创建时间倒序）。 */
export async function listConversationRuns(
  conversationId: string,
  signal?: AbortSignal
): Promise<ApiResult<RunMetaDtoV2[]>> {
  void signal;
  try {
    const runs = await getSdk().runs.list(conversationId);
    return { ok: true, requestId: "runs.list", data: runs };
  } catch (error) {
    return toFailureFromUnknown<RunMetaDtoV2[]>(error);
  }
}

/**
 * 提交工具调用确认（放行 / 拒绝）。
 *
 * @param runId Run 标识。
 * @param toolCallId 待确认工具调用 ID。
 * @param decision allow / deny。
 * @param signal 取消信号。
 * @returns 结构化提交结果。
 */
export async function submitConfirmation(
  runId: string,
  toolCallId: string,
  decision: "allow" | "deny",
  signal?: AbortSignal
): Promise<ApiResult<{ toolCallId: string; decision: "allow" | "deny" }>> {
  void signal;
  try {
    await getSdk().runs.resolveConfirmation(runId, toolCallId, decision);
    return { ok: true, requestId: runId, data: { toolCallId, decision } };
  } catch (error) {
    return toFailureFromUnknown<{ toolCallId: string; decision: "allow" | "deny" }>(error);
  }
}

/**
 * Run 的终态摘要；新协议快照不再携带 result，终态正文由调用方在结束后重新拉取消息列表获得。
 */
export interface RunTerminalDto {
  status: RunStatusDtoV2;
  requestId: string;
  error?: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
}

/** 终态 run 状态机值；到达后订阅关闭。 */
export const TERMINAL_STATUSES: ReadonlySet<RunStatusDtoV2> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

/** `createAndStreamRun` 入参：与旧 `AgentRunCreateRequestDto` 对齐的最小子集。 */
export interface CreateRunRequest {
  message: string;
  conversationId: string;
  clientMessageId?: string;
  modelId?: string;
  mode: "auto" | "report";
  source: "composer" | "report_button" | "cli";
  workspaceId?: string;
}

/** run 流选项：取消信号、事件回调、accepted 回调。 */
export interface RunStreamOptions {
  signal?: AbortSignal;
  onEvent?: (event: RunStreamEventDtoV2) => void;
  onAccepted?: (accepted: { runId: string; requestId: string; conversationId: string; modelId: string; status: RunStatusDtoV2 }) => void | Promise<void>;
  maxReconnects?: number;
}

/**
 * 创建异步 Run 并消费事件流：先同步投递 `initialEvents`，再订阅 live 帧，终态到达后 resolve。
 *
 * 与旧实现不同，这里**没有** SSE 解析 / afterSequence 续传 / maxReconnects：runtime 的
 * `subscribeRun` 已内含 replay+live 合并并终态自动关闭，调用方只持退订函数（spec §5.3/§5.4）。
 *
 * @param request Run 创建请求。
 * @param options 取消、事件回调与 accepted 回调。
 * @returns Run 的终态摘要（不含正文）。
 */
export async function createAndStreamRun(
  request: CreateRunRequest,
  options: RunStreamOptions = {}
): Promise<ApiResult<RunTerminalDto>> {
  let unsubscribe: (() => void) | undefined;
  let resolveTerminal: (result: ApiResult<RunTerminalDto>) => void = () => undefined;
  try {
    const input: StartRunInputDto = {
      conversationId: request.conversationId,
      message: request.message,
      mode: request.mode,
      source: request.source,
      workspaceId: request.workspaceId
    };
    const started = await getSdk().runs.start(input);
    const { accepted, initialEvents } = started;
    // accepted hook 可先提交取消等控制操作，再进入订阅，避免创建响应与用户停止之间遗留后台 Run。
    await options.onAccepted?.({
      runId: accepted.runId,
      requestId: accepted.requestId,
      conversationId: accepted.conversationId,
      modelId: accepted.modelId,
      status: accepted.status
    });
    for (const event of initialEvents) {
      options.onEvent?.(event);
    }
    // 终态归约复用旧 `terminalOf` 逻辑（保持 RunTerminalDto 形状与终态判定）。
    const earlyTerminal = initialEvents.map(terminalOf).find(Boolean);
    if (earlyTerminal) return earlyTerminal as ApiResult<RunTerminalDto>;
    unsubscribe = await getSdk().events.subscribeRun(accepted.runId, (event) => {
      options.onEvent?.(event);
      const terminalEvent = terminalOf(event);
      if (terminalEvent) {
        unsubscribe?.();
        resolveTerminal(terminalEvent as ApiResult<RunTerminalDto>);
      }
    });
    return await new Promise<ApiResult<RunTerminalDto>>((resolve) => {
      resolveTerminal = resolve;
      // 取消信号：主动退订并判定为 request_cancelled。
      options.signal?.addEventListener("abort", () => {
        unsubscribe?.();
        resolve({
          ok: false,
          requestId: accepted.requestId,
          error: { code: "request_cancelled", message: "已停止等待 Run。", requestId: accepted.requestId }
        });
      }, { once: true });
    });
  } catch (error) {
    unsubscribe?.();
    return toFailureFromUnknown<RunTerminalDto>(error);
  }
}

/** @param runId Run 标识。 @returns 最新 Run 快照（新协议 V2）。 */
export async function cancelRun(runId: string): Promise<ApiResult<RunSnapshotDtoV2>> {
  try {
    const snapshot = await getSdk().runs.cancel(runId);
    if (!snapshot) {
      return { ok: false, requestId: runId, error: { code: "not_found", message: "run 不存在。", requestId: runId } };
    }
    return { ok: true, requestId: snapshot.requestId, data: snapshot };
  } catch (error) {
    return toFailureFromUnknown<RunSnapshotDtoV2>(error);
  }
}

/**
 * 重放某个已存在 Run 的事件流（W-9）：一次性历史恢复，不等待终态；用 signal 监听 abort 退订避免泄漏。
 *
 * @param runId Run 标识。
 * @param options 取消信号与事件回调。
 * @returns 流结束（历史回放完成/连接关闭）后 resolve；失败静默结束（重放失败不阻断页面）。
 */
export async function replayRunEvents(
  runId: string,
  options: { signal?: AbortSignal; onEvent?: (event: RunStreamEventDtoV2) => void } = {}
): Promise<void> {
  let unsubscribe: (() => void) | undefined;
  const onAbort = () => unsubscribe?.();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    unsubscribe = await getSdk().events.subscribeRun(runId, (event) => options.onEvent?.(event));
  } catch {
    // 重放只是辅助恢复，不向上抛错。
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 跟随一个**已存在** run 的事件流（观测台用）：首帧起 replay 已落盘事件，随后接实时帧；
 * 终态 `run_status` 到达后 unsubscribe 并 resolve；同样处理 `signal.aborted` 退订。
 *
 * @param runId Run 标识。
 * @param options 取消信号、起始游标（本端去重高水位）与事件回调。
 * @returns 终态到达或重连耗尽后 resolve。
 */
export async function followRunEvents(
  runId: string,
  options: { signal?: AbortSignal; afterSequence?: number; onEvent?: (event: RunStreamEventDtoV2) => void } = {}
): Promise<void> {
  let unsubscribe: (() => void) | undefined;
  const onAbort = () => unsubscribe?.();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const afterSequence = options.afterSequence ?? 0;
  try {
    unsubscribe = await getSdk().events.subscribeRun(runId, (event) => {
      // afterSequence 仅作本端去重高水位（小于它的帧丢弃），不向 runtime 续传。
      if (event.sequence <= afterSequence) return;
      options.onEvent?.(event);
      if (terminalOf(event)) {
        unsubscribe?.();
        options.signal?.removeEventListener("abort", onAbort);
      }
    });
    // 等待终态或取消：runtime 订阅在终态自动关闭，但取消需主动退订；以取消信号收尾避免 Promise 悬挂。
    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      options.signal?.addEventListener("abort", finish, { once: true });
    });
  } catch {
    // 事件流失败不遮蔽面板。
  } finally {
    unsubscribe?.();
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 从 envelope 提取终态摘要：agent_end / run_error / run_status 终值都是终止信号。
 *
 * @param event canonical run event envelope。
 * @returns 终态摘要；非终止事件返回 undefined。
 */
function terminalOf(event: RunStreamEventDtoV2): ApiResult<RunTerminalDto> | undefined {
  const payload = (event.payload ?? {}) as {
    status?: RunStatusDtoV2;
    error?: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
  };
  if (event.type === "run_error") {
    const error = payload.error ?? { code: "internal_error", message: "Run 失败。", requestId: event.requestId };
    return { ok: false, requestId: event.requestId, error: toApiError(error, event.requestId) };
  }
  if (event.type === "agent_end") {
    if (payload.error) {
      return {
        ok: false,
        requestId: event.requestId,
        error: toApiError(payload.error, event.requestId)
      };
    }
    return { ok: true, requestId: event.requestId, data: { status: "completed", requestId: event.requestId } };
  }
  if (event.type === "run_status" && payload.status && TERMINAL_STATUSES.has(payload.status)) {
    if (payload.status === "completed") {
      return { ok: true, requestId: event.requestId, data: { status: "completed", requestId: event.requestId } };
    }
    if (payload.status === "cancelled" || payload.status === "interrupted") {
      return {
        ok: false,
        requestId: event.requestId,
        error: toApiError({ code: "request_cancelled", message: "Run 已停止。", requestId: event.requestId }, event.requestId)
      };
    }
    return {
      ok: false,
      requestId: event.requestId,
      error: payload.error
        ? toApiError(payload.error, event.requestId)
        : { code: "internal_error", message: "Run 失败。", requestId: event.requestId }
    };
  }
  return undefined;
}

/**
 * 把事件 payload 里的原始错误归一为渲染端结构化 `ApiError`：payload 的 code 为开放字符串，
 * 这里按受控错误码集合收窄，缺失或非受控时回退 `internal_error`，避免窄类型不兼容。
 *
 * @param error 原始错误（code 为开放字符串）。
 * @param fallbackRequestId 缺省请求 id（payload 未携带时回退）。
 * @returns 结构化 ApiError。
 */
function toApiError(
  error: { code: string; message: string; requestId?: string; details?: Record<string, unknown> },
  fallbackRequestId: string
): ApiError {
  const code = (KNOWN_ERROR_CODES.has(error.code) ? error.code : "internal_error") as ApiErrorCode;
  return {
    code,
    message: error.message,
    requestId: error.requestId ?? fallbackRequestId,
    details: error.details
  };
}

/** 受控错误码集合（与 @aiagent/types 的 ApiErrorCode 对齐）。 */
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "validation_failed",
  "agent_failed",
  "tool_failed",
  "trace_failed",
  "request_cancelled",
  "run_interrupted",
  "internal_error"
]);
