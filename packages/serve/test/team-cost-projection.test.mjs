/**
 * serve `cost_summary` 产线 + G-T1 team 成本投影接线单测（docs/v2.0/03-team-eval.md §9.1）。
 *
 * 被测链路：`createOhnaServer({ getTeamState })` → `RunManagerOptions.getTeamState`
 * → run 收尾 `projectTeamCostSummary(getTeamState())` → `cost_summary.payload.team`。
 *
 * 关于「假控制器」：这里的 `getTeamState` 只返回**内存态 `TeamState` 快照**（controller
 * 的纯数据产物），不 mock 任何模型输出、不装假 streamFn 回放预置 tool_call——`streamFn`
 * 仍是 serve 单测既有的「不联网 stub provider」，与 team 评测（L2b 真 provider）无关。
 *
 * 断言重点：
 * 1. 注入后 team 段与 `projectTeamCostSummary` 输出**逐字段一致**（单一真相源，serve 不二次累加）；
 * 2. 未注入（--no-team）时不出现 team 段——事件形状与接入前一致；
 * 3. 注入但团队为空（未 spawn 成员）时同样省略 team 段；
 * 4. team 段先于 run_status 落盘（订阅者拿到终态时已持有成本），且 team 段随 JSONL 持久化，
 *    断线重连 replay 可读。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { projectTeamCostSummary } from "@aiagent/agent";
import { createOhnaServer } from "../dist/index.js";
import { createAssistantMessageEventStream } from "@aiagent/ai";

const MODEL = {
  id: "stub-model",
  name: "Stub Model",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://127.0.0.1/mock",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096
};

/**
 * 自带 usage 的文本 stub：不联网，产出带 input/output/cost 的 assistant 消息。
 *
 * serve 单测既有的 `createTextStream` usage 全为 0，无法验证 `byModel` 是否真的在累加，
 * 所以这里单独造一条带非零 usage（input=100 / output=20 / cost=0.002）的流。
 *
 * @returns {Function} StreamFn。
 */
function createUsageTextStream() {
  return () => {
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "（测试替身）团队任务完成。" }],
      api: "openai-completions",
      provider: "mock",
      model: MODEL.id,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120,
        cost: { input: 0.0015, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.002 }
      },
      stopReason: "stop",
      timestamp: Date.now()
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({
        type: "text_start",
        contentIndex: 0,
        partial: { ...message, content: [{ type: "text", text: "" }] }
      });
      stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: message.content[0].text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

/**
 * 构造一个成员的内存态（形状对齐 `@aiagent/agent` 的 `TeamMember`，只填投影会读的字段）。
 *
 * @param {string} modelId 成员模型 id。
 * @param {object} [extra] 覆盖字段（usage / budgetExceeded / durationMs）。
 * @returns {object} 成员快照。
 */
function member(modelId, extra = {}) {
  return {
    name: "unused",
    role: "analyst",
    model: { id: modelId },
    status: "done",
    allowedTools: [],
    summary: "",
    ...extra
  };
}

/**
 * 构造内存态 `TeamState`（Map + 数组，与 controller.getTeamState 的快照同形）。
 *
 * @param {Record<string, object>} members 成员名 → 成员快照。
 * @param {object} [extra] 覆盖字段（peakConcurrency）。
 * @returns {object} TeamState。
 */
function teamState(members, extra = {}) {
  const map = new Map();
  for (const [name, value] of Object.entries(members)) map.set(name, { ...value, name });
  return { members: map, inboundQueues: new Map(), events: [], ...extra };
}

/**
 * 创建隔离的测试服务。
 *
 * @param {object} [options] 测试选项。
 * @param {Function} [options.getTeamState] 团队状态读取器（不传 = 未接 team）。
 * @returns {Promise<object>} 测试上下文。
 */
async function createTestServer(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-serve-team-cost-"));
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const server = await createOhnaServer({
    workspaceRoot,
    dataDir,
    model: MODEL,
    apiKey: "test-key",
    systemPrompt: "test system prompt",
    tools: [],
    staticDir: path.join(root, "web-dist"),
    streamFn: createUsageTextStream(),
    ...(options.getTeamState ? { getTeamState: options.getTeamState } : {}),
  });
  return { server, root };
}

/**
 * 清理服务与临时目录。
 *
 * @param {object} context 测试上下文。
 */
async function dispose(context) {
  await context.server.shutdown();
  await context.server.close();
  await fs.rm(context.root, { recursive: true, force: true });
}

/**
 * 轮询直到 run 进入终态。
 *
 * @param {object} server 服务。
 * @param {string} snapshotUrl 快照地址。
 * @returns {Promise<object>} 终态快照。
 */
