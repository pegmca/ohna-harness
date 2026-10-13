import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type EvalMode = "chat" | "rag" | "report" | "failure";

export interface FinancialFactExpectation {
  label: string;
  value: number;
  unit: string;
  currency?: string;
  period: string;
  source: string;
}

export interface UnifiedEvalCase {
  id: string;
  mode: EvalMode;
  query: string;
  expectedFacts: FinancialFactExpectation[];
  expectedCitations: string[];
  expectedWorkflow: string[];
  expectedSections: string[];
  expectedExportStatus?: "placeholder" | "completed" | "blocked";
  tags: string[];
  fixture: UnifiedEvalFixture;
}

export interface UnifiedEvalFixture {
  answer: string;
  citations: Array<{ source: string; quote: string }>;
  retrievedChunks: Array<{ id: string; source: string; text: string }>;
  workflow: string[];
  sections: string[];
  exportStatus?: "placeholder" | "completed" | "blocked";
  ok: boolean;
  latencyMs: number;
  traceId: string;
  requestId: string;
}

import type { FailureCategory } from "./trajectory.js";

export interface EvalDataset { schemaVersion: "1.0.0"; datasetVersion: string; seed: number; cases: UnifiedEvalCase[] }
export interface AutomationMetrics { citationCoverage: number; financialAccuracy: number; sourceGroundedness: number; successRate: number; workflowCompletion: number; reportSectionCoverage: number; exportStatusRate: number; averageLatencyMs: number; p95LatencyMs: number }
/** 单条 case 的指标：7 项确定性指标 + 可选 LLM-as-Judge 校准信号（不计入门禁）。 */
export type CaseMetrics = Omit<AutomationMetrics, "averageLatencyMs" | "p95LatencyMs"> & {
  /** LLM 判定答案正确性的校准分（0~1）；仅当传入 judge 时存在。 */
  llmAnswerCorrectness?: number;
  /** LLM 判定忠实性的校准分（0~1）；仅当传入 judge 时存在。 */
  llmFaithfulness?: number;
};

/** 单条 case 的打分结果（含逐条指标、失败项与归因）。 */
export interface AutomationCaseResult {
  caseId: string;
  mode: EvalMode;
  query: string;
  passed: boolean;
  metrics: CaseMetrics;
  latencyMs: number;
  traceId: string;
  requestId: string;
  evidence: UnifiedEvalFixture;
  failures: string[];
  rootCause?: string;
  improvement?: string;
  /** 失败 taxonomy 主分类（来自 trajectory 分类）；当 evidence.ok 且无分类时为 "none" 或省略。可选字段，不参与门禁与聚合。 */
  failureCategory?: FailureCategory;
  /** 轨迹匹配摘要（便于报告展示）：actual 实际工具名序列、expected 期望工具名序列、是否匹配。可选字段。 */
  trajectory?: { actual: string[]; expected?: string[]; matched?: boolean };
}
export interface RegressionThresholds { successRate: number; citationCoverage: number; financialAccuracy: number; sourceGroundedness: number; workflowCompletion: number; maxP95LatencyIncreaseMs: number; p95LatencyMs: number }
export interface EvalBaseline { schemaVersion: "1.0.0"; datasetVersion: string; createdAt: string; config: { seed: number; strategy: "deterministic_fixture"; thresholds: RegressionThresholds }; metrics: AutomationMetrics }
export interface BaselineDiff { metric: keyof AutomationMetrics; current: number; baseline: number; delta: number };
export interface AutomationReport { schemaVersion: "1.0.0"; datasetVersion: string; run: { id: string; startedAt: string; seed: number; strategy: "deterministic_fixture"; llmJudge: boolean }; metrics: AutomationMetrics; results: AutomationCaseResult[]; failures: AutomationCaseResult[]; baseline?: EvalBaseline; diff: BaselineDiff[]; regressionReasons: string[]; slo?: SloSummary }

/**
 * SLO / 错误预算摘要（P3 门禁增强，纯增量）：用阈值把现状指标翻译为"是否突破预算"的可读结论。
 * 作为 AutomationReport 的可选字段，不破坏既有 7 项指标与回归门禁形状。
 */
