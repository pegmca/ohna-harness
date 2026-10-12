import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageEventStream } from "@aiagent/ai";
import { createPlanner, createReflexionHook } from "../dist/plan-reflexion.js";

/** 构造一条 assistant 消息（测试用）。 */
function assistantMessage(content, stopReason = "stop") {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "mock-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
}

function textMessage(text, stopReason = "stop") {
  return assistantMessage([{ type: "text", text }], stopReason);
}

const MODEL = {
  id: "mock-model",
  name: "Mock",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

/**
 * 构造按序返回固定文本（一条 done 事件）的 mock streamFn。
 * @param text 最终 assistant 文本。
 */
function createTextStreamFn(text) {
  return (model, context, options) => {
    const message = textMessage(text);
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

/** 构造一个带唯一 message 的钩子上下文（每轮传入不同对象以触发新一次反思）。 */
function makeHookContext(turn) {
  const message = textMessage(`turn ${turn} answer`);
  return {
    message,
    toolResults: [],
    context: { systemPrompt: "sys", messages: [message], tools: [] },
    newMessages: [message],
  };
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

test("planner: valid JSON yields a parsed Plan with subtasks", async () => {
  const planJson = JSON.stringify({
    subtasks: [
      { id: "1", title: "调研", description: "收集资料", dependsOn: [] },
      { id: "2", title: "撰写", description: "产出报告", dependsOn: ["1"] },
    ],
  });
  const planner = createPlanner({ model: MODEL, streamFn: createTextStreamFn(planJson) });

  const plan = await planner.plan("写一份市场分析报告");

  assert.equal(plan.goal, "写一份市场分析报告");
  assert.equal(plan.subtasks.length, 2);
  assert.equal(plan.subtasks[0].id, "1");
  assert.equal(plan.subtasks[0].status, "pending");
  assert.deepEqual(plan.subtasks[1].dependsOn, ["1"]);
  assert.ok(plan.createdAt > 0);
});

test("planner: bare array JSON is also accepted", async () => {
  const planJson = JSON.stringify([
    { id: "a", title: "步骤A" },
    { id: "b", title: "步骤B", dependsOn: ["a"] },
  ]);
  const planner = createPlanner({ model: MODEL, streamFn: createTextStreamFn(planJson) });

  const plan = await planner.plan("做两件事");
  assert.equal(plan.subtasks.length, 2);
  assert.equal(plan.subtasks[1].dependsOn[0], "a");
});

test("planner: malformed JSON degrades to a single-subtask fallback Plan (no throw)", async () => {
  const planner = createPlanner({ model: MODEL, streamFn: createTextStreamFn("抱歉我无法规划这段文字") });

  const plan = await planner.plan("完成一个模糊目标");

  assert.equal(plan.subtasks.length, 1);
  assert.equal(plan.subtasks[0].id, "task-1");
  assert.equal(plan.subtasks[0].title, "完成一个模糊目标");
  assert.equal(plan.subtasks[0].status, "pending");
});

test("planner: stream error degrades gracefully to fallback Plan", async () => {
  const errorStreamFn = () => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      const msg = textMessage("boom", "error");
      stream.push({ type: "start", partial: msg });
      stream.push({ type: "error", reason: "error", error: msg });
    });
    return stream;
  };
  const planner = createPlanner({ model: MODEL, streamFn: errorStreamFn });

  const plan = await planner.plan("目标");
  assert.equal(plan.subtasks.length, 1);
});

// ---------------------------------------------------------------------------
// Reflexion
// ---------------------------------------------------------------------------

test("reflexion: satisfactory → hook allows stop (returns true, no base)", async () => {
  const hooks = createReflexionHook({
    model: MODEL,
    streamFn: createTextStreamFn(JSON.stringify({ satisfactory: true, critique: "" })),
  });

  const ctx = makeHookContext(1);
  const snapshot = await hooks.prepareNextTurn(ctx);
  const stop = await hooks.shouldStopAfterTurn(ctx);

  assert.equal(stop, true);
  // 满意时不注入 [反思]：prepareNextTurn 返回 undefined（无 base、无需改 context）。
  assert.equal(snapshot, undefined);
});

test("reflexion: unsatisfactory → returns false and prepareNextTurn injects [反思] message", async () => {
  const hooks = createReflexionHook({
    model: MODEL,
    streamFn: createTextStreamFn(JSON.stringify({ satisfactory: false, critique: "缺少数据来源" })),
  });

  const ctx = makeHookContext(1);
  const snapshot = await hooks.prepareNextTurn(ctx);
  const stop = await hooks.shouldStopAfterTurn(ctx);

  assert.equal(stop, false);
  assert.ok(snapshot && snapshot.context, "应返回带 context 的快照");
  const last = snapshot.context.messages[snapshot.context.messages.length - 1];
  assert.equal(last.role, "user");
  assert.match(last.content, /\[反思\]/);
  assert.match(last.content, /缺少数据来源/);
});

test("reflexion: reflection budget caps retries", async () => {
  const hooks = createReflexionHook({
    model: MODEL,
    maxReflections: 2,
    streamFn: createTextStreamFn(JSON.stringify({ satisfactory: false, critique: "还不够好" })),
  });

  // 第一轮：不满意 → false，注入反思。
  const ctx1 = makeHookContext(1);
  await hooks.prepareNextTurn(ctx1);
  assert.equal(await hooks.shouldStopAfterTurn(ctx1), false);

  // 第二轮：仍不满意，但已是最后一次重试 → 预算耗尽 → 允许停止（true）。
  const ctx2 = makeHookContext(2);
  await hooks.prepareNextTurn(ctx2);
  assert.equal(await hooks.shouldStopAfterTurn(ctx2), true);
});

test("reflexion: composes with baseShouldStop (does not override user budget)", async () => {
  let baseCalls = 0;
  const hooks = createReflexionHook({
    model: MODEL,
    streamFn: createTextStreamFn(JSON.stringify({ satisfactory: true, critique: "" })),
    baseShouldStop: (ctx) => {
      baseCalls += 1;
      return false; // 底层说"别停"
    },
  });

  const ctx = makeHookContext(1);
  await hooks.prepareNextTurn(ctx);
  const stop = await hooks.shouldStopAfterTurn(ctx);

  // 反思满意 → 委托 baseShouldStop，不做主循环的自我停止判定。
  assert.equal(stop, false);
  assert.equal(baseCalls, 1);
});

test("reflexion: composes with basePrepareNextTurn (appends critique on top of base)", async () => {
  const baseContext = { systemPrompt: "sys", messages: [{ role: "user", content: "preset" }], tools: [] };
  let baseCalls = 0;
  const hooks = createReflexionHook({
    model: MODEL,
    streamFn: createTextStreamFn(JSON.stringify({ satisfactory: false, critique: "请补充数据来源" })),
    basePrepareNextTurn: (ctx) => {
      baseCalls += 1;
      return { context: baseContext };
    },
  });

  const ctx = makeHookContext(1);
  const snapshot = await hooks.prepareNextTurn(ctx);
  // 不满意 → 应在 base 返回的 context 之上追加 [反思] 消息，而非覆盖底层。
  assert.equal(baseCalls, 1);
  assert.ok(snapshot && snapshot.context);
  assert.equal(snapshot.context.messages[0].content, "preset");
  const last = snapshot.context.messages[snapshot.context.messages.length - 1];
  assert.match(last.content, /\[反思\]/);
  assert.match(last.content, /请补充数据来源/);
});

test("reflexion: reflection LLM failure is treated as neutral (allows stop)", async () => {
  const errorStreamFn = () => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      const msg = textMessage("boom", "error");
      stream.push({ type: "start", partial: msg });
      stream.push({ type: "error", reason: "error", error: msg });
    });
    return stream;
  };
  const hooks = createReflexionHook({ model: MODEL, streamFn: errorStreamFn });

  const ctx = makeHookContext(1);
  await hooks.prepareNextTurn(ctx);
  const stop = await hooks.shouldStopAfterTurn(ctx);

  // 反思调用失败 → 中性，不阻断主循环，允许停止。
  assert.equal(stop, true);
});
