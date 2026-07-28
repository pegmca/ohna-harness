import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiServer } from "../dist/index.js";
import { createInMemoryRunStore } from "../dist/adapters/in-memory-run-runtime.js";
import { createInMemoryApiTestRuntime } from "../dist/adapters/in-memory-test-runtime.js";

const runRequest = {
  message: "帮我查询 000001.SZ 最近一期净利润和 ROE。",
  conversationId: "conversation_test",
  mode: "auto",
  source: "composer"
};

async function bootstrap(app, visitorId) {
  const response = await app.inject({
    method: "POST", url: "/api/identity/bootstrap",
    payload: { visitorId, fingerprintVersion: "test-v1" }
  });
  return response.headers["set-cookie"].split(";")[0];
}

async function waitForTerminal(app, snapshotUrl, headers = {}) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({ method: "GET", url: snapshotUrl, headers });
    const snapshot = response.json().data;
    if (["succeeded", "failed", "cancelled"].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not reach terminal state.");
}

test("health and readiness separate liveness from dependency readiness", async () => {
  const app = createApiServer({
    ...createInMemoryApiTestRuntime(),
    readiness: async () => ({ ok: false, dependency: "test-provider", message: "not configured" })
  });
  assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/ready" })).statusCode, 503);
  await app.close();
});

test("model catalog exposes stable provider but not provider model name", async () => {
  const app = createApiServer(createInMemoryApiTestRuntime());
  const response = await app.inject({ method: "GET", url: "/api/models" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.models[0].provider, "mock");
  assert.equal("model" in response.json().data.models[0], false);
  await app.close();
});

test("POST /api/runs validates the new run creation contract", async () => {
  const app = createApiServer(createInMemoryApiTestRuntime());
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
  const app = createApiServer(createInMemoryApiTestRuntime());
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
  assert.equal(snapshot.result.tracePersistence.status, "complete");
  await app.close();
});

test("Trace API 按 session user 隔离 requestId", async () => {
  const app = createApiServer({ ...createInMemoryApiTestRuntime(), requireIdentity: true });
  const ownerCookie = await bootstrap(app, "visitor-trace-owner-0001");
  const foreignCookie = await bootstrap(app, "visitor-trace-owner-0002");
  const accepted = (await app.inject({
    method: "POST", url: "/api/runs", headers: { cookie: ownerCookie },
    payload: { ...runRequest, clientMessageId: "trace-owner-client-1" }
  })).json().data;
  await waitForTerminal(app, accepted.snapshotUrl, { cookie: ownerCookie });
  const own = await app.inject({
    method: "GET", url: `/api/traces/${accepted.requestId}`, headers: { cookie: ownerCookie }
  });
  assert.equal(own.statusCode, 200);
  assert.equal(own.json().data.requestId, accepted.requestId);
  const foreign = await app.inject({
    method: "GET", url: `/api/traces/${accepted.requestId}`, headers: { cookie: foreignCookie }
  });
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.json().error.code, "not_found");
  await app.close();
});

test("Trace 持久化失败不打断 Agent，并在最终结果留下结构化降级证据", async () => {
  const unavailableTraceStore = {
    async initialize() { throw new Error("postgres://user:secret@internal/trace"); },
    async append() { throw new Error("raw database exception"); },
    async finalize() { throw new Error("raw database exception"); },
    async getByRequestId() { return undefined; },
    async listEvents() { return undefined; }
  };
  const app = createApiServer({ ...createInMemoryApiTestRuntime(), traceStore: unavailableTraceStore });
  const accepted = (await app.inject({ method: "POST", url: "/api/runs", payload: runRequest })).json().data;
  const snapshot = await waitForTerminal(app, accepted.snapshotUrl);
  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.result.ok, true);
  assert.deepEqual(snapshot.result.tracePersistence, {
    status: "degraded",
    diagnostic: {
      code: "trace_persistence_degraded",
      message: "Trace 持久化暂时不可用；Agent 主结果已保留。"
    }
  });
  assert.equal(JSON.stringify(snapshot).includes("postgres://"), false);
  assert.equal(JSON.stringify(snapshot).includes("raw database exception"), false);
  await app.close();
});

