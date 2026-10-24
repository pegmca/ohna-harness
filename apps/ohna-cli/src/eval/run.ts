/**
 * ohna 编码 Agent 评测执行器（v2.0 评测体系 Step 4，领域自治方案 §3.4 / ohna-eval-run 工作项）。
 *
 * 本模块是评测「执行编排」中枢：把 dataset 的 case、adapter 的 mock 工具与离线 streamFn、
 * metrics 的打分、eval-core 的报告聚合串成一条链路，产出 `EvalReportDto`。
 *
 * 关键职责与约束（Step 4 验收硬条件）：
 * - **轨迹证据来自 agentLoop 的 AgentEvent 流**：订阅 `agentLoop` 事件流，把
 *   `tool_execution_end` 事件投影成 `ToolCallStep[]`（app eval 域投影，不进内核投影）；
 *   内核 `matchTrajectory` 只做「匹配」，不投影。
 * - **临时工作区真实创建并清理**：每条 case 用 `node:fs/tmp` 建临时目录，预置种子文件，
 *   mock 工具真实写盘，case 后 `rmSync` 递归清理。
 * - **streamFn 可注入**：integration 档和单测用 adapter 的离线确定性 streamFn 替身（控制流驱动），
 *   live 档用真实 `streamSimple`（缺配置明确报错）；离线替身**不参与打分**。
 * - 仅聚合「有期望字段」的指标（applicable）：无期望字段的指标由 metrics 标记
 *   `applicable=false`，本执行器透传、不强制参与（修 G5）。
 *
 * 入口：`runOhnaEval(dataset, { tier, judge?, baseline? }) => Promise<EvalReportDto>`。
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { agentLoop, defaultConvertToLlm, type AgentContext, type AgentLoopConfig, type AgentEvent, type StreamFn } from "@aiagent/agent";
import type { Context, SimpleStreamOptions, Model } from "@aiagent/ai";
import { streamSimple } from "@aiagent/ai";
import type { ToolCallStep } from "@aiagent/eval-core";
import {
  aggregateToReport,
  evaluateCaseOutcome,
  scoreCaseWithEvidence,
  type OhnaCaseEvidence,
  type ScoredCase,
} from "./metrics.js";
import {
  createMockCodingTools,
  createOfflineStreamFn,
  createDenialRecorder,
  createEvalPermissionBeforeToolCall,
} from "./adapter.js";
import type { OhnaEvalCase, OhnaEvalDataset } from "./dataset.js";

/**
 * 评测执行档位（各 app 内部策略，不进内核，见 docs/v2.0/02-eval-system-v2.md §3.1）。
 */
export type EvalTier = "integration" | "live";

/**
 * LLM-as-Judge 适配器（可选，当前为「校准信号」，**未接入打分与门禁**）。
 *
 * 设计定位（Step 4 验收 + 评审 minor）：Judge 仅作离线校准观察，不作为 CI 门禁指标，
 * 因此 run 链路**显式不调用** `judge.score()`——接了 `--judge` 也不应静默产生
 * 「已评判」假象。`runOhnaEval` 接受该参数仅为「预留接线位」，并在文档中标注未启用；
 * 若要启用，需在 `runCase` 打分后调用 `judge.score` 并把结果透传到报告（当前
 * `EvalReportDto` 结构无该字段，需扩展——属于后续工作项，不在本步范围）。
 */
export interface OhnaCodingJudge {
  /** 对单条 case 的某个 rubric 打分（预留，当前不进聚合/门禁）。 */
  score(rubric: string, case_: OhnaEvalCase, evidence: OhnaCaseEvidence): Promise<number>;
}

/**
 * runOhnaEval 选项。
 */
export interface RunOhnaEvalOptions {
  /** 执行档位：integration=离线确定性 streamFn 替身；live=真实 provider（缺配置报错）。 */
  tier: EvalTier;
  /**
   * 可选 LLM-as-Judge 适配器。**当前未启用**：run 链路不调用 `judge.score()`，
   * 仅占位为后续校准接线位（详见 `OhnaCodingJudge` 类型注释）。不传入不影响任何门禁。
   */
  judge?: OhnaCodingJudge;
  /** 可选 baseline（当前执行器不直接读门禁，门禁在 index.ts 用 eval-core；保留透传位）。 */
  baseline?: unknown;
  /**
   * 可选临时工作区根（默认 `os.tmpdir()`）。测试可注入一个独立子目录，使「清理断言」与
   * 其它并发 runOhnaEval 调用隔离，避免共享全局 tmpdir 命名空间产生的竞态误判（不改动生产默认）。
   */
  tmpRoot?: string;
}

