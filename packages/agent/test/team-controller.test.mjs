import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageEventStream } from "@aiagent/ai";
import { z } from "zod";
import {
  createTeamController,
  createBullBearRiskTeam,
  getTeamView,
  createBudgetGuard,
} from "../dist/team-controller.js";

/** 构造一个 Model（测试用，字段对齐 @aiagent/ai 的 Model）。 */
function makeModel(id = "mock-model") {
  return {
    id,
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
}

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

/**
 * 构造 mock streamFn：每次调用返回一条固定 assistant 消息的事件流（start → done）。
 * @param message 要回放的 assistant 消息。
 * @returns StreamFn 兼容函数。
 */
function createMockStreamFn(message) {
  return () => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        stream.push({ type: "done", reason: message.stopReason, message });
      }
    });
    return stream;
  };
}

/** 从 controller.tools 中按名字取工具。 */
function getTool(controller, name) {
  const tool = controller.tools.find((t) => t.name === name);
  assert.ok(tool, `工具 ${name} 应已注册`);
  return tool;
}

test("TeamCreate 向 supervisor 的工具集注册，并写入 team 状态", async () => {
  const controller = createTeamController({ defaultModel: makeModel() });
  assert.equal(controller.tools.length, 2);
  assert.ok(controller.tools.some((t) => t.name === "TeamCreate"));
  assert.ok(controller.tools.some((t) => t.name === "SendMessage"));

  const teamCreate = getTool(controller, "TeamCreate");
  const result = await teamCreate.execute("call-1", { name: "analyst", role: "研究员" });

  assert.equal(result.isError, undefined); // AgentToolResult 协议无 isError 字段
  assert.ok(controller.hasMember("analyst"));
  const state = controller.getTeamState();
  assert.ok(state.members.has("analyst"));
  assert.equal(state.members.get("analyst").role, "研究员");
  assert.ok(state.events.some((e) => e.type === "member_created" && e.member === "analyst"));
  // inbound 队列随成员建立。
  assert.ok(Array.isArray(state.inboundQueues.get("analyst")));
});

test("SendMessage 触发隔离 subagent 运行并回收摘要（上下文隔离 + 摘要回收 + 任务不重复）", async () => {
  // 捕获 subagent 实际收到的 LLM 上下文，验证任务未被重复注入（上下文隔离 + 零重复）。
  const captured = [];
  const streamFn = (model, context) => {
    captured.push(context);
    return createMockStreamFn(textMessage("看涨：基本面强劲"))();
  };
  const controller = createTeamController({ defaultModel: makeModel(), streamFn });
  await getTool(controller, "TeamCreate").execute("c1", { name: "analyst", role: "研究员" });

  const sendMessage = getTool(controller, "SendMessage");
  const result = await sendMessage.execute("c2", { recipient: "analyst", content: "分析 A 公司" });

  // 摘要回收为工具结果文本，主上下文不含子代理探索细节。
  assert.match(result.content[0].text, /已完成/);
  assert.match(result.content[0].text, /看涨：基本面强劲/);
  assert.equal(result.details.status, "done");
  assert.equal(result.details.summary, "看涨：基本面强劲");

  const member = controller.getTeamState().members.get("analyst");
  assert.equal(member.status, "done");
  assert.equal(member.summary, "看涨：基本面强劲");

  // 上下文隔离 + 任务不重复：子代理只被调用一次，且委派内容只出现一次
  // （回归保护：若任务同时塞进 subContext.messages 与 agentLoop 的 prompts，会重复出现）。
  assert.equal(captured.length, 1, "子代理应被调用一次");
  const subMessages = captured[0].messages;
  const taskOccurrences = subMessages.filter((m) => m.role === "user" && m.content === "分析 A 公司");
  assert.equal(taskOccurrences.length, 1, "委派任务在子代理上下文里不应重复");

  // team 状态投影：消息入队 + 成员启动 + 完成。
  const events = controller.getTeamState().events.map((e) => e.type);
  assert.ok(events.includes("message_sent"));
  assert.ok(events.includes("member_started"));
  assert.ok(events.includes("member_completed"));
  // 消息总线：inbound 队列记录了 supervisor → analyst 的派发。
  assert.equal(controller.getTeamState().inboundQueues.get("analyst").length, 1);
});

