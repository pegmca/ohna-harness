/**
 * ohna 编码 Agent 评测指标（v2.0 评测体系 Step 4，领域自治方案 §3.4）。
 *
 * 本模块是编码 Agent 评测的「领域语义层」：把「一条 case + 真实 agentLoop 跑出的确定性证据」
 * 投影成若干指标。它**只认识 case 字段与确定性证据**（轨迹 / 文件快照 / 权限记录 / 轮数），
 * 不依赖任何模型生成质量、不 import `@aiagent/eval`（旧包）、不关心 agentLoop 内部。
 *
 * 指标清单（与 docs/v2.0/02-eval-system-v2.md §3.4 对齐）：
 * - fileChangeCorrectness：实际工作区文件快照 vs case.expectedFileChanges（mustContain/forbid）。
 * - permissionCompliance：应被拒绝的工具是否确实被权限闸门拦截（期望拒绝集合 vs 实际拒绝集合）。
 * - toolSelectionCorrectness：期望工具序列 vs 实际 ToolCallStep[]（经 eval-core matchTrajectory 匹配）。
 * - turnEfficiency：实际收敛轮数 vs 预算轮数 maxTurns（实际 ≤ 预算得满分，超出按线性衰减）。
 *
 * 修 G5：每个指标函数返回 `{ name, score, applicable }`；`applicable=false`（无期望字段）的
 * 指标不参与 `aggregateToReport` 的聚合与门禁。
 */

import { matchTrajectory, roundScore, type ToolCallStep } from "@aiagent/eval-core";
import type { EvalCaseOutcome, EvalMetricValue, EvalReportDto } from "@aiagent/types";
import type { OhnaEvalCase, OhnaExpectedFileChange } from "./dataset.js";

/**
 * 单指标计算结果（内部中间形态）。
 *
 * `applicable` 缺省 `true`；为 `false` 时该指标不参与聚合与门禁（修 G5）。
 */
export interface MetricScore {
  /** 指标名（与 EvalReportDto.metrics[].name 对齐）。 */
  name: string;
  /** 归一化到 [0,1] 的指标得分。 */
  score: number;
  /** 是否计入聚合与门禁；缺省 true（修 G5）。 */
  applicable?: boolean;
}

/** 单条 case 的评测输出：case id、逐指标得分与是否通过。 */
export interface ScoredCase {
  /** case 唯一 id。 */
  id: string;
  /** 逐指标得分（含 applicable 标记）。 */
  metrics: MetricScore[];
  /** 该 case 是否整体通过（所有 applicable 指标均 passed）。 */
  passed: boolean;
  /** 失败的指标名（applicable 指标中未通过者）；空数组表示通过。 */
  failedMetrics: string[];
}

/** 单条 case 的确定性证据（由 run 工作项从 agentLoop 投影产出）。 */
export interface OhnaCaseEvidence {
  /** 实际工具调用轨迹（已投影为 ToolCallStep[]，含 isError）。 */
  trajectory: ToolCallStep[];
  /** 实际被权限闸门拒绝的工具名集合。 */
  deniedTools: string[];
  /** 实际收敛轮数（turn_end 计数）。 */
  actualTurns: number;
  /** 执行后工作区文件快照：path → content（不含被删除文件）。 */
  workspaceSnapshot: Map<string, string>;
}

/** 各指标的通过阈值（applicable 指标的 pass 判定）。 */
const METRIC_PASS_THRESHOLDS: Record<string, number> = {
  fileChangeCorrectness: 1,
  permissionCompliance: 1,
  toolSelectionCorrectness: 1,
  turnEfficiency: 1,
};

/**
 * 计算 fileChangeCorrectness：实际文件快照 vs 期望 mustContain/forbid 断言。
 *
 * 每条期望：文件必须存在；`mustContain` 子串全部出现、`forbid` 子串全部不出现方计通过。
 * 所有期望项都通过才得满分（平均通过率）。无 `expectedFileChanges` 时 `applicable=false`。
 *
 * @param case_ 评测 case（取其 expectedFileChanges）。
 * @param snapshot 执行后工作区文件快照（path → content）。
 * @returns 文件改动正确性指标。
 */
export function fileChangeCorrectness(
  case_: Pick<OhnaEvalCase, "expectedFileChanges">,
  snapshot: Map<string, string>,
): MetricScore {
  const expectations = case_.expectedFileChanges;
  if (!expectations || expectations.length === 0) {
    // 无期望字段：不适用，不进聚合/门禁（修 G5）。
    return { name: "fileChangeCorrectness", score: 1, applicable: false };
  }

  let passCount = 0;
  for (const expectation of expectations) {
    if (isFileChangeMet(expectation, snapshot)) passCount += 1;
  }
  return {
    name: "fileChangeCorrectness",
    score: roundScore(passCount / expectations.length),
    applicable: true,
  };
}

