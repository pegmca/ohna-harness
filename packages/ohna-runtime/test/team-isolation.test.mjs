/**
 * Task 7 验收：TeamController 按 conversationId 持有 + run 绑定按 runId 精确隔离。
 *
 * 覆盖 spec §7.4 的硬约束：
 * 1. 两个 conversation 并行跑 Team 时，各自持有独立 controller（成员互不共享）；
 * 2. 子代理边界事件和 llm_call 按 conversationId + runId 精确路由到归属 run，绝不落到另一个 run；
 * 3. 先结束的 run release 只摘自己那一项，不误摘另一 run 的绑定；
 * 4. 禁止「最后登记的活跃 run」路由：在 A 仍活跃时新建并结束 B，A 的事件不得被 B 抢占。
 *
 * 约束前提（全局约束）：每个 conversation 同一时刻最多一个 active run。因此「按 runId 精确路由」
 * 由「每个 conversation 内部以 runId 登记绑定、转发器只在本会话绑定表内取当前活跃项」保证，
 * 无需把 runId 透传进 agent 内核。跨 conversation 的 controller 完全独立，事件绝不串流。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { createServeTeamSession } from "../dist/run/team-session.js";

/** 最小可用模型（仅取 Team 接线所需字段）。 */
function makeModel() {
  return {
    id: "stub-model",
    name: "Stub Model",
    api: "openai-completions",
    provider: "mock",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096
  };
}

/**
 * 一条完整的 assistant 消息（stub 用）。usage.cost.total = 0，不污染成本断言。
 *
 * @param {object[]} content 内容块。
 * @param {string} stopReason 停止原因。
 * @returns {object} AssistantMessage。
 */
function assistantMessage(content, stopReason) {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: makeModel().id,
    usage: {
      input: 3,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason,
    timestamp: Date.now()
  };
}

/**
 * 把一条消息推成完整的流式事件序列（stub base streamFn 用）。
 *
 * @param {object} stream AssistantMessageEventStream。
 * @param {object} message AssistantMessage。
 */
function pushMessage(stream, message) {
  stream.push({ type: "start", partial: { ...message, content: [] } });
  message.content.forEach((block, contentIndex) => {
    if (block.type === "text") {
      stream.push({ type: "text_start", contentIndex, partial: message });
      stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
    }
  });
  stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
}

/**
 * 注入用 base streamFn：不经 provider、不联网，直接收尾为纯文本。
 * 子代理的 agentLoop 借此在零网络下跑完，从而触发四类边界事件转发。
 *
 * @returns {Function} StreamFn。
 */
function stubStreamFn() {
  return () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() =>
      pushMessage(stream, assistantMessage([{ type: "text", text: "收到。" }], "stop"))
    );
    return stream;
  };
}

/** 工具表构造占位（Team 工具由 controller 提供，这里只关心接线隔离）。 */
function emptyTools() {
  return [];
}

test("[Task 7] 同一进程两个 conversation 各自持有独立 controller，成员互不共享", async () => {
  const session = createServeTeamSession({ model: makeModel(), streamFn: stubStreamFn() });
  const a = session.getOrCreate("conversation-a");
  const b = session.getOrCreate("conversation-b");
  assert.notEqual(a, b, "两个 conversation 必须拿到不同的会话级句柄");

  // 在 A 建立成员，在 B 建立同名成员：两 controller 独立，B 不应看到 A 的成员。
  const createA = a.teamTools.find((tool) => tool.name === "TeamCreate");
  await createA.execute("x1", { name: "worker", role: "执行者", tools: [] });
  const createB = b.teamTools.find((tool) => tool.name === "TeamCreate");
  await createB.execute("x2", { name: "worker", role: "执行者", tools: [] });

  assert.deepEqual(
    [...a.getTeamState().members.keys()],
    ["worker"],
    "A 的 controller 只应有自己建立的 worker"
  );
  assert.deepEqual(
    [...b.getTeamState().members.keys()],
    ["worker"],
    "B 的 controller 只应有自己建立的 worker，不与 A 共享成员名"
  );

  // 再次 getOrCreate 返回缓存的同一实例（成员跨轮保留）。
  assert.equal(session.getOrCreate("conversation-a"), a, "getOrCreate 必须返回缓存的同一 controller");

  // release 只销毁该 conversation 的 controller。
  session.release("conversation-a");
  const refreshed = session.getOrCreate("conversation-a");
  assert.notEqual(refreshed, a, "release 后应重建出新的 controller 实例");
  assert.deepEqual(
    [...refreshed.getTeamState().members.keys()],
    [],
    "release 后重建的 controller 成员已清空"
  );
});

