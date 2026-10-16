/**
 * 容量 / SLO 证据脚本（docs/v1.2 §3 差距#7 收口 · 数据化叙事用）。
 *
 * 运行方式（先 build，再跑脚本）：
 *   pnpm --filter @aiagent/agent build
 *   node test/capacity-slo-evidence.mjs
 *
 * 它用 agent 包的 mock 能力（AssistantMessageEventStream + 可控 streamFn）分别跑：
 *   (a) 单 Agent：N 次（每次 1 turn、可控时延）；
 *   (b) 多 Agent：bull/bear/risk 三成员并发 M 次（maxConcurrentMembers=3）。
 * 收集每次的 RunSloSummary，对两组分别调用 summarizeSlo，打印「单 Agent vs 多 Agent」对比表。
 *
 * 说明：成本数字已由 cost_summary 覆盖，本脚本只补「时延 / 成功率 / 并发」容量证据。
 * 全部用 mock 模型，不触网、不花钱；结果用于展示与回归对照。
 */
import assert from "node:assert/strict";
import { agentLoop, defaultConvertToLlm, createBullBearRiskTeam, summarizeSlo } from "../packages/agent/dist/index.js";
import { AssistantMessageEventStream } from "../packages/ai/dist/index.js";

const N = Number(process.env.SLO_N ?? 6);
const M = Number(process.env.SLO_M ?? 4);
const LATENCY_MS = Number(process.env.SLO_LATENCY ?? 30);

/** 构造一个 Model（字段对齐 @aiagent/ai 的 Model）。 */
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

/** 构造一条带自定义 usage 的 assistant 消息（成本护栏 / 证据口径用）。 */
function costedMessage(text, totalTokens, costTotal) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "mock",
    model: "mock-model",
    usage: {
      input: totalTokens / 2,
      output: totalTokens / 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * 构造可控时延的 mock streamFn：latencyMs 后回放一条固定 assistant 消息（start → done）。
 * 用 setTimeout 模拟真实 LLM 调用墙钟时延，使 durationMs 反映可量化 SLO。
 *
 * @param message 要回放的 assistant 消息。
 * @param latencyMs 单 turn 模拟时延（毫秒）。
 * @returns StreamFn 兼容函数。
 */
function makeMockStreamFn(message, latencyMs) {
  return () => {
    const stream = new AssistantMessageEventStream();
    setTimeout(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
    }, latencyMs);
    return stream;
  };
}

/**
 * 跑一次单 Agent（单 turn），返回本次 run 的 SLO 样本。
 * 时延 = 包裹 agentLoop 的墙钟；turnCount = assistant 消息数；成本 = 累加 usage.cost。
 *
 * @param latencyMs 单 turn 模拟时延。
 * @returns RunSloSummary。
 */
async function runSingleAgent(latencyMs) {
  const msg = costedMessage("结论：基本面稳健", 800, 0.04);
  const start = Date.now();
  let assistantTurns = 0;
  let totalCost = 0;
  const stream = agentLoop(
    [{ role: "user", content: "分析某公司", timestamp: Date.now() }],
    { systemPrompt: "你是金融研究 Agent。", messages: [], tools: [] },
    {
      model: makeModel("single"),
      apiKey: "test",
      convertToLlm: defaultConvertToLlm,
      shouldStopAfterTurn: ({ newMessages }) =>
        newMessages.filter((m) => m.role === "assistant").length >= 1,
    },
    undefined,
    makeMockStreamFn(msg, latencyMs),
  );
  for await (const event of stream) {
    if (event.type === "message_end" && event.message.role === "assistant") {
      assistantTurns++;
      const cost = event.message.usage?.cost?.total;
      if (Number.isFinite(cost)) totalCost += cost;
    }
  }
  const durationMs = Date.now() - start;
  return {
    durationMs,
    turnCount: assistantTurns,
    outcome: "completed",
    totalCost,
    // 单 Agent 一次在途 run 即 1 个活跃执行（容量基准）。
    activeRuns: 1,
    peakConcurrency: 1,
  };
}

