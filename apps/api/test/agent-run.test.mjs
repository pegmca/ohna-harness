import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiServer } from "../dist/index.js";

test("POST /api/agent/run returns structured agent response", async () => {
  const app = createApiServer();
  const response = await app.inject({
    method: "POST",
    url: "/api/agent/run",
    payload: {
      message: "帮我查询 000001.SZ 最近一期净利润和 ROE。",
      reportMode: false
    }
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.intent, "tool");
  assert.equal(body.data.ok, true);
  assert.equal(body.data.trace.events.some((event) => event.type === "tool_call"), true);
  assert.equal(body.data.trace.summary.toolCallCount, 1);
  assert.equal(body.data.trace.events.every((event) => event.spanId && (event.type === "request_received" || event.parentSpanId)), true);

  const traceResponse = await app.inject({ method: "GET", url: `/api/traces/${body.data.requestId}` });
  assert.equal(traceResponse.statusCode, 200);
  assert.equal(traceResponse.json().data.traceId, body.data.traceId);

  await app.close();
});

test("POST /api/approvals/decision records approval decisions", async () => {
  const app = createApiServer();
  const response = await app.inject({
    method: "POST",
    url: "/api/approvals/decision",
    payload: {
      approvalId: "approval_demo",
      decision: "approved",
      reviewerNote: "manual test"
    }
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.approvalId, "approval_demo");
  assert.equal(body.data.decision, "approved");

  await app.close();
});

test("POST /api/agent/run forwards report activation DTOs and returns report plan", async () => {
  const app = createApiServer();
  const response = await app.inject({
    method: "POST",
    url: "/api/agent/run",
    payload: {
      message: "基于最近两年公告和财务数据，为 000001.SZ 生成研究简报。",
      reportMode: true,
      reportTriggerSource: "button"
    }
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.intent, "report_skill");
  assert.equal(body.data.reportPlan.status, "ready");
  assert.equal(body.data.reportPlan.triggerSource, "button");
  assert.equal(body.data.reportPlan.subject, "000001.SZ");
  assert.equal(body.data.reportPlan.timeRange, "最近两年");
  assert.equal(body.data.trace.events.some((event) => event.type === "report_skill_activation"), true);
  assert.equal(body.data.trace.events.some((event) => event.type === "report_plan"), true);

  await app.close();
});

test("report workflow routes expose nodes, preview artifact and traceable citations", async () => {
  const app = createApiServer();
  const agentResponse = await app.inject({ method: "POST", url: "/api/agent/run", payload: {
    message: "基于最近两年公告和财务数据，为 000001.SZ 生成研究简报 PDF。",
    reportMode: true
  }});
  const plan = agentResponse.json().data.reportPlan;
  const agentRun = agentResponse.json().data;
  const startResponse = await app.inject({ method: "POST", url: "/api/report-workflows", payload: { plan, requestId: agentRun.requestId, traceId: agentRun.traceId } });
  const started = startResponse.json();

  assert.equal(startResponse.statusCode, 200);
  assert.equal(started.ok, true);
  assert.deepEqual(started.data.run.nodes.map((node) => node.nodeId), [
    "data_collector", "analyzer", "risk_checker", "citation_verifier", "report_writer", "pdf_exporter"
  ]);
  assert.equal(started.data.run.status, "paused");
  assert.equal(started.data.artifact.status, "html_preview_only");
  assert.equal(started.data.artifact.pdfExport.status, "queued");
  assert.match(started.data.artifact.markdown, /核心结论/);
  assert.equal(started.data.artifact.citations.length > 0, true);
  assert.equal(typeof started.data.artifact.citations[0].documentId, "string");
  assert.equal(typeof started.data.artifact.citations[0].chunkId, "string");

  const traceResponse = await app.inject({ method: "GET", url: `/api/traces/${started.requestId}` });
  const traceEvents = traceResponse.json().data.events;
  assert.equal(traceEvents.some((event) => event.type === "citation_verifier"), true);
  assert.equal(traceEvents.some((event) => event.type === "pdf_export" && event.status === "queued"), true);
  assert.equal(traceEvents.some((event) => event.type === "report_skill_activation"), true);
  assert.equal(traceEvents.some((event) => event.type === "workflow_node"), true);

  const runResponse = await app.inject({ method: "GET", url: `/api/report-workflows/${started.data.run.runId}` });
  const artifactResponse = await app.inject({ method: "GET", url: `/api/report-artifacts/${started.data.artifact.artifactId}` });
  assert.equal(runResponse.json().data.run.runId, started.data.run.runId);
  assert.equal(artifactResponse.json().data.artifactId, started.data.artifact.artifactId);
  await app.close();
});

test("POST /api/agent/run rejects empty messages with ApiResult failure", async () => {
  const app = createApiServer();
  const response = await app.inject({
    method: "POST",
    url: "/api/agent/run",
    payload: {
      message: "   "
    }
  });

  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "validation_failed");

  await app.close();
});

test("POST /api/agent/run returns structured agent failures with trace", async () => {
  const app = createApiServer();
  const response = await app.inject({
    method: "POST",
    url: "/api/agent/run",
    payload: {
      message: "帮我查询 999999.SZ 最近一期净利润和 ROE。"
    }
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.ok, false);
  assert.equal(body.data.error.code, "agent_failed");
  assert.equal(body.data.trace.events.some((event) => event.type === "final_response" && event.ok === false), true);

  await app.close();
});

test("data sources and rag routes expose ingest, chunks, search and citation answer", async () => {
  const app = createApiServer();
  const ingestResponse = await app.inject({
    method: "POST",
    url: "/api/data-sources/ingest",
    payload: {
      source: "demo",
      fileName: "annual-report.md",
      content: "# 资产质量\n公司不良率保持稳定。\n\n# 盈利能力\n公司净利润同比增长。"
    }
  });

  assert.equal(ingestResponse.statusCode, 200);
  const ingestBody = ingestResponse.json();
  assert.equal(ingestBody.ok, true);
  assert.equal(ingestBody.data.indexedChunkCount > 0, true);

  const documentsResponse = await app.inject({
    method: "GET",
    url: "/api/data-sources/documents"
  });
  const chunksResponse = await app.inject({
    method: "GET",
    url: "/api/data-sources/chunks"
  });

  assert.equal(documentsResponse.statusCode, 200);
  assert.equal(chunksResponse.statusCode, 200);
  assert.equal(documentsResponse.json().data.documents.length, 1);
  assert.equal(chunksResponse.json().data.chunks.length, ingestBody.data.indexedChunkCount);

  const searchResponse = await app.inject({
    method: "POST",
    url: "/api/rag/search",
    payload: {
      query: "资产质量",
      topK: 5
    }
  });
  const searchBody = searchResponse.json();

  assert.equal(searchResponse.statusCode, 200);
  assert.equal(searchBody.ok, true);
  assert.equal(searchBody.data.results.length > 0, true);
  assert.equal(searchBody.data.results[0].citation.source, "demo");
  assert.equal(searchBody.data.results[0].citation.heading, "资产质量");
  assert.equal(typeof searchBody.data.results[0].citation.chunkIndex, "number");

  const answerResponse = await app.inject({
    method: "POST",
    url: "/api/rag/answer",
    payload: {
      question: "公司资产质量如何？",
      topK: 5
    }
  });
  const answerBody = answerResponse.json();

  assert.equal(answerResponse.statusCode, 200);
  assert.equal(answerBody.ok, true);
  assert.equal(answerBody.data.answer.citations.length > 0, true);
  assert.equal(answerBody.data.answer.citations[0].documentId, ingestBody.data.document.documentId);

  const unknownResponse = await app.inject({
    method: "POST",
    url: "/api/rag/answer",
    payload: {
      question: "公司海外新能源业务收入是多少？",
      topK: 5
    }
  });
  const unknownBody = unknownResponse.json();

  assert.equal(unknownResponse.statusCode, 200);
  assert.equal(unknownBody.ok, true);
  assert.match(unknownBody.data.answer.answer, /资料不足|无法可靠回答/);

  await app.close();
});