test("子代理失败以结构化错误回传，supervisor 不崩溃（失败隔离）", async () => {
  const controller = createTeamController({
    defaultModel: makeModel(),
    streamFn: createMockStreamFn(textMessage("boom", "error")),
  });
  await getTool(controller, "TeamCreate").execute("c1", { name: "risky", role: "压力测试" });

  const sendMessage = getTool(controller, "SendMessage");
  const result = await sendMessage.execute("c2", { recipient: "risky", content: "压测" });

  // 失败以可读文本 + isError:false 回传，supervisor 可继续决策。
  assert.match(result.content[0].text, /执行失败/);
  assert.equal(result.details.status, "failed");
  assert.ok(result.details.error);

  const member = controller.getTeamState().members.get("risky");
  assert.equal(member.status, "failed");
  // supervisor 主循环未崩溃：仍可查询状态 / 视图。
  assert.doesNotThrow(() => getTeamView(controller.getTeamState()));
  assert.match(controller.getTeamView(), /risky \[failed\]/);
});

test("成员不存在时 SendMessage 返回结构化错误而非抛异常", async () => {
  const controller = createTeamController({ defaultModel: makeModel(), streamFn: createMockStreamFn(textMessage("x")) });
  const result = await getTool(controller, "SendMessage").execute("c1", { recipient: "ghost", content: "hi" });
  assert.match(result.content[0].text, /执行失败/);
  assert.equal(result.details.error.code, "member_not_found");
});

test("createBullBearRiskTeam 预置 bull/bear/risk 三成员（阶段五演示）", async () => {
  const controller = createBullBearRiskTeam({
    defaultModel: makeModel("super-model"),
    readOnlyTools: ["research", "read"],
  });
  const state = controller.getTeamState();
  assert.equal(state.members.size, 3);
  for (const name of ["bull", "bear", "risk"]) {
    assert.ok(state.members.has(name), `应存在成员 ${name}`);
    assert.deepEqual(state.members.get(name).allowedTools, ["research", "read"]);
  }
  assert.match(controller.getTeamView(), /bull \[idle\]/);
});

test("getTeamView 渲染团队状态快照", async () => {
  const controller = createTeamController({ defaultModel: makeModel() });
  await getTool(controller, "TeamCreate").execute("c1", { name: "m1", role: "角色一" });
  const view = controller.getTeamView();
  assert.match(view, /Team: 1 members/);
  assert.match(view, /m1 \[idle\] 角色一/);
});

/**
 * 构造一条带自定义 usage 的 assistant 消息（测试成本护栏用）。
 * @param text 文本块内容。
 * @param totalTokens 累计 token 数。
 * @param costTotal 累计成本（美元）。
 * @returns assistant 消息。
 */
function costedMessage(text, totalTokens, costTotal) {
  const m = textMessage(text);
  m.usage = {
    input: totalTokens / 2,
    output: totalTokens / 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
  };
  return m;
}

test("(a) 成本护栏：预算超限时子代理被干净停止（部分摘要 + budgetExceeded + 不崩溃）", async () => {
  // 单轮 usage 即超出 per-member 成本上限；护栏应在 turn_end 返回 true，以 agent_end 干净收尾。
  const controller = createTeamController({
    defaultModel: makeModel("m"),
    streamFn: createMockStreamFn(costedMessage("部分分析结论", 1000, 0.07)),
    budget: { maxCostPerMember: 0.05 },
  });
  await getTool(controller, "TeamCreate").execute("c1", { name: "analyst", role: "研究员" });
  const result = await getTool(controller, "SendMessage").execute("c2", { recipient: "analyst", content: "分析" });

  // 干净停止：无 endError，走 done 分支但仍标记 budgetExceeded（不是崩溃）。
  assert.equal(result.details.status, "done");
  assert.equal(result.details.budgetExceeded, true);
  assert.equal(result.details.summary, "部分分析结论"); // 仍回传已产生部分摘要
  assert.doesNotThrow(() => getTeamView(controller.getTeamState()));

  const member = controller.getTeamState().members.get("analyst");
  assert.equal(member.budgetExceeded, true);
  assert.equal(member.usage.cost, 0.07);
});

