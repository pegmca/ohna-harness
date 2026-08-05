/**
 * Loop eval runner（docs/worktree/06-capability-integration.md 第 4 节）：
 * 用 mock streamFn 注入确定性模型流跑真 `agentLoop`，从 run_events 收集证据投影后
 * 复用 automation.ts 的确定性打分与回归门禁——指标口径、阈值、`llmJudge: false` 不变。
 *
 * 事件映射（06 映射表）：
 * - 断言来源从旧 trace 事件切到 loop/run_events：agent_start / turn_start /
 *   message_end（AssistantMessage，token 统计来源）/ tool_execution_start /
 *   tool_execution_end / agent_end（run 终止证据）；
 * - 能力事件名保留：retrieval（grounding hook 写入）、workflow_node / pdf_export
 *   （generate_report 工具 sink 写入）、security / mcp_tool_discovered（本数据集无对应
 *   期望，不模拟）；
 * - intent_routed / report_plan / report_skill_activation / approval / agent_step /
 *   model_call / tool_call / final_response 随旧体系删除，断言与 fixture 字段同步移除
 *   （dataset v1.0.0 本就不含这些字段，反向断言见 loop-runner.test.mjs）。
 *
 * 双层预算：agentLoop config 层（shouldStopAfterTurn 计 turn 数与 token 累计，
 * maxTurns 见 LOOP_EVAL_BUDGETS）+ runner 硬上限（事件消费侧计数 turn_start 超限即
 * abort，外加每 case 墙钟兜底），防止 mock 流失效时 eval 失控；超预算记 ok=false。
 */
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Usage,
} from "@aiagent/ai";
import {
  agentLoop,
  defaultConvertToLlm,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@aiagent/agent";
import { z } from "zod";
import {
  aggregateAutomationMetrics,
  checkAutomationRegression,
  DEFAULT_REGRESSION_THRESHOLDS,
  scoreCaseWithEvidence,
  type AutomationCaseResult,
  type AutomationReport,
  type EvalBaseline,
  type EvalDataset,
  type EvalMode,
  type RegressionThresholds,
  type UnifiedEvalCase,
  type UnifiedEvalFixture,
} from "./automation.js";
import { projectRunEvents, type LoopEvalRunEvent } from "./loop-projection.js";

export type { LoopEvalRunEvent } from "./loop-projection.js";

/** 单个 case 的多轮 loop 预算（06 文档第 4 节预算表）。 */
export interface LoopEvalBudget {
  /** agentLoop config 层 turn 上限（shouldStopAfterTurn 计数）。 */
  maxTurns: number;
  /** input+output 合计 token 预算，按 AssistantMessage.usage 累计。 */
  tokenBudget: number;
}

/** mode → 预算映射：chat 一轮问答+兜底续轮；rag 接地注入+至多 2 次工具轮；report 检索+长工具+总结；failure 必须触达终止。 */
export const LOOP_EVAL_BUDGETS: Readonly<Record<EvalMode, LoopEvalBudget>> = {
  chat: { maxTurns: 2, tokenBudget: 8_000 },
  rag: { maxTurns: 4, tokenBudget: 24_000 },
  report: { maxTurns: 10, tokenBudget: 80_000 },
  failure: { maxTurns: 3, tokenBudget: 16_000 },
};

/** runner 硬上限：config 层失效时的兜底，turn 数允许少量冗余（steering/follow-up 空转）。 */
const RUNNER_HARD_TURN_SLACK = 2;
/** runner 硬上限：单 case 墙钟兜底毫秒数。 */
const RUNNER_HARD_DEADLINE_MS = 30_000;

/** 单条 case 的 loop 执行产出：证据投影 + 完整 run_events。 */
export interface LoopEvalCaseRun {
  caseId: string;
  /** 从 run_events 投影出的打分证据（形状与 fixture 相同，替代旧直接读 fixture）。 */
  evidence: UnifiedEvalFixture;
  /** 本次 run 收集的全部 run_events（供事件映射断言与调试）。 */
  events: LoopEvalRunEvent[];
  /** 是否因超预算被截停（turn 或 token 维度）。 */
  budgetExceeded: boolean;
}

/** runLoopEval 选项。 */
export interface LoopEvalOptions {
  baseline?: EvalBaseline;
  thresholds?: RegressionThresholds;
  /** 测试注入：覆盖按 fixture 推导的默认 mock streamFn。 */
  streamFnFactory?: (item: UnifiedEvalCase) => StreamFn;
  /** 观测钩子：每个 case 跑完后回调其 run_events（供测试断言事件映射）。 */
  onCaseRun?: (run: LoopEvalCaseRun) => void;
}

/** eval 专用 mock 模型条目；api 仅占位，mock streamFn 不会发起 HTTP 请求。 */
const EVAL_MODEL: Model<"openai-completions"> = {
  id: "eval-mock",
  name: "Eval Mock Agent",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://localhost/eval-mock",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

/** 每轮 mock usage：非零以便 token 预算累计逻辑被真实执行。 */
const TURN_USAGE: Usage = {
  input: 120,
  output: 80,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 200,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * 用真 agentLoop 跑整个数据集并生成与旧入口同形状的报告。
 * case 顺序执行保证可复现；证据来自 run_events 投影而非直接读 fixture。
 *
 * @param dataset 固定版本数据集（fixture 作为 mock 流/工具的确定性种子）。
 * @param options 基线、阈值与测试注入点。
 * @returns 机器报告（strategy 仍为 deterministic_fixture，llmJudge  false）。
 */
export async function runLoopEval(dataset: EvalDataset, options: LoopEvalOptions = {}): Promise<AutomationReport> {
  const thresholds = options.thresholds ?? DEFAULT_REGRESSION_THRESHOLDS;
  const results: AutomationCaseResult[] = [];

  for (const item of dataset.cases) {
    const run = await runEvalCaseWithLoop(item, options);
    options.onCaseRun?.(run);
    results.push(scoreCaseWithEvidence(item, run.evidence));
  }

  const metrics = aggregateAutomationMetrics(results);
  const baseline = options.baseline;
  const diff = baseline
    ? (Object.keys(metrics) as Array<keyof typeof metrics>).map((metric) => ({
        metric,
        current: metrics[metric],
        baseline: baseline.metrics[metric],
        delta: Math.round((metrics[metric] - baseline.metrics[metric]) * 1000) / 1000,
      }))
    : [];
  const regressionReasons = checkAutomationRegression(metrics, baseline, thresholds);

  return {
    schemaVersion: "1.0.0",
    datasetVersion: dataset.datasetVersion,
    run: {
      id: `eval-${dataset.datasetVersion}-seed-${dataset.seed}`,
      startedAt: new Date().toISOString(),
      seed: dataset.seed,
      strategy: "deterministic_fixture",
      llmJudge: false,
    },
    metrics,
    results,
    failures: results.filter((item) => !item.passed),
    baseline,
    diff,
    regressionReasons,
  };
}

/**
 * 跑单条 case：装配 mock 工具与 grounding hook → agentLoop → run_events → 证据投影。
 *
 * @param item 数据集用例。
 * @param options 可选 streamFn 覆盖（测试用）。
 * @returns 证据、run_events 与预算截停标记。
 */
export async function runEvalCaseWithLoop(
  item: UnifiedEvalCase,
  options: Pick<LoopEvalOptions, "streamFnFactory"> = {},
): Promise<LoopEvalCaseRun> {
  const budget = LOOP_EVAL_BUDGETS[item.mode];
  const events: LoopEvalRunEvent[] = [];
  const record = (type: string, payload: Record<string, unknown>): void => {
    events.push({ seq: events.length + 1, type, payload });
  };

  const startedAt = Date.now();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), RUNNER_HARD_DEADLINE_MS);

  // 预算状态：config 层（shouldStopAfterTurn）与 runner 硬上限共用计数。
  let turnsCompleted = 0;
  let tokensUsed = 0;
  let budgetExceeded = false;

  const context = {
    systemPrompt: "你是金融研究助手。需要证据时调用工具，用户要求研报时必须调用 generate_report。",
    messages: [] as AgentMessage[],
    tools: createEvalTools(item, record),
  };

  const config: AgentLoopConfig = {
    model: EVAL_MODEL,
    convertToLlm: defaultConvertToLlm,
    transformContext: createEvalGroundingTransform(item, record),
    deadlineMs: RUNNER_HARD_DEADLINE_MS,
    shouldStopAfterTurn: ({ newMessages }) => {
      // turn 与 token 双维度预算：token 按 newMessages 中 assistant 消息 usage 累计。
      turnsCompleted += 1;
      tokensUsed = sumAssistantTokens(newMessages);
      if (turnsCompleted >= budget.maxTurns || tokensUsed > budget.tokenBudget) {
        budgetExceeded = true;
        return true;
      }
      return false;
    },
  };

  const streamFn = options.streamFnFactory?.(item) ?? createFixtureStreamFn(item);
  const prompt: AgentMessage = { role: "user", content: item.query, timestamp: Date.now() };
  const stream = agentLoop([prompt], context, config, controller.signal, streamFn);

  try {
    let turnStarts = 0;
    for await (const event of stream) {
      recordLoopEvent(event, record);
      if (event.type === "turn_start") {
        turnStarts += 1;
        // runner 硬上限：config 层预算失效（如钩子被改坏）时兜底掐断。
        if (turnStarts > budget.maxTurns + RUNNER_HARD_TURN_SLACK) controller.abort();
      }
    }
  } finally {
    clearTimeout(deadline);
  }

  const evidence = projectRunEvents(item, events, { budgetExceeded, latencyMs: Date.now() - startedAt });
  return { caseId: item.id, evidence, events, budgetExceeded };
}

/**
 * 按 fixture 推导每轮 mock assistant 消息并生成 StreamFn（fixture 驱动，不按 mode 分支）：
 * - fixture.workflow 非空：turn1 调 generate_report，turn2 输出 fixture.answer 收尾；
 * - 否则 fixture.retrievedChunks 非空：turn1 调 search_filings，turn2 输出 fixture.answer；
 * - 否则单轮文本回答；
 * - fixture.ok=false（失败注入用例）：收尾轮以 stopReason "error" 终止，复现 run 级失败。
 *
 * @param item 数据集用例。
 * @returns 确定性 mock streamFn（事件序列对齐真实 provider：start → done/error）。
 */
function createFixtureStreamFn(item: UnifiedEvalCase): StreamFn {
  const script = planMockTurns(item);
  let turn = 0;

  return (): AssistantMessageEventStream => {
    const spec = script[Math.min(turn, script.length - 1)];
    turn += 1;
    const message = createMockAssistantMessage(spec);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      }
    });
    return stream;
  };
}

