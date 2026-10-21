/**
 * Trace 测试共享 fixture（03 L2）：从原 `TracePage.test.tsx` 迁移而来。
 *
 * hook 测试（`use-trace-stream.test.tsx`）与抽屉渲染测试（`TraceDrawer.test.tsx`）
 * 共用同一组 run / 事件样本，保证「数据编排」与「展示」两层用同一份真实顺序的事件。
 */
import type { LlmCallRecordDto, RunMetaDtoV2, RunStreamEventDtoV2 } from "@aiagent/types";

export const terminalRun: RunMetaDtoV2 = {
  runId: "run-terminal-1",
  requestId: "sess-1:1",
  conversationId: "conv-1",
  modelId: "stub-model",
  mode: "observe",
  source: "cli",
  status: "completed",
  createdAt: "2026-10-20T00:00:01.000Z"
};

export const liveRun: RunMetaDtoV2 = {
  ...terminalRun,
  runId: "run-live-2",
  requestId: "sess-1:2",
  status: "running",
  createdAt: "2026-10-20T00:00:02.000Z"
};

export const managedRun: RunMetaDtoV2 = {
  ...terminalRun,
  runId: "run-managed-3",
  requestId: "req-3",
  mode: "auto",
  source: "composer",
  status: "completed",
  createdAt: "2026-10-20T00:00:03.000Z"
};

export const llmRecord: LlmCallRecordDto = {
  callId: "call-1",
  callIndex: 1,
  startedAt: 1,
  durationMs: 42,
  attemptCount: 1,
  request: {
    provider: "mock",
    api: "openai-completions",
    modelId: "stub-model",
    baseUrl: "http://127.0.0.1/mock",
    messages: [{ role: "user", content: "hi" }],
    providerPayload: { model: "stub-model", stream: true }
  },
  response: {
    status: 200,
    finishReason: "stop",
    usage: {
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    message: { role: "assistant", content: [{ type: "text", text: "done" }] }
  }
};

/**
 * 构造 canonical run 事件。
 *
 * @param sequence 序号。
 * @param type 事件类型。
 * @param payload 负载。
 * @param runId 事件所属 run（默认终态 run）。
 * @returns run 事件 envelope。
 */
export function runEvent(
  sequence: number,
  type: RunStreamEventDtoV2["type"],
  payload: unknown,
  runId = "run-terminal-1"
): RunStreamEventDtoV2 {
  return {
    eventId: `e-${runId}-${sequence}`,
    runId,
    requestId: "sess-1:1",
    conversationId: "conv-1",
    sequence,
    type,
    payload,
    createdAt: "2026-10-20T00:00:01.000Z"
  };
}

/** @returns 真实顺序：用户消息先收尾，再发生 LLM 调用，最后是助手消息与终态。 */
export function realOrderEvents(): RunStreamEventDtoV2[] {
  return [
    runEvent(1, "message_start", { message: { role: "user", content: "hello" } }),
    runEvent(2, "message_end", { message: { role: "user", content: "hello" } }),
    runEvent(3, "llm_call", llmRecord),
    runEvent(4, "message_start", { message: { role: "assistant", content: [] } }),
    runEvent(5, "message_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    runEvent(6, "run_status", { status: "completed" })
  ];
}
