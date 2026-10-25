/**
 * Trace 测试共享 fixture（03 L2 / v2.0 W3）：从原 `TracePage.test.tsx` 迁移而来。
 *
 * hook 测试（`use-trace-stream.test.tsx`）与抽屉渲染测试（`TraceDrawer.test.tsx`）
 * 共用同一组 run / 事件样本，保证「数据编排」与「展示」两层用同一份真实顺序的事件。
 *
 * v2.0 形状（docs/v2.0/04 头声明不向后兼容）：`llm_call` 记录必带 `window`，
 * 边界事件必带 `agentId` / `turnIndex`；Team run 额外包含子代理的身份与交错事件。
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

/** Team run 的摘要（auto 模式，模型同 stub-model）。 */
export const teamRun: RunMetaDtoV2 = {
  ...managedRun,
  runId: "run-team-4",
  requestId: "req-4",
  createdAt: "2026-10-20T00:00:04.000Z"
};

export const llmRecord: LlmCallRecordDto = {
  callId: "call-1",
  callIndex: 1,
  startedAt: 1,
  durationMs: 42,
  attemptCount: 1,
  // v2.0 形状：window 必填、agentId 归 supervisor、composition 为 onPayload 现算的五分类构成。
  window: { contextWindow: 128000, maxTokens: 4096, reserveTokens: 16384 },
  agentId: "supervisor",
  composition: { system: 3, tools: 0, user: 1, assistant: 0, toolResult: 0, total: 4 },
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
 * 构造一条带指定 agentId 身份的 LLM 调用记录。
 *
 * @param agentId 发起方（未传表示错误路径下未打标）。
 * @param callIndex run 内序号（两条链各自计数，Team 场景会出现同号）。
 * @param overrides 需要覆盖的字段。
 * @returns 新的采集记录。
 */
export function llmRecordFor(
  agentId: string | undefined,
  callIndex: number,
  overrides: Partial<LlmCallRecordDto> = {}
): LlmCallRecordDto {
  return {
    ...llmRecord,
    callId: `call-${agentId ?? "anon"}-${callIndex}`,
    callIndex,
    agentId,
    ...overrides
  };
}

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

/**
 * 构造 agent_start 的 payload。
 *
 * @param agentId 身份。
 * @param parentId 父身份（Team 子代理为 supervisor）。
 * @param label 展示名。
 * @param role 角色。
 * @returns payload。
 */
export function agentStartPayload(
  agentId: string,
  parentId: string | undefined,
  label: string,
  role: string
): unknown {
  return { type: "agent_start", agentId, parentId, label, role, modelId: "stub-model" };
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

/**
 * 单 run（非 Team）v2.0 事件序列：带身份与 turn 边界，用于执行地图/TurnGroup 断言。
 *
 * @returns 7 帧事件（含一次 compaction 与一次工具调用）。
 */
export function singleAgentEvents(): RunStreamEventDtoV2[] {
  return [
    runEvent(1, "context_event", {
      kind: "compaction",
      tokensBefore: 62000,
      tokensAfter: 12000,
      detail: "保留最近 6 轮，摘要 480 字符"
    }),
    // `user_message` 不在 `RunStreamEventDtoV2["type"]` 的可枚举联合里（消息正文走会话端点），
    // 这里用 message_end 承载「用户消息先到」的真实顺序。
    runEvent(2, "message_end", { type: "message_end", agentId: "supervisor", message: { role: "user", content: "hello" } }),
    runEvent(3, "agent_start", agentStartPayload("supervisor", undefined, "supervisor", "supervisor")),
    runEvent(4, "turn_start", { type: "turn_start", agentId: "supervisor", turnIndex: 0 }),
    runEvent(5, "message_end", { type: "message_end", agentId: "supervisor", message: { role: "user", content: "hello" } }),
    runEvent(6, "llm_call", llmRecord),
    runEvent(7, "tool_execution_start", { type: "tool_execution_start", agentId: "supervisor", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } }),
    runEvent(8, "tool_execution_end", { type: "tool_execution_end", agentId: "supervisor", toolCallId: "t1", toolName: "read", result: { ok: true } }),
    runEvent(9, "turn_end", { type: "turn_end", agentId: "supervisor", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] }),
    runEvent(10, "turn_start", { type: "turn_start", agentId: "supervisor", turnIndex: 1 }),
    runEvent(11, "llm_call", llmRecordFor("supervisor", 2)),
    runEvent(12, "turn_end", { type: "turn_end", agentId: "supervisor", turnIndex: 1, message: { role: "assistant", content: [] }, toolResults: [] }),
    runEvent(13, "agent_end", { type: "agent_end", agentId: "supervisor", messages: [] }),
    runEvent(14, "run_status", { status: "completed" })
  ];
}