/** mock 轮次脚本：text 为最终回答，toolCall 为当轮工具调用（二选一）；error 表示 run 级失败收尾。 */
interface MockTurnSpec {
  text?: string;
  toolCall?: { name: string; arguments: Record<string, unknown> };
  error?: boolean;
}

/**
 * 从 fixture 推导工具调用序列（06：工具调用序列从 fixture 的 workflow/检索期望推导）。
 * 纯 fixture 驱动：failure 用例同样可能携带检索/工作流证据（如 fail-002 无来源结论、
 * fail-003 workflow 中途终止），不能按 mode 跳过。
 *
 * @param item 数据集用例。
 * @returns 逐轮 mock 输出脚本。
 */
function planMockTurns(item: UnifiedEvalCase): MockTurnSpec[] {
  const { fixture } = item;
  const finalTurn: MockTurnSpec = { text: fixture.answer, error: !fixture.ok };
  if (fixture.workflow.length > 0) {
    return [
      { toolCall: { name: "generate_report", arguments: { subject: item.query } } },
      finalTurn,
    ];
  }
  if (fixture.retrievedChunks.length > 0) {
    return [
      { toolCall: { name: "search_filings", arguments: { query: item.query } } },
      finalTurn,
    ];
  }
  return [finalTurn];
}