async function waitForTerminal(server, snapshotUrl) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = (await server.app.inject({ method: "GET", url: snapshotUrl })).json().data;
    if (["completed", "failed", "cancelled", "interrupted"].includes(snapshot?.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not reach terminal state.");
}

/**
 * 解析 SSE 响应体中的 run_event 帧。
 *
 * @param {string} body SSE 文本。
 * @returns {object[]} 事件数组（按出现顺序）。
 */
function parseSseEvents(body) {
  return body
    .split("\n\n")
    .filter((frame) => frame.includes("event: run_event"))
    .map((frame) =>
      JSON.parse(
        frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n")
      )
    );
}

/**
 * 跑一次最小 run 并取回全量事件流。
 *
 * @param {object} server 服务。
 * @returns {Promise<object[]>} 事件数组。
 */
async function runOnce(server, options = {}) {
  const conversation = await server.createConversation("team 成本投影");
  const created = await server.createRun({
    conversationId: conversation.conversationId,
    message: "请让团队分析一下"
  });
  // 钩子时机：`createRun` 返回时 `RunManager` 已完成 `costTracker.begin`（团队用量基线快照），
  // 而 run 的派发尚未收尾。在此切换团队状态，精确模拟生产里「成员由本 run 内的 TeamCreate
  // 创建」的时序——基线为空、收尾时成员已有用量。
  options.onAfterCreateRun?.();
  await waitForTerminal(server, created.accepted.snapshotUrl);
  const sse = await server.app.inject({ method: "GET", url: created.accepted.eventsUrl });
  assert.equal(sse.statusCode, 200);
  return parseSseEvents(sse.body);
}

test("G-T1: 注入 getTeamState → cost_summary.team 与 projectTeamCostSummary 逐字段一致", async () => {
  const state = teamState(
    {
      bull: member("stub-model", { usage: { tokens: 120, cost: 0.0012 }, durationMs: 640 }),
      bear: member("stub-model", { usage: { tokens: 80, cost: 0.0008 }, durationMs: 410 }),
      // 创建但未跑过的成员：投影保留且 tokens/cost 为 0（§9.1.4 语义 1）。
      risk: member("stub-model"),
      guard: member("stub-model", { usage: { tokens: 10, cost: 0.0001 }, budgetExceeded: true })
    },
    { peakConcurrency: 2 }
  );
  // 时序必须与生产一致：成员是在**本 run 内**被 TeamCreate 创建并跑完的，
  // 而非 run 开始前就存在。serve 在 run 开始时给团队用量打基线，收尾只报本 run 增量，
  // 因此这里在 run 启动后再让成员「出现」，否则会被正确判定为历史 run 的用量。
  let live = teamState({});
  const context = await createTestServer({ getTeamState: () => live });
  const events = await runOnce(context.server, { onAfterCreateRun: () => { live = state; } });
  try {
    const costSummary = events.find((event) => event.type === "cost_summary");
    assert.ok(costSummary, "run 收尾必须产出 cost_summary");

    // 唯一真相源：serve 不做二次累加，数值必须与 agent 纯函数投影一致。
    // 差异仅在「本 run 无增量的成员」被按 run 归因剔除（见下），总量与逐成员数值不变。
    const { team } = costSummary.payload;
    const full = projectTeamCostSummary(state);
    assert.equal(team.totalTokens, full.totalTokens);
    assert.equal(team.totalCost, full.totalCost);
    for (const item of team.members) {
      assert.deepEqual(item, full.members.find((m) => m.name === item.name));
    }

    // run 级归因：有用量的成员（bull/bear/guard）全部出现，数值与全量投影逐字段相等。
    assert.equal(team.members.length, 3, "有本 run 用量增量的成员必须全部出现");
    assert.ok(team.members.some((m) => m.name === "bull"));
    assert.ok(team.members.some((m) => m.name === "bear"));
    assert.ok(team.members.some((m) => m.name === "guard"));
    // 零用量成员（risk）本 run 没有任何增量，按 run 归因被剔除——它属于「创建了但没跑」，
    // 不应把一个不属于本 run 的 0 用量行挂到本 run 的账上（跨 run 重复计数正是要根治的缺陷）。
    assert.equal(team.members.some((m) => m.name === "risk"), false, "本 run 零用量成员不应计入本 run 账");
    assert.equal(team.totalTokens, 210);
    assert.equal(Math.round(team.totalCost * 1e6) / 1e6, 0.0021);
    assert.equal(team.peakConcurrency, 2);
    assert.equal(team.members.find((item) => item.name === "bull").durationMs, 640);
    assert.equal(team.members.find((item) => item.name === "guard").budgetExceeded, true);
  } finally {
    await dispose(context);
  }
});

test("G-T1: 未注入 getTeamState（--no-team）→ cost_summary 不含 team 段，形状与接入前一致", async () => {
  const context = await createTestServer();
  try {
    const events = await runOnce(context.server);
    const costSummary = events.find((event) => event.type === "cost_summary");
    assert.ok(costSummary, "无 team 时也必须产出成本汇总");
    assert.equal("team" in costSummary.payload, false, "未接 team 时不得出现 team 键");
    // 既有扁平段仍然完整（本次新增产线不改变 byModel / byTool / total 口径）。
    assert.deepEqual(costSummary.payload.byModel, {
      [MODEL.id]: { input: 100, output: 20, totalTokens: 120, cost: 0.002 }
    });
    assert.equal(costSummary.payload.totalTokens, 120);
    assert.equal(costSummary.payload.totalCost, 0.002);
    assert.equal(costSummary.payload.turnCount, 1);
    assert.equal(costSummary.payload.outcome, "completed");
  } finally {
    await dispose(context);
  }
});

test("G-T1: 注入 getTeamState 但团队为空 → 省略 team 段（不产生误导性空段）", async () => {
  const context = await createTestServer({ getTeamState: () => teamState({}) });
  try {
    const events = await runOnce(context.server);
    const costSummary = events.find((event) => event.type === "cost_summary");
    assert.ok(costSummary);
    assert.equal("team" in costSummary.payload, false, "members 为空时不并入 team 段");
  } finally {
    await dispose(context);
  }
});

test("G-T1: cost_summary 先于 run_status 发出，且 team 段随 JSONL 持久化", async () => {
  const state = teamState({ bull: member("stub-model", { usage: { tokens: 5, cost: 0.00005 } }) });
  // 同上：成员在 run 期间出现（生产时序），故 run 起点为空团队。
  let live = teamState({});
  const context = await createTestServer({ getTeamState: () => live });
  const events = await runOnce(context.server, { onAfterCreateRun: () => { live = state; } });
  try {
    const costIndex = events.findIndex((event) => event.type === "cost_summary");
    const statusIndex = events.findIndex((event) => event.type === "run_status");
    assert.ok(costIndex >= 0 && statusIndex >= 0);
    assert.ok(costIndex < statusIndex, "成本汇总必须在终态帧之前，订阅者拿到终态时已持有 team 段");

    // 持久化：cost_summary 属关键事件（非 message_update），断线重连 replay 必须能恢复 team 段。
    const persisted = events[costIndex];
    const file = path.join(context.root, "data", "runs", `${persisted.runId}.jsonl`);
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const saved = lines.find((line) => line.type === "cost_summary");
    assert.ok(saved, "cost_summary 必须落盘");
    assert.deepEqual(saved.payload.team, projectTeamCostSummary(state));
  } finally {
    await dispose(context);
  }
});

test("G-T1: 投影抛错时不影响 run 终态（观测数据不得拖垮执行）", async () => {
  const context = await createTestServer({
    getTeamState: () => {
      throw new Error("boom");
    }
  });
  try {
    const events = await runOnce(context.server);
    const terminal = events.find((event) => event.type === "run_status");
    assert.equal(terminal.payload.status, "completed", "投影失败必须被吞掉，run 仍 completed");
    const costSummary = events.find((event) => event.type === "cost_summary");
    assert.equal(costSummary, undefined, "投影失败时不发半成品 cost_summary");
  } finally {
    await dispose(context);
  }
});

/**
 * 一条执行中会挂起的流：永不发 done，使 run 停留在 active（首轮进行中）。
 *
 * @returns {Function} StreamFn。
 */
function createHangingStream() {
  return () => {
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: "openai-completions",
      provider: "mock",
      model: MODEL.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now()
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
    });
    return stream;
  };
}