test("SSE 终态 replay 支持 Last-Event-ID 与 afterSequence，且不重复业务事件", async () => {
  const app = createApiServer(createInMemoryApiTestRuntime());
  const accepted = (await app.inject({ method: "POST", url: "/api/runs", payload: runRequest })).json().data;
  const snapshot = await waitForTerminal(app, accepted.snapshotUrl);
  const after = Math.max(0, snapshot.events.length - 3);
  const replay = await app.inject({
    method: "GET",
    url: `${accepted.eventsUrl}?afterSequence=${after - 1}`,
    headers: { "last-event-id": String(after) }
  });
  assert.equal(replay.statusCode, 200);
  const events = replay.body.split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(events.map((event) => event.sequence), snapshot.events.slice(after).map((event) => event.sequence));
  assert.equal(new Set(events.map((event) => event.sequence)).size, events.length);
  assert.equal(["run_result", "run_error"].includes(events.at(-1).type), true);
  await app.close();
});

test("重复 clientMessageId 复用同一 Run，且 Run API 对用户隐藏其他用户资源", async () => {
  const app = createApiServer({ ...createInMemoryApiTestRuntime(), requireIdentity: true });
  const cookieOne = await bootstrap(app, "visitor-run-owner-0001");
  const cookieTwo = await bootstrap(app, "visitor-run-owner-0002");
  const payload = { ...runRequest, clientMessageId: "client-idempotency-1" };
  const first = await app.inject({ method: "POST", url: "/api/runs", headers: { cookie: cookieOne }, payload });
  const duplicate = await app.inject({ method: "POST", url: "/api/runs", headers: { cookie: cookieOne }, payload });
  assert.equal(first.statusCode, 202);
  assert.equal(duplicate.statusCode, 202);
  assert.equal(first.json().data.runId, duplicate.json().data.runId);

  const runId = first.json().data.runId;
  for (const request of [
    { method: "GET", url: `/api/runs/${runId}` },
    { method: "DELETE", url: `/api/runs/${runId}` },
    { method: "GET", url: `/api/runs/${runId}/events` }
  ]) {
    const response = await app.inject({ ...request, headers: { cookie: cookieTwo } });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "not_found");
  }
  await app.close();
});

test("run snapshot returns structured not_found errors", async () => {
  const app = createApiServer(createInMemoryApiTestRuntime());
  const response = await app.inject({ method: "GET", url: "/api/runs/missing" });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "not_found");
  await app.close();
});