/**
 * Team run 事件序列：主线程与两个子代理的事件**交错**出现。
 *
 * 交错是真实形态（子代理运行嵌在主线程的工具执行之间），因此这里刻意让
 * `spawn-agent` 的 turn_start 落在 supervisor 的 turn 1 中间、`researcher` 的
 * llm_call 又落在 supervisor 的 turn 2 期间，用来验证「按键归属而非区间切割」。
 *
 * @returns Team run 事件序列。
 */
export function teamRunEvents(): RunStreamEventDtoV2[] {
  return [
    runEvent(1, "agent_start", agentStartPayload("supervisor", undefined, "supervisor", "supervisor"), "run-team-4"),
    runEvent(2, "turn_start", { type: "turn_start", agentId: "supervisor", turnIndex: 0 }, "run-team-4"),
    runEvent(3, "message_end", { type: "message_end", agentId: "supervisor", message: { role: "user", content: "拆解任务" } }, "run-team-4"),
    runEvent(4, "llm_call", llmRecordFor("supervisor", 1), "run-team-4"),
    runEvent(5, "tool_execution_start", { type: "tool_execution_start", agentId: "supervisor", toolCallId: "spawn-1", toolName: "spawn_agent", args: { name: "researcher" } }, "run-team-4"),
    runEvent(6, "agent_start", agentStartPayload("researcher", "supervisor", "researcher", "researcher"), "run-team-4"),
    runEvent(7, "turn_start", { type: "turn_start", agentId: "researcher", turnIndex: 0 }, "run-team-4"),
    runEvent(8, "llm_call", llmRecordFor("researcher", 1), "run-team-4"),
    runEvent(9, "tool_execution_end", { type: "tool_execution_end", agentId: "supervisor", toolCallId: "spawn-1", toolName: "spawn_agent", result: { agentId: "researcher" } }, "run-team-4"),
    runEvent(10, "turn_end", { type: "turn_end", agentId: "researcher", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] }, "run-team-4"),
    runEvent(11, "agent_end", { type: "agent_end", agentId: "researcher", messages: [] }, "run-team-4"),
    runEvent(12, "turn_end", { type: "turn_end", agentId: "supervisor", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] }, "run-team-4"),
    runEvent(13, "turn_start", { type: "turn_start", agentId: "supervisor", turnIndex: 1 }, "run-team-4"),
    runEvent(14, "agent_start", agentStartPayload("spawn-agent", "supervisor", "spawn-agent", "worker"), "run-team-4"),
    runEvent(15, "turn_start", { type: "turn_start", agentId: "spawn-agent", turnIndex: 0 }, "run-team-4"),
    runEvent(16, "llm_call", llmRecordFor("spawn-agent", 1), "run-team-4"),
    runEvent(17, "turn_end", { type: "turn_end", agentId: "spawn-agent", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] }, "run-team-4"),
    runEvent(18, "agent_end", { type: "agent_end", agentId: "spawn-agent", messages: [] }, "run-team-4"),
    runEvent(19, "llm_call", llmRecordFor("supervisor", 2), "run-team-4"),
    runEvent(20, "turn_end", { type: "turn_end", agentId: "supervisor", turnIndex: 1, message: { role: "assistant", content: [] }, toolResults: [] }, "run-team-4"),
    runEvent(21, "agent_end", { type: "agent_end", agentId: "supervisor", messages: [] }, "run-team-4"),
    runEvent(22, "run_status", { status: "completed" }, "run-team-4")
  ];
}
