/**
 * TeamController 编排机契约测试（docs/v2.0/03-team-eval.md §6.2「严格迁移」）。
 *
 * 迁移前后的分界（本文件只保留 L1 + L2a 两段，L2b 真 provider 段见 team-l2b-provider.test.mjs）：
 * - **T-L1（纯函数）**：`createBudgetGuard` / `createMemberStopHook` / 并发原语，用合成 usage 直接驱动，
 *   零模型、100% 确定。§6.1 三个纯函数的精确契约断言在 team-pure*.test.mjs，本文件只保留
 *   「controller 视角」的等价断言，防止接线漂移。
 * - **T-L2a（纯状态迁移，零模型）**：TeamCreate / SendMessage 的 TeamState 断言。
 *   `SendMessage` 对不存在成员在 `agentLoop` 之前早退，因此天然不依赖模型输出。
 *
 * 已删除：`createMockStreamFn`（注入固定 assistant 消息流 = mock 模型输出，踩 §4.2 红线）
 * 及所有依赖它「回放固定模型消息」的用例。失败隔离 / 摘要回收 / 权限继承通道的逻辑
 * 已被下沉到 L1 纯函数（extractSummary / classifyAborted / assembleSubagentConfig），
 * 端到端口径改由 L2b（真 provider + mock 工具副作用）覆盖。
 *
 * 本文件**不出现任何 streamFn**：凡需要驱动 agentLoop 的用例都不属于这里的层级。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  createTeamController,
  createBullBearRiskTeam,
  getTeamView,
  createBudgetGuard,
  createMemberStopHook,
  AsyncMutex,
  mapWithConcurrencyLimit,
} from "../dist/team-controller.js";

/**
 * 构造一个 Model（测试用，字段对齐 @aiagent/ai 的 Model）。
 * 这里只是模型**元数据**（费率/上下文窗口），不是模型输出、不是 streamFn。
 *
 * @param id 模型 id。
 * @returns 可直接赋给 defaultModel 的 Model 对象。
 */