test("report mode is orchestrated inside the canonical run", async () => {
  const app = createApiServer(createInMemoryApiTestRuntime());
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
  const app = createApiServer(createInMemoryApiTestRuntime());
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

test("approval decision 在 API 重启后仍可执行，且支持幂等重试与冲突检测", async () => {
  // 两个 server 实例共享同一份 repository/runStore，等价于重启后连接同一数据库。
  const runStore = createInMemoryRunStore();
  const runtime = createInMemoryApiTestRuntime({ runStore });
  const appOne = createApiServer(runtime);
  const accepted = (await appOne.inject({
    method: "POST",
    url: "/api/runs",
    payload: {
      message: "执行 SQL: SELECT * FROM metrics",
      conversationId: "conversation_approval_restart",
      mode: "auto",
      source: "composer"
    }
  })).json().data;
  const snapshot = await waitForTerminal(appOne, accepted.snapshotUrl);
  const approval = snapshot.result.trace.events.find(
    (event) => event.type === "approval" && event.status === "requested"
  );
  await appOne.close();

  const appTwo = createApiServer(runtime);
  const url = `/api/runs/${accepted.runId}/approvals/${approval.approvalId}/decision`;
  const decided = await appTwo.inject({
    method: "POST",
    url,
    payload: { decision: "approved", inputDigest: approval.inputDigest }
  });
  assert.equal(decided.statusCode, 200);
  assert.equal(decided.json().data.decision, "approved");

  const retry = await appTwo.inject({
    method: "POST",
    url,
    payload: { decision: "approved", inputDigest: approval.inputDigest }
  });
  assert.equal(retry.statusCode, 200);

  const conflict = await appTwo.inject({
    method: "POST",
    url,
    payload: { decision: "rejected", inputDigest: approval.inputDigest }
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, "conflict");
  await appTwo.close();
});

test("approval decision 拒绝其他已认证用户，reviewer 身份只来自服务端 session", async () => {
  const app = createApiServer({
    ...createInMemoryApiTestRuntime(),
    requireIdentity: true
  });
  const cookieOne = await bootstrap(app, "visitor-approval-owner-1");
  const cookieTwo = await bootstrap(app, "visitor-approval-other-2");
  const accepted = (await app.inject({
    method: "POST",
    url: "/api/runs",
    headers: { cookie: cookieOne },
    payload: {
      message: "执行 SQL: SELECT * FROM metrics",
      conversationId: "conversation_approval_isolation",
      mode: "auto",
      source: "composer"
    }
  })).json().data;
  const snapshot = await waitForTerminal(app, accepted.snapshotUrl, { cookie: cookieOne });
  const approval = snapshot.result.trace.events.find(
    (event) => event.type === "approval" && event.status === "requested"
  );
  const url = `/api/runs/${accepted.runId}/approvals/${approval.approvalId}/decision`;

  const foreign = await app.inject({
    method: "POST",
    url,
    headers: { cookie: cookieTwo },
    payload: { decision: "approved", inputDigest: approval.inputDigest }
  });
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.json().error.code, "forbidden");

  const owned = await app.inject({
    method: "POST",
    url,
    headers: { cookie: cookieOne },
    payload: { decision: "approved", inputDigest: approval.inputDigest }
  });
  assert.equal(owned.statusCode, 200);
  await app.close();
});

test("workflow PDF 审批带确定性 digest，可经 decision endpoint 决定并放行 PDF 导出", async () => {
  const written = new Map();
  const artifactStorage = {
    async writePdf(bytes) {
      const key = "test/report.pdf";
      written.set(key, bytes);
      return { provider: "local", key, sizeBytes: bytes.length, checksumSha256: "ab".repeat(32) };
    },
    async readPdf(key) { return written.get(key); },
    async deletePdf(key) { written.delete(key); }
  };
  const app = createApiServer({
    ...createInMemoryApiTestRuntime(),
    artifactStorage
  });
  const accepted = (await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: {
      message: "基于最近两年公告和财务数据，为 000001.SZ 生成研究简报 PDF。",
      conversationId: "conversation_pdf_approval",
      mode: "report",
      source: "report_button"
    }
  })).json().data;
  const snapshot = await waitForTerminal(app, accepted.snapshotUrl);
  const approval = snapshot.result.reportWorkflow.run.approvalRequest;
  // 回归防护：workflow 审批必须在登记前补齐非空 digest，否则永远无法决定。
  assert.equal(typeof approval.inputDigest, "string");
  assert.equal(approval.inputDigest.length > 0, true);

  const decided = await app.inject({
    method: "POST",
    url: `/api/runs/${accepted.runId}/approvals/${approval.approvalId}/decision`,
    payload: { decision: "approved", inputDigest: approval.inputDigest }
  });
  assert.equal(decided.statusCode, 200);
  assert.equal(decided.json().data.decision, "approved");

  const artifactId = snapshot.result.reportWorkflow.artifact.artifactId;
  const exported = await app.inject({ method: "POST", url: `/api/report-artifacts/${artifactId}/pdf` });
  assert.equal(exported.statusCode, 200);
  assert.equal(exported.json().data.status, "pdf_ready");
  await app.close();
});

test("data sources and RAG routes retain structured DTO boundaries", async () => {
  const app = createApiServer(createInMemoryApiTestRuntime());
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
  const app = createApiServer(createInMemoryApiTestRuntime());
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
  const app = createApiServer(createInMemoryApiTestRuntime());
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
  const app = createApiServer(createInMemoryApiTestRuntime());
  const evalResponse = await app.inject({ method: "GET", url: "/api/product/eval-report" });
  const architecture = await app.inject({ method: "GET", url: "/api/product/architecture" });
  assert.equal(evalResponse.json().data.caseCount, 31);
  assert.equal(architecture.json().data.nodes.some((node) => node.label === "apps/api"), true);
  await app.close();
});
