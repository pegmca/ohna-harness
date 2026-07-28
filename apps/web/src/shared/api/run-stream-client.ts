import type {
  AgentRunAcceptedDto,
  AgentRunCreateRequestDto,
  AgentRunResponseDto,
  AgentRunSnapshotDto,
  AgentRunStreamEventDto,
  ApiResult
} from "@aiagent/types";
import { parseApiResult } from "./http-client";

export interface RunStreamOptions {
  signal?: AbortSignal;
  onEvent?: (event: AgentRunStreamEventDto) => void;
  onAccepted?: (accepted: AgentRunAcceptedDto) => void | Promise<void>;
  maxReconnects?: number;
}

/**
 * 创建异步 Run 并消费 canonical SSE；断线时按 sequence 重放，最终以 snapshot 兜底。
 *
 * @param request Run 创建请求。
 * @param options 取消、事件回调与重连配置。
 * @returns Run 的终态结果。
 */
export async function createAndStreamRun(
  request: AgentRunCreateRequestDto,
  options: RunStreamOptions = {}
): Promise<ApiResult<AgentRunResponseDto>> {
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
 * @returns 最新 Run 快照。
 */
export async function cancelRun(runId: string): Promise<ApiResult<AgentRunSnapshotDto>> {
  return parseApiResult(await fetch(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE" }));
}

async function consumeRunStream(
  accepted: AgentRunAcceptedDto,
  lastSequence: number,
  options: RunStreamOptions,
  recordSequence: (sequence: number) => void
): Promise<ApiResult<AgentRunResponseDto> | undefined> {
  const response = await fetch(accepted.eventsUrl, {
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

function consumeFrame(
  frame: string,
  onEvent: RunStreamOptions["onEvent"],
  recordSequence: (sequence: number) => void
): ApiResult<AgentRunResponseDto> | undefined {
  const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
  if (!data) return undefined;
  const event = JSON.parse(data) as AgentRunStreamEventDto;
  recordSequence(event.sequence);
  onEvent?.(event);
  if (event.type === "run_result") return { ok: true, data: event.result, requestId: event.requestId };
  if (event.type === "run_error") return { ok: false, error: event.error, requestId: event.requestId };
  return undefined;
}

async function readTerminalSnapshot(accepted: AgentRunAcceptedDto): Promise<ApiResult<AgentRunResponseDto>> {
  const snapshot = await parseApiResult<AgentRunSnapshotDto>(await fetch(accepted.snapshotUrl));
  if (!snapshot.ok) return snapshot;
  if (snapshot.data.result) return { ok: true, data: snapshot.data.result, requestId: snapshot.data.requestId };
  if (snapshot.data.error) return { ok: false, error: snapshot.data.error, requestId: snapshot.data.requestId };
  if (snapshot.data.status === "cancelled") return cancelled(snapshot.data.requestId);
  return {
    ok: false,
    requestId: snapshot.data.requestId,
    error: {
      code: "internal_error",
      message: "事件流重连失败，Run 尚未进入可恢复终态。",
      requestId: snapshot.data.requestId,
      details: { status: snapshot.data.status }
    }
  };
}

function cancelled(requestId: string): ApiResult<AgentRunResponseDto> {
  return {
    ok: false,
    requestId,
    error: { code: "request_cancelled", message: "浏览器已停止等待 Run。", requestId }
  };
}
