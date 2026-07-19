import assert from "node:assert/strict";
import { test } from "node:test";
import { createInMemoryTraceRecorder } from "@aiagent/trace";
import {
  createReportPackageSummary,
  createReportWorkflowNodes,
  reportAnalyzerInputSchema,
  reportAnalyzerOutputSchema,
  reportCitationVerifierInputSchema,
  reportCitationVerifierOutputSchema,
  reportDataCollectorInputSchema,
  reportDataCollectorOutputSchema,
  reportPdfExporterInputSchema,
  reportPdfExporterOutputSchema,
  reportRiskCheckerInputSchema,
  reportRiskCheckerOutputSchema,
  reportWriterInputSchema,
  reportWriterOutputSchema,
  runReportWorkflow
} from "../dist/index.js";

test("report package exposes its boundary summary", () => {
  assert.deepEqual(createReportPackageSummary(), {
    packageName: "@aiagent/report",
    boundary: "report_workflow_nodes_writer_export_adapter",
    runtimeState: "agentic_rag_ready"
  });
});

test("report workflow nodes declare input and output schemas", () => {
  assert.equal(createReportWorkflowNodes().length, 6);

  for (const schema of [
    reportDataCollectorInputSchema,
    reportDataCollectorOutputSchema,
    reportAnalyzerInputSchema,
    reportAnalyzerOutputSchema,
    reportRiskCheckerInputSchema,
    reportRiskCheckerOutputSchema,
    reportCitationVerifierInputSchema,
    reportCitationVerifierOutputSchema,
    reportWriterInputSchema,
    reportWriterOutputSchema,
    reportPdfExporterInputSchema,
    reportPdfExporterOutputSchema
  ]) {
    assert.equal(typeof schema.safeParse, "function");
  }
});

test("report workflow executes a ready plan to draft and PDF placeholder", async () => {
  const trace = createInMemoryTraceRecorder("trace_report_workflow_happy");
  const runId = "report_wf_test_happy";
  const result = await runReportWorkflow(createReadyPlan(), {
    runId,
    trace,
    documents: [createDemoDocument()],
    approvalDecisions: [approvePdfExport(runId)]
  });

  assert.equal(result.ok, true);
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.run.executedSteps, 6);
  assert.match(result.draft.markdown, /000001\.SZ/);
  assert.equal(result.export.status, "placeholder");
  assert.equal(result.run.nodes.every((node) => node.status === "succeeded"), true);
  assert.equal(trace.getEvents().filter((event) => event.type === "workflow_node").length, 12);
  assert.equal(trace.getEvents().some((event) => event.type === "approval" && event.status === "approved"), true);
});

test("report workflow triggers supplementary retrieval when citations are missing", async () => {
  const trace = createInMemoryTraceRecorder("trace_report_workflow_retry");
  const runId = "report_wf_test_retry";
  const result = await runReportWorkflow(
    {
      ...createReadyPlan(),
      reportType: "risk_review",
      requiredData: ["filings", "financial_metrics", "risk"]
    },
    {
      runId,
      trace,
      documents: [],
      maxRetries: 2,
      approvalDecisions: [approvePdfExport(runId)]
    }
  );

  assert.equal(result.ok, true);
  assert.match(result.draft.markdown, /资料不足|不足以判断/);
  assert.ok(result.state.verifierRetryCount > 0);

  const verifierEvents = trace
    .getEvents()
    .filter((event) => event.type === "citation_verifier");
  assert.ok(verifierEvents.length > 0);

  const lastVerifierEvent = verifierEvents[verifierEvents.length - 1];
  assert.ok(lastVerifierEvent.retryCount <= 2);
  assert.equal(lastVerifierEvent.decision, "fail");
});

test("report workflow returns max step structured failure", async () => {
  const result = await runReportWorkflow(createReadyPlan(), { maxSteps: 3, documents: [createDemoDocument()] });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "max_steps_exceeded");
  assert.equal(result.run.executedSteps, 3);
  assert.equal(result.run.nodes[3].status, "failed");
});