/**
 * 订阅 agentLoop 事件流，**抽干**后收集「轨迹投影所需证据」。
 *
 * 投影规则（app eval 域职责，不进内核）：
 * - `tool_execution_start` 携带 `args`，`tool_execution_end` 携带 `isError`；二者配对投影成
 *   `ToolCallStep{ tool, args, isError }`（内核 `matchTrajectory` 只做匹配，不感知本投影）；
 * - `turn_end` 计数 → 实际收敛轮数（turnEfficiency）。
 *
 * 消费语义（关键修正，修 review-major）：
 * - `EventStream` 是**单消费者**语义，`result()` 仅返回终止事件的最终结果、**不会抽干事件**；
 *   此前把抽干丢进 `void (async()=>{})()` 脱离主流程，会与 `result()` 在 `agent_end` 的
 *   早 resolve 竞态——`runCase` 读到 `turns=0` 再被 `Math.max(turns,1)` 地板成 1，使
 *   `turnEfficiency` 对任意 case 恒为 1.0，掩盖真实超预算。
 * - 本函数改为**唯一消费者**：用 `for await` 抽干整条流（流在 `agent_end` 后置 done，`for await`
 *   在此之后自然结束），返回 `Promise` 让 `runCase` 串行等待；轮数**不再地板**，
 *   真实反映收敛轮数（如 `maxTurns=1` 离线驱动必 2 轮 → 0.8）。
 *
 * @param stream agentLoop 返回的事件流。
 * @returns 抽干后得到的轨迹与轮数。
 */
async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<{
  trajectory: ToolCallStep[];
  turns: number;
}> {
  const trajectory: ToolCallStep[] = [];
  let turns = 0;
  const argsByToolCall = new Map<string, Record<string, unknown>>();

  // 唯一消费者：for await 直到流结束（agent_end 后置 done，迭代器自然 return）。
  for await (const event of stream) {
    if (event.type === "tool_execution_start") {
      argsByToolCall.set(event.toolCallId, (event.args ?? {}) as Record<string, unknown>);
    } else if (event.type === "tool_execution_end") {
      const args = argsByToolCall.get(event.toolCallId) ?? {};
      trajectory.push({ tool: event.toolName, args, isError: event.isError });
    } else if (event.type === "turn_end") {
      turns += 1;
    }
  }

  return { trajectory, turns };
}

/**
 * 构造一个最小合法的 Model（离线 / live 都需要传给 AgentLoopConfig；离线替身不消费它）。
 *
 * @returns Model 对象。
 */
function buildEvalModel(): Model<"openai-completions"> {
  return {
    id: "eval-offline",
    name: "eval-offline",
    api: "openai-completions",
    provider: "eval-offline",
    baseUrl: "http://localhost/eval",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4096,
  };
}

/**
 * 执行单条 case：建临时工作区 → 预置种子文件 → 跑 agentLoop → 投影证据 → 读快照 → 打分。
 *
 * 临时工作区真实创建（`mkdtempSync`）；mock 工具真实写盘；case 后 `rmSync` 递归清理。
 *
 * @param case_ 单条评测 case。
 * @param streamFn 注入的 streamFn（离线替身或真实 streamSimple）。
 * @returns 该 case 的打分结果 + 确定性证据。
 */