test("G-T1: 取消仍在执行的 run 仍有 cost_summary，终态为 interrupted（不静默缺失成本）", async () => {
  // resolveWorkspace 卡点机制已随 Task 11 退役，无法复现「execute 未启动」窗口。
  // 改为：用挂起流让 run 进入 active（首轮进行中），确认其已激活后 cancel，断言仍发
  // cost_summary 且终态 interrupted——本质仍是「非 completed 终态也发 cost_summary」。
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-serve-team-cost-cancel-"));
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const server = await createOhnaServer({
    workspaceRoot,
    dataDir,
    model: MODEL,
    apiKey: "test-key",
    systemPrompt: "test system prompt",
    tools: [],
    staticDir: path.join(root, "web-dist"),
    streamFn: createHangingStream()
  });
  try {
    const conversation = await server.createConversation("active 中取消");
    const created = await server.createRun({
      conversationId: conversation.conversationId,
      message: "一直跑被取消"
    });

    // 等 run 进入 active（首轮已派发、尚未终态）。
    let active = false;
    for (let attempt = 0; attempt < 300 && !active; attempt += 1) {
      const listed = await server.listRunsByConversation(conversation.conversationId);
      const run = listed.find((r) => r.runId === created.accepted.runId);
      active = run && ["queued", "running", "active"].includes(run.status);
      if (!active) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(active, "run 必须已进入 active 表");

    await server.cancelRun(created.accepted.runId);

    const sse = await server.app.inject({ method: "GET", url: created.accepted.eventsUrl });
    const events = parseSseEvents(sse.body);
    const terminal = events.find((event) => event.type === "run_status");
    assert.ok(terminal, "run 必须收尾");
    const costSummary = events.find((event) => event.type === "cost_summary");
    assert.ok(costSummary, "提前取消的 run 也必须有 cost_summary（不能缺失被误读为零成本）");
    assert.equal(costSummary.payload.outcome, "interrupted");
    assert.equal(typeof costSummary.payload.totalTokens, "number");
    assert.equal(typeof costSummary.payload.durationMs, "number");
  } finally {
    await server.shutdown();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("G-T1: 投影失败输出带 runId 的 stderr 诊断（不静默吞掉）", async () => {
  const context = await createTestServer({
    getTeamState: () => {
      throw new Error("projection boom");
    }
  });
  const originalWrite = process.stderr.write;
  const captured = [];
  process.stderr.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    const events = await runOnce(context.server);
    const terminal = events.find((event) => event.type === "run_status");
    assert.equal(terminal.payload.status, "completed", "诊断输出不得改变 run 终态");
    const diagnostic = captured.find((line) => line.includes("cost_summary"));
    assert.ok(diagnostic, "必须留下可排障的 stderr 诊断");
    assert.match(diagnostic, /projection boom/, "诊断需带底层错误原因");
    assert.match(diagnostic, /[0-9a-f-]{36}/, "诊断需带 runId，便于按 run 归因");
  } finally {
    process.stderr.write = originalWrite;
    await dispose(context);
  }
});

test("G-T1: 同一会话连跑两个 run → 第二个 run 的 team 段不重复计入第一个 run（run 级归因）", async () => {
  // 缺陷复现：TeamController 是**会话级**实例（state.members / usage 跨 run 存活），
  // 若收尾时直接 projectTeamCostSummary(getTeamState()) 投影全量状态，第二个 run 会把
  // 第一个 run 的成员成本再算一遍，成本归因随会话单调虚高（§7 tokenAttributionToMember 失真）。
  // 修复方式：run 开始打基线快照，收尾只报增量。本用例钉死该行为。
  let live = teamState({});
  const context = await createTestServer({ getTeamState: () => live });
  try {
    // ---- run 1：bull 跑出 100 tokens / $0.001 ----
    let events1 = await runOnce(context.server, {
      onAfterCreateRun: () => {
        live = teamState({ bull: member("stub-model", { usage: { tokens: 100, cost: 0.001 } }) });
      }
    });
    const team1 = events1.find((event) => event.type === "cost_summary").payload.team;
    assert.ok(team1, "run 1 必须有 team 段");
    assert.equal(team1.totalTokens, 100);
    assert.equal(team1.members.length, 1);

    // ---- run 2：同一 controller，bull 累计涨到 160，且新增 bear 30 ----
    // 团队状态是累加的（生产里 controller 不会因 run 结束而重置）。
    const events2 = await runOnce(context.server, {
      onAfterCreateRun: () => {
        live = teamState({
          bull: member("stub-model", { usage: { tokens: 160, cost: 0.0016 } }),
          bear: member("stub-model", { usage: { tokens: 30, cost: 0.0003 } })
        });
      }
    });
    const team2 = events2.find((event) => event.type === "cost_summary").payload.team;
    assert.ok(team2, "run 2 必须有 team 段");

    // run 2 只报增量：bull 增量 60、bear 增量 30，合计 90 —— 而不是累计的 190。
    const bull2 = team2.members.find((m) => m.name === "bull");
    const bear2 = team2.members.find((m) => m.name === "bear");
    assert.equal(bull2.tokens, 60, "bull 在 run 2 的增量必须是 60（160-100），不能是累计 160");
    assert.equal(bear2.tokens, 30, "bear 是本 run 新成员，增量即全部用量");
    assert.equal(team2.totalTokens, 90, "run 2 总量为增量之和，不得包含 run 1 的 100");
    assert.equal(Number(team2.totalCost.toFixed(6)), 0.0009);
  } finally {
    await dispose(context);
  }
});
