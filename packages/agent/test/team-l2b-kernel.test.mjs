/**
 * T-L2b 确定性内核：真 provider 链路（`streamSimple` → openai-completions adapter → `fetch`）的
 * 控制流验收，加上 §6.2 迁移后的确定性覆盖（并发原语 / 投影纯函数 / SLO 聚合）。
 *
 * 为什么需要本文件：`team-l2b-provider.test.mjs` 在没有 LLM 凭据的环境里只能显式 skip，
 * 于是「真 provider 驱动 → 子代理 agentLoop → 摘要回收 → 状态回写」这条链路在本仓库 CI 中
 * 永远跑不到。本文件把**传输层**（HTTP `fetch`）替换成回放 SSE 字节流的桩。
 *
 * ## 本文件严格分成两个断言面（不得混用，见 03 §4.3）
 *
 * 1. **`[L2b-kernel]`**（T-L2b 证据面）：桩只回「纯文本回复」或「HTTP 错误」，
 *    **绝不脚本化 tool_call / 多轮脚本**。「模型想说什么」完全由 provider adapter
 *    从服务端字节流解析得出，断言只指控制流（status / 摘要非空 / 状态回写 / 护栏通道是否触发 /
 *    在飞峰值），对任意合理回复都成立，因此接到真 provider 路径也不会 flaky。
 * 2. **`[transport-contract]`**（传输层契约，**不进** T-L2b 硬门禁证据面）：显式构造
 *    服务端按协议回包字节（含 `tool_calls` chunk）来验证「若模型决定调用工具，调用会落到
 *    被 mock 的 `execute` 出口」——它测的是**适配器 + 工具执行器的协议契约**，
 *    证据来自这里写死的服务端字节，**不是模型行为证据**。
 *    真实「模型自主决定是否/何时调用工具」的证据只能来自带凭据的 `team-l2b-provider.test.mjs`
 *    与 L4；编排决策（该不该 spawn / 该调谁）更不属于本文件。
 *
 * 与 `createMockStreamFn`（已删除）的本质区别：
 * - 删除的 mock 在**模型抽象之上**注入 `AssistantMessage` 对象 = 直接伪造模型输出（§4.2 红线）；
 * - 本文件的桩在**网络字节层**，是 provider 连通性测试的标准做法（与 packages/ai/test 同源）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { streamSimple } from "@aiagent/ai";
import { createTeamController } from "../dist/team-controller.js";
import { projectTeamCostSummary } from "../dist/team/run-event.js";
import { summarizeSlo } from "../dist/team/slo.js";

/**
 * 构造一个指向假 baseUrl 的 Model（元数据与 @aiagent/ai 的 Model 对齐）。
 *
 * @param id 模型 id。
 * @param patch 覆盖字段（费率等）。
 * @returns Model 对象。
 */
function makeModel(id = "kernel-model", patch = {}) {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "test-provider",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    ...patch,
  };
}

/**
 * 把 SSE chunk 列表编码成 fetch Response（服务端字节流形状）。
 *
 * @param chunks OpenAI chat.completion.chunk 对象数组。
 * @returns HTTP Response。
 */
function sseResponse(chunks) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * 构造一段「服务端返回纯文本回复」的 SSE chunk 序列。
 *
 * 注意：这里的 `content` 是**服务端字面响应**（等价于真实网关回包），不是预置的模型决策——
 * 桩不知道 agent 上下文是什么，也无法让模型「选择工具」。
 *
 * @param text 服务端回包文本。
 * @param usage 服务端上报的用量（可选）。
 * @param modelId 回包中的 model 字段。
 * @returns chunk 数组。
 */
function textChunks(text, usage, modelId = "kernel-model") {
  const chunks = [{ id: "c-1", model: modelId, choices: [{ delta: { content: text }, finish_reason: null }] }];
  chunks.push({
    id: "c-1",
    model: modelId,
    choices: [{ delta: {}, finish_reason: "stop" }],
    ...(usage ? { usage } : {}),
  });
  return chunks;
}

/**
 * 构造一个「真 provider 链路 + 传输层桩」的 streamFn：
 * 内部就是 `streamSimple`（与 controller 缺省路径同一函数），只把 `fetch` 换成本地桩。
 * 不注入任何 apiKey 校验逻辑、不注入任何消息内容。
 *
 * @param handler `(url, init) => Response` 的服务端处理器（记录请求并回放字节流）。
 * @returns StreamFn。
 */
function createTransportStubbedStreamFn(handler) {
  return (model, context, options) => streamSimple(model, context, { ...options, apiKey: "test-key", fetch: handler });
}