/**
 * 组装一条完整的 mock AssistantMessage。
 *
 * @param spec 本轮输出脚本。
 * @returns AssistantMessage（toolUse / stop / error）。
 */
function createMockAssistantMessage(spec: MockTurnSpec): AssistantMessage {
  const content: AssistantMessage["content"] = spec.toolCall
    ? [{ type: "toolCall", id: `eval_call_${spec.toolCall.name}`, name: spec.toolCall.name, arguments: spec.toolCall.arguments }]
    : [{ type: "text", text: spec.text ?? "" }];
  return {
    role: "assistant",
    content,
    api: EVAL_MODEL.api,
    provider: EVAL_MODEL.provider,
    model: EVAL_MODEL.id,
    usage: TURN_USAGE,
    stopReason: spec.toolCall ? "toolUse" : spec.error ? "error" : "stop",
    timestamp: Date.now(),
  };
}

/**
 * 创建 eval 用 mock 工具集（生产 generate_report / search_filings 的确定性替身）：
 * - search_filings：返回 fixture.retrievedChunks 作为检索结果（details 携带 chunks）；
 * - generate_report：按 fixture.workflow 逐节点写 workflow_node 事件、按 fixture
 *   写 pdf_export 事件，details 携带 sections / citations / exportStatus。
 *
 * @param item 数据集用例（fixture 为种子）。
 * @param record run_events 记录器。
 * @returns 可直接放入 agentLoop config.tools 的 AgentTool 数组。
 */
