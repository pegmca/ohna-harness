/**
 * finance-api 评测执行器（v2.0 评测体系 Step 3，领域自治方案 §3.3 / finance-eval-run 工作项）。
 *
 * 本模块是评测「执行编排」中枢：把 dataset 的 rag 用例、adapter 的真实 runtime、metrics 的
 * 打分、eval-core 的报告聚合串成一条 deterministic 链路，产出 `EvalReportDto`。
 *
 * 关键职责与约束：
 * - 修 G1：deterministic 档对 `mode==="rag"` 的 case **真实调用** `DataSourceRuntime.answer()`
 *   （检索 + 生成），禁止 fixture 回放 retrievedChunks；每条 case 独立 ingest 其 documents。
 * - 仅聚合「有期望字段」的指标（applicable）：无期望字段的指标由 metrics 标记
 *   `applicable=false`，本执行器透传、不强制参与（修 G5 在 eval-core 与 metrics 层落地）。
 * - judge 可选：传入 `judge` 时对 llmFaithfulness / llmContextRecall / contextPrecision 等
 *   校准信号打分，作为报告的附加信息，**不进 aggregateToReport 门禁**（只做校准参考）。
 *
 * 入口：`runFinanceEval(dataset, { tier, judge?, baseline? }) => Promise<EvalReportDto>`。
 */

import type { RagAnswer } from "@aiagent/rag";
import {
  aggregateToReport,
  evaluateCaseOutcome,
  refusalRate,
  scoreCaseWithEvidence,
  type FinanceEvalCaseLike,
  type MetricScore,
  type ScoredCase
} from "./metrics.js";
import { createDeterministicFinanceRagRuntime } from "./adapter.js";
import type { FinanceEvalDataset } from "./dataset.js";

/**
 * 评测执行档位（各 app 内部策略，不进内核，见 docs/v2.0/02-eval-system-v2.md §3.1）。
 */
export type EvalTier = "deterministic" | "integration" | "live";

/**
 * LLM-as-Judge 适配器（可选）。
 *
 * 仅负责把「一条 case 的 RAG 证据 + 某 rubric」转化为一个校准分数；
 * 真实模型调用 / 网络 / provider 读取都在 judge-rubrics.ts 内完成。本执行器只依赖这个函数签名，
 * 使 run 层与 judge 实现解耦（judge 缺失时整体跳过打分，不影响确定性指标与门禁）。
 */
export interface FinanceRagJudge {
  /**
   * 对单条 case 的某个 rubric 打分。
   *
   * @param rubric  rubric 名（faithfulness / contextRecall / contextPrecision）。
   * @param case_   金融评测 case（含 query / goldEvidence 等）。
   * @param answer  真实 runtime 产出的 RagAnswer（含 answer / citations / retrievalResults）。
   * @returns 校准分数（[0,1]）；无法判定时返回中性分（见 judge-rubrics.ts）。
   */
  score(rubric: "faithfulness" | "contextRecall" | "contextPrecision", case_: FinanceEvalCaseLike & { query: string; goldEvidence?: string[] }, answer: RagAnswer): Promise<number>;
}

/**
 * runFinanceEval 选项。
 */
export interface RunFinanceEvalOptions {
  /** 执行档位；当前实现仅 deterministic 跑真实 RAG 链路，其余档位留 Step 5 / live。 */
  tier: EvalTier;
  /** 可选 LLM-as-Judge 适配器（只产校准信号，不进门禁）。 */
  judge?: FinanceRagJudge;
  /** 可选 baseline（当前执行器不直接读门禁，门禁在 index.ts 用 eval-core；保留透传位以对齐签名）。 */
  baseline?: unknown;
}

/**
 * 过滤出 deterministic 档需要执行的用例（当前仅 "rag" 类；其余类留 Step 5）。
 *
 * @param dataset 完整数据集。
 * @returns mode === "rag" 的用例（保留原顺序）。
 */
function selectDeterministicCases(dataset: FinanceEvalDataset): FinanceEvalDataset["cases"] {
  return dataset.cases.filter((item) => item.mode === "rag");
}

/**
 * 把一条 case 投影为 metrics 所需的最小契约。
 *
 * metrics.ts 的 `FinanceEvalCaseLike` 只认 id / 期望字段；这里直接从领域 case 透传，
 * 未知字段由 dataset 加载器透传，不在此处耦合。
 *
 * @param case_ 金融评测 case。
 * @returns metrics 可消费的最小投影。
 */
function toCaseLike(case_: FinanceEvalDataset["cases"][number]): FinanceEvalCaseLike {
  return {
    id: case_.id,
    expectedSources: case_.expectedSources,
    expectedDocumentIds: case_.expectedDocumentIds,
    expectedKeywords: case_.expectedKeywords,
    minCitations: case_.minCitations
  };
}

/**
 * 执行单条 rag case：装配 runtime → 真实 ingest documents → 真实 answer → 投影证据 → 打分。
 *
 * 修 G1 的核心：每条 case 独立建一个内存 runtime 并真实 ingest 其 `documents`，再调
 * `runtime.answer(query)` 拿到真实 `RagAnswer`（检索 + 生成全程走 `@aiagent/rag` 真实链路），
 * 而非回放旧 fixture.retrievedChunks。
 *
 * @param case_ 单条 rag case。
 * @returns 该 case 的打分结果与真实 answer（供 refusalRate / judge 使用）。
 */
