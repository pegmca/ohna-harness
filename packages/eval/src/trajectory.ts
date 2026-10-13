/**
 * 轨迹评测 + 失败 taxonomy（docs/v1.1/04-eval-observability.md · P2）：
 * 把 run_events 投影出的工具调用序列（trajectory）与"从 fixture 推导的期望工具序列"做
 * strict / subset 匹配，并对失败 case 给出单一主分类（幻觉 / 检索缺失 / 工具误用 / 工作流
 * 不完整 / 循环等）。
 *
 * 设计要点：
 * - 全部为纯函数，不依赖网络 / IO，可独立单测，零回归现有 7 项确定性门禁。
 * - 类型层仅 `import type` 引用 `@aiagent/eval` 的 `UnifiedEvalCase` / `UnifiedEvalFixture`，
 *   运行时无循环依赖（automation.ts 也是用 `import type` 反向引用本模块，编译期擦除）。
 */
import type { LoopEvalRunEvent } from "./loop-projection.js";
import type { UnifiedEvalCase, UnifiedEvalFixture } from "./automation.js";

/** 单个工具调用的有序步骤（由 run_events 的 tool_execution_start/end 配对得到）。 */
export interface ToolCallStep {
  /** 该次调用的 start 事件序号，用于保序。 */
  seq: number;
  /** 工具名（如 search_filings / generate_report）。 */
  toolName: string;
  /** 该次调用的入参（来自 tool_execution_start 的 args）。 */
  args: Record<string, unknown>;
  /** 是否执行报错（来自 tool_execution_end 的 isError，缺 end 时默认 false）。 */
  isError: boolean;
  /** 结果摘要（可选）：从工具 result.content 文本截断，便于报告展示。 */
  resultSummary?: string;
}

/**
 * 把 run_events 投影为有序工具调用序列。
 * 按 `seq` 顺序，将 `tool_execution_start` 与同 `toolCallId` 的 `tool_execution_end` 配对；
 * 防御式：缺少对应 end 时用 start 信息兜底，`isError` 默认 false。
 *
 * @param events 本次 run 收集的全部 run_events（含 tool_execution_start/end）。
 * @returns 按调用顺序排列的工具调用步骤数组。
 */
export function extractToolTrajectory(events: readonly LoopEvalRunEvent[]): ToolCallStep[] {
  const starts = events
    .filter((event) => event.type === "tool_execution_start")
    .sort((a, b) => a.seq - b.seq);

  const steps: ToolCallStep[] = [];
  for (const start of starts) {
    const startPayload = start.payload as { toolCallId?: unknown; toolName?: unknown; args?: unknown };
    const toolCallId = startPayload.toolCallId;
    // 配对同 toolCallId 且在本 start 之后发生的 end 事件（取最近一条）。
    const end = events.find(
      (event) =>
        event.type === "tool_execution_end" &&
        (event.payload as { toolCallId?: unknown }).toolCallId === toolCallId &&
        event.seq > start.seq,
    );
    const endPayload = end?.payload as { isError?: unknown; result?: { content?: Array<{ type?: unknown; text?: unknown }> } } | undefined;

    const result = endPayload?.result;
    const textBlock = result?.content?.find((block) => block.type === "text" && typeof block.text === "string");
    const resultSummary = typeof textBlock?.text === "string" ? textBlock.text.slice(0, 80) : undefined;

    steps.push({
      seq: start.seq,
      toolName: String(startPayload.toolName ?? ""),
      args: (startPayload.args as Record<string, unknown>) ?? {},
      isError: Boolean(endPayload?.isError),
      resultSummary,
    });
  }
  return steps;
}

/** 期望轨迹中的单条工具约束：工具名 + 可选必填参数键。 */
export interface TrajectoryExpectation {
  /** 期望调用的工具名。 */
  toolName: string;
  /** 该工具调用必须携带的入参键；用于参数级校验。 */
  requiredArgs?: string[];
}

/** 轨迹匹配模式：strict 要求顺序且数量一致；subset 要求期望是实际轨迹的保序子序列。 */
export type TrajectoryMatchMode = "strict" | "subset";

/** 轨迹匹配结果：给出 matched 判定与差异明细，便于报告展示。 */
export interface TrajectoryMatchResult {
  /** 实际使用的匹配模式。 */
  mode: TrajectoryMatchMode;
  /** 是否匹配：缺工具 / 多余工具 / 参数缺失任一项存在则为 false。 */
  matched: boolean;
  /** 期望工具名序列。 */
  expected: string[];
  /** 实际工具名序列。 */
  actual: string[];
  /** 期望中存在但实际缺失的工具名。 */
  missing: string[];
  /** 实际中存在但期望未要求的工具名（strict 模式下视为不匹配）。 */
  extra: string[];
  /** 同名工具调用中必填参数缺失的定位。 */
  paramMismatches: Array<{ toolName: string; missingArgs: string[] }>;
}

