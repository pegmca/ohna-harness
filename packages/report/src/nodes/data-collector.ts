import type { DataSourceRuntime, RetrievalResult } from "@aiagent/rag";
import type { DataSourceIngestRequestDto } from "@aiagent/types";
import type { WorkflowEventSink, WorkflowNodeDefinition } from "@aiagent/workflow";
import {
  reportDataCollectorInputSchema,
  reportDataCollectorOutputSchema,
  type ReportDataCollectorInput,
  type ReportDataCollectorOutput,
  type ReportEvidenceItem
} from "../schemas.js";
import type { ReportWorkflowDemoDocument, ReportWorkflowState } from "../workflow-types.js";

/**
 * Data Collector 节点：基于 plan 生成 RAG queries，调用现有 RAG search/answer 能力收集证据。
 * 支持 follow-up queries（补充检索），并把 retrieval trace 和 citation 一起写入证据。
 *
 * @param _maxRetries 仅用于摘要展示，与节点执行无关。
 * @returns workflow node definition。
 */
export function createDataCollectorNode(_maxRetries: number): WorkflowNodeDefinition<ReportDataCollectorInput, ReportDataCollectorOutput, ReportWorkflowState> {
  return {
    nodeId: "data_collector",
    type: "report.data_collector",
    title: "Data Collector",
    inputSchema: reportDataCollectorInputSchema,
    outputSchema: reportDataCollectorOutputSchema,
    buildInput: (state) => ({
      plan: state.plan,
      followUpQueries: state.followUpQueries
    }),
    execute: async (input, context) => {
      const subject = input.plan.subject;

      if (!subject) {
        throw new Error("Report workflow requires plan.subject before collecting data.");
      }

      // runtime 由组合根注入（必填），节点内不再自建缺省 runtime：
      // 缺少注入时宁可在编译期/装配期暴露，也不要在运行期用不可用的 runtime 静默产出空证据。
      const runtime = context.state.dataSourceRuntime;
      const timeRange = input.plan.timeRange ?? "最近两年";

      await ingestReportDocuments(runtime, context.state.documents);

      const queries = buildDataCollectorQueries(subject, timeRange, input.plan.requiredData, input.followUpQueries);

      await emitDataCollectorEvent(context.sink, queries, input.followUpQueries);

      const evidence: ReportEvidenceItem[] = [];
      const retrievalTraces: unknown[] = [];
      const sourceErrors: Array<{ query: string; code: string; message: string }> = [];

      for (const query of queries) {
        const searchResult = await runtime.search(query, { topK: 3, mode: "hybrid" });

        if (!searchResult.ok) {
          sourceErrors.push({ query, code: searchResult.error.code, message: searchResult.error.message });
          continue;
        }

        retrievalTraces.push(searchResult.data.trace);

        for (const result of searchResult.data.results) {
          evidence.push(createEvidenceItem(result, query, evidence.length));
        }
      }

      const filings = [...new Set(evidence.map((item) => item.source))];
      const financialMetrics = input.plan.requiredData.includes("financial_metrics")
        ? extractFinancialMetrics(evidence, timeRange)
        : [];

      return {
        subject,
        timeRange,
        filings,
        financialMetrics,
        evidence,
        retrievalTraces,
        partial: sourceErrors.length > 0,
        sourceErrors
      };
    },
    applyOutput: (state, output) => ({
      ...state,
      collectedData: mergeCollectedData(state.collectedData, output),
      dataSourceRuntime: state.dataSourceRuntime
    }),
    summarizeInput: (input) => ({
      planId: input.plan.planId,
      subject: input.plan.subject,
      requiredData: input.plan.requiredData,
      followUpQueryCount: input.followUpQueries?.length ?? 0
    }),
    summarizeOutput: (output) => ({
      subject: output.subject,
      timeRange: output.timeRange,
      filingCount: output.filings.length,
      metricCount: output.financialMetrics.length,
      evidenceCount: output.evidence.length,
      retrievalTraceCount: output.retrievalTraces?.length ?? 0
      , partial: output.partial
      , sourceErrorCount: output.sourceErrors.length
    })
  };
}