export interface SloSummary {
  /** P95 延迟 SLO：value 实测、budget 阈值、breached 是否突破。 */
  p95LatencyMs: { value: number; budget: number; breached: boolean };
  /** 错误预算：budget 允许最大失败率、consumed 已消耗失败率、remaining 剩余、breached 是否耗尽。 */
  errorBudget: { budget: number; consumed: number; remaining: number; breached: boolean };
}

export const DEFAULT_REGRESSION_THRESHOLDS: RegressionThresholds = { successRate: 0.8, citationCoverage: 0.85, financialAccuracy: 0.8, sourceGroundedness: 0.85, workflowCompletion: 0.9, maxP95LatencyIncreaseMs: 50, p95LatencyMs: 10000 };

/**
 * 读取并校验版本化 dataset；runner 只接受固定 schema，避免用例格式漂移。
 * @param path dataset JSON 路径。
 * @returns 已校验的数据集。
 */
export async function loadEvalDataset(path: string): Promise<EvalDataset> {
  const value = JSON.parse(await readFile(path, "utf8")) as EvalDataset;
  if (value.schemaVersion !== "1.0.0" || !value.datasetVersion || !Number.isInteger(value.seed) || !Array.isArray(value.cases) || value.cases.length < 30 || value.cases.length > 50) throw new Error("invalid eval dataset: expected schema 1.0.0 and 30-50 cases");
  const ids = new Set<string>();
  for (const item of value.cases) { if (!item.id || !item.query || ids.has(item.id)) throw new Error(`invalid or duplicate eval case: ${item.id}`); ids.add(item.id); }
  return value;
}

/**
 * 使用固定 fixture 执行统一回归；不读取 API key，也不调用网络，因此相同 dataset 可复现。
 * @param dataset 固定版本数据集。
 * @param baseline 可选基线。
 * @param thresholds 回归阈值。
 * @returns 完整机器报告。
 */
export function runAutomationEval(dataset: EvalDataset, baseline?: EvalBaseline, thresholds: RegressionThresholds = DEFAULT_REGRESSION_THRESHOLDS): AutomationReport {
  const results = dataset.cases.map(scoreCase);
  const metrics = aggregateAutomationMetrics(results);
  const diff = baseline ? (Object.keys(metrics) as Array<keyof AutomationMetrics>).map((metric) => ({ metric, current: metrics[metric], baseline: baseline.metrics[metric], delta: round(metrics[metric] - baseline.metrics[metric]) })) : [];
  const regressionReasons = checkAutomationRegression(metrics, baseline, thresholds);
  return { schemaVersion: "1.0.0", datasetVersion: dataset.datasetVersion, run: { id: `eval-${dataset.datasetVersion}-seed-${dataset.seed}`, startedAt: new Date().toISOString(), seed: dataset.seed, strategy: "deterministic_fixture", llmJudge: false }, metrics, results, failures: results.filter((item) => !item.passed), baseline, diff, regressionReasons, slo: computeSloSummary(metrics, thresholds) };
}

/** @param report 当前报告。 @param dataset 数据集。 @param thresholds 阈值。 @returns 可显式保存的基线。 */
export function createBaseline(report: AutomationReport, dataset: EvalDataset, thresholds: RegressionThresholds = DEFAULT_REGRESSION_THRESHOLDS): EvalBaseline { return { schemaVersion: "1.0.0", datasetVersion: dataset.datasetVersion, createdAt: new Date().toISOString(), config: { seed: dataset.seed, strategy: "deterministic_fixture", thresholds }, metrics: report.metrics }; }