function makeModel(id = "test-model") {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "deepseek",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

/**
 * 从 controller.tools 中按名字取工具。
 *
 * @param controller TeamController 实例。
 * @param name 工具名。
 * @returns 对应 AgentTool。
 */
function getTool(controller, name) {
  const tool = controller.tools.find((t) => t.name === name);
  assert.ok(tool, `工具 ${name} 应已注册`);
  return tool;
}

/**
 * 构造一个「工具副作用出口被 mock」的工具：execute 不落盘、不跑子进程，只记录调用。
 * 这是 03 §4.1 允许的 mock 面（动作对外部世界的效果），与模型输出无关。
 *
 * @param name 工具名。
 * @param calls 调用记录数组（会追加 `{ params }`）。
 * @param resultText execute 的固定返回文本。
 * @returns AgentTool。
 */
function createMockedWriteTool(name, calls, resultText = "written") {
  return {
    name,
    description: `${name}（测试用，副作用已 mock）`,
    label: name,
    parameters: z.object({ path: z.string(), content: z.string().optional() }),
    effect: "mutate",
    async execute(_toolCallId, params) {
      calls.push({ params });
      return { content: [{ type: "text", text: resultText }], details: {} };
    },
  };
}

// ---------------------------------------------------------------------------
// T-L2a：编排机契约（纯状态迁移，零模型）
// ---------------------------------------------------------------------------

test("[L2a] TeamCreate 向 supervisor 的工具集注册，并写入 team 状态", async () => {
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

test("[L2a] SendMessage 对不存在成员返回 member_not_found（agentLoop 之前的早退路径）", async () => {
  // 零 streamFn：若早退判定被挪到 agentLoop 之后，这里不会得到结构化 member_not_found。
  const controller = createTeamController({ defaultModel: makeModel() });
  const before = controller.getTeamState().events.length;

  const result = await getTool(controller, "SendMessage").execute("c1", {
    recipient: "ghost",
    content: "hi",
  });

  assert.equal(result.details.status, "failed");
  assert.equal(result.details.error.code, "member_not_found");
  assert.match(result.content[0].text, /执行失败/);
  // 早退：不产生任何团队事件（未入队、未启动）。
  assert.equal(controller.getTeamState().events.length, before);
  assert.equal(controller.getTeamState().inboundQueues.size, 0);
});

test("[L2a] 直接 runMember 不存在的成员同样返回 member_not_found，且不抛异常", async () => {
  const controller = createTeamController({ defaultModel: makeModel() });
  const result = await controller.runMember("nobody", "任务");
  assert.equal(result.status, "failed");
  assert.deepEqual(result.error, { code: "member_not_found", message: '成员 "nobody" 不存在' });
  assert.deepEqual(result.artifacts, []);
});

test("[L2a] 重复创建同名成员抛 duplicate_member", async () => {
  const controller = createTeamController({ defaultModel: makeModel() });
  await controller.createMember({ name: "dup", role: "角色" });
  assert.throws(() => controller.createMember({ name: "dup", role: "另一个角色" }), /duplicate_member/);
  // 状态未被污染：仍是首次创建的那个成员。
  assert.equal(controller.getTeamState().members.get("dup").role, "角色");
});

test("[L2a] TeamCreate 工具在重复成员时把错误抛给 loop（自动转 isError 结果）", async () => {
  const controller = createTeamController({ defaultModel: makeModel() });
  const teamCreate = getTool(controller, "TeamCreate");
  await teamCreate.execute("c1", { name: "analyst", role: "研究员" });
  await assert.rejects(() => teamCreate.execute("c2", { name: "analyst", role: "研究员" }), /duplicate_member/);
});

test("[L2a] createBullBearRiskTeam 预置 bull/bear/risk 三成员（阶段五演示）", () => {
  const controller = createBullBearRiskTeam({
    defaultModel: makeModel("super-model"),
    readOnlyTools: ["research", "read"],
  });
  const state = controller.getTeamState();
  assert.equal(state.members.size, 3);
  for (const name of ["bull", "bear", "risk"]) {
    assert.ok(state.members.has(name), `应存在成员 ${name}`);
    assert.deepEqual(state.members.get(name).allowedTools, ["research", "read"]);
    // 预置成员都带角色专属 systemPrompt（上下文隔离的角色注入）。
    assert.ok(state.members.get(name).systemPrompt.length > 0);
  }
  assert.match(controller.getTeamView(), /bull \[idle\]/);
});

test("[L2a] getTeamView 渲染团队状态快照", async () => {
  const controller = createTeamController({ defaultModel: makeModel() });
  await getTool(controller, "TeamCreate").execute("c1", { name: "m1", role: "角色一" });
  const view = controller.getTeamView();
  assert.match(view, /Team: 1 members/);
  assert.match(view, /m1 \[idle\] 角色一/);
});

test("[L2a] getTeamView 是纯函数：同快照两次渲染结果一致，且不 mutate 快照", () => {
  const snapshot = {
    members: new Map([
      ["m1", { name: "m1", role: "研究员", model: makeModel(), status: "done", usage: { tokens: 10, cost: 0.01 } }],
    ]),
    inboundQueues: new Map(),
    events: [],
  };
  const first = getTeamView(snapshot);
  const second = getTeamView(snapshot);
  assert.equal(first, second);
  assert.match(first, /团队总计: 10 tokens/);
  assert.equal(snapshot.members.size, 1);
});

test("[L2a] TeamCreate / SendMessage 声明 effect=read（编排原语不触发审批）", () => {
  const controller = createTeamController({ defaultModel: makeModel() });
  for (const tool of controller.tools) {
    assert.equal(tool.effect, "read", `${tool.name} 应为只读编排原语`);
  }
});

test("[L2a] getTeamState 返回浅拷贝快照：外部 mutate 不影响内部状态", async () => {
  const controller = createTeamController({ defaultModel: makeModel() });
  await controller.createMember({ name: "m1", role: "角色" });
  const snapshot = controller.getTeamState();
  snapshot.members.delete("m1");
  snapshot.events.push({ type: "member_created", timestamp: 0, member: "ghost" });
  assert.ok(controller.hasMember("m1"));
  assert.equal(controller.getTeamState().members.size, 1);
  assert.equal(controller.getTeamState().events.length, 1);
});

// ---------------------------------------------------------------------------
// T-L1：resolveTools 语义（K3 工具子集的最小化边界，纯状态）
// ---------------------------------------------------------------------------

test("[L1] 成员工具子集：allowedTools undefined=全量池 / []=零工具（resolveTools 输入语义）", async () => {
  const readTool = {
    name: "read",
    description: "读",
    label: "read",
    parameters: z.object({ path: z.string() }),
    effect: "read",
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };
  const writes = [];
  const writeTool = createMockedWriteTool("write", writes);

  const controller = createTeamController({
    defaultModel: makeModel(),
    availableTools: [readTool, writeTool],
  });

  // resolveTools 的输入正是 member.allowedTools 与 availableTools 这两个可观测量的组合；
  // 二者的「不存在 / 显式空数组 / 具名子集」三态在此逐一定位（成员侧断言）。
  const full = await controller.createMember({ name: "full", role: "全量" });
  assert.equal(full.allowedTools, undefined, "undefined 表示未指定（回退全量池）");
  const none = await controller.createMember({ name: "none", role: "零工具", tools: [] });
  assert.deepEqual(none.allowedTools, [], "显式空数组必须保留为空，不能被当成全量池");
  const partial = await controller.createMember({ name: "partial", role: "只读", tools: ["read"] });
  assert.deepEqual(partial.allowedTools, ["read"]);

  // 纯状态路径：未派发任务 → 工具副作用出口一次都未被触碰。
  assert.equal(writes.length, 0);
});

// ---------------------------------------------------------------------------
// T-L1：并发原语（信号量 / worker 池 / 互斥锁，100% 确定性，不经 agentLoop）
// ---------------------------------------------------------------------------

/**
 * 构造一个「用可等待的闸门制造在飞重叠」的异步任务：
 * 每个任务把 resolve 推进 gate，测试在确认在飞数后统一放行。
 *
 * @param gate 收集放行函数的数组。
 * @param state 在飞计数状态对象（{ inFlight, peak }）。
 * @returns mapWithConcurrencyLimit 的任务函数。
 */
function gatedTask(gate, state) {
  return async (item) => {
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    await new Promise((resolve) => gate.push(resolve));
    state.inFlight--;
    return item;
  };
}

/**
 * 持续放行闸门里的任务，直到 target 完成；每次放行前断言在飞数不超过 limit。
 * 用递归而非固定轮次，避免与 worker 取任务的时序耦合导致偶发挂起。
 *
 * @param gate 放行函数数组。
 * @param state 在飞计数状态。
 * @param limit 在飞上限。
 * @param total 任务总数（全部完成即返回）。
 * @returns 全部任务完成后 resolve。
 */
async function drainUntilDone(gate, state, limit, total) {
  const settled = [];
  while (settled.length < total) {
    assert.ok(state.inFlight <= limit, `在飞数 ${state.inFlight} 应 <= ${limit}`);
    if (gate.length === 0) {
      // 等待 worker 取任务并进入临界区。
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(gate.length > 0 || settled.length >= total, "未全部完成前必须始终有任务在飞");
      continue;
    }
    const pending = gate.splice(0, gate.length);
    settled.push(...pending);
    for (const resolve of pending) resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("[L1] mapWithConcurrencyLimit：在飞峰值不超过 limit，结果顺序与输入一致", async () => {
  const gate = [];
  const state = { inFlight: 0, peak: 0 };
  const items = ["a", "b", "c", "d", "e", "f", "g"];
  const running = mapWithConcurrencyLimit(items, 3, gatedTask(gate, state));

  await drainUntilDone(gate, state, 3, items.length);
  const results = await running;

  assert.deepEqual(results, items, "结果顺序必须与输入一致（不因并发乱序）");
  assert.ok(state.peak <= 3, `在飞峰值 ${state.peak} 应 <= 3`);
  assert.equal(state.peak, 3, "limit=3 且任务充足时应真实并发到 3");
});

test("[L1] mapWithConcurrencyLimit：空输入返回空数组，limit<=0 夹到串行", async () => {
  assert.deepEqual(await mapWithConcurrencyLimit([], 3, async (x) => x), []);

  const gate = [];
  const state = { inFlight: 0, peak: 0 };
  const items = [1, 2, 3];
  const running = mapWithConcurrencyLimit(items, 0, gatedTask(gate, state));
  await drainUntilDone(gate, state, 1, items.length);
  assert.deepEqual(await running, items);
  assert.equal(state.peak, 1, "limit=0 必须夹到串行（峰值 1）");
});

test("[L1] AsyncMutex：临界区串行执行（合成输入，不经 agentLoop）", async () => {
  const mutex = new AsyncMutex();
  let inside = 0;
  let peak = 0;
  const order = [];

  /* 每个任务进入临界区后刻意 await 一次，给「没有互斥」留出穿插窗口。 */
  const critical = async (label) => {
    await mutex.acquire();
    try {
      inside++;
      peak = Math.max(peak, inside);
      order.push(`enter:${label}`);
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`exit:${label}`);
      inside--;
    } finally {
      mutex.release();
    }
  };

  await Promise.all(["a", "b", "c"].map((label) => critical(label)));
  assert.equal(peak, 1, "任意时刻临界区内至多一个持有者");
  // FIFO：enter/exit 成对且不交错。
  assert.deepEqual(order, ["enter:a", "exit:a", "enter:b", "exit:b", "enter:c", "exit:c"]);
});

/**
 * 构造一条 shouldStopAfterTurn 钩子上下文的合成样本（只填护栏真正读取的字段）。
 *
 * @param tokens 本回合 token 数。
 * @param cost 本回合成本（美元）。
 * @returns 钩子上下文。
 */
function syntheticTurn(tokens, cost = 0) {
  return {
    message: { role: "assistant", usage: { totalTokens: tokens, cost: { total: cost } } },
    toolResults: [],
    context: { messages: [], tools: [] },
    newMessages: [],
  };
}

test("[L1] createMemberStopHook：并发临界区下团队总 ceiling 原子生效（合成 usage）", async () => {
  // 团队总 token ceiling = 150；每个钩子单回合产 100 tokens。
  // 若「读-判-写」不原子，多个成员会同时读到 0 而同时放行 → 累计突破上限。
  const accumulator = { totalTokens: 0, totalCost: 0 };
  const mutex = new AsyncMutex();
  const model = makeModel();
  const hooks = Array.from({ length: 6 }, () => createMemberStopHook(model, { maxTokensTotal: 150 }, accumulator, mutex));

  const stops = await Promise.all(hooks.map((hook) => hook.shouldStopAfterTurn(syntheticTurn(100))));
  assert.equal(stops.filter(Boolean).length, 5, "150 只够 1 个成员，其余 5 个被拦停");
  assert.ok(accumulator.totalTokens <= 150, `团队累计 ${accumulator.totalTokens} 不得超 ceiling 150`);
  // per-member 用量无论是否被拦停都提交（用量报告准确）。
  for (const hook of hooks) assert.equal(hook.usage.tokens, 100);
});

test("[L1] createMemberStopHook：per-member 上限与 deadline 触发干净停止，用量仍计入", async () => {
  const accumulator = { totalTokens: 0, totalCost: 0 };
  const mutex = new AsyncMutex();
  const model = makeModel();

  const perMember = createMemberStopHook(model, { maxCostPerMember: 0.05 }, accumulator, mutex);
  assert.equal(await perMember.shouldStopAfterTurn(syntheticTurn(10, 0.04)), false);
  assert.equal(await perMember.shouldStopAfterTurn(syntheticTurn(10, 0.04)), true, "累计 0.08 超 0.05 → 停止");
  assert.equal(perMember.usage.cost, 0.08);

  // deadline：护栏闭包自查墙钟（agent-loop 不消费 deadlineMs），已在过去 → 立即停止。
  const expired = createMemberStopHook(model, {}, accumulator, mutex, Date.now() - 1);
  assert.equal(await expired.shouldStopAfterTurn(syntheticTurn(1)), true);

  // 未到期 → 不停止。
  const alive = createMemberStopHook(model, {}, accumulator, mutex, Date.now() + 60_000);
  assert.equal(await alive.shouldStopAfterTurn(syntheticTurn(1)), false);
});

test("[L1] createBudgetGuard 派发前估算（纯函数，独立于实际 usage）", () => {
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

  // token 上限必须与成本上限对称（回归防护）：零成本模型的估算成本恒为 0，
  // 若预检只比成本，纯 token ceiling 会永远放行，派发前拒绝这一层被静默跳过。
  // 这正是 W3 在 T-L1/T-L2a 档观测到的内核缺陷，此处锁定修复。
  const freeModel = makeModel("free");
  freeModel.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const zero = { totalTokens: 0, totalCost: 0 };

  // 零成本模型 + per-member token 上限：估算超限 → 拒绝。
  assert.equal(createBudgetGuard(freeModel, 100_000, { maxTokensPerMember: 10 }, zero), false);
  // 零成本模型 + 团队 token ceiling：估算超限 → 拒绝（此前会错误放行）。
  assert.equal(createBudgetGuard(freeModel, 100_000, { maxTokensTotal: 10 }, zero), false);
  // 团队 token ceiling 的剩余余量判定：余量不足 → 拒绝；余量充足 → 允许。
  assert.equal(createBudgetGuard(freeModel, 100, { maxTokensTotal: 1_000 }, { totalTokens: 950, totalCost: 0 }), false);
  assert.equal(createBudgetGuard(freeModel, 10, { maxTokensTotal: 1_000 }, { totalTokens: 0, totalCost: 0 }), true);
  // 未配置 token 上限时行为不变（付费模型按成本判定）。
  assert.equal(createBudgetGuard(model, 100_000, {}, acc), true);
});

test("[L1] runMember 的派发前预算预检：超预算直接拒绝，不触碰模型、不产生运行事件", async () => {
  // 预检早退发生在 agentLoop 之前，因此零 streamFn 即可断言全部状态：
  // 若预检被挪到 agentLoop 之后，这里会得到 subagent_failed 而非 budget_exceeded。
  const model = makeModel("expensive");
  model.cost = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
  const controller = createTeamController({ defaultModel: model, budget: { maxCostPerMember: 0.5 } });
  await controller.createMember({ name: "member", role: "角色" });

  const result = await controller.runMember("member", "任务", undefined, 1_000_000);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "budget_exceeded");
  assert.equal(result.budgetExceeded, true);
  assert.deepEqual(result.usage, { tokens: 0, cost: 0 });

  const state = controller.getTeamState();
  assert.equal(state.members.get("member").status, "failed");
  assert.equal(state.members.get("member").budgetExceeded, true);
  // 预检早退：未入队、未启动，只记录 member_failed。
  assert.deepEqual(
    state.events.map((e) => e.type),
    ["member_created", "member_failed"],
  );
  assert.equal(state.events[1].detail, "budget_precheck");
  assert.equal(state.inboundQueues.get("member").length, 0);
  // 团队累加器未被污染。
  assert.deepEqual(controller.getBudgetAccumulator(), { totalTokens: 0, totalCost: 0 });
});