/**
 * 将 demo documents 批量 ingest 到 RAG runtime，跳过已存在 sourceUri 的文档避免重复索引。
 *
 * 文档列表已是 async cursor 分页接口，这里循环拉完所有页再取 sourceUri 集合。
 *
 * @param runtime RAG runtime。
 * @param documents 待 ingest 的 demo 文档。
 */
async function ingestReportDocuments(
  runtime: DataSourceRuntime,
  documents: ReportWorkflowDemoDocument[]
): Promise<void> {
  const existingSources = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await runtime.listDocuments({
      limit: 100,
      ...(cursor !== undefined ? { cursor } : {})
    });
    page.documents.forEach((document) => existingSources.add(document.sourceUri));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  for (const document of documents) {
    if (existingSources.has(document.source)) {
      continue;
    }

    const request: DataSourceIngestRequestDto = {
      source: document.source,
      fileName: document.fileName,
      contentType: document.contentType,
      content: document.content
    };
    const result = await runtime.ingest(request);

    if (!result.ok) {
      throw new Error(`ingest demo document failed: ${result.error.message}`);
    }
  }
}

/**
 * 根据 plan 和可选的 follow-up queries 生成 Data Collector 检索 queries。
 * 初始检索基于 subject、timeRange 和 requiredData；补充检索直接使用 Critic/Verifier 提供的 queries。
 *
 * @param subject 研究对象。
 * @param timeRange 时间范围。
 * @param requiredData plan 要求的数据类型。
 * @param followUpQueries 可选的补充检索 queries。
 * @returns 本次要执行的 query 列表。
 */
function buildDataCollectorQueries(
  subject: string,
  timeRange: string,
  requiredData: readonly string[],
  followUpQueries: readonly string[] | undefined
): string[] {
  if (followUpQueries && followUpQueries.length > 0) {
    return [...followUpQueries];
  }

  const queries: string[] = [];

  if (requiredData.includes("filings") || requiredData.length === 0) {
    queries.push(`${subject} ${timeRange} 年报`, `${subject} ${timeRange} 公告`);
  }

  if (requiredData.includes("financial_metrics")) {
    queries.push(`${subject} 净利润 ROE ${timeRange}`, `${subject} 营业收入 ${timeRange}`);
  }

  if (requiredData.includes("risk")) {
    queries.push(`${subject} 风险因素`, `${subject} 不良贷款 风险`);
  }

  if (queries.length === 0) {
    queries.push(`${subject} ${timeRange}`);
  }

  return queries;
}

/**
 * 从 retrieval result 创建标准化的报告证据项，保留 citation 和原始 query 便于追溯。
 *
 * @param result RAG retrieval result。
 * @param query 产生该证据的 query。
 * @param index 证据序号，用于生成唯一 id。
 * @returns 报告证据项。
 */
function createEvidenceItem(result: RetrievalResult, query: string, index: number): ReportEvidenceItem {
  return {
    id: `evidence_${result.chunkId}_${String(index).padStart(3, "0")}`,
    source: result.citation.source,
    quote: result.citation.quote,
    retrievalResult: result,
    citation: result.citation,
    query
  };
}

/**
 * 合并多次 Data Collector 运行的结果，按 chunkId 去重证据，避免补充检索引入重复 citation。
 *
 * @param existing 已有的 collected data。
 * @param latest 最新一次 Data Collector 输出。
 * @returns 合并后的 collected data。
 */