async function runRagCase(
  case_: FinanceEvalDataset["cases"][number]
): Promise<{ scored: ScoredCase; answer: RagAnswer | null }> {
  const runtime = await createDeterministicFinanceRagRuntime(case_.documents);
  const response = await runtime.answer(case_.query);

  if (!response.ok) {
    // 真实链路失败（理论上确定性 embedding + 内存 store 不应失败）；按"证据缺失"打分：
    // 返回一个 retrievalHitRate 等全部 applicable 指标 0 分的 ScoredCase，附 failedMetrics。
    return {
      scored: {
        id: case_.id,
        metrics: [
          { name: "retrievalHitRate", score: 0, applicable: case_.expectedSources?.length || case_.expectedDocumentIds?.length ? true : false },
          { name: "mrr", score: 0, applicable: case_.expectedSources?.length || case_.expectedDocumentIds?.length ? true : false },
          { name: "ndcg", score: 0, applicable: case_.expectedSources?.length || case_.expectedDocumentIds?.length ? true : false },
          { name: "citationCoverage", score: 0, applicable: true },
          { name: "answerCorrectness", score: 0, applicable: case_.expectedKeywords?.length ? true : false }
        ],
        passed: false,
        failedMetrics: ["retrievalHitRate", "mrr", "ndcg", "citationCoverage", "answerCorrectness"].filter((name) => {
          if (name === "answerCorrectness") return Boolean(case_.expectedKeywords?.length);
          if (name === "citationCoverage") return true;
          return Boolean(case_.expectedSources?.length || case_.expectedDocumentIds?.length);
        })
      },
      answer: null
    };
  }

  const answer = response.data.answer;
  const metrics: MetricScore[] = scoreCaseWithEvidence(toCaseLike(case_), answer);
  const scored = evaluateCaseOutcome({ id: case_.id }, metrics);
  return { scored, answer };
}

/**
 * 运行金融评测，产出 `EvalReportDto`（跨边界线格式，eval-core 与 CI 门禁消费）。
 *
 * deterministic 档只跑 rag 类 case：每条 case 真实 ingest 其 documents 后调
 * `DataSourceRuntime.answer()` 得到 `RagAnswer`，投影证据后再由 metrics 打分，最后
 * `aggregateToReport` 聚合成报告。judge 可选（仅产校准信号，不进报告门禁）。
 *
 * @param dataset 已加载的金融评测数据集。
 * @param options 执行选项（tier / 可选 judge / baseline 透传位）。
 * @returns 聚合后的评测报告线格式。
 */
export async function runFinanceEval(
  dataset: FinanceEvalDataset,
  options: RunFinanceEvalOptions
): Promise<ReturnType<typeof aggregateToReport>> {
  const { tier, judge } = options;

  // 当前实现：deterministic 档真实跑 RAG 链路；integration/live 留 Step 5 / live，
  // 这里以 deterministic 为唯一实现路径，其余档位暂复用同一链路（tier 作为报告元信息保留）。
  if (tier !== "deterministic") {
    // 避免静默误用：非 deterministic 档位尚未实现时显式报错，而非假装跑通。
    throw new Error(`eval 档位 "${tier}" 尚未在 finance-api 实现（Step 3 仅 deterministic 跑通 RAG 链路）。`);
  }

  const ragCases = selectDeterministicCases(dataset);
  const scoredCases: ScoredCase[] = [];
  const answers: RagAnswer[] = [];
  const judgeScores: { id: string; faithfulness?: number; contextRecall?: number; contextPrecision?: number }[] = [];

  for (const case_ of ragCases) {
    const { scored, answer } = await runRagCase(case_);

    if (answer) {
      answers.push(answer);

      // 可选 judge：仅产校准信号，不进 aggregateToReport 门禁（见 §3.3 指标表「校准信号」列）。
      if (judge) {
        const [faithfulness, contextRecall, contextPrecision] = await Promise.all([
          judge.score("faithfulness", case_ as FinanceEvalCaseLike & { query: string; goldEvidence?: string[] }, answer).catch(() => 0),
          judge.score("contextRecall", case_ as FinanceEvalCaseLike & { query: string; goldEvidence?: string[] }, answer).catch(() => 0),
          judge.score("contextPrecision", case_ as FinanceEvalCaseLike & { query: string; goldEvidence?: string[] }, answer).catch(() => 0)
        ]);
        judgeScores.push({ id: case_.id, faithfulness, contextRecall, contextPrecision });
      }
    }

    scoredCases.push(scored);
  }

  // 聚合确定性指标；refusalRate 作为跨 case 聚合指标并入 metrics（来自 RagAnswerDto.status）。
  const report = aggregateToReport("finance-api", dataset.datasetVersion, scoredCases);
  if (answers.length > 0) {
    const rate = refusalRate(answers);
    // 仅在确有 rag case 跑通时追加；applicable 恒为 true（反映拒答质量）。
    report.metrics.push({ name: "refusalRate", value: rate, unit: "ratio", applicable: true });
  }

  // judge 校准信号以 summary 形式附带（不进 metrics / 门禁），便于人工查看趋势。
  if (judgeScores.length > 0) {
    const summarize = (key: "faithfulness" | "contextRecall" | "contextPrecision"): string => {
      const values = judgeScores.map((item) => item[key]).filter((value): value is number => typeof value === "number");
      if (values.length === 0) return "n/a";
      const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
      return avg.toFixed(3);
    };
    const summaryParts = [
      "judge 校准信号（不进 CI 门禁）:",
      `llmFaithfulness=${summarize("faithfulness")}`,
      `llmContextRecall=${summarize("contextRecall")}`,
      `contextPrecision=${summarize("contextPrecision")}`
    ];
    report.summary = [report.summary, summaryParts.join("  ")].filter(Boolean).join("\n");
  }

  return report;
}
