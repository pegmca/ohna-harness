/**
 * P1 完整 checkpoint 续跑验证（docs/v1.2 §4 P1）。
 *
 * 验证 execute 真正消费 snapshot.lastCheckpoint：在 (re)start 时若已有检查点，
 * 从已落库消息重建上下文（含 prompt + 已完成轮次的 assistant/toolResult）并从最近检查点续跑，
 * 跳过已完成轮次（不重放 LLM / 读类工具），且写类工具经确定性去重键复用、绝不重放副作用。
 *
 * 用内存事实源构造一个"崩溃后 recoverStale 式重排"场景：
 *   run1：完成 2 轮（轮 1 调写类工具 generate_report，轮 2 调读类工具 lookup）后于第 3 轮生成时崩溃，
 *         留下 checkpoint.turn=2 与已落库消息；
 *   run2：重置为 queued 后再次 execute，应只从第 3 轮续跑。run2 的第 3 轮用与 run1 轮 1
 *         完全相同的参数重新调用写类工具 generate_report，以验证确定性去重键命中、复用已落结果、
 *         绝不重跑副作用（原单步脚本即便续跑损坏也只会产出 1 次 LLM 调用，断言被混淆）。
 * 断言：
 *   (a) run2 的 LLM 调用次数为 2（仅续跑出的第 3、4 轮），非完整重放的 4 次；
 *   (b) 写类工具真实执行次数跨 run1+run2 恒为 1：run2 第 3 轮同名同参调用命中确定性去重键、
 *       复用已落结果，不重跑副作用（正确性红线）；
 *   (c) 读类工具同样只执行 1 次（run1 命中），run2 不重放；
 *   (d) run2 最终 completed。
 */
import assert from "node:assert/strict";
import test from "node:test";
import z from "zod";
import { createRunApplicationService } from "../dist/application/run-service.js";
import { createInMemoryConversationStores } from "../dist/adapters/in-memory-conversation-store.js";
import {
  createInMemoryRunEventBus,
  createInMemoryExecutionRegistry,
  createInMemoryToolResultStore,
  createInMemoryRunCancelStore,
} from "../dist/adapters/in-memory-run-runtime.js";
import { createInMemoryBudgetTracker } from "../dist/application/budget-tracker.js";

const RUN_ID = "run-checkpoint-resume-1";
const USER_ID = "user-checkpoint-resume-1";
const CONVERSATION_ID = "conv-checkpoint-resume-1";
const MODEL_ID = "mock-resume";

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};

/** 构造一个带副作用计数器的写类工具替身（模拟 generate_report 这类有副作用的工具）。 */
function makeWriteTool(counter, name = "generate_report") {
  return {
    name,
    description: `${name} (test double)`,
    label: "Report",
    parameters: z.object({ subject: z.string() }),
    async execute(_toolCallId, params) {
      counter.count += 1;
      return { content: [{ type: "text", text: `report:${params.subject}` }], details: {} };
    }
  };
}

/** 构造一个带副作用计数器的读类工具替身（模拟只读检索，重放无副作用但应被跳过）。 */
function makeReadTool(counter, name = "lookup") {
  return {
    name,
    description: `${name} (test double)`,
    label: "Lookup",
    parameters: z.object({ query: z.string() }),
    async execute(_toolCallId, params) {
      counter.count += 1;
      return { content: [{ type: "text", text: `lookup:${params.query}` }], details: {} };
    }
  };
}

/**
 * 构造一个确定性 mock streamFn：按脚本逐轮产出 assistant 消息。
 * 脚本元素可为 { toolCall: {name,args} }（带工具调用的中间轮）或 { final: text }（终态回答），
 * 或 { crash: true }（该轮生成时抛出，模拟崩溃）。
 *
 * @param script 逐轮脚本。
 * @param callCounter 跨实例共享的调用计数（用于断言 LLM 被调用次数）。
 * @returns streamFn 替身。
 */