test("(b) maxConcurrentMembers 真正限制并发在飞数（计数断言）", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  // 延迟流：进入 agentLoop 时计数 +1，流结束后 -1，从而观测并发在飞数。
  const delayStreamFn = (model, context) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const message = textMessage(`成员 ${context.messages.length}`);
    const stream = new AssistantMessageEventStream();
    setTimeout(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      inFlight--;
    }, 30);
    return stream;
  };

  // 信号量容量 = 2；runMembers 即便要求 limit=10，真实在飞也不得超过 2。
  const controller = createTeamController({
    defaultModel: makeModel("m"),
    streamFn: delayStreamFn,
    maxConcurrentMembers: 2,
  });
  for (const name of ["a", "b", "c", "d"]) {
    await controller.createMember({ name, role: "成员" });
  }

  const results = await controller.runMembers(["a", "b", "c", "d"], "任务", 10);
  assert.equal(results.length, 4);
  assert.ok(maxInFlight <= 2, `并发在飞数应 <=2，实际 ${maxInFlight}`);
  assert.ok(maxInFlight >= 1, "应有并发发生");
});

test("(c) 团队聚合预算生效：跨成员共享累加器触发总 ceiling", async () => {
  // 团队总上限 $0.09，每个成员单轮成本 $0.05：第 1 个通过，后续被团队总 ceiling 拦停。
  const controller = createTeamController({
    defaultModel: makeModel("m"),
    streamFn: createMockStreamFn(costedMessage("结论", 500, 0.05)),
    budget: { maxCostTotal: 0.09, maxCostPerMember: 1 },
  });
  for (const name of ["m1", "m2", "m3"]) {
    await controller.createMember({ name, role: "成员" });
  }

  await controller.runMembers(["m1", "m2", "m3"], "任务", 3);
  const state = controller.getTeamState();
  // 第一个成员未触发（undefined 视为未超）；其余被团队总 ceiling 停止。
  assert.equal(state.members.get("m1").budgetExceeded ?? false, false);
  assert.equal(state.members.get("m2").budgetExceeded, true);
  assert.equal(state.members.get("m3").budgetExceeded, true);
  // 团队总成本行在视图中可观测。
  assert.match(controller.getTeamView(), /团队总计/);
});

test("createBudgetGuard 派发前估算（纯函数，独立于实际 usage）", async () => {
  // 模型费率 input=1 / output=1 $/百万 token；估算 1,000,000 token → 估算成本 $2.0。
  const model = makeModel("m");
  model.cost = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
  const acc = { totalTokens: 0, totalCost: 0 };

  // 超 per-member 成本上限 → 拒绝。
  assert.equal(createBudgetGuard(model, 1_000_000, { maxCostPerMember: 1 }, acc), false);
  // 未超 → 允许。
  assert.equal(createBudgetGuard(model, 100_000, { maxCostPerMember: 1 }, acc), true);
  // 团队总 ceiling：剩余余额不足 → 拒绝。
  const acc2 = { totalTokens: 0, totalCost: 5 };
  assert.equal(createBudgetGuard(model, 100_000, { maxCostTotal: 10 }, acc2), true);
  assert.equal(createBudgetGuard(model, 10_000_000, { maxCostTotal: 10 }, acc2), false);
});

test("(d) 并发下团队总 ceiling 原子生效（Mutex 防超支，A-1 修复）", async () => {
  // 团队总 token ceiling = 150，每个成员单轮产 100 tokens；仅团队 ceiling 约束（per-member 放开）。
  // 并发 6 个成员、maxConcurrentMembers=3：若临界区不原子，可能出现"都读到 0 双双放行"突破上限；
  // 加 AsyncMutex 串行化读-判-写后，任何时刻团队累计 totalTokens 必须 <= 150。
  const controller = createTeamController({
    defaultModel: makeModel("m"),
    streamFn: createMockStreamFn(costedMessage("结论", 100, 0)),
    maxConcurrentMembers: 3,
    budget: { maxTokensTotal: 150 },
  });
  const names = ["m1", "m2", "m3", "m4", "m5", "m6"];
  for (const name of names) {
    await controller.createMember({ name, role: "成员" });
  }

  const results = await controller.runMembers(names, "任务", 6);
  assert.equal(results.length, 6);

  // 干净停止：全部以 done 收尾，不崩溃（被护栏停止的仍走 done 分支）。
  for (const r of results) {
    assert.equal(r.status, "done");
    // 每个成员自身确实产生了 100 tokens（per-member 用量报告准确）。
    assert.equal(r.usage.tokens, 100);
  }

  // 总额约束：150 仅够 1 个成员（100），其余 5 个被团队 ceiling 拦停。
  const exceeded = results.filter((r) => r.budgetExceeded);
  const completed = results.filter((r) => !r.budgetExceeded);
  assert.equal(exceeded.length, 5, "5 个成员应被团队 ceiling 拦停");
  assert.equal(completed.length, 1, "仅 1 个成员能在 ceiling 内完成");
  for (const r of exceeded) assert.equal(r.budgetExceeded, true);

  // 任何时刻团队累计 totalTokens 不超 ceiling（A-1 原子性核心断言）。
  assert.ok(
    controller.getBudgetAccumulator().totalTokens <= 150,
    `团队累计 totalTokens ${controller.getBudgetAccumulator().totalTokens} 不应超过 ceiling 150`,
  );
});


