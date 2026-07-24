import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiServer } from "../dist/index.js";
import { createIdentityService, createInMemoryIdentityRepository } from "../../../packages/identity/dist/index.js";

test("browser fingerprint bootstrap creates a session-backed userId", async () => {
  const app = createApiServer({ requireIdentity: true });
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/identity/bootstrap",
    payload: { visitorId: "visitor-api-test-123", fingerprintVersion: "fingerprintjs-v5" }
  });
  assert.equal(bootstrap.statusCode, 200);
  assert.match(bootstrap.headers["set-cookie"], /aiagent_session=/);
  const cookie = bootstrap.headers["set-cookie"].split(";")[0];
  const me = await app.inject({ method: "GET", url: "/api/identity/me", headers: { cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().data.userId, bootstrap.json().data.userId);
  await app.close();
});

test("QQ binding challenge links the current browser user", async () => {
  const identityService = createIdentityService(createInMemoryIdentityRepository(), { fingerprintPepper: "api-binding-test" });
  const app = createApiServer({ requireIdentity: true, identityService, qqBotEnabled: true, qqBotQrUrl: "https://example.com/qq.png" });
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/identity/bootstrap",
    payload: { visitorId: "visitor-binding-test", fingerprintVersion: "fingerprintjs-v5" }
  });
  const cookie = bootstrap.headers["set-cookie"].split(";")[0];
  const challengeResponse = await app.inject({
    method: "POST",
    url: "/api/identity/qq-binding-challenges",
    headers: { cookie }
  });
  assert.equal(challengeResponse.statusCode, 200);
  const challenge = challengeResponse.json().data;
  const consumed = await identityService.consumeQqBinding(challenge.code, "bot-one", "qq-open-id");
  assert.equal(consumed.status, "bound");
  const status = await app.inject({
    method: "GET",
    url: `/api/identity/qq-binding-challenges/${challenge.challengeId}`,
    headers: { cookie }
  });
  assert.equal(status.json().data.status, "bound");
  await app.close();
});

test("health and readiness distinguish liveness from dependency readiness", async () => {
  const app = createApiServer({ readiness: async () => ({ ok: false, dependency: "test-provider", message: "not configured" }) });
  const health = await app.inject({ method: "GET", url: "/health" });
  const ready = await app.inject({ method: "GET", url: "/ready" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().ok, true);
  assert.equal(ready.statusCode, 503);
  assert.equal(ready.json().dependency, "test-provider");
  await app.close();
});

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

test("POST /api/runs exposes ordered live-run events and terminal snapshot", async () => {
  const app = createApiServer();
  const acceptedResponse = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { message: "查询 000001.SZ 的行情", conversationId: "conversation_sse" }
  });
  assert.equal(acceptedResponse.statusCode, 202);
  const accepted = acceptedResponse.json().data;
  let snapshot;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const response = await app.inject({ method: "GET", url: accepted.snapshotUrl });
    snapshot = response.json().data;
    if (["succeeded", "failed", "cancelled"].includes(snapshot.status)) break;
  }

  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.conversationId, "conversation_sse");
  assert.equal(snapshot.events[0].type, "run_status");
  assert.deepEqual(snapshot.events.map((event) => event.sequence), snapshot.events.map((_, index) => index + 1));
  assert.equal(snapshot.events.some((event) => event.type === "trace_event"), true);
  assert.equal(snapshot.events.at(-1).type, "run_result");
  const marketEvent = snapshot.events.find((event) => event.type === "trace_event" && event.event.type === "tool_call");
  assert.equal(marketEvent.event.result.series.bars.length, 60);
  await app.close();
});

test("POST /api/approvals/decision records approval decisions", async () => {
  const app = createApiServer();
  const pendingResponse = await app.inject({ method: "POST", url: "/api/agent/run", payload: { message: "执行 SQL: SELECT * FROM metrics", reportMode: false } });
  const pending = pendingResponse.json().data.trace.events.find((event) => event.type === "approval" && event.status === "requested");
  const response = await app.inject({
    method: "POST",
    url: "/api/approvals/decision",
    payload: {
      approvalId: pending.approvalId,
      decision: "approved",
      requestId: pending.requestId,
      inputDigest: pending.inputDigest,
      reviewerNote: "manual test"
    }
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.approvalId, pending.approvalId);
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
  assert.equal(started.data.artifact.reportId, plan.planId);
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
  const approval = started.data.run.approvalRequest;
  const forbiddenExport = await app.inject({ method: "POST", url: `/api/report-artifacts/${started.data.artifact.artifactId}/pdf` });
  assert.equal(forbiddenExport.statusCode, 403);
  const approvalResponse = await app.inject({ method: "POST", url: "/api/approvals/decision", payload: { approvalId: approval.approvalId, decision: "approved", requestId: approval.requestId, inputDigest: approval.inputDigest } });
  assert.equal(approvalResponse.statusCode, 200);
  const exportResponse = await app.inject({ method: "POST", url: `/api/report-artifacts/${started.data.artifact.artifactId}/pdf` });
  assert.equal(exportResponse.statusCode, 200);
  assert.equal(exportResponse.json().data.status, "pdf_ready");
  const downloadResponse = await app.inject({ method: "GET", url: exportResponse.json().data.pdfExport.downloadUrl });
  assert.equal(downloadResponse.headers["content-type"], "application/pdf");
  assert.match(downloadResponse.rawPayload.toString("utf8"), /^%PDF-1\.4/);
  await app.close();
});

test("product showcase endpoints expose eval evidence and package architecture", async () => {
  const app = createApiServer();
  const evalResponse = await app.inject({ method: "GET", url: "/api/product/eval-report" });
  const architectureResponse = await app.inject({ method: "GET", url: "/api/product/architecture" });
  assert.equal(evalResponse.json().data.failures.length, 3);
  assert.equal(evalResponse.json().data.demoData, true);
  assert.equal(architectureResponse.json().data.nodes.some((node) => node.label === "packages/report"), true);
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