function makeScriptedStreamFn(script, callCounter) {
  return (model) => {
    const index = callCounter.count;
    callCounter.count += 1;
    const step = script[index] ?? script[script.length - 1];
    async function* generator() {
      if (step?.crash) throw new Error(`simulated crash at turn ${index + 1}`);
      let content;
      if (step?.toolCall) {
        content = [{ type: "toolCall", id: `tc-${index + 1}`, name: step.toolCall.name, arguments: step.toolCall.args }];
      } else {
        content = [{ type: "text", text: step?.final ?? "answer" }];
      }
      const message = {
        role: "assistant",
        content,
        api: "openai-completions",
        provider: "mock",
        model: model.id,
        usage: ZERO_USAGE,
        stopReason: step?.toolCall ? "tool_calls" : "stop",
        timestamp: Date.now()
      };
      yield { type: "start", partial: { ...message, content: [] } };
      yield { type: "done", reason: message.stopReason, message };
    }
    return {
      [Symbol.asyncIterator]: generator,
      async result() {
        let content;
        if (step?.toolCall) content = [{ type: "toolCall", id: `tc-${index + 1}`, name: step.toolCall.name, arguments: step.toolCall.args }];
        else content = [{ type: "text", text: step?.final ?? "answer" }];
        return { role: "assistant", content, api: "openai-completions", provider: "mock", model: model.id, usage: ZERO_USAGE, stopReason: step?.toolCall ? "tool_calls" : "stop", timestamp: Date.now() };
      }
    };
  };
}

/**
 * 内存 RunStore（测试用）：对齐 createInMemoryRunStore 的语义，额外暴露 resetToQueued，
 * 用于模拟 recoverStale 把崩溃 run 重置为 queued 后重新 claim 执行（保留 lastCheckpoint）。
 */
function createResumableRunStore({ messageStore }) {
  const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
  const runs = new Map();
  function statusFromEvent(event, current) {
    if (event.type === "run_status") return event.payload?.status ?? current;
    if (event.type === "run_error") return event.payload?.error?.code === "request_cancelled" ? "cancelled" : "failed";
    if (event.type === "agent_end") {
      const payload = event.payload ?? {};
      if (payload.error) return "failed";
      const last = [...(payload.messages ?? [])].reverse().find((m) => m.role === "assistant");
      if (last?.stopReason === "aborted") return "cancelled";
      if (last?.stopReason === "error") return "failed";
      return "completed";
    }
    return current;
  }
  return {
    async create(input) {
      const existing = [...runs.values()].find((r) => r.snapshot.requestId === input.requestId && r.userId === input.userId);
      if (existing) return { snapshot: structuredClone(existing.snapshot), created: false };
      const msg = messageStore
        ? await messageStore.appendUserMessageIdempotently(input.userId, {
            conversationId: input.conversationId, runId: input.runId, role: "user",
            content: input.message, clientMessageId: input.clientMessageId, createdAt: input.createdAt
          })
        : undefined;
      const snapshot = {
        runId: input.runId, requestId: input.requestId, conversationId: input.conversationId,
        userMessageId: msg?.message?.id ?? `um-${input.runId}`, modelId: input.modelId, mode: input.mode,
        source: input.source, status: "queued", lastEventSequence: 0, createdAt: input.createdAt, updatedAt: input.createdAt
      };
      runs.set(input.runId, { snapshot, userId: input.userId, events: [], requestPayload: structuredClone(input.requestPayload) });
      return { snapshot: structuredClone(snapshot), created: true };
    },
    async findById(userId, runId) {
      const run = runs.get(runId);
      return run?.userId === userId ? structuredClone(run.snapshot) : undefined;
    },
    async appendEvent(userId, runId, eventInput) {
      const run = runs.get(runId);
      if (!run || run.userId !== userId || TERMINAL.has(run.snapshot.status)) return undefined;
      const nextStatus = statusFromEvent(eventInput, run.snapshot.status);
      const event = { ...structuredClone(eventInput), eventId: `ev-${run.events.length + 1}`, sequence: run.events.length + 1 };
      run.events.push(event);
      run.snapshot = { ...run.snapshot, status: nextStatus, updatedAt: event.createdAt, lastEventSequence: event.sequence };
      return structuredClone(event);
    },
    async listEvents(userId, runId, afterSequence) {
      const run = runs.get(runId);
      return run?.userId === userId ? structuredClone(run.events.filter((e) => e.sequence > afterSequence)) : undefined;
    },
    async recoverStale() { return []; },
    async setCheckpoint(userId, runId, checkpoint) {
      const run = runs.get(runId);
      if (run && run.userId === userId) run.snapshot.lastCheckpoint = checkpoint;
    },
    async claimNext() { return undefined; },
    async renewLease() { return false; },
    async release() {},
    /** 模拟 recoverStale 把崩溃 run 重置为 queued 重新执行（保留 lastCheckpoint）。 */
    resetToQueued(runId) {
      const run = runs.get(runId);
      if (run) run.snapshot = { ...run.snapshot, status: "queued", leaseUntil: null, claimedBy: null };
    },
    /** 测试读取最终快照。 */
    snapshot(runId) { return runs.get(runId)?.snapshot; }
  };
}