/**
 * 构造一个副作用被 mock 的工具（§4.1 允许）：execute 只记录调用，不产生真实副作用。
 *
 * @param name 工具名。
 * @param calls 调用记录。
 * @returns AgentTool。
 */
function createMockedTool(name, calls) {
  return {
    name,
    description: `${name}（副作用已 mock）`,
    label: name,
    parameters: z.object({ path: z.string().optional() }),
    effect: "mutate",
    async execute(_toolCallId, params) {
      calls.push({ name, params });
      return { content: [{ type: "text", text: `${name}:mocked` }], details: {} };
    },
  };
}

test("[L2b-kernel] 真 provider 链路驱动 runMember：控制流走通、摘要回收、状态与时延回写", async () => {
  // 服务端处理器：记录请求，回一段纯文本流（不是预置 assistant 消息）。
  const requests = [];
  const usage = { prompt_tokens: 120, completion_tokens: 30 };
  const streamFn = createTransportStubbedStreamFn(async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return sseResponse(textChunks("上下文隔离是子代理只回传摘要。", usage));
  });

  const calls = [];
  const controller = createTeamController({
    defaultModel: makeModel(),
    streamFn,
    availableTools: [createMockedTool("write", calls)],
  });
  await controller.createMember({ name: "analyst", role: "研究员", tools: ["write"] });

  const result = await controller.runMember("analyst", "用一句话说明上下文隔离。");

  // 模型侧确实经真实 provider 链路请求了一次（不是桩替身直接返回结果）。
  assert.equal(requests.length, 1, "应发生一次真实的 provider HTTP 请求");
  assert.equal(requests[0].url, "https://example.test/v1/chat/completions");
  assert.equal(requests[0].headers.authorization, "Bearer test-key");
  assert.equal(requests[0].body.model, "kernel-model");
  assert.equal(requests[0].body.stream, true);
  // 委派任务只注入一次（上下文隔离 + 任务不重复：agent-loop 的 prompts 与 context.messages 不重叠）。
  const userMessages = requests[0].body.messages.filter((m) => m.role === "user" && m.content === "用一句话说明上下文隔离。");
  assert.equal(userMessages.length, 1, "委派任务在子代理上下文里不应重复");

  // 控制流断言（对任意服务端回复都成立）。
  assert.equal(result.status, "done");
  assert.equal(typeof result.summary, "string");
  assert.ok(result.summary.length > 0, "摘要必须非空");
  assert.ok(!calls.length, "纯文本回复不应触碰工具副作用出口");

  const member = controller.getTeamState().members.get("analyst");
  assert.equal(member.status, "done");
  assert.equal(member.summary, result.summary);
  assert.ok(Number.isFinite(member.durationMs) && member.durationMs >= 0, "成员时延应回写");

  // 成本投影贯通：usage 经 model 费率换算（此处费率为 0）后进入 team 段。
  const summary = projectTeamCostSummary(controller.getTeamState());
  assert.equal(summary.members.length, 1);
  assert.equal(summary.members[0].name, "analyst");
  assert.equal(typeof summary.members[0].durationMs, "number");
});

/**
 * 传输层契约用例（`[transport-contract]`，**不进 T-L2b 硬门禁证据面**）。
 *
 * 本用例显式构造「服务端按 openai-completions 协议回 tool_calls 字节」的两轮响应，用来验证
 * 适配器把 tool_calls 解析成 toolCall 块、loop 执行被 mock 的 `execute`、产物回收进 artifacts——
 * 即**协议契约与工具执行器契约**。它测的是这里写死的服务端字节，**不是模型行为**：
 * 真实「模型自主决定是否调用工具」的证据只能来自带凭据的 team-l2b-provider.test.mjs 与 L4（§4.3）。
 * 因此禁止把本用例的结论（「模型会调用 write」）当作编排决策证据使用。
 */
