/**
 * team 评测域公共入口（docs/v2.0/03-team-eval.md §8 的 `index.ts`）。
 *
 * 本文件是 team 评测的 barrel + 组装点：
 * - 对外只暴露 `runTeamEvaluation`（一条从「数据集 → 报告 → 硬门禁 → 趋势段」的完整链路）
 *   与 SLO 规格表；子模块（dataset / run / metrics / adapter / trajectory / trend）各自
 *   直接导出，测试可以逐层 import（L1/L2 分层断言清晰的前提）。
 * - team 与 coding **互相独立**：本域不 import `../dataset.js` / `../run.js`，指标名全带
 *   `team` 前缀，报告文件名/目录由调用方（`../index.ts`）保证互不覆盖。
 *
 * 硬约束回指：`packages/eval-core` 保持零 `@aiagent/*` 依赖——本域所有 team 语义
 * （指标聚合、门禁分层、趋势渲染）都留在 app 层，内核只提供 `gateReport` / `writeReports` /
 * `matchTrajectory` / `roundScore` 等纯机制。
 */

import { gateReport } from "@aiagent/eval-core";
import type { GateResult, SloSpec } from "@aiagent/eval-core";
import type { EvalReportDto } from "@aiagent/types";
import { aggregateTeamMetrics, HARD_GATE_METRICS, TEAM_METRIC_SPECS, toHardGateReport } from "./metrics.js";
import { runTeamEval, type TeamCaseRun } from "./run.js";
import type { TeamEvalDataset, TeamMetricName, TeamTier } from "./types.js";
import { countTeamCasesByMode } from "./dataset.js";

export { loadTeamDataset, parseTeamDataset, countTeamCasesByMode, TEAM_DATASET_MIN_CASES } from "./dataset.js";
export {
  runTeamEval,
  runTeamL1Case,
  runTeamL2aCase,
  runTeamProviderCase,
  type RunTeamEvalOptions,
  type TeamCaseRun,
} from "./run.js";
export {
  TEAM_METRIC_SPECS,
  HARD_GATE_METRICS,
  TREND_METRICS,
  COST_AMPLIFICATION_WARN_RATIO,
  aggregateTeamMetrics,
  scoreTeamCase,
  isHardGateMetric,
  isTrendMetric,
  isTeamMetricPassed,
  toHardGateReport,
  contractL1,
  contractStatuses,
  teamConvergence,
  teamCostAmplificationRatio,
  teamDispatchCorrectness,
  teamOverBudget,
  teamPeakConcurrency,
  teamPermissionInheritanceCorrectness,
  teamSubagentCompletionRate,
  teamTokenAttributionToMember,
} from "./metrics.js";
export {
  createInheritanceGate,
  createRecordingGate,
  createSideEffectMockTools,
  DEFAULT_TEAM_TOOL_POOL,
  detectProviderCredentials,
  resolveExpectedTools,
  type CreateSideEffectMockToolsOptions,
  type TeamToolInvocation,
} from "./adapter.js";
export {
  lastTeamCostSection,
  matchExpectedDispatch,
  projectDispatchSteps,
  projectSends,
  projectTeamMemberUsage,
  type TeamDispatchStep,
  type TeamRunEventLike,
} from "./trajectory.js";
export { appendTrendSection, buildTeamTrend, type TeamTrendSection, type TrendMetricRow } from "./trend.js";
export type {
  TeamCaseEvidence,
  TeamEvalCase,
  TeamEvalDataset,
  TeamEvalMode,
  TeamExpectedMember,
  TeamExpectedPermission,
  TeamExpectedSend,
  TeamGateClass,
  TeamMetricName,
  TeamMetricScore,
  TeamMetricSpec,
  TeamTier,
} from "./types.js";

/**
 * team 硬门禁 SLO（§8「硬门禁」三条 + 合同类指标必须恒 1）。
 *
 * 全部是**确定性指标**：真 provider 的非确定性不会影响它们（§6.3），因此可以安全 block。
 * 趋势指标（dispatch / 成本放大比 / token 归因）**故意不列入**——`toHardGateReport` 还会把它们
 * 置为 `applicable:false`，形成「配置层 + 数据层」双重保险。
 */
export const TEAM_HARD_GATE_SLOS: readonly SloSpec[] = HARD_GATE_METRICS.map((metric) => ({
  metric,
  min: 1,
}));

/**
 * 单次 team 评测的完整产出。
 */
export interface TeamEvaluationResult {
  /** 完整报告（含硬门禁 + 趋势全部指标）。 */
  report: EvalReportDto;
  /** 硬门禁判定（只吃 `toHardGateReport` 的报告）。 */
  gate: GateResult;
  /** 逐 case 执行结果（含 skip 原因，供报告与调试）。 */
  runs: TeamCaseRun[];
  /** 显式跳过的档位原因（如「无 provider 凭据，跳过 T-L2b」）；未跳过时 undefined。 */
  skipReason?: string;
  /**
   * 本档是否**可判定**：至少有一条 case 真正执行过，且聚合出了至少一个 applicable 指标。
   *
   * `false` 表示「没跑」（缺凭据 / 环境不具备），此时门禁结论是「不可判定」而**不是通过**：
   * - `gate.passed === false` 且 reason 明确写「不可判定」；
   * - 调用方禁止据此写 baseline（否则会产生一份没有断言的全不适用基线，
   *   让后续所有门禁永久恒绿——这正是本字段存在的唯一原因）。
   */
  decidable: boolean;
  /** 人类可读摘要（写进 `EvalReportDto.summary`）。 */
  summary: string;
}