test("P1 续跑：已完成轮次不重放 LLM，写类工具复用已落结果不重跑副作用", async () => {
  const conversationStores = createInMemoryConversationStores();
  const messageStore = conversationStores.messageStore;
  // run 创建前需存在会话（messageStore 归属校验依赖会话行）；会话 id 须与请求 conversationId 一致。
  await conversationStores.conversationRepository.create(USER_ID, { id: CONVERSATION_ID, title: "checkpoint-resume 会话" });
  const runStore = createResumableRunStore({ messageStore });
  const toolResultStore = createInMemoryToolResultStore();
  const cancelStore = createInMemoryRunCancelStore();

  const reportCounter = { count: 0 };
  const lookupCounter = { count: 0 };
  const generateReport = makeWriteTool(reportCounter);
  const lookup = makeReadTool(lookupCounter);

  // 跨两次 execute 共享同一工具实例，counter 累积，用于断言副作用未被重复执行。
  const tools = [generateReport, lookup];
  const writeToolNames = ["generate_report"];

  const request = {
    message: "研究宁德时代并生成研报",
    conversationId: CONVERSATION_ID,
    modelId: MODEL_ID,
    mode: "auto",
    source: "composer"
  };

  // run1：第 1 轮调写类工具、第 2 轮调读类工具、第 3 轮生成时崩溃。
  const run1Calls = { count: 0 };
  const run1StreamFn = makeScriptedStreamFn([
    { toolCall: { name: "generate_report", args: { subject: "宁德时代" } } },
    { toolCall: { name: "lookup", args: { query: "ROE" } } },
    { crash: true }
  ], run1Calls);

  const service1 = createRunApplicationService({
    store: runStore,
    messageStore,
    eventBus: createInMemoryRunEventBus(),
    executionRegistry: createInMemoryExecutionRegistry(),
    resolveModel: () => ({ model: { id: MODEL_ID, name: "mock", api: "openai-completions", provider: "mock", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }, apiKey: "test", streamFn: run1StreamFn }),
    tools,
    attachmentRepository: { bindMessageByDocumentId: async () => {}, findByDocumentId: async () => undefined },
    citationRepository: { saveMessageCitations: async () => {} },
    writeToolNames,
    toolResultStore,
    cancelStore,
    budgetTracker: createInMemoryBudgetTracker({}),
    // 固定 runId 便于在两次 execute 间用同一 runId 续跑（默认 randomUUID 会使 runId 不可控）。
    createId: (prefix) => (prefix === "run" ? RUN_ID : `${prefix}-${RUN_ID}`)
  });

  const created = await service1.create(request, USER_ID);
  assert.equal(created.runId, RUN_ID);
  await service1.execute(RUN_ID, request, USER_ID);

  // run1 崩溃于第 3 轮：应当已落库 2 轮消息、检查点 turn=2，且写/读工具各执行 1 次。
  const snapshotAfterCrash = runStore.snapshot(RUN_ID);
  assert.equal(snapshotAfterCrash.lastCheckpoint?.turn, 2, "崩溃后检查点应停在已完成轮次（turn=2）");
  assert.equal(reportCounter.count, 1, "run1 应真实执行写类工具 1 次");
  assert.equal(lookupCounter.count, 1, "run1 应真实执行读类工具 1 次");
  assert.equal(run1Calls.count, 3, "run1 的 LLM 被调用 3 次（含崩溃的第 3 轮）");

  // 模拟 recoverStale：重置为 queued 但保留检查点，重新 claim 后再次 execute。
  runStore.resetToQueued(RUN_ID);
  const run2Calls = { count: 0 };
  // 续跑两步：第 3 轮用与 run1 轮 1 完全相同参数重新调用写类工具 generate_report（验证确定性去重键命中、
  // 复用已落结果、不重跑副作用），第 4 轮产出终态回答。
  const run2StreamFn = makeScriptedStreamFn([
    { toolCall: { name: "generate_report", args: { subject: "宁德时代" } } },
    { final: "基于前面的研究与研报，结论如下……" }
  ], run2Calls);

  const service2 = createRunApplicationService({
    store: runStore,
    messageStore,
    eventBus: createInMemoryRunEventBus(),
    executionRegistry: createInMemoryExecutionRegistry(),
    resolveModel: () => ({ model: { id: MODEL_ID, name: "mock", api: "openai-completions", provider: "mock", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }, apiKey: "test", streamFn: run2StreamFn }),
    tools,
    attachmentRepository: { bindMessageByDocumentId: async () => {}, findByDocumentId: async () => undefined },
    citationRepository: { saveMessageCitations: async () => {} },
    writeToolNames,
    toolResultStore,
    cancelStore,
    budgetTracker: createInMemoryBudgetTracker({}),
    // 固定 runId 便于在两次 execute 间用同一 runId 续跑（默认 randomUUID 会使 runId 不可控）。
    createId: (prefix) => (prefix === "run" ? RUN_ID : `${prefix}-${RUN_ID}`)
  });

  await service2.execute(RUN_ID, request, USER_ID);

  const finalSnapshot = runStore.snapshot(RUN_ID);
  assert.equal(finalSnapshot.status, "completed", "续跑后应正常完成");

  // (a) 续跑只从第 3 轮生成：LLM 调用 2 次（第 3、4 轮），而非完整重放的 4 次（含 run1 的 2 轮 + 崩溃第 3 轮）。
  assert.equal(run2Calls.count, 2, "续跑应跳过已完成轮次，LLM 仅被调用 2 次（第 3、4 轮）");

  // (b) 写类工具跨 run1+run2 真实执行次数恒为 1：run2 第 3 轮同名同参重新调用 generate_report，
  //     命中确定性去重键、复用已落结果，绝不重跑副作用（正确性红线，原单步脚本的断言被混淆）。
  assert.equal(reportCounter.count, 1, "写类工具续跑同名同参调用应命中去重键复用结果，不重跑副作用（副作用红线）");

  // (c) 读类工具同样在已完成轮次中执行过，续跑不重放。
  assert.equal(lookupCounter.count, 1, "读类工具不应在续跑中被重复执行");

  // 检查点推进到完成轮次：终态前第 4 轮（run2 第 2 轮）已 checkpoint。
  assert.ok(finalSnapshot.lastCheckpoint?.turn >= 4, "续跑后检查点应推进到第 4 轮");
});