test("report workflow pauses and rejects PDF export without executing sensitive action", async () => {
  const runId = "report_wf_test_approval";
  const paused = await runReportWorkflow(createReadyPlan(), {
    runId,
    documents: [createDemoDocument()]
  });

  assert.equal(paused.ok, false);
  assert.equal(paused.run.status, "paused");
  assert.equal(paused.error.code, "approval_required");
  assert.equal(paused.approvalRequest.approvalId, `approval_${runId}_pdf_exporter`);
  assert.equal(paused.run.nodes[5].status, "paused");

  const rejected = await runReportWorkflow(createReadyPlan(), {
    runId,
    documents: [createDemoDocument()],
    approvalDecisions: [
      {
        approvalId: `approval_${runId}_pdf_exporter`,
        decision: "rejected",
        reviewerNote: "demo reject"
      }
    ]
  });

  assert.equal(rejected.ok, false);
  assert.equal(rejected.run.status, "rejected");
  assert.equal(rejected.error.code, "approval_rejected");
  assert.equal(rejected.state.export, undefined);
});

test("report workflow rejects plans without subject as structured invalid workflow", async () => {
  const result = await runReportWorkflow({
    ...createReadyPlan(),
    status: "needs_clarification",
    subject: undefined,
    clarificationQuestions: ["请提供研究对象。"]
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_workflow");
  assert.equal(result.run.executedSteps, 0);
});

test("report workflow risk review asks for more evidence when risk disclosure is missing", async () => {
  const runId = "report_wf_test_risk";
  const result = await runReportWorkflow(
    {
      ...createReadyPlan(),
      reportType: "risk_review",
      requiredData: ["filings", "risk"]
    },
    {
      runId,
      documents: [
        {
          source: "demo/no-risk-doc",
          fileName: "no-risk.md",
          contentType: "text/markdown",
          content: "# 经营情况\n公司营业收入保持稳定增长。"
        }
      ],
      maxRetries: 1,
      approvalDecisions: [approvePdfExport(runId)]
    }
  );

  assert.equal(result.ok, true);
  assert.match(result.draft.markdown, /资料不足|不足以判断|风险/);
  assert.ok(result.state.risks.needsMoreEvidence);
  assert.ok(result.state.risks.followUpQueries.length > 0);
});

test("report workflow degrades to an explicitly partial report when non-critical sources fail", async () => {
  const runId = "report_wf_partial_source";
  const unavailableRuntime = {
    listDocuments: () => [], listChunks: () => [], snapshot: () => ({ documents: [], chunks: [], embeddedChunks: [] }),
    ingest: async () => ({ ok: true, data: {} }),
    search: async () => ({ ok: false, error: { code: "retrieval_failed", message: "market source temporarily unavailable" } }),
    answer: async () => ({ ok: false, error: { code: "answer_failed", message: "unavailable" } })
  };
  const result = await runReportWorkflow(createReadyPlan(), { runId, dataSourceRuntime: unavailableRuntime, maxRetries: 0, approvalDecisions: [approvePdfExport(runId)] });
  assert.equal(result.ok, true); assert.equal(result.run.partial, true); assert.equal(result.state.collectedData.partial, true); assert.ok(result.state.collectedData.sourceErrors.length > 0); assert.match(result.draft.markdown, /资料不足|无法基于/);
});

function createReadyPlan() {
  return {
    planId: "report_plan_test",
    status: "ready",
    triggerSource: "natural_language",
    reportType: "company_brief",
    subject: "000001.SZ",
    timeRange: "最近两年",
    requiredData: ["filings", "financial_metrics"],
    assumptions: ["测试 plan。"],
    clarificationQuestions: [],
    steps: [
      {
        id: "collect_filings",
        kind: "collect_filings",
        title: "收集公告和财报",
        description: "测试步骤。",
        requiredData: ["filings"],
        optional: false
      }
    ]
  };
}

function approvePdfExport(runId) {
  return {
    approvalId: `approval_${runId}_pdf_exporter`,
    decision: "approved",
    reviewerNote: "test approval"
  };
}

function createDemoDocument() {
  return {
    source: "demo/annual-report",
    fileName: "000001-annual-report.md",
    contentType: "text/markdown",
    content: `# 000001.SZ 2024 年年度报告摘要

## 盈利能力
2024 年，公司实现营业收入 1646 亿元，同比下降 3.2%；归属于股东的净利润 397 亿元，同比增长 2.1%。加权平均净资产收益率（ROE）为 10.5%，同比下降 0.4 个百分点。

## 资产质量
截至 2024 年末，公司不良贷款率为 1.05%，较上年末下降 0.01 个百分点。拨备覆盖率保持充足，资产质量整体保持稳定。
`
  };
}