/**
 * 判断单条文件改动期望是否满足。
 *
 * @param expectation 文件改动期望。
 * @param snapshot 工作区快照。
 * @returns 是否满足。
 */
function isFileChangeMet(expectation: OhnaExpectedFileChange, snapshot: Map<string, string>): boolean {
  if (!snapshot.has(expectation.path)) return false;
  const content = snapshot.get(expectation.path) ?? "";
  const mustAll = (expectation.mustContain ?? []).every((sub) => content.includes(sub));
  const forbidNone = (expectation.forbid ?? []).every((sub) => !content.includes(sub));
  return mustAll && forbidNone;
}

/**
 * 计算 permissionCompliance：期望被拒工具 vs 实际被拒工具。
 *
 * 期望拒绝集合与实际拒绝集合需**完全一致**才满分（期望拒的都拒了、没期望拒的没被误拒）。
 * 无 `expectedPermissionDenials`（且默认为空）时：若实际也无任何拒绝则适用且满分；
 * 但若实际拒绝了未预期的工具，则视为违反，得分 0（仍 applicable）。
 *
 * @param case_ 评测 case（取其 expectedPermissionDenials）。
 * @param deniedTools 实际被拒绝的工具名集合。
 * @returns 权限合规指标。
 */
export function permissionCompliance(
  case_: Pick<OhnaEvalCase, "expectedPermissionDenials">,
  deniedTools: string[],
): MetricScore {
  const expected = new Set(case_.expectedPermissionDenials ?? []);
  const actual = new Set(deniedTools);

  const missingRejections = [...expected].filter((tool) => !actual.has(tool));
  const extraRejections = [...actual].filter((tool) => !expected.has(tool));

  const score = missingRejections.length === 0 && extraRejections.length === 0 ? 1 : 0;
  return { name: "permissionCompliance", score, applicable: true };
}

/**
 * 计算 toolSelectionCorrectness：期望工具序列 vs 实际轨迹（eval-core matchTrajectory）。
 *
 * 无 `expectedToolCalls` 时 `applicable=false`。匹配采用 subset 模式（期望是实际轨迹的
 * 保序子序列即可），参数级校验以期望项 args 键集为必填参数。
 *
 * @param case_ 评测 case（取其 expectedToolCalls）。
 * @param trajectory 实际工具调用轨迹（ToolCallStep[]）。
 * @returns 工具选择正确性指标。
 */
export function toolSelectionCorrectness(
  case_: Pick<OhnaEvalCase, "expectedToolCalls">,
  trajectory: ToolCallStep[],
): MetricScore {
  const expected = case_.expectedToolCalls;
  if (!expected || expected.length === 0) {
    // 无期望字段：不适用，不进聚合/门禁（修 G5）。
    return { name: "toolSelectionCorrectness", score: 1, applicable: false };
  }
  const match = matchTrajectory(trajectory, expected, "subset");
  return { name: "toolSelectionCorrectness", score: match.matched ? 1 : 0, applicable: true };
}

/**
 * 计算 turnEfficiency：实际收敛轮数 vs 预算轮数。
 *
 * 实际轮数 ≤ 预算得满分；超出预算时按线性衰减（每超出一预算单位扣 0.2，下限 0）。
 * 无 `maxTurns` 时 `applicable=false`。
 *
 * @param case_ 评测 case（取其 maxTurns）。
 * @param actualTurns 实际收敛轮数。
 * @returns 轮效率指标。
 */
export function turnEfficiency(
  case_: Pick<OhnaEvalCase, "maxTurns">,
  actualTurns: number,
): MetricScore {
  const budget = case_.maxTurns;
  if (budget === undefined || budget <= 0) {
    // 无预算期望：不适用，不进聚合/门禁（修 G5）。
    return { name: "turnEfficiency", score: 1, applicable: false };
  }
  if (actualTurns <= budget) {
    return { name: "turnEfficiency", score: 1, applicable: true };
  }
  const overshoot = actualTurns - budget;
  const score = Math.max(0, 1 - overshoot * 0.2);
  return { name: "turnEfficiency", score: roundScore(score), applicable: true };
}

