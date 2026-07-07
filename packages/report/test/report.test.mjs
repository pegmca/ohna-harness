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
    runtimeState: "mock_nodes_ready"
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
  const result = await runReportWorkflow(createReadyPlan(), { trace });

  assert.equal(result.ok, true);
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.run.executedSteps, 6);
  assert.match(result.draft.markdown, /000001.SZ/);
  assert.equal(result.export.status, "placeholder");
  assert.equal(result.run.nodes.every((node) => node.status === "succeeded"), true);
  assert.equal(trace.getEvents().filter((event) => event.type === "workflow_node").length, 12);
});

test("report workflow returns max step structured failure", async () => {
  const result = await runReportWorkflow(createReadyPlan(), { maxSteps: 3 });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "max_steps_exceeded");
  assert.equal(result.run.executedSteps, 3);
  assert.equal(result.run.nodes[3].status, "failed");
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