async function runCase(
  case_: OhnaEvalCase,
  streamFn: StreamFn,
  tmpRoot?: string,
): Promise<{ scored: ScoredCase; evidence: OhnaCaseEvidence }> {
  const workspace = mkdtempSync(join(tmpRoot ?? tmpdir(), "ohna-eval-"));
  try {
    // 预置种子文件（落真实临时工作区）。
    for (const seed of case_.workspaceSeed ?? []) {
      const full = resolve(workspace, seed.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, seed.content, "utf8");
    }

    const tools = createMockCodingTools(workspace);
    const recorder = createDenialRecorder();
    const beforeToolCall = createEvalPermissionBeforeToolCall(case_, recorder);

    const context: AgentContext = {
      systemPrompt: "你是编码评测 Agent（离线确定性替身驱动）。",
      messages: [],
      tools,
    };

    const model = buildEvalModel();
    const config: AgentLoopConfig = {
      model,
      convertToLlm: defaultConvertToLlm,
      // 评测必须保序：并行模式下 tool_execution_* 事件按「完成顺序」发出，投影出的轨迹会
      // 偏离声明顺序（如 [read, edit] 因 edit 先 resolve 变成 [edit, read]），污染
      // toolSelectionCorrectness 的顺序判定。评测装配强制 sequential，使轨迹与助手声明严格一致
      // （这是对 agentLoop 的「配置」约束，不是改内核；production runTurn 仍用默认 parallel）。
      toolExecution: "sequential",
      beforeToolCall: beforeToolCall as AgentLoopConfig["beforeToolCall"],
      // 防御：超过预算一定轮数强制收敛（避免任何意外死循环）。
      shouldStopAfterTurn: (ctx) => {
        const budget = case_.maxTurns ?? 4;
        return ctx.context.messages.filter((m) => m.role === "assistant").length > budget + 1;
      },
    };

    const stream = agentLoop([{ role: "user", content: case_.prompt, timestamp: Date.now() }], context, config, undefined, streamFn);

    // 抽干事件流收集轨迹与轮数（唯一消费者；内部 for await 直到 agent_end 后自然结束，
    // 不再与 result() 竞态，轮数为真实收敛轮数，无地板）。
    const collected = await collectEvents(stream);
    // 仍需 consume result() 以驱使 agentLoop 内部收尾（消息结果），但轨迹/轮数已来自抽干。
    await stream.result();

    const trajectory = collected.trajectory;
    const actualTurns = collected.turns;
    const deniedTools = [...recorder.snapshot()];

    // 读取执行后工作区快照（path 相对工作区根）。
    const snapshot = readWorkspaceSnapshot(workspace);

    const evidence: OhnaCaseEvidence = {
      trajectory,
      deniedTools,
      actualTurns,
      workspaceSnapshot: snapshot,
    };

    const metrics = scoreCaseWithEvidence(case_, evidence);
    const scored = evaluateCaseOutcome({ id: case_.id }, metrics);
    return { scored, evidence };
  } finally {
    // 真实清理临时工作区（含 mock 写入的文件）。
    rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * 递归读取临时工作区全部文本文件，投影为 path → content 快照。
 *
 * @param root 工作区根目录。
 * @returns 文件快照（相对路径 → 内容）。
 */
function readWorkspaceSnapshot(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      try {
        if (statSync(abs).isDirectory()) {
          walk(abs, rel);
        } else {
          snapshot.set(rel, readFileSync(abs, "utf8"));
        }
      } catch {
        // 读失败（如权限/二进制）跳过，不影响文本快照断言。
      }
    }
  };
  walk(root, "");
  return snapshot;
}

/**
 * 运行 ohna 编码评测，产出 `EvalReportDto`（跨边界线格式，eval-core 与 CI 门禁消费）。
 *
 * integration 档用离线确定性 streamFn 替身驱动 agentLoop 走完控制流（断言轨迹与权限通道），
 * 指标由确定性文件后果 + 权限记录 + 轮数判定；live 档用真实 streamSimple。
 *
 * @param dataset 已加载的 ohna 编码评测数据集。
 * @param options 执行选项（tier / 可选 judge / baseline 透传位）。
 * @returns 聚合后的评测报告线格式。
 */
export async function runOhnaEval(
  dataset: OhnaEvalDataset,
  options: RunOhnaEvalOptions,
): Promise<ReturnType<typeof aggregateToReport>> {
  const { tier, tmpRoot } = options;

  // 选 streamFn：integration=离线替身（控制流驱动，不打分）；live=真实 provider（缺配置报错）。
  const resolveStreamFn = (case_: OhnaEvalCase): StreamFn => {
    if (tier === "live") {
      // 真实 provider：用 @aiagent/ai 的 streamSimple；若无 API key 配置，streamSimple 内部
      // 会把错误编码进事件流（stopReason=error），agentLoop 会收尾。
      assertLiveProviderConfigured();
      return ((model: Model<"openai-completions">, ctx: Context, opts?: SimpleStreamOptions) =>
        streamSimple(model, ctx, opts)) as StreamFn;
    }
    return createOfflineStreamFn(case_);
  };

  const scoredCases: ScoredCase[] = [];

  for (const case_ of dataset.cases) {
    const streamFn = resolveStreamFn(case_);
    const { scored } = await runCase(case_, streamFn, tmpRoot);
    scoredCases.push(scored);
  }

  return aggregateToReport("ohna-cli", dataset.datasetVersion, scoredCases);
}

/**
 * live 档前置校验：当前仓库无 provider API key 配置时应明确失败，而非静默回退到离线。
 *
 * 直接尝试 `streamSimple` 会在缺配置时报错；此处仅作语义断言占位——真实校验交给
 * @aiagent/ai 的 provider 解析（缺 key 时 streamSimple 把错误收进事件流）。
 * 本函数当前不抛错（让 streamSimple 自然失败），保留为 live 档扩展点。
 */
function assertLiveProviderConfigured(): void {
  // 故意不读取任何 key：live 档应由真实环境注入 provider 配置。
  // 若仓库无配置，streamSimple 会自然在事件流里产生 error 并收尾，runOhnaEval 据此判定失败。
}