/**
 * 运行一次 team 评测并判定硬门禁。
 *
 * 门禁语义沿用 eval-core 的 `gateReport`：首次跑（`baseline === null`）返回
 * 「无 baseline，需先 --update-baseline」的 exitCode 1，而不是静默放行。
 *
 * @param dataset 已加载的 team 数据集。
 * @param options.tier 执行档位。
 * @param options.baseline 基线报告（首次跑传 null）。
 * @param options.credentials 可选凭据覆盖（测试注入）。
 * @returns 报告 + 硬门禁结果 + 逐 case 执行结果。
 */
export async function runTeamEvaluation(
  dataset: TeamEvalDataset,
  options: {
    tier: TeamTier;
    baseline: EvalReportDto | null;
    credentials?: { available: boolean; reason?: string };
  },
): Promise<TeamEvaluationResult> {
  const runs = await runTeamEval(dataset, {
    tier: options.tier,
    ...(options.credentials ? { credentials: options.credentials } : {}),
  });

  const scored = runs.map((run) => run.metrics);
  const metrics = aggregateTeamMetrics(scored);
  const executedRuns = runs.filter((run) => run.executed);
  const skipReason = executedRuns.length === 0 ? runs[0]?.skipReason : undefined;

  const cases = runs.map((run) => {
    const failedMetrics = run.metrics
      .filter((metric) => metric.applicable !== false && metric.score < 1)
      .map((metric) => metric.name);
    return {
      id: run.id,
      // skip 的 case 记为 not passed（不伪造通过），并在 failedTaxonomy 标注原因。
      passed: run.executed && failedMetrics.length === 0,
      ...(failedMetrics.length > 0 ? { failedMetrics } : {}),
      ...(run.executed ? {} : { failedTaxonomy: "skipped:no_provider_credentials" }),
    };
  });

  const modeCounts = countTeamCasesByMode(dataset.cases);
  const modeText = Object.entries(modeCounts)
    .map(([mode, count]) => `${mode}=${count}`)
    .join(" / ");
  // summary 顶部固定标注可判定性：看报告的人要能一眼区分「真通过」与「根本没跑」。
  const verdictBanner =
    executedRuns.length === 0
      ? "【本档不可判定：0 条 case 执行】"
      : executedRuns.length < dataset.cases.length
        ? `【本档部分不可判定：${dataset.cases.length - executedRuns.length}/${dataset.cases.length} 条未执行】`
        : "【本档可判定】";
  const summary = [
    verdictBanner,
    `tier=${options.tier}；case=${dataset.cases.length}（${modeText}）；执行=${executedRuns.length}`,
    skipReason ? `显式跳过：${skipReason}` : "",
  ]
    .filter(Boolean)
    .join("；");

  const report: EvalReportDto = {
    target: "ohna-eval-team",
    dataset: dataset.datasetVersion,
    createdAt: new Date().toISOString(),
    metrics,
    cases,
    summary,
  };

  // 两侧都过同一道投影：基线若带趋势指标（历史遗留 / 人工注入），也必须在 diff 前被剔除，
  // 否则会被记成 missing(current=0) 并误判为低于 SLO（实测复现，故 curr/baseline 对称处理）。
  // 可判定性判定：没有 case 真正执行（或聚合后一个 applicable 指标都没有）时，
  // 本次评测**什么都没测**。此时绝不能落回 `gateReport` 的「空 diff = 通过」路径——
  // 那会让 CI 上的 T-L2b 恒绿而一条断言都没跑（§4.2 红线：不许静默通过）。
  const decidable = executedRuns.length > 0 && metrics.some((metric) => metric.applicable !== false);

  if (!decidable) {
    const notDecidable = `无任何 case 执行，本档不可判定${skipReason ? `（${skipReason}）` : ""}`;
    return {
      report,
      gate: { passed: false, reasons: [notDecidable], exitCode: 1 },
      runs,
      decidable: false,
      ...(skipReason ? { skipReason } : {}),
      summary: `${summary}；${notDecidable}`,
    };
  }

  const gate = gateReport(
    toHardGateReport(report),
    options.baseline ? toHardGateReport(options.baseline) : null,
    [...TEAM_HARD_GATE_SLOS],
  );
  return { report, gate, runs, decidable: true, ...(skipReason ? { skipReason } : {}), summary };
}

/**
 * 返回某档位应执行 / 跳过的说明（供 CLI `--help` 与报告表头）。
 *
 * @param tier 档位。
 * @returns 该档位的执行形态说明。
 */
export function describeTeamTier(tier: TeamTier): string {
  switch (tier) {
    case "T-L1":
      return "T-L1 纯函数投影（零模型、100% 确定性，硬门禁）";
    case "T-L2a":
      return "T-L2a 编排机契约纯状态迁移（零模型、100% 确定性，硬门禁）";
    case "T-L2b":
      return "T-L2b 真 provider 驱动 + mock 工具副作用（需凭据，控制流硬门禁）";
    case "T-L4":
      // 注意：当前**没有** judge 评分链路（见 docs §8.1）。不要在这里宣称有 judge，
      // 否则报告读者会以为决策已被裁判，而实际只有指标观测。
      return "T-L4 真模型驱动的编排决策观测（需凭据；趋势门禁不 block，当前无 judge 评分）";
    default: {
      const never: never = tier;
      return String(never);
    }
  }
}

/** 供外部校验使用的指标名全集（防止拼写漂移）。 */
export const TEAM_METRIC_NAMES: readonly TeamMetricName[] = TEAM_METRIC_SPECS.map((spec) => spec.name);