/** @param report 机器报告。 @returns 可读 Markdown。 */
export function renderMarkdownReport(report: AutomationReport): string {
  const m = report.metrics;
  const lines = [`# Eval 回归报告`, ``, `- Dataset: ${report.datasetVersion}`, `- Cases: ${report.results.length}`, `- Seed / strategy: ${report.run.seed} / ${report.run.strategy}`, `- LLM judge: ${report.run.llmJudge ? "已启用" : "未使用"}`, ``, `## 指标`, ``, `| 指标 | 当前 | Baseline | 变化 |`, `|---|---:|---:|---:|`];
  for (const key of Object.keys(m) as Array<keyof AutomationMetrics>) { const d = report.diff.find((item) => item.metric === key); lines.push(`| ${key} | ${m[key]} | ${d?.baseline ?? "-"} | ${d?.delta ?? "-"} |`); }
  lines.push(``, `## 逐条结果`, ``, `| Case | Mode | Pass | Citation | Financial | Grounded | Latency |`, `|---|---|---:|---:|---:|---:|---:|`);
  for (const item of report.results) lines.push(`| ${item.caseId} | ${item.mode} | ${item.passed ? "yes" : "no"} | ${item.metrics.citationCoverage} | ${item.metrics.financialAccuracy} | ${item.metrics.sourceGroundedness} | ${item.latencyMs}ms |`);
  lines.push(``, `## 失败案例`, ``);
  for (const item of report.failures) lines.push(`### ${item.caseId}`, ``, `- Query: ${item.query}`, `- Trace / request: ${item.traceId} / ${item.requestId}`, `- Evidence: retrieved=[${item.evidence.retrievedChunks.map((c) => c.id).join(", ")}], citations=[${item.evidence.citations.map((c) => c.source).join(", ")}]`, `- Answer/report: ${item.evidence.answer || "（空）"}`, `- 失败项: ${item.failures.join("；")}`, `- 根因: ${item.rootCause}`, `- 改进: ${item.improvement}`, ``);
  lines.push(``, `## SLO / 错误预算`, ``);
  if (report.slo) {
    const { p95LatencyMs: p95, errorBudget: eb } = report.slo;
    lines.push(
      `- P95 延迟: ${p95.value}ms / 预算 ${p95.budget}ms → ${p95.breached ? "突破" : "达标"}`,
      `- 错误预算: 预算 ${eb.budget} / 已耗 ${eb.consumed} / 剩余 ${eb.remaining} → ${eb.breached ? "耗尽" : "充足"}`
    );
  } else {
    lines.push("- 未计算（无 SLO 摘要）");
  }
  lines.push(`## 回归门禁`, ``, report.regressionReasons.length ? report.regressionReasons.map((x) => `- ${x}`).join("\n") : "- 通过");
  return `${lines.join("\n")}\n`;
}

