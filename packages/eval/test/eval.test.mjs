import assert from "node:assert/strict";
import { test } from "node:test";
import { createEvalPackageSummary, createEvalResult } from "../dist/index.js";

test("eval package entry exposes its boundary summary", () => {
  const summary = createEvalPackageSummary();

  assert.equal(summary.packageName, "@aiagent/eval");
  assert.equal(summary.boundary, "rag_eval_cases_metrics_reports");
  assert.equal(summary.runtimeState, "types_and_mock_only");
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
          quote: "净利润同比增长",
          confidence: 0.91
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