function createEvalTools(item: UnifiedEvalCase, record: (type: string, payload: Record<string, unknown>) => void): AgentTool[] {
  const { fixture } = item;

  const searchFilings: AgentTool = {
    name: "search_filings",
    description: "按 query 检索公告/年报片段（eval mock）。",
    label: "search_filings",
    parameters: z.object({ query: z.string() }),
    execute: async () => ({
      content: [
        {
          type: "text",
          text: fixture.retrievedChunks.map((chunk) => `[${chunk.id}] 来源：${chunk.source}\n${chunk.text}`).join("\n"),
        },
      ],
      details: { chunks: fixture.retrievedChunks },
    }),
  };

  const generateReport: AgentTool = {
    name: "generate_report",
    description: "生成研究报告（eval mock）：内部跑完整 workflow，末端导出 PDF。",
    label: "generate_report",
    parameters: z.object({ subject: z.string(), scope: z.string().optional() }),
    execute: async () => {
      for (const node of fixture.workflow) {
        record("workflow_node", { node, status: "completed" });
      }
      if (fixture.exportStatus) {
        record("pdf_export", { status: fixture.exportStatus, sections: fixture.sections });
      }
      return {
        content: [{ type: "text", text: `研报草稿（${fixture.sections.join(" / ")}）` }],
        details: {
          sections: fixture.sections,
          citations: fixture.citations,
          exportStatus: fixture.exportStatus,
        },
      };
    },
  };

  return [searchFilings, generateReport];
}

/**
 * 创建 eval 用 grounding transformContext（生产 grounding hook 的确定性替身）：
 * 首轮调用前把 fixture.retrievedChunks 以 <untrusted_context> user 消息注入，
 * 并写 retrieval 事件（事件名与生产一致；payload 携带 chunks 与 citations 供投影）。
 * 只注入一次，避免 pi transformContext 每轮都跑导致的重复注入。
 *
 * @param item 数据集用例。
 * @param record run_events 记录器。
 * @returns 可直接挂到 AgentLoopConfig.transformContext 的函数。
 */
function createEvalGroundingTransform(
  item: UnifiedEvalCase,
  record: (type: string, payload: Record<string, unknown>) => void,
): AgentLoopConfig["transformContext"] {
  let injected = false;

  return async (messages) => {
    if (injected) return messages;
    injected = true;
    // fixture 驱动：凡带检索证据的用例都注入（含 failure 模式的无来源结论用例）。
    if (item.fixture.retrievedChunks.length === 0) return messages;

    record("retrieval", {
      query: item.query,
      mode: "hybrid",
      topK: item.fixture.retrievedChunks.length,
      chunkIds: item.fixture.retrievedChunks.map((chunk) => chunk.id),
      chunks: item.fixture.retrievedChunks,
      citations: item.fixture.citations,
    });

    const contextMessage: AgentMessage = {
      role: "user",
      content: `<untrusted_context>\n${item.fixture.retrievedChunks.map((chunk) => chunk.text).join("\n")}\n</untrusted_context>`,
      timestamp: Date.now(),
    };
    // 与生产 hook 一致：插到最后一条用户消息之前，让模型先看到证据再看到问题。
    const index = messages.map((message) => message.role).lastIndexOf("user");
    return index === -1
      ? [...messages, contextMessage]
      : [...messages.slice(0, index), contextMessage, ...messages.slice(index)];
  };
}

/**
 * 把 loop AgentEvent 归并进 run_events：只记录断言与投影需要的事件，
 * 载荷保留投影所需字段（message / usage / 工具名与结果）。
 *
 * @param event loop 事件。
 * @param record run_events 记录器。
 */
function recordLoopEvent(event: AgentEvent, record: (type: string, payload: Record<string, unknown>) => void): void {
  switch (event.type) {
    case "agent_start":
      record("agent_start", {});
      break;
    case "agent_end":
      record("agent_end", {
        error: event.error,
        messages: event.messages,
      });
      break;
    case "turn_start":
      record("turn_start", {});
      break;
    case "turn_end":
      record("turn_end", { message: event.message, toolResults: event.toolResults });
      break;
    case "message_end":
      record("message_end", { message: event.message });
      break;
    case "tool_execution_start":
      record("tool_execution_start", { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
      break;
    case "tool_execution_end":
      record("tool_execution_end", { toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError });
      break;
    default:
      // message_start / message_update / tool_execution_update 不进证据投影，省略。
      break;
  }
}

/**
 * 累计 newMessages 中全部 assistant 消息的 token 用量（input+output 合计口径）。
 *
 * @param messages 本次 run 新产生的消息。
 * @returns token 总量。
 */
function sumAssistantTokens(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === "assistant") total += message.usage.input + message.usage.output;
  }
  return total;
}
