import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeRagMetrics,
  createDemoRagRuntime,
  createEvalPackageSummary,
  createEvalResult,
  createRagEvalReport,
  DEMO_DOCUMENTS,
  RAG_EVAL_CASES,
  runRagEval
} from "../dist/index.js";

test("eval package entry exposes its boundary summary", () => {
  const summary = createEvalPackageSummary();

  assert.equal(summary.packageName, "@aiagent/eval");
  assert.equal(summary.boundary, "rag_eval_cases_metrics_reports");
  assert.equal(summary.runtimeState, "runner_and_cases_ready");
});

test("eval result can express answer quality metrics", () => {
  const result = createEvalResult({
    case: {
      id: "eval_001",
      question: "公司净利润变化的依据是什么？",
      expectedAnswer: "应引用年报中的净利润同比变化描述。",
      requiredDocumentIds: ["doc_001"]
    },
    answer: {
      answer: "公司净利润同比增长。",
      citations: [
        {
          chunkId: "chunk_001",
          documentId: "doc_001",
          source: "demo",
          quote: "净利润同比增长",
          confidence: 0.91,
          chunkIndex: 0
        }
      ],
      retrievalResults: []
    },
    metrics: [
      {
        name: "citation_coverage",
        score: 1,
        passed: true,
        details: "引用命中 requiredDocumentIds"
      }
    ]
  });

  assert.equal(result.caseId, "eval_001");
  assert.equal(result.passed, true);
  assert.equal(result.answer.citations[0].documentId, "doc_001");
});

test("computeRagMetrics returns four metrics for a passing case", () => {
  const evalCase = {
    id: "eval_metrics_001",
    question: "资产质量如何？",
    expectedAnswer: "不良率保持稳定。",
    expectedKeywords: ["不良率", "稳定"],
    requiredDocumentIds: ["doc_001"],
    minCitations: 1
  };

  const context = {
    question: evalCase.question,
    answer: {
      answer: "资产质量稳定，不良贷款率保持在低位。",
      citations: [
        {
          chunkId: "doc_001_chunk_0000",
          documentId: "doc_001",
          source: "demo",
          heading: "资产质量",
          chunkIndex: 0,
          quote: "不良贷款率保持在低位，资产质量稳定。",
          confidence: 0.85
        }
      ],
      retrievalResults: [
        {
          chunkId: "doc_001_chunk_0000",
          documentId: "doc_001",
          score: 0.85,
          rank: 1,
          text: "不良贷款率保持在低位，资产质量稳定。",
          citation: {
            chunkId: "doc_001_chunk_0000",
            documentId: "doc_001",
            source: "demo",
            heading: "资产质量",
            chunkIndex: 0,
            quote: "不良贷款率保持在低位，资产质量稳定。",
            confidence: 0.85
          }
        }
      ]
    },
    topRetrievedChunkIds: ["doc_001_chunk_0000"],
    topRetrievedDocumentIds: ["doc_001"]
  };

  const metrics = computeRagMetrics(evalCase, context);

  assert.equal(metrics.length, 4);
  assert.ok(metrics.some((metric) => metric.name === "retrievalHitRate"));
  assert.ok(metrics.some((metric) => metric.name === "answerCorrectness"));
  assert.ok(metrics.some((metric) => metric.name === "faithfulness"));
  assert.ok(metrics.some((metric) => metric.name === "citationCoverage"));
  assert.ok(metrics.every((metric) => metric.passed));
});