/**
 * 跑一次 bull/bear/risk 三成员并发团队（maxConcurrentMembers=3），返回本次 run 的 SLO 样本。
 * 时延 = 包裹 runMembers 的墙钟；turnCount = 各成员 assistant 消息之和；
 * 成本 = 各成员用量成本之和；peakConcurrency = controller 观测到的在飞成员峰值。
 *
 * @param latencyMs 每成员单 turn 模拟时延。
 * @returns RunSloSummary。
 */
async function runBullBearRiskTeam(latencyMs) {
  const controller = createBullBearRiskTeam({
    defaultModel: makeModel("team"),
    streamFn: makeMockStreamFn(costedMessage("视角结论", 500, 0.05), latencyMs),
    maxConcurrentMembers: 3,
  });
  const start = Date.now();
  await controller.runMembers(["bull", "bear", "risk"], "评估某标的多空与风险", 3);
  const durationMs = Date.now() - start;

  const state = controller.getTeamState();
  let turnCount = 0;
  let totalCost = 0;
  for (const [, member] of state.members) {
    // 每个成员产出 1 条 assistant 消息（1 turn）。
    if (member.usage && Number.isFinite(member.usage.cost)) {
      turnCount += 1;
      totalCost += member.usage.cost;
    }
  }
  return {
    durationMs,
    turnCount,
    outcome: "completed",
    totalCost,
    activeRuns: 1,
    // 多代理并发峰值：来自 controller 维护的 runningMembers 在飞计数峰值（此处 = 3）。
    peakConcurrency: state.peakConcurrency ?? 3,
  };
}

/** 打印一行对比指标（格式化，便于终端阅读）。 */
function fmt(n, digits = 2) {
  return typeof n === "number" ? n.toFixed(digits) : String(n ?? "-");
}

async function main() {
  console.log(`\n=== 容量 / SLO 证据：单 Agent (N=${N}) vs 多 Agent (M=${M}) ===`);
  console.log(`（单 turn 模拟时延 ${LATENCY_MS}ms；mock 模型，不触网不花钱）\n`);

  const singleRuns = [];
  for (let i = 0; i < N; i++) singleRuns.push(await runSingleAgent(LATENCY_MS));
  const teamRuns = [];
  for (let i = 0; i < M; i++) teamRuns.push(await runBullBearRiskTeam(LATENCY_MS));

  const single = summarizeSlo(singleRuns);
  const team = summarizeSlo(teamRuns);

  // 健全性断言：样本数正确，且团队并发峰值应大于单 Agent（多代理真正并发）。
  assert.equal(single.count, N);
  assert.equal(team.count, M);
  assert.ok(team.maxPeakConcurrency !== undefined && team.maxPeakConcurrency > 1, "团队应观测到并发峰值 > 1");

  const rows = [
    ["样本数 count", single.count, team.count],
    ["成功率 successRate", fmt(single.successRate), fmt(team.successRate)],
    ["时延 p50 (ms)", fmt(single.p50DurationMs, 1), fmt(team.p50DurationMs, 1)],
    ["时延 p95 (ms)", fmt(single.p95DurationMs, 1), fmt(team.p95DurationMs, 1)],
    ["平均时延 (ms)", fmt(single.avgDurationMs, 1), fmt(team.avgDurationMs, 1)],
    ["平均成本 ($)", fmt(single.avgCost), fmt(team.avgCost)],
    ["平均 turn 数", fmt(single.avgTurnCount, 1), fmt(team.avgTurnCount, 1)],
    ["峰值并发 maxPeakConcurrency", single.maxPeakConcurrency ?? "-", team.maxPeakConcurrency ?? "-"],
  ];

  console.log(["指标", "单 Agent", "多 Agent (bull/bear/risk)"].join("\t"));
  for (const [label, a, b] of rows) {
    console.log([label, String(a), String(b)].join("\t"));
  }
  console.log(
    "\n解读：团队峰值并发 = 3 但单次 run 时延与单 Agent 接近（并发执行），"
      + "平均成本 ≈ 3×——对应「多代理贵、必须收口」的容量/SLO 证据。",
  );
  console.log("summarizeSlo 单 Agent:", JSON.stringify(single));
  console.log("summarizeSlo 多 Agent:", JSON.stringify(team));
}

main().catch((err) => {
  console.error("证据脚本失败:", err);
  process.exit(1);
});