/**
 * 对齐期望与实际工具名序列，返回每个期望工具对应的实际下标（未对齐为 -1）。
 * strict 要求长度与顺序完全一致；subset 用贪心保序子序列匹配。
 *
 * @param expectedNames 期望工具名序列。
 * @param actualNames 实际工具名序列。
 * @param mode 匹配模式。
 * @returns 与期望等长的下标数组，-1 表示该期望工具未对齐。
 */
function alignTrajectory(expectedNames: readonly string[], actualNames: readonly string[], mode: TrajectoryMatchMode): number[] {
  const align: number[] = [];
  if (mode === "strict") {
    // strict：长度不等则整体无法 1:1 对齐，全部标记为未对齐。
    if (expectedNames.length !== actualNames.length) {
      for (let i = 0; i < expectedNames.length; i += 1) align.push(-1);
      return align;
    }
    for (let i = 0; i < expectedNames.length; i += 1) {
      align.push(expectedNames[i] === actualNames[i] ? i : -1);
    }
    return align;
  }
  // subset：期望必须是实际轨迹的保序子序列。
  let cursor = 0;
  for (let i = 0; i < expectedNames.length; i += 1) {
    while (cursor < actualNames.length && actualNames[cursor] !== expectedNames[i]) cursor += 1;
    if (cursor >= actualNames.length) {
      align.push(-1);
    } else {
      align.push(cursor);
      cursor += 1;
    }
  }
  return align;
}

/**
 * 将期望轨迹与实际工具调用序列做匹配，输出 matched 判定与差异明细。
 *
 * - strict：expected 工具名序列须与 actual **顺序且数量一致**；actual 多出记 extra，
 *   expected 多出记 missing。
 * - subset：expected 须是 actual 的**保序子序列**；多余工具不计入 extra 触发失败。
 * - 对匹配上的同名工具调用，校验 `requiredArgs` 每个键是否出现在对应 actual step 的 `args`，
 *   缺失记入 `paramMismatches`。
 *
 * 综合判定：`matched = missing.length===0 && (mode==="subset" ? true : extra.length===0) && paramMismatches.length===0`。
 *
 * @param expected 期望轨迹（工具名 + 必填参数）。
 * @param actual 实际工具调用序列（来自 run_events 投影）。
 * @param mode 匹配模式。
 * @returns 匹配结果（matched + 差异明细）。
 */
export function matchTrajectory(
  expected: readonly TrajectoryExpectation[],
  actual: readonly ToolCallStep[],
  mode: TrajectoryMatchMode,
): TrajectoryMatchResult {
  const expectedNames = expected.map((item) => item.toolName);
  const actualNames = actual.map((step) => step.toolName);
  const align = alignTrajectory(expectedNames, actualNames, mode);

  // 缺失 / 多余按"工具名是否出现"判定（比位置更贴近语义：出现过的工具不算缺失）。
  const missing = expectedNames.filter((name) => !actualNames.includes(name));
  const extra = actualNames.filter((name) => !expectedNames.includes(name));
  // 全部期望工具是否都成功对齐（strict 要求顺序一致，subset 要求保序子序列）。
  const alignedAll = align.every((index) => index >= 0);

  // 参数级校验：仅对成功对齐的同名工具调用检查 requiredArgs。
  const paramMismatches: Array<{ toolName: string; missingArgs: string[] }> = [];
  for (let i = 0; i < expected.length; i += 1) {
    const actualIndex = align[i];
    if (actualIndex < 0) continue;
    const requirement = expected[i];
    if (!requirement.requiredArgs || requirement.requiredArgs.length === 0) continue;
    const step = actual[actualIndex];
    const presentArgs = step.args ?? {};
    const missingArgs = requirement.requiredArgs.filter((key) => !(key in presentArgs));
    if (missingArgs.length > 0) {
      paramMismatches.push({ toolName: requirement.toolName, missingArgs });
    }
  }

  const matched =
    alignedAll &&
    missing.length === 0 &&
    (mode === "subset" ? true : extra.length === 0) &&
    paramMismatches.length === 0;

  return { mode, matched, expected: [...expectedNames], actual: [...actualNames], missing, extra, paramMismatches };
}

/** 失败主分类：单一主因，用于失败 taxonomy 报告与归因。 */
export type FailureCategory =
  | "retrieval_missing"
  | "hallucination"
  | "tool_misuse"
  | "workflow_incomplete"
  | "loop"
  | "none";

/**
 * 从 fixture 推导期望工具序列（与 loop-runner 的 mock 脚本口径一致）：
 * 有 workflow 期望 → 期望一次 generate_report；否则有检索证据 → 期望一次 search_filings。
 * 用于 classifyFailure 内部 strict 模式轨迹校验与 runLoopEval 的 trajectory 字段展示。
 *
 * @param item 数据集用例（fixture 为种子）。
 * @returns 推导出的期望工具约束序列。
 */