test("(K3) runMember 把 beforeToolCall 继承给子代理：deny write 时子代理写入被拦下", async () => {
  // 子代理脚本：先发起 write 工具调用，再给出最终文本。
  const responses = [
    assistantMessage(
      [{ type: "toolCall", id: "t1", name: "write", arguments: { path: "a.txt", content: "x" } }],
      "toolUse",
    ),
    textMessage("已完成探索（写入被拒绝）"),
  ];
  let step = 0;
  const streamFn = () => createMockStreamFn(responses[Math.min(step++, responses.length - 1)])();

  let executed = 0;
  const writeTool = {
    name: "write",
    description: "写文件",
    label: "write",
    parameters: z.object({ path: z.string(), content: z.string() }),
    effect: "mutate",
    async execute() {
      executed += 1;
      return { content: [{ type: "text", text: "written" }], details: {} };
    },
  };

  // 模拟 supervisor 的权限闸门：plan 模式语义——所有 mutate 直接 block。
  const hookCalls = [];
  const beforeToolCall = async (ctx) => {
    hookCalls.push({
      toolName: ctx.toolCall.name,
      args: ctx.args,
      toolNames: (ctx.context.tools ?? []).map((tool) => tool.name),
    });
    if (ctx.toolCall.name === "write") {
      return { block: true, reason: "当前为 plan 模式，已拒绝 write 的写操作（未执行）。" };
    }
    return undefined;
  };

  const controller = createTeamController({
    defaultModel: makeModel(),
    streamFn,
    availableTools: [writeTool],
    beforeToolCall,
  });
  await controller.createMember({ name: "writer", role: "写手" });
  const result = await controller.runMember("writer", "写一个文件");

  // 钩子确实被调用，且看到的是子代理自己的工具表与校验后参数。
  assert.equal(hookCalls.length, 1, "子代理的 write 调用必须经过继承的 beforeToolCall");
  assert.equal(hookCalls[0].toolName, "write");
  assert.equal(hookCalls[0].args.path, "a.txt");
  // 子代理看到的是自己的工具子集（availableTools 快照），不是 supervisor 的完整工具表。
  assert.deepEqual(hookCalls[0].toolNames, ["write"]);
  // 被 block 后工具未真正执行，子代理仍以 completed 收尾（错误即数据）。
  assert.equal(executed, 0, "block 后子代理不得执行 write");
  assert.equal(result.status, "done");
  assert.match(result.summary, /写入被拒绝/);
});

test("TeamCreate / SendMessage 声明 effect=read（编排原语不触发审批）", () => {
  const controller = createTeamController({ defaultModel: makeModel() });
  for (const tool of controller.tools) {
    assert.equal(tool.effect, "read", `${tool.name} 应为只读编排原语`);
  }
});

test("allowedTools: [] 表示零工具（不再被误判为全量池）", async () => {
  const capturedTools = [];
  const streamFn = (_model, context) => {
    capturedTools.push(context.tools ?? []);
    return createMockStreamFn(textMessage("无工具完成"))();
  };
  const writeTool = {
    name: "write",
    description: "写文件",
    label: "write",
    parameters: z.object({ path: z.string() }),
    effect: "mutate",
    async execute() {
      return { content: [{ type: "text", text: "written" }], details: {} };
    },
  };

  const controller = createTeamController({
    defaultModel: makeModel(),
    streamFn,
    availableTools: [writeTool],
  });
  await controller.createMember({ name: "no-tools", role: "零工具成员", tools: [] });
  const result = await controller.runMember("no-tools", "只思考");

  assert.equal(result.status, "done");
  assert.deepEqual(capturedTools[0], [], "显式空数组必须授予零工具");

  // 对照组：省略 tools 仍表示全量池（保持既有语义）。
  await controller.createMember({ name: "all-tools", role: "全量成员" });
  await controller.runMember("all-tools", "只思考");
  assert.deepEqual(capturedTools[1].map((tool) => tool.name), ["write"], "undefined 应回退全量池");
});