test("[transport-contract] 服务端回包含 tool_calls 时，调用落到被 mock 的 execute 出口（契约，非模型证据）", async () => {
  const calls = [];
  const toolCallChunks = [
    {
      id: "c-2",
      model: "kernel-model",
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "write", arguments: "" } }],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "c-2",
      model: "kernel-model",
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] },
          finish_reason: null,
        },
      ],
    },
    { id: "c-2", model: "kernel-model", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];

  let round = 0;
  const streamFn = createTransportStubbedStreamFn(async () => {
    round++;
    // 传输层写死：第 1 轮回 tool_calls 字节，第 2 轮回最终文本。这是「服务端脚本」，不是模型决策。
    return round === 1 ? sseResponse(toolCallChunks) : sseResponse(textChunks("已按要求处理。"));
  });

  const controller = createTeamController({
    defaultModel: makeModel(),
    streamFn,
    availableTools: [createMockedTool("write", calls)],
  });
  await controller.createMember({ name: "writer", role: "写手", tools: ["write"] });

  const result = await controller.runMember("writer", "处理一下 a.txt");
  assert.equal(result.status, "done");
  // 协议契约：tool_calls 被解析、execute 被调用一次、参数经 JSON 流式拼装正确。
  assert.equal(calls.length, 1, "工具调用应恰好落到 mock 的 execute 出口一次");
  assert.equal(calls[0].name, "write");
  assert.deepEqual(calls[0].params, { path: "a.txt" });
  // 产物面记录了这次工具调用的短摘要（extractSummary 产物收集走通）。
  assert.ok(result.artifacts.some((artifact) => artifact.startsWith("write:")), "artifacts 应含 write 产物");
  // 契约约定：tool_calls 轮之后 loop 继续下一轮直到最终回复（agent-loop 的既有语义）。
  assert.equal(round, 2, "tool_calls 轮之后应继续下一轮直到最终回复");
});

test("[L2b-kernel] 护栏通道在真 provider 链路上被触发：budgetExceeded 回写且干净收尾", async () => {
  // 服务端上报 1000 output tokens；单成员成本上限 $0.001 必然在首轮后触发护栏。
  // 注：护栏在「本轮 usage 累计后」判定，停止后 loop 立即收尾——首轮必停是确定性的；
  // 但对「真实模型的回复」不假设轮数，故只断言请求数落在契约允许的 1..2 次内。
  const model = makeModel("priced-model", { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
  let requests = 0;
  const streamFn = createTransportStubbedStreamFn(async () => {
    requests++;
    return sseResponse(textChunks("部分结论", { prompt_tokens: 10, completion_tokens: 1000 }));
  });

  const controller = createTeamController({
    defaultModel: model,
    streamFn,
    budget: { maxCostPerMember: 0.001 },
  });
  await controller.createMember({ name: "costly", role: "研究员" });

  const result = await controller.runMember("costly", "分析");

  // 只断言「护栏通道被触发」这个信号：干净停止（done + budgetExceeded），不断言精确 usage。
  assert.equal(result.status, "done");
  assert.equal(result.budgetExceeded, true);
  assert.ok(result.usage, "配置护栏时应回写用量");
  assert.ok(result.usage.tokens > 0, "护栏累计用量应大于 0");
  // 首轮 usage 已超上限 → 不应继续空跑多轮（1 次即停为主路径，2 次是允许的续轮余地）。
  assert.ok(requests >= 1 && requests <= 2, `护栏触发后应立即收尾，实际请求 ${requests} 次`);

  const member = controller.getTeamState().members.get("costly");
  assert.equal(member.budgetExceeded, true);
  assert.equal(member.status, "done");
  assert.ok(controller.getTeamView().includes("⚠预算超限"), "视图应标记预算超限");
  // 团队累加器受 per-member 停止影响：per-member 停止发生在团队提交之前，团队总额保持 0。
  assert.ok(controller.getBudgetAccumulator().totalCost <= 0.001);
});

test("[L2b-kernel] provider 失败路径（HTTP 401/500）收敛为结构化错误，不抛异常", async () => {
  // 覆盖两档常见真实 provider 失败：鉴权失败与上游故障；二者都必须经 adapter 变成
  // stopReason:"error"，再由 controller 的失败判定收敛为结构化 error（失败隔离）。
  for (const status of [401, 500]) {
    const streamFn = createTransportStubbedStreamFn(async () => new Response("provider boom", { status }));
    const controller = createTeamController({ defaultModel: makeModel(), streamFn });
    await controller.createMember({ name: "risky", role: "压力测试" });

    const result = await controller.runMember("risky", "压测");
    // 错误码口径：StreamFn 契约要求失败编码进事件流而非抛出，因此 controller 只能由 stopReason 派生
    // `subagent_failed`（agent_end.error 只用于「钩子违约」的兜底收尾）。
    assert.equal(result.status, "failed");
    assert.deepEqual(result.error, { code: "subagent_failed", message: "stopReason: error" });
    assert.equal(controller.getTeamState().members.get("risky").status, "failed");
    assert.doesNotThrow(() => controller.getTeamView());
  }
});

test("[L2b-kernel] 并发信号量：传输层慢响应下在飞成员峰值不超过 maxConcurrentMembers", async () => {
  let inFlight = 0;
  let peak = 0;
  const streamFn = createTransportStubbedStreamFn(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      // 人造服务端延迟制造真实在飞重叠（延迟发生在 provider 请求内部，不依赖模型输出）。
      await new Promise((resolve) => setTimeout(resolve, 20));
      return sseResponse(textChunks("已处理"));
    } finally {
      inFlight--;
    }
  });

  const controller = createTeamController({ defaultModel: makeModel(), streamFn, maxConcurrentMembers: 2 });
  for (const name of ["a", "b", "c", "d"]) {
    await controller.createMember({ name, role: "成员" });
  }

  const results = await controller.runMembers(["a", "b", "c", "d"], "任务", 4);
  assert.equal(results.length, 4);
  for (const result of results) assert.equal(result.status, "done");
  assert.ok(peak <= 2, `在飞峰值 ${peak} 应 <= 2`);
  assert.ok(peak >= 1, "应观测到并发");
  assert.ok(controller.getTeamState().peakConcurrency <= 2, "controller 观测的峰值同样应 <= 2");
});

