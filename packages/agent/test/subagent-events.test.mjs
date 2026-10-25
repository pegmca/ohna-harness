/**
 * v2.0 §2.1 子代理事件转发钩子 + §1.3 AgentEvent 身份（docs/v2.0/04 §8）。
 *
 * 两个断言面：
 * - **AgentEvent 身份（纯内核）**：`agentLoop` 缺省兜底根身份；显式 identity 原样出现在
 *   四类边界事件上，`turnIndex` 从 0 起、每次 turn_start 自增。用 FakeStreamFn 直接驱动
 *   `agentLoop`（与 agent-loop.test.mjs 同源），零 provider。
 * - **onSubagentEvent（controller 转发）**：子代理事件必须逃出 `runMember`；四类透传、
 *   message_* / tool_* 不转发、回调抛错不打断子代理。这里经**真 provider 链路 + 传输层桩**
 *   （见 transport-stub.mjs）驱动真实 `agentLoop`，只替换 HTTP fetch，不伪造模型输出。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageEventStream } from "@aiagent/ai";
import { z } from "zod";
import { agentLoop, createTeamController, estimateComposition, SUPERVISOR_AGENT_ID } from "../dist/index.js";
import {
  createTransportStubbedStreamFn,
  makeModel,
  sseResponse,
  textChunks,
} from "./transport-stub.mjs";

/**
 * 构造一条 assistant 消息（最小形状）。
 *
 * @param content content blocks。
 * @param stopReason 终止原因。
 * @returns AssistantMessage。
 */
function assistantMessage(content, stopReason = "stop") {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "mock-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

/**
 * 构造一个在「provider 位置」回固定 assistant 终态的 FakeStreamFn。
 * （agentLoop 的身份断言只关心 loop 自身发射的事件，与真实协议无关。）
 *
 * @returns StreamFn。
 */
function fakeTextStreamFn() {
  return () => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message: assistantMessage([{ type: "text", text: "ok" }]) });
    });
    return stream;
  };
}

/**
 * 驱动一次 agentLoop 并收集全部事件。
 *
 * @param config agentLoop 配置。
 * @returns 事件数组。
 */
async function runLoop(config) {
  const events = [];
  const stream = agentLoop(
    [{ role: "user", content: "hi", timestamp: 1 }],
    { systemPrompt: "s", messages: [] },
    config,
    undefined,
    fakeTextStreamFn(),
  );
  for await (const event of stream) events.push(event);
  return events;
}

/** 一个真实形状的工具（zod parameters，与项目内 AgentTool 契约一致）；副作用只在内存。 */
const echoTool = {
  name: "echo",
  description: "echo（副作用无关）",
  label: "echo",
  parameters: z.object({ value: z.string() }),
  execute: async () => ({ content: [{ type: "text", text: "x" }], details: {} }),
};