/** @param report 报告。 @param jsonPath JSON 输出。 @param markdownPath Markdown 输出。 @returns 写入完成。 */
export async function writeReports(report: AutomationReport, jsonPath: string, markdownPath: string): Promise<void> { await mkdir(dirname(jsonPath), { recursive: true }); await mkdir(dirname(markdownPath), { recursive: true }); await Promise.all([writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`), writeFile(markdownPath, renderMarkdownReport(report))]); }
/** @param path baseline 路径。 @returns baseline；不存在时返回 undefined。 */
export async function readBaseline(path: string): Promise<EvalBaseline | undefined> { try { return JSON.parse(await readFile(path, "utf8")) as EvalBaseline; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
/** @param baseline 基线。 @param path 路径。 @returns 写入完成。 */
export async function writeBaseline(baseline: EvalBaseline, path: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`); }

function scoreCase(item: UnifiedEvalCase): AutomationCaseResult {
  return scoreCaseWithEvidence(item, item.fixture);
}

/**
 * 用一份证据（旧口径为 fixture，新口径为 run_events 投影）给单条 case 打分。
 * 指标定义与阈值口径完全不变，是 deterministic fixture 策略的唯一打分入口。
 *
 * `judgeScores` 为可选参数（由 `runLoopEval` 在调用 judge 后传入已解析分数）：仅当传入时，才在
 * 逐条 `metrics` 中追加 `llmAnswerCorrectness` / `llmFaithfulness` 两个校准信号（passed 恒为 true、
 * 不计入门禁与聚合）。**不传时函数行为与改造前完全一致**（metrics 字段数量、顺序、passed、返回形状
 * 逐字节一致，零回归）。
 *
 * @param item 数据集用例（期望值来源）。
 * @param f 待打分证据，形状与 fixture 相同。
 * @param judgeScores 可选 LLM-as-Judge 已解析分数（答案正确性 + 忠实性）。
 * @returns 单条 case 的完整打分结果。
 */
export function scoreCaseWithEvidence(
  item: UnifiedEvalCase,
  f: UnifiedEvalFixture,
  judgeScores?: { answerCorrectness: number; faithfulness: number }
): AutomationCaseResult {
  const citationCoverage = ratio(item.expectedCitations, (source) => f.citations.some((c) => c.source === source));
  const factChecks = item.expectedFacts.map((fact) => checkFact(fact, f)); const financialAccuracy = factChecks.length ? factChecks.filter(Boolean).length / factChecks.length : 1;
  const sourceGroundedness = ratio(f.citations, (citation) => f.retrievedChunks.some((chunk) => chunk.source === citation.source && normalize(chunk.text).includes(normalize(citation.quote))));
  const workflowCompletion = ratio(item.expectedWorkflow, (step) => f.workflow.includes(step)); const reportSectionCoverage = ratio(item.expectedSections, (section) => f.sections.includes(section));
  const exportStatusRate = item.expectedExportStatus ? Number(f.exportStatus === item.expectedExportStatus) : 1;

  // 7 项确定性指标（顺序固定，作为门禁与聚合口径）。judge 校准信号不进入此集合。
  const deterministic: Omit<AutomationMetrics, "averageLatencyMs" | "p95LatencyMs"> = {
    citationCoverage: round(citationCoverage),
    financialAccuracy: round(financialAccuracy),
    sourceGroundedness: round(sourceGroundedness),
    successRate: Number(f.ok),
    workflowCompletion: round(workflowCompletion),
    reportSectionCoverage: round(reportSectionCoverage),
    exportStatusRate
  };

  // 失败项仅来自确定性指标；judge 校准分始终 passed=true，绝不进入 failures。
  const failures: string[] = [];
  for (const [name, score] of Object.entries(deterministic)) if (score < 1) failures.push(`${name}=${score}`);

  const metrics: CaseMetrics = { ...deterministic };
  if (judgeScores) {
    metrics.llmAnswerCorrectness = round(judgeScores.answerCorrectness);
    metrics.llmFaithfulness = round(judgeScores.faithfulness);
  }

  return { caseId: item.id, mode: item.mode, query: item.query, passed: failures.length === 0, metrics, latencyMs: f.latencyMs, traceId: f.traceId, requestId: f.requestId, evidence: f, failures, rootCause: failures.length ? rootCause(failures) : undefined, improvement: failures.length ? improvement(failures) : undefined };
}
function checkFact(fact: FinancialFactExpectation, fixture: UnifiedEvalFixture): boolean { const text = `${fixture.answer} ${fixture.citations.map((c) => c.quote).join(" ")}`; return normalize(text).includes(normalize(String(fact.value))) && normalize(text).includes(normalize(fact.unit)) && normalize(text).includes(normalize(fact.period)) && (!fact.currency || normalize(text).includes(normalize(fact.currency))) && fixture.citations.some((c) => c.source === fact.source); }
/** 参与聚合的 7 项确定性指标（固定顺序，judge 校准信号不进入聚合口径）。 */
const AGGREGATED_METRIC_KEYS: Array<keyof Omit<AutomationMetrics, "averageLatencyMs" | "p95LatencyMs">> = [
  "citationCoverage",
  "financialAccuracy",
  "sourceGroundedness",
  "successRate",
  "workflowCompletion",
  "reportSectionCoverage",
  "exportStatusRate"
];

/** @param results 全部 case 打分结果。 @returns 聚合后的总体指标（含 latency 分布）。 */
export function aggregateAutomationMetrics(results: AutomationCaseResult[]): AutomationMetrics {
  const avg = (key: (typeof AGGREGATED_METRIC_KEYS)[number]) =>
    round(results.reduce((sum, item) => sum + item.metrics[key], 0) / results.length);
  const latencies = results.map((x) => x.latencyMs).sort((a, b) => a - b);
  return {
    citationCoverage: avg("citationCoverage"),
    financialAccuracy: avg("financialAccuracy"),
    sourceGroundedness: avg("sourceGroundedness"),
    successRate: round(results.filter((x) => x.passed).length / results.length),
    workflowCompletion: avg("workflowCompletion"),
    reportSectionCoverage: avg("reportSectionCoverage"),
    exportStatusRate: avg("exportStatusRate"),
    averageLatencyMs: round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    p95LatencyMs: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? 0
  };
}
/**
 * 计算 SLO / 错误预算摘要（纯函数，零回归）：把现状指标与阈值翻译为"是否突破预算"的可读结论。
 * - P95 延迟：value > budget 即 breached（与既有 maxP95LatencyIncreaseMs 的 baseline 比较互不影响）；
 * - 错误预算：budget = 1 - successRate 门槛（允许的最大失败率），consumed = 1 - 实际 successRate，
 *   remaining = max(0, budget - consumed)，consumed > budget 即 breached。
 *
 * @param m 当前总体指标。 @param t 回归阈值。 @returns SLO / 错误预算摘要。
 */
export function computeSloSummary(m: AutomationMetrics, t: RegressionThresholds): SloSummary {
  const p95Value = m.p95LatencyMs;
  const p95Budget = t.p95LatencyMs;
  const errorBudget = 1 - t.successRate;
  const consumed = 1 - m.successRate;
  const remaining = Math.max(0, errorBudget - consumed);
  return {
    p95LatencyMs: { value: p95Value, budget: p95Budget, breached: p95Value > p95Budget },
    errorBudget: { budget: errorBudget, consumed, remaining, breached: consumed > errorBudget },
  };
}

/** @param m 当前指标。 @param b 可选基线。 @param t 回归阈值。 @returns 触发的回归原因列表，空数组表示通过。 */
export function checkAutomationRegression(m: AutomationMetrics, b: EvalBaseline | undefined, t: RegressionThresholds): string[] { const r:string[]=[]; for (const key of ["successRate","citationCoverage","financialAccuracy","sourceGroundedness","workflowCompletion"] as const) if (m[key] < t[key]) r.push(`${key} ${m[key]} 低于门槛 ${t[key]}`); if (m.p95LatencyMs > t.p95LatencyMs) r.push(`p95 latency ${m.p95LatencyMs}ms 超过 SLO ${t.p95LatencyMs}ms`); if (b) { for (const key of ["successRate","citationCoverage","financialAccuracy","sourceGroundedness","workflowCompletion"] as const) if (m[key] < b.metrics[key]) r.push(`${key} 相对 baseline 回退 ${round(m[key]-b.metrics[key])}`); if (m.p95LatencyMs-b.metrics.p95LatencyMs>t.maxP95LatencyIncreaseMs) r.push(`p95 latency 增加 ${m.p95LatencyMs-b.metrics.p95LatencyMs}ms`); } return r; }
function ratio<T>(items: readonly T[], predicate:(item:T)=>boolean):number { return items.length ? items.filter(predicate).length/items.length : 1; }
function normalize(v:string):string { return v.toLowerCase().replace(/[\s,，]/g,""); } function round(v:number):number{return Math.round(v*1000)/1000;}
function rootCause(f:string[]):string { if(f.some(x=>x.startsWith("financialAccuracy"))) return "财务事实的数值、单位、币种、期间或来源未同时满足。"; if(f.some(x=>x.startsWith("sourceGroundedness"))) return "引用文本无法在 retrieved chunk 中逐项回溯。"; if(f.some(x=>x.startsWith("workflowCompletion"))) return "Report workflow 在预期节点前终止。"; return "输出缺少预期引用、章节或导出状态。"; }
function improvement(f:string[]):string { return f.some(x=>x.startsWith("financialAccuracy")) ? "增加结构化事实抽取与期间/币种校验，失败时拒答。" : f.some(x=>x.startsWith("workflowCompletion")) ? "补齐节点重试与结构化 workflow 终止原因。" : "强化 citation verifier，并保留 claim 到 chunk 的映射。"; }
