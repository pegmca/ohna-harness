import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiServer } from "../dist/index.js";

const runRequest = {
  message: "帮我查询 000001.SZ 最近一期净利润和 ROE。",
  conversationId: "conversation_test",
  mode: "auto",
  source: "composer"
};

async function waitForTerminal(app, snapshotUrl) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({ method: "GET", url: snapshotUrl });
    const snapshot = response.json().data;
    if (["succeeded", "failed", "cancelled"].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not reach terminal state.");
}

test("health and readiness separate liveness from dependency readiness", async () => {
  const app = createApiServer({
    readiness: async () => ({ ok: false, dependency: "test-provider", message: "not configured" })
  });
  assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/ready" })).statusCode, 503);
  await app.close();
});

test("POST /api/runs validates the new run creation contract", async () => {
  const app = createApiServer();
  const invalid = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { message: "hello" }
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "validation_failed");
  await app.close();
});

test("run application service exposes ordered events and a terminal snapshot", async () => {
  const app = createApiServer();
  const acceptedResponse = await app.inject({ method: "POST", url: "/api/runs", payload: runRequest });
  assert.equal(acceptedResponse.statusCode, 202);
  const accepted = acceptedResponse.json().data;
  const snapshot = await waitForTerminal(app, accepted.snapshotUrl);

  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.result.runId, accepted.runId);
  assert.equal(snapshot.result.conversationId, runRequest.conversationId);
  assert.deepEqual(snapshot.events.map((event) => event.sequence), snapshot.events.map((_, index) => index + 1));
  assert.equal(snapshot.events[0].type, "run_status");
  assert.equal(snapshot.events.at(-1).type, "run_result");
  assert.equal(snapshot.events.some((event) => event.type === "trace_event"), true);
  await app.close();
});

test("run snapshot returns structured not_found errors", async () => {
  const app = createApiServer();
  const response = await app.inject({ method: "GET", url: "/api/runs/missing" });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "not_found");
  await app.close();
});

test("report mode is orchestrated inside the canonical run", async () => {
  const app = createApiServer();
  const accepted = (await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: {
      message: "基于最近两年公告和财务数据，为 000001.SZ 生成研究简报 PDF。",
      conversationId: "conversation_report",
      mode: "report",
      source: "report_button"
    }
  })).json().data;
  const snapshot = await waitForTerminal(app, accepted.snapshotUrl);

  assert.equal(snapshot.result.intent, "report_skill");
  assert.equal(snapshot.result.reportWorkflow.run.status, "paused");
  assert.equal(snapshot.result.reportWorkflow.artifact.status, "html_preview_only");
  assert.equal(snapshot.result.reportWorkflow.run.approvalRequest.permissionLevel, "needs_approval");
  await app.close();
});

test("approval decision is bound to its run and input digest", async () => {
  const app = createApiServer();
  const accepted = (await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: {
      message: "执行 SQL: SELECT * FROM metrics",
      conversationId: "conversation_approval",
      mode: "auto",
      source: "composer"
    }
  })).json().data;
  const snapshot = await waitForTerminal(app, accepted.snapshotUrl);
  const approval = snapshot.result.trace.events.find(
    (event) => event.type === "approval" && event.status === "requested"
  );
  const rejected = await app.inject({
    method: "POST",
    url: `/api/runs/${accepted.runId}/approvals/${approval.approvalId}/decision`,
    payload: { decision: "approved", inputDigest: "wrong" }
  });
  assert.equal(rejected.statusCode, 403);

  const approved = await app.inject({
    method: "POST",
    url: `/api/runs/${accepted.runId}/approvals/${approval.approvalId}/decision`,
    payload: { decision: "approved", inputDigest: approval.inputDigest }
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().data.decision, "approved");
  await app.close();
});

test("data sources and RAG routes retain structured DTO boundaries", async () => {
  const app = createApiServer();
  const ingest = await app.inject({
    method: "POST",
    url: "/api/data-sources/ingest",
    payload: {
      source: "demo",
      fileName: "annual-report.md",
      content: "# 资产质量\n公司不良率保持稳定。\n\n# 盈利能力\n净利润同比增长。"
    }
  });
  assert.equal(ingest.statusCode, 200);
  assert.equal(ingest.json().data.documentVersion, 1);
  assert.equal(ingest.json().data.deduplicated, false);

  const documents = await app.inject({ method: "GET", url: "/api/data-sources/documents" });
  assert.equal(documents.statusCode, 200);
  assert.equal(documents.json().data.nextCursor, null);
  assert.equal(documents.json().data.documents.length, 1);
  assert.equal(documents.json().data.documents[0].latestVersion, 1);
  assert.equal(documents.json().data.documents[0].latestStatus, "indexed");
  assert.equal(documents.json().data.documents[0].scope, "shared");

  const chunks = await app.inject({ method: "GET", url: "/api/data-sources/chunks" });
  assert.equal(chunks.statusCode, 200);
  assert.equal(chunks.json().data.nextCursor, null);
  assert.equal(chunks.json().data.chunks.length, ingest.json().data.indexedChunkCount);

  const answer = await app.inject({
    method: "POST",
    url: "/api/rag/answer",
    payload: { question: "公司资产质量如何？", topK: 5 }
  });
  assert.equal(answer.statusCode, 200);
  assert.equal(answer.json().data.answer.citations.length > 0, true);
  await app.close();
});

test("data sources ingest rejects unsafe source identifiers", async () => {
  const app = createApiServer();
  const unsafeSources = ["/etc/passwd", "file:///etc/passwd", "../x", "C:\\data\\x.md", "~/secret.md"];

  for (const source of unsafeSources) {
    const response = await app.inject({
      method: "POST",
      url: "/api/data-sources/ingest",
      payload: {
        source,
        fileName: "annual-report.md",
        content: "# 资产质量\n公司不良率保持稳定。"
      }
    });
    assert.equal(response.statusCode, 400, `source ${source} should be rejected`);
    assert.equal(response.json().error.code, "validation_failed");
  }

  const documents = await app.inject({ method: "GET", url: "/api/data-sources/documents" });
  assert.equal(documents.json().data.documents.length, 0);
  await app.close();
});

test("data sources list routes validate pagination query and page through results", async () => {
  const app = createApiServer();
  for (let index = 0; index < 3; index += 1) {
    const ingest = await app.inject({
      method: "POST",
      url: "/api/data-sources/ingest",
      payload: {
        source: `demo/doc-${index}`,
        fileName: `doc-${index}.md`,
        content: `# 文档 ${index}\n第 ${index} 篇内容。`
      }
    });
    assert.equal(ingest.statusCode, 200);
  }

  const invalid = await app.inject({ method: "GET", url: "/api/data-sources/documents?limit=0" });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "validation_failed");

  const seen = new Set();
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const url = cursor
      ? `/api/data-sources/documents?limit=2&cursor=${encodeURIComponent(cursor)}`
      : "/api/data-sources/documents?limit=2";
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200);
    response.json().data.documents.forEach((document) => seen.add(document.documentId));
    if (!response.json().data.nextCursor) break;
    cursor = response.json().data.nextCursor;
  }
  assert.equal(seen.size, 3);
  await app.close();
});

test("product evidence routes remain readable", async () => {
  const app = createApiServer();
  const evalResponse = await app.inject({ method: "GET", url: "/api/product/eval-report" });
  const architecture = await app.inject({ method: "GET", url: "/api/product/architecture" });
  assert.equal(evalResponse.json().data.caseCount, 31);
  assert.equal(architecture.json().data.nodes.some((node) => node.label === "apps/api"), true);
  await app.close();
});