export function deriveExpectedTrajectory(item: UnifiedEvalCase): TrajectoryExpectation[] {
  const expected: TrajectoryExpectation[] = [];
  if (item.fixture.workflow.length > 0) {
    expected.push({ toolName: "generate_report" });
  } else if (item.fixture.retrievedChunks.length > 0) {
    expected.push({ toolName: "search_filings" });
  }
  return expected;
}

/**
 * 判定证据中的 citation 是否被检索接地：每条 citation 的 quote 必须在某条
 * retrieved chunk 文本中出现（归一化后）。空 citation 视为真空接地。
 *
 * @param evidence 投影出的打分证据。
 * @returns 全部 citation 均能被 retrievedChunks 支撑时为 true。
 */
function isCitationsGrounded(evidence: UnifiedEvalFixture): boolean {
  if (evidence.citations.length === 0) return true;
  return evidence.citations.every((citation) =>
    evidence.retrievedChunks.some((chunk) => normalize(chunk.text).includes(normalize(citation.quote))),
  );
}

/**
 * 检测失控循环：实际轨迹中出现连续 ≥ threshold 次同名工具调用。
 *
 * @param trajectory 实际工具调用序列。
 * @param threshold 触发循环的连续同名次数阈值。
 * @returns 存在失控循环时为 true。
 */
function hasConsecutiveLoop(trajectory: readonly ToolCallStep[], threshold: number): boolean {
  let run = 0;
  let last = "";
  for (const step of trajectory) {
    if (step.toolName === last) {
      run += 1;
    } else {
      run = 1;
      last = step.toolName;
    }
    if (run >= threshold) return true;
  }
  return false;
}

/**
 * 对单条 case 给出**单一主分类**（失败 taxonomy），按优先级链判定：
 *
 * 优先级理由（从高到低，越具体的结构性失败越先判）：
 * 1. workflow_incomplete：期望工作流节点未跑完，是最具体的结构性失败信号。
 * 2. retrieval_missing：期望引用但证据未被检索接地（引用无支撑）。
 * 3. hallucination：期望事实却无任何检索/引用支撑（编造）。
 * 4. tool_misuse：工具执行报错，或严格模式轨迹不匹配（调用了非预期工具）。
 * 5. loop：连续 ≥3 次同名工具调用（失控循环）。
 * 6. 兜底：有明确失败信号（ok=false）但未命中以上分类时归为 tool_misuse。
 * 7. 默认：无任何失败信号 → none。
 *
 * 注意：本函数不读取确定性指标内部结构，仅依据 evidence 投影与 trajectory 做分类，
 * 因此**不参与 7 项门禁与聚合**（只作为可选字段附加到结果）。
 *
 * @param input.evidence 投影出的打分证据。
 * @param input.trajectory 实际工具调用序列（来自 run_events）。
 * @param input.item 数据集用例（期望值来源）。
 * @returns 单一主分类。
 */
export function classifyFailure(input: {
  evidence: UnifiedEvalFixture;
  trajectory: readonly ToolCallStep[];
  item: UnifiedEvalCase;
}): FailureCategory {
  const { evidence, trajectory, item } = input;
  // 复用 runner 的推导口径，在 strict 模式下校验是否调用了非预期工具。
  const expected = deriveExpectedTrajectory(item);
  const strictMatch = matchTrajectory(expected, trajectory, "strict");
  const hasErrorStep = trajectory.some((step) => step.isError);

  // 1. 工作流不完整（最具体的结构性失败）。
  if (item.expectedWorkflow.length > 0 && evidence.workflow.length < item.expectedWorkflow.length) {
    return "workflow_incomplete";
  }
  // 2. 检索缺失 / 未接地：期望引用但证据无法被检索接地。
  if (item.expectedCitations.length > 0 && !isCitationsGrounded(evidence)) {
    return "retrieval_missing";
  }
  // 3. 幻觉：期望事实但无检索且无引用支撑（编造）。
  if (item.expectedFacts.length > 0 && evidence.retrievedChunks.length === 0 && evidence.citations.length === 0) {
    return "hallucination";
  }
  // 4. 工具误用：工具执行报错，或严格模式轨迹不匹配（调用了非预期工具）。
  if (hasErrorStep || (trajectory.length > 0 && !strictMatch.matched)) {
    return "tool_misuse";
  }
  // 5. 失控循环：连续 ≥3 次同名工具调用。
  if (hasConsecutiveLoop(trajectory, 3)) {
    return "loop";
  }
  // 6. 兜底：有明确失败信号但未命中上述分类 → 工具误用。
  if (!evidence.ok) {
    return "tool_misuse";
  }
  // 7. 默认：无失败信号。
  return "none";
}

/** 归一化文本：小写并移除空白与中英文逗号，便于 citation/事实匹配的稳健比对。 */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s,，]/g, "");
}