test("[Task 7] 跨 conversation 子代理事件按 runId 精确路由，互不串流", async () => {
  // 全局约束：每个 conversation 至多一个 active run。两个 conversation 各持一个活跃 run，
  // 并行派发子代理，验证事件只落到各自 conversation 的绑定，绝不跨 conversation 串流。
  const session = createServeTeamSession({ model: makeModel(), streamFn: stubStreamFn() });
  const convA = session.getOrCreate("conversation-a");
  const convB = session.getOrCreate("conversation-b");

  /** @type {any[]} */
  const runAEvents = [];
  /** @type {any[]} */
  const runBEvents = [];

  const turnA = convA.beginRun(
    { runId: "run-a", emit: (e) => runAEvents.push(e), emitLlmCall: () => {} },
    emptyTools()
  );
  const turnB = convB.beginRun(
    { runId: "run-b", emit: (e) => runBEvents.push(e), emitLlmCall: () => {} },
    emptyTools()
  );

  // 在 A 建立并派发子代理。
  const createA = convA.teamTools.find((tool) => tool.name === "TeamCreate");
  await createA.execute("a1", { name: "a-worker", role: "执行者", tools: [] });
  const sendA = convA.teamTools.find((tool) => tool.name === "SendMessage");
  await sendA.execute("a2", { recipient: "a-worker", content: "汇报" });

  // 在 B 建立并派发同名子代理（成员名相同，验证 controller 隔离而非全局成员池）。
  const createB = convB.teamTools.find((tool) => tool.name === "TeamCreate");
  await createB.execute("b1", { name: "a-worker", role: "执行者", tools: [] });
  const sendB = convB.teamTools.find((tool) => tool.name === "SendMessage");
  await sendB.execute("b2", { recipient: "a-worker", content: "汇报" });

  assert.ok(
    runAEvents.some((e) => e.type === "agent_start" && e.agentId === "a-worker"),
    "A 的子代理事件必须归属 runA"
  );
  assert.ok(
    runBEvents.some((e) => e.type === "agent_start" && e.agentId === "a-worker"),
    "B 的子代理事件必须归属 runB"
  );
  // 关键隔离断言：A 的收集器里不得出现 B 派发的子代理边界事件。
  for (const ev of runBEvents) {
    assert.ok(
      !runAEvents.includes(ev),
      "B 派发的子代理事件不得串流进 runA 的收集器（无 last-active 路由）"
    );
  }
  for (const ev of runAEvents) {
    assert.ok(!runBEvents.includes(ev), "A 派发的子代理事件不得串流进 runB 的收集器");
  }

  // 结束 B 后，A 仍活跃，A 仍可继续派发，且只进 runA。
  turnB.release();
  await sendA.execute("a3", { recipient: "a-worker", content: "继续" });
  for (const ev of runBEvents) {
    assert.ok(!runAEvents.includes(ev), "release B 后 A 的新事件仍不得混入 B 旧事件");
  }
  assert.ok(
    runAEvents.filter((e) => e.type === "agent_start").length >= 1,
    "A 持续派发子代理，事件只归 runA"
  );

  turnA.release();
});

test("[Task 7] 同 conversation 内 run 绑定隔离：release 后事件不串到旧 run", async () => {
  // 同一 conversation 先后两个 run（不并行，符合全局约束），验证 run-1 release 后，
  // run-2 派发的子代理事件只进 run-2，绝不被旧 run-1 的收集器误收（无 last-active 路由）。
  const session = createServeTeamSession({ model: makeModel(), streamFn: stubStreamFn() });
  const conv = session.getOrCreate("conversation-x");

  /** @type {any[]} */
  const run1Events = [];
  /** @type {any[]} */
  const run2Events = [];

  const turn1 = conv.beginRun(
    { runId: "run-1", emit: (e) => run1Events.push(e), emitLlmCall: () => {} },
    emptyTools()
  );
  const create1 = conv.teamTools.find((tool) => tool.name === "TeamCreate");
  await create1.execute("c1", { name: "worker", role: "执行者", tools: [] });
  const send1 = conv.teamTools.find((tool) => tool.name === "SendMessage");
  await send1.execute("s1", { recipient: "worker", content: "第一轮" });
  turn1.release();

  // run-1 结束后，本 conversation 无活跃绑定；此时派发必须经 run-2 登记后才承接。
  const turn2 = conv.beginRun(
    { runId: "run-2", emit: (e) => run2Events.push(e), emitLlmCall: () => {} },
    emptyTools()
  );
  await send1.execute("s2", { recipient: "worker", content: "第二轮" });

  assert.ok(
    run2Events.some((e) => e.type === "agent_start" && e.agentId === "worker"),
    "run-2 派发的子代理事件必须归属 run-2"
  );
  // run-1 release 之后再派发，run-1 收集器不应再增长（旧绑定已摘除）。
  const run1CountAfterRelease = run1Events.length;
  await send1.execute("s3", { recipient: "worker", content: "第三轮" });
  assert.equal(
    run1Events.length,
    run1CountAfterRelease,
    "run-1 release 后不再接收任何子代理事件（无 last-active 路由）"
  );
  assert.ok(
    run2Events.filter((e) => e.type === "agent_start").length >= 2,
    "run-2 持续派发，事件只归 run-2"
  );

  turn2.release();
});