/**
 * 计算单条 case 的全部确定性指标。
 *
 * 统一入口：run 工作项调用本函数得到逐指标得分，再交给 `aggregateToReport` 聚合。
 *
 * @param case_ 评测 case（领域 schema）。
 * @param evidence 本次跑出的确定性证据（轨迹 / 拒绝 / 轮数 / 文件快照）。
 * @returns 逐指标得分列表。
 */
export function scoreCaseWithEvidence(
  case_: OhnaEvalCase,
  evidence: OhnaCaseEvidence,
): MetricScore[] {
  return [
    fileChangeCorrectness(case_, evidence.workspaceSnapshot),
    permissionCompliance(case_, evidence.deniedTools),
    toolSelectionCorrectness(case_, evidence.trajectory),
    turnEfficiency(case_, evidence.actualTurns),
  ];
}

/**
 * 判断单指标得分是否通过（仅对 applicable 指标有效）。
 *
 * @param metric 指标得分。
 * @returns 通过与否。
 */
function isMetricPassed(metric: MetricScore): boolean {
  const threshold = METRIC_PASS_THRESHOLDS[metric.name];
  if (threshold === undefined) {
    // 未知指标默认宽松通过，避免误拦；新增指标应在阈值表登记。
    return true;
  }
  return metric.score >= threshold;
}

/**
 * 把单条 case 的指标得分收敛为 `ScoredCase`（含 passed / failedMetrics）。
 *
 * `passed` = 所有 applicable 指标均 passed；`failedMetrics` 承载失败指标名（修 RAG 归因丢失）。
 *
 * @param case_ 评测 case（仅需 id）。
 * @param metrics 逐指标得分。
 * @returns 收敛后的 scored case。
 */
export function evaluateCaseOutcome(
  case_: { id: string },
  metrics: MetricScore[],
): ScoredCase {
  const applicableMetrics = metrics.filter((metric) => metric.applicable !== false);
  const failedMetrics = applicableMetrics
    .filter((metric) => !isMetricPassed(metric))
    .map((metric) => metric.name);
  const passed = failedMetrics.length === 0;

  return {
    id: case_.id,
    metrics,
    passed,
    failedMetrics,
  };
}

/**
 * 把逐 case 指标聚合为 `EvalReportDto`（落实前置修正 #3 + 修 G5）。
 *
 * 聚合契约：
 * - `metrics[].value` = 该指标跨 case 的**聚合均值**（仅对 applicable 项求平均，修 G5）；
 *   某指标在所有 case 均 `applicable=false` 时，写 `applicable=false` 且 value=0，不进分母/门禁。
 * - `cases[].passed` = `metrics.every(m => m.passed)`（所有 applicable 指标 passed）；
 * - `cases[].failedMetrics` = 失败指标名（修 RAG 归因丢失）。
 *
 * @param target 被测目标标识（如 "ohna-eval"）。
 * @param dataset 数据集标识（如 "coding-v1"）。
 * @param scoredCases 逐 case 的评分结果（id + 逐指标得分 + passed/failedMetrics）。
 * @returns 聚合后的跨边界报告线格式。
 */
export function aggregateToReport(
  target: string,
  dataset: string,
  scoredCases: ScoredCase[],
): EvalReportDto {
  // 收集所有出现过且 applicable 的指标名（按首次出现顺序，保持稳定报告顺序）。
  const metricNames: string[] = [];
  const applicableByMetric = new Map<string, number[]>();

  for (const scored of scoredCases) {
    for (const metric of scored.metrics) {
      if (!metricNames.includes(metric.name)) {
        metricNames.push(metric.name);
      }
      if (metric.applicable !== false) {
        const bucket = applicableByMetric.get(metric.name) ?? [];
        bucket.push(metric.score);
        applicableByMetric.set(metric.name, bucket);
      }
    }
  }

  const aggregatedMetrics: EvalMetricValue[] = metricNames.map((name) => {
    const values = applicableByMetric.get(name);
    const applicable = values !== undefined && values.length > 0;
    const value = applicable
      ? roundScore(values.reduce((sum, value) => sum + value, 0) / values.length)
      : 0;
    return {
      name,
      value,
      unit: "ratio",
      applicable,
    };
  });

  const caseOutcomes: EvalCaseOutcome[] = scoredCases.map((scored) => ({
    id: scored.id,
    passed: scored.passed,
    ...(scored.failedMetrics.length > 0 ? { failedMetrics: scored.failedMetrics } : {}),
  }));

  return {
    target,
    dataset,
    createdAt: new Date().toISOString(),
    metrics: aggregatedMetrics,
    cases: caseOutcomes,
  };
}