test("computeRagMetrics marks retrieval as failed when expected document is missing", () => {
  const evalCase = {
    id: "eval_metrics_002",
    question: "盈利能力如何？",
    expectedKeywords: ["净利润"],
    requiredDocumentIds: ["doc_missing"],
    minCitations: 1
  };

  const context = {
    question: evalCase.question,
    answer: {
      answer: "净利润同比增长。",
      citations: [
        {
          chunkId: "doc_001_chunk_0001",
          documentId: "doc_001",
          source: "demo",
          chunkIndex: 1,
          quote: "净利润同比增长",
          confidence: 0.8
        }
      ],
      retrievalResults: [
        {
          chunkId: "doc_001_chunk_0001",
          documentId: "doc_001",
          score: 0.8,
          rank: 1,
          text: "净利润同比增长",
          citation: {
            chunkId: "doc_001_chunk_0001",
            documentId: "doc_001",
            source: "demo",
            chunkIndex: 1,
            quote: "净利润同比增长",
            confidence: 0.8
          }
        }
      ]
    },
    topRetrievedChunkIds: ["doc_001_chunk_0001"],
    topRetrievedDocumentIds: ["doc_001"]
  };

  const metrics = computeRagMetrics(evalCase, context);
  const retrievalMetric = metrics.find((metric) => metric.name === "retrievalHitRate");

  assert.equal(retrievalMetric.passed, false);
  assert.equal(retrievalMetric.score, 0);
});

test("createRagEvalReport aggregates metrics and collects up to 3 failures", () => {
  const results = [
    createPassingResult("eval_a"),
    createFailingResult("eval_b"),
    createFailingResult("eval_c"),
    createFailingResult("eval_d")
  ];

  const report = createRagEvalReport(results);

  assert.equal(report.metrics.totalCases, 4);
  assert.equal(report.metrics.passedCases, 1);
  assert.equal(report.metrics.failedCases, 3);
  assert.equal(report.failures.length, 3);
  assert.ok(report.recommendations.length > 0);
});

test("demo documents and cases count meet the task requirement", () => {
  assert.ok(DEMO_DOCUMENTS.length >= 3, "should have at least 3 demo documents");
  assert.equal(RAG_EVAL_CASES.length, 30, "should have exactly 30 eval cases");
});

test("runRagEval runs 30 cases against demo runtime and returns report", async () => {
  const runtime = await createDemoRagRuntime();
  const result = await runRagEval({
    cases: RAG_EVAL_CASES,
    runtime,
    options: { topK: 5, mode: "hybrid" }
  });

  assert.equal(result.ok, true);
  assert.ok(result.output.durationMs > 0);
  assert.equal(result.output.report.metrics.totalCases, 30);
  assert.equal(result.output.results.length, 30);

  const report = result.output.report;
  console.log("RAG Eval Report:");
  console.log(JSON.stringify(report.metrics, null, 2));
  console.log(`Failures: ${report.failures.length}`);

  report.failures.forEach((failure) => {
    console.log(`- ${failure.caseId}: ${failure.question}`);
    console.log(`  analysis: ${failure.analysis}`);
  });

  assert.ok(report.failures.length >= 0);
  assert.ok(typeof report.metrics.retrievalHitRate === "number");
  assert.ok(typeof report.metrics.answerCorrectness === "number");
  assert.ok(typeof report.metrics.faithfulness === "number");
  assert.ok(typeof report.metrics.citationCoverage === "number");
});

function createPassingResult(caseId) {
  return {
    caseId,
    question: "测试问题",
    answer: {
      answer: "测试答案。",
      citations: [{ chunkId: "c1", documentId: "d1", source: "demo", chunkIndex: 0, quote: "测试", confidence: 0.9 }],
      retrievalResults: []
    },
    metrics: [
      { name: "retrievalHitRate", score: 1, passed: true, details: "ok" },
      { name: "answerCorrectness", score: 1, passed: true, details: "ok" },
      { name: "faithfulness", score: 1, passed: true, details: "ok" },
      { name: "citationCoverage", score: 1, passed: true, details: "ok" }
    ],
    passed: true
  };
}

function createFailingResult(caseId) {
  return {
    caseId,
    question: "失败测试问题",
    answer: {
      answer: "失败测试答案。",
      citations: [],
      retrievalResults: []
    },
    metrics: [
      { name: "retrievalHitRate", score: 0, passed: false, details: "missing" },
      { name: "answerCorrectness", score: 0, passed: false, details: "missing" },
      { name: "faithfulness", score: 0, passed: false, details: "missing" },
      { name: "citationCoverage", score: 0, passed: false, details: "missing" }
    ],
    passed: false
  };
}
