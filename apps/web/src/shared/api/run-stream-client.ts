import type {
  AgentRunAcceptedDto,
  AgentRunCreateRequestDto,
  ApiError,
  ApiResult,
  RunSnapshotDtoV2,
  RunStatusDtoV2,
  RunStreamEventDtoV2
} from "@aiagent/types";
import { parseApiResult } from "./http-client";

/**
 * Run 的终态摘要；新协议 snapshot 不再携带 result，
 * 终态正文由调用方在结束后重新拉取消息列表获得。
 */
export interface RunTerminalDto {
  status: RunStatusDtoV2;
  requestId: string;
  error?: ApiError;
}

export interface RunStreamOptions {
  signal?: AbortSignal;
  /** 每个 canonical run_event envelope（含 run_status / message_update / tool_execution_* 等）。 */
  onEvent?: (event: RunStreamEventDtoV2) => void;
  onAccepted?: (accepted: AgentRunAcceptedDto) => void | Promise<void>;
  maxReconnects?: number;
}

/** 终态 run 状态机值；到达后 SSE 与重连循环都停止。 */
const TERMINAL_STATUSES: ReadonlySet<RunStatusDtoV2> = new Set(["completed", "failed", "cancelled", "interrupted"]);

/**
 * 创建异步 Run 并消费 run_event SSE；断线按 sequence 续传，重连耗尽后以 snapshot 状态兜底。
 *
 * @param request Run 创建请求。
 * @param options 取消、事件回调与重连配置。
 * @returns Run 的终态摘要（不含正文）。
 */
export async function createAndStreamRun(
  request: AgentRunCreateRequestDto,
  options: RunStreamOptions = {}
): Promise<ApiResult<RunTerminalDto>> {
  const acceptedResponse = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: options.signal
  });
  const accepted = await parseApiResult<AgentRunAcceptedDto>(acceptedResponse);
  if (!accepted.ok) return accepted;
  // accepted hook 可先提交取消等控制操作，再进入 SSE，避免创建响应与用户停止之间遗留后台 Run。
  await options.onAccepted?.(accepted.data);

  let lastSequence = 0;
  const maxReconnects = options.maxReconnects ?? 3;
  for (let attempt = 0; attempt <= maxReconnects; attempt += 1) {
    const terminal = await consumeRunStream(accepted.data, lastSequence, options, (sequence) => {
      lastSequence = Math.max(lastSequence, sequence);
    });
    if (terminal) return terminal;
    if (options.signal?.aborted) return cancelled(accepted.data.requestId);
  }
  return readTerminalSnapshot(accepted.data);
}

/**
 * 显式取消运行；关闭浏览器流不等于取消后台任务。
 *
 * @param runId Run 标识。
 * @returns 最新 Run 快照（新协议 V2）。
 */
export async function cancelRun(runId: string): Promise<ApiResult<RunSnapshotDtoV2>> {
  return parseApiResult(await fetch(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE" }));
}

/**
 * 消费一段 SSE 流；遇到终止事件返回终态摘要，断流返回 undefined 触发续传。
 *
 * @param accepted Run 创建响应。
 * @param lastSequence 已消费的最大事件序号。
 * @param options 流配置。
 * @param recordSequence 序号高水位记录回调。
 * @returns 终态摘要或 undefined（连接中断）。
 */
async function consumeRunStream(
  accepted: AgentRunAcceptedDto,
  lastSequence: number,
  options: RunStreamOptions,
  recordSequence: (sequence: number) => void
): Promise<ApiResult<RunTerminalDto> | undefined> {
  // 断线续传：afterSequence 与 Last-Event-ID 同时携带，服务端取大者。
  const separator = accepted.eventsUrl.includes("?") ? "&" : "?";
  const url = lastSequence > 0
    ? `${accepted.eventsUrl}${separator}afterSequence=${lastSequence}`
    : accepted.eventsUrl;
  const response = await fetch(url, {
    headers: { accept: "text/event-stream", ...(lastSequence ? { "last-event-id": String(lastSequence) } : {}) },
    signal: options.signal
  });
  if (!response.ok || !response.body) return undefined;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const result = consumeFrame(frame, options.onEvent, recordSequence);
      if (result) return result;
    }
    if (chunk.done) return undefined;
  }
}

/**
 * 解析单个 SSE 帧（`event: run_event` + JSON envelope）并判定终止事件。
 *
 * @param frame 原始 SSE 帧文本。
 * @param onEvent 事件回调。
 * @param recordSequence 序号高水位记录回调。
 * @returns 终止事件对应的终态摘要；非终止帧返回 undefined。
 */
function consumeFrame(
  frame: string,
  onEvent: RunStreamOptions["onEvent"],
  recordSequence: (sequence: number) => void
): ApiResult<RunTerminalDto> | undefined {
  // 心跳行没有 data 字段，直接跳过；event 名不匹配也跳过。
  if (!frame.split("\n").some((line) => line === "event: run_event")) return undefined;
  const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
  if (!data) return undefined;
  const event = JSON.parse(data) as RunStreamEventDtoV2;
  recordSequence(event.sequence);
  onEvent?.(event);
  return terminalOf(event);
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
    error?: ApiError;
  };
  if (event.type === "run_error") {
    const error = payload.error ?? { code: "internal_error", message: "Run 失败。", requestId: event.requestId };
    return { ok: false, requestId: event.requestId, error: { ...error, requestId: error.requestId ?? event.requestId } };
  }
  if (event.type === "agent_end") {
    if (payload.error) {
      return {
        ok: false,
        requestId: event.requestId,
        error: { ...payload.error, requestId: payload.error.requestId ?? event.requestId }
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
        error: { code: "request_cancelled", message: "Run 已停止。", requestId: event.requestId }
      };
    }
    return {
      ok: false,
      requestId: event.requestId,
      error: payload.error
        ? { ...payload.error, requestId: payload.error.requestId ?? event.requestId }
        : { code: "internal_error", message: "Run 失败。", requestId: event.requestId }
    };
  }
  return undefined;
}

/**
 * 重连耗尽后读取 snapshot 兜底：新协议 snapshot 只有状态，终态正文由调用方重新拉取消息列表。
 *
 * @param accepted Run 创建响应。
 * @returns snapshot 推导出的终态摘要。
 */
async function readTerminalSnapshot(accepted: AgentRunAcceptedDto): Promise<ApiResult<RunTerminalDto>> {
  const snapshot = await parseApiResult<RunSnapshotDtoV2>(await fetch(accepted.snapshotUrl));
  if (!snapshot.ok) return snapshot;
  const { status } = snapshot.data;
  if (status === "completed") {
    return { ok: true, requestId: snapshot.data.requestId, data: { status, requestId: snapshot.data.requestId } };
  }
  if (snapshot.data.error) return { ok: false, error: snapshot.data.error as ApiError, requestId: snapshot.data.requestId };
  if (status === "cancelled" || status === "interrupted") return cancelled(snapshot.data.requestId);
  return {
    ok: false,
    requestId: snapshot.data.requestId,
    error: {
      code: "internal_error",
      message: "事件流重连失败，Run 尚未进入可恢复终态。",
      requestId: snapshot.data.requestId,
      details: { status }
    }
  };
}

/** @param requestId 请求 ID。 @returns 浏览器侧主动停止的结构化结果。 */
function cancelled(requestId: string): ApiResult<RunTerminalDto> {
  return {
    ok: false,
    requestId,
    error: { code: "request_cancelled", message: "浏览器已停止等待 Run。", requestId }
  };
}