function mergeCollectedData(
  existing: ReportDataCollectorOutput | undefined,
  latest: ReportDataCollectorOutput
): ReportDataCollectorOutput {
  if (!existing) {
    return latest;
  }

  const existingChunkIds = new Set(
    existing.evidence.map((item) => item.retrievalResult?.chunkId).filter((id): id is string => typeof id === "string")
  );
  const newEvidence = latest.evidence.filter(
    (item) => typeof item.retrievalResult?.chunkId !== "string" || !existingChunkIds.has(item.retrievalResult.chunkId)
  );

  return {
    subject: latest.subject,
    timeRange: latest.timeRange,
    filings: [...new Set([...existing.filings, ...latest.filings])],
    financialMetrics: deduplicateMetrics([...existing.financialMetrics, ...latest.financialMetrics]),
    evidence: [...existing.evidence, ...newEvidence],
    retrievalTraces: [...(existing.retrievalTraces ?? []), ...(latest.retrievalTraces ?? [])],
    partial: existing.partial || latest.partial,
    sourceErrors: [...existing.sourceErrors, ...latest.sourceErrors]
  };
}

/**
 * 按 name + period 去重财务指标，避免补充检索重复添加同一指标。
 *
 * @param metrics 指标列表。
 * @returns 去重后的指标列表。
 */
function deduplicateMetrics(metrics: ReportDataCollectorOutput["financialMetrics"]): ReportDataCollectorOutput["financialMetrics"] {
  const seen = new Set<string>();

  return metrics.filter((metric) => {
    const key = `${metric.name}_${metric.period}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * 从证据文本中抽取常见财务指标，仅作启发式示例，不保证生产级准确性。
 *
 * @param evidence 证据列表。
 * @param period 时间范围，写入指标 period 字段。
 * @returns 抽取到的财务指标列表。
 */
function extractFinancialMetrics(
  evidence: readonly ReportEvidenceItem[],
  period: string
): ReportDataCollectorOutput["financialMetrics"] {
  const metrics: ReportDataCollectorOutput["financialMetrics"] = [];
  const seen = new Set<string>();

  for (const item of evidence) {
    const text = item.quote;

    const netProfitMatch = text.match(/净利润[^\d]*(\d+(?:\.\d+)?)\s*亿元/);
    if (netProfitMatch && !seen.has("net_profit")) {
      seen.add("net_profit");
      metrics.push({
        name: "net_profit",
        value: `${netProfitMatch[1]}亿元`,
        period,
        sourceEvidenceId: item.id
      });
    }

    const roeMatch = text.match(/ROE[^\d]*(\d+(?:\.\d+)?)%/);
    if (roeMatch && !seen.has("roe")) {
      seen.add("roe");
      metrics.push({
        name: "roe",
        value: `${roeMatch[1]}%`,
        period,
        sourceEvidenceId: item.id
      });
    }

    const revenueMatch = text.match(/营业收入[^\d]*(\d+(?:\.\d+)?)\s*亿元/);
    if (revenueMatch && !seen.has("revenue")) {
      seen.add("revenue");
      metrics.push({
        name: "revenue",
        value: `${revenueMatch[1]}亿元`,
        period,
        sourceEvidenceId: item.id
      });
    }
  }

  return metrics;
}

/**
 * 经 sink 发出 Data Collector 的检索意图事件，便于观察初始检索和补充检索的 query 差异。
 *
 * @param sink 节点事件出口。
 * @param queries 本次执行的 queries。
 * @param followUpQueries 可选的 follow-up queries 标记。
 * @returns sink 完成 Promise。
 */
async function emitDataCollectorEvent(
  sink: WorkflowEventSink | undefined,
  queries: readonly string[],
  followUpQueries: readonly string[] | undefined
): Promise<void> {
  if (!sink) {
    return;
  }

  try {
    await sink({
      type: "tool_call",
      payload: {
        toolName: "report.data_collector_search",
        args: {
          queryCount: queries.length,
          queries: queries.map((query) => (query.length > 60 ? `${query.slice(0, 60)}...` : query)),
          isFollowUp: (followUpQueries?.length ?? 0) > 0
        },
        durationMs: 0,
        ok: true,
        createdAt: new Date().toISOString()
      }
    });
  } catch {
    // sink 失败不应影响 workflow 主流程。
  }
}