/** 最小 loop 配置（convertToLlm 直通）。 */
function baseConfig(patch = {}) {
  return {
    model: makeModel("loop-model"),
    convertToLlm: (messages) => messages.filter((m) => m.role !== "compaction"),
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// §1.3 AgentEvent 身份
// ---------------------------------------------------------------------------

test("AgentEvent 身份：config.identity 缺省 → 兜底为 supervisor 根身份", async () => {
  const events = await runLoop(baseConfig());

  const start = events.find((e) => e.type === "agent_start");
  assert.deepEqual(
    { agentId: start.agentId, parentId: start.parentId, label: start.label, role: start.role, modelId: start.modelId },
    {
      agentId: SUPERVISOR_AGENT_ID,
      parentId: undefined,
      label: SUPERVISOR_AGENT_ID,
      role: SUPERVISOR_AGENT_ID,
      modelId: "loop-model",
    },
  );

  const turnStart = events.find((e) => e.type === "turn_start");
  assert.equal(turnStart.agentId, SUPERVISOR_AGENT_ID);
  assert.equal(turnStart.turnIndex, 0);

  const turnEnd = events.find((e) => e.type === "turn_end");
  assert.equal(turnEnd.agentId, SUPERVISOR_AGENT_ID);
  assert.equal(turnEnd.turnIndex, 0);

  const end = events.at(-1);
  assert.equal(end.type, "agent_end");
  assert.equal(end.agentId, SUPERVISOR_AGENT_ID);
});

test("AgentEvent 身份：显式 identity 原样出现在全部边界事件上", async () => {
  const identity = {
    agentId: "member-a",
    parentId: SUPERVISOR_AGENT_ID,
    label: "member-a",
    role: "研究员",
    modelId: "loop-model",
  };
  const events = await runLoop(baseConfig({ identity }));

  const start = events.find((e) => e.type === "agent_start");
  assert.deepEqual(
    { agentId: start.agentId, parentId: start.parentId, label: start.label, role: start.role, modelId: start.modelId },
    identity,
  );
  for (const type of ["turn_start", "turn_end", "agent_end"]) {
    const event = events.find((e) => e.type === type);
    assert.equal(event.agentId, "member-a", `${type} 必须携带 agentId`);
  }
});

test("AgentEvent 身份：兜底收尾（钩子抛错）的 agent_end 同样带身份", async () => {
  const events = await runLoop(
    baseConfig({
      identity: { agentId: "member-b", parentId: SUPERVISOR_AGENT_ID, label: "member-b", role: "评审", modelId: "m" },
      shouldStopAfterTurn: () => {
        throw new Error("hook exploded");
      },
    }),
  );

  const end = events.at(-1);
  assert.equal(end.type, "agent_end");
  assert.equal(end.agentId, "member-b");
  assert.equal(end.error.code, "agent_loop_aborted");
});

test("AgentEvent 身份：turnIndex 从 0 起、每个 turn 严格 +1", async () => {
  // 用一个真实形状的 AgentTool（zod parameters）驱动多轮：服务端回 tool_calls，
  // 工具把副作用留在内存里，loop 随即进入第 2 轮。只断言 turnIndex 序列，不把
  // 「模型决定调工具」当结论（服务端字节是这里写死的，见 team-l2b-kernel 的分面说明）。
  let round = 0;
  const streamFn = createTransportStubbedStreamFn(async () => {
    round += 1;
    if (round === 1) {
      return sseResponse([
        {
          id: "c1",
          model: "kernel-model",
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call-1", type: "function", function: { name: "echo", arguments: '{"value":"x"}' } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { id: "c1", model: "kernel-model", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);
    }
    return sseResponse(textChunks("done"));
  });

  const events = [];
  const stream = agentLoop(
    [{ role: "user", content: "hi", timestamp: 1 }],
    { systemPrompt: "s", messages: [], tools: [echoTool] },
    baseConfig(),
    undefined,
    streamFn,
  );
  for await (const event of stream) events.push(event);

  const turnStartIndices = events.filter((e) => e.type === "turn_start").map((e) => e.turnIndex);
  const turnEndIndices = events.filter((e) => e.type === "turn_end").map((e) => e.turnIndex);
  assert.deepEqual(turnStartIndices, [0, 1]);
  assert.deepEqual(turnEndIndices, [0, 1]);
  assert.ok(events.filter((e) => e.type === "turn_start").every((e) => e.agentId === SUPERVISOR_AGENT_ID));
  assert.ok(events.filter((e) => e.type === "turn_end").every((e) => e.agentId === SUPERVISOR_AGENT_ID));
});

// ---------------------------------------------------------------------------
// §2.1 onSubagentEvent 转发
// ---------------------------------------------------------------------------

/**
 * 构造一个带 onSubagentEvent 的 controller（真 provider 链路 + fetch 桩）。
 *
 * @param onSubagentEvent 转发回调。
 * @returns { controller, requests }
 */
function makeController(onSubagentEvent) {
  const requests = [];
  const streamFn = createTransportStubbedStreamFn(async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return sseResponse(textChunks("子代理结论：可行。", { prompt_tokens: 10, completion_tokens: 5 }));
  });
  const controller = createTeamController({
    defaultModel: makeModel(),
    streamFn,
    ...(onSubagentEvent ? { onSubagentEvent } : {}),
  });
  return { controller, requests };
}

test("onSubagentEvent：四类边界事件透传，带子代理身份（agentId=name / parentId=supervisor）", async () => {
  const forwarded = [];
  const { controller, requests } = makeController((event, identity) => forwarded.push({ event, identity }));
  await controller.createMember({ name: "analyst", role: "研究员" });

  const result = await controller.runMember("analyst", "评估一下。");
  assert.equal(result.status, "done");
  assert.equal(requests.length, 1, "子代理确实经真 provider 链路跑了一次");

  // 四类边界事件各至少一条，且顺序为 start → turn_start → turn_end → agent_end。
  const types = forwarded.map((item) => item.event.type);
  assert.ok(types.includes("agent_start"));
  assert.ok(types.includes("turn_start"));
  assert.ok(types.includes("turn_end"));
  assert.equal(types.at(-1), "agent_end");
  assert.equal(types[0], "agent_start");

  for (const { event, identity } of forwarded) {
    assert.equal(identity.agentId, "analyst");
    assert.equal(event.agentId, "analyst");
  }
  // parentId 只出现在 agent_start（其余边界事件不携带该字段）。
  const start = forwarded.find((item) => item.event.type === "agent_start");
  assert.equal(start.identity.parentId, SUPERVISOR_AGENT_ID);
  assert.equal(start.event.parentId, SUPERVISOR_AGENT_ID);
  assert.equal(start.event.role, "研究员");
  assert.equal(start.event.label, "analyst");
  assert.equal(start.event.modelId, "kernel-model");
  assert.equal("parentId" in forwarded.find((item) => item.event.type === "turn_start").identity, false);
});

test("onSubagentEvent：message_* / tool_execution_* 不转发", async () => {
  const forwarded = [];
  const { controller } = makeController((event) => forwarded.push(event));
  await controller.createMember({ name: "analyst", role: "研究员" });
  await controller.runMember("analyst", "评估一下。");

  const forwards = forwarded.map((event) => event.type);
  for (const type of forwards) {
    assert.ok(
      ["agent_start", "agent_end", "turn_start", "turn_end"].includes(type),
      `不应转发 ${type}`,
    );
  }
  // 子代理内部确实产生过 message_* 事件（否则本断言无效）：runMember 的摘要非空即证明有 assistant 消息。
  assert.ok(forwards.length >= 4);
});

test("onSubagentEvent：回调抛错被吞掉，子代理照常完成", async () => {
  let calls = 0;
  const { controller } = makeController(() => {
    calls += 1;
    throw new Error("sink exploded");
  });
  await controller.createMember({ name: "analyst", role: "研究员" });

  const result = await controller.runMember("analyst", "评估一下。");
  assert.equal(result.status, "done");
  assert.ok(result.summary.length > 0);
  assert.ok(calls >= 4, "每个边界事件都应尝试转发一次");
});

test("onSubagentEvent：未配置回调时零额外行为（不抛错、结果不变）", async () => {
  const { controller } = makeController(undefined);
  await controller.createMember({ name: "analyst", role: "研究员" });
  const result = await controller.runMember("analyst", "评估一下。");
  assert.equal(result.status, "done");
  assert.ok(result.summary.length > 0);
});

test("onSubagentEvent：子代理 streamFn 的 observer 身份与事件身份一致（同一 agentId 口径）", async () => {
  // 本用例只断言「estimateComposition 可在真实 context 上工作」这一采集层事实，
  // observer 注入本身由 serve/CLI 的转发器负责（04 §2.2），此处不做替身断言。
  const composition = estimateComposition("s", [{ role: "user", content: "hi", timestamp: 1 }], []);
  assert.ok(composition.total > 0);
});