test("[L2b-kernel] AsyncMutex 临界区：团队总 ceiling 在并发钩子下严格不超（合成 usage）", async () => {
  const { AsyncMutex, createMemberStopHook } = await import("../dist/team-controller.js");
  const accumulator = { totalTokens: 0, totalCost: 0 };
  const mutex = new AsyncMutex();
  const model = makeModel();
  const turn = (tokens) => ({
    message: { role: "assistant", usage: { totalTokens: tokens, cost: { total: 0 } } },
    toolResults: [],
    context: { messages: [], tools: [] },
    newMessages: [],
  });

  // 两个成员各跑两轮、每轮 60 tokens，团队 ceiling=100：只可能有一轮被提交（60），
  // 任何时刻累加器都不得 >= ceiling。
  const hooks = [createMemberStopHook(model, { maxTokensTotal: 100 }, accumulator, mutex), createMemberStopHook(model, { maxTokensTotal: 100 }, accumulator, mutex)];
  const outcomes = [];
  for (let round = 0; round < 2; round++) {
    outcomes.push(...(await Promise.all(hooks.map((hook) => hook.shouldStopAfterTurn(turn(60))))));
    assert.ok(accumulator.totalTokens < 100, `累加器 ${accumulator.totalTokens} 不得达到 ceiling`);
  }
  assert.equal(outcomes.filter(Boolean).length, 3, "仅第一轮的第一个成员被放行，其余 3 次被拦停");
});

test("[L2b-kernel] projectTeamCostSummary + summarizeSlo：迁移后的确定性下游投影", () => {
  // 合成 TeamState（零模型）：投影口径与团队总量严格对齐。
  const state = {
    members: new Map([
      ["bull", { name: "bull", role: "多头", model: makeModel("m1"), status: "done", usage: { tokens: 300, cost: 0.03 }, durationMs: 40 }],
      ["bear", { name: "bear", role: "空头", model: makeModel("m2"), status: "failed", usage: { tokens: 100, cost: 0.01 }, budgetExceeded: true }],
    ]),
    inboundQueues: new Map(),
    events: [],
    peakConcurrency: 2,
  };
  const team = projectTeamCostSummary(state);
  assert.equal(team.totalTokens, 400);
  assert.ok(Math.abs(team.totalCost - 0.04) < 1e-12);
  assert.equal(team.peakConcurrency, 2);
  assert.equal(team.members.filter((m) => m.budgetExceeded).length, 1);

  // SLO 聚合：成功/失败/中断三态 + 容量峰值。
  const slo = summarizeSlo([
    { durationMs: 100, turnCount: 2, outcome: "completed", totalCost: 0.02, activeRuns: 1, peakConcurrency: 2 },
    { durationMs: 300, turnCount: 4, outcome: "failed", totalCost: 0.04, activeRuns: 3, peakConcurrency: 4 },
    { durationMs: 200, turnCount: 3, outcome: "interrupted", totalCost: 0.01 },
  ]);
  assert.equal(slo.count, 3);
  assert.ok(Math.abs(slo.successRate - 1 / 3) < 1e-12);
  assert.equal(slo.p50DurationMs, 200);
  assert.equal(slo.maxActiveRuns, 3);
  assert.equal(slo.maxPeakConcurrency, 4);
  assert.ok(Math.abs(slo.avgCost - 0.07 / 3) < 1e-12);
});
