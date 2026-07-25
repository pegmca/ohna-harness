import assert from "node:assert/strict";
import { test } from "node:test";
import { publishArtifactPdf } from "../dist/application/artifact-service.js";

test("file publish is compensated when pdf_ready metadata commit fails", async () => {
  const calls = [];
  let saves = 0;
  const repository = {
    async save(value) {
      saves += 1;
      calls.push(["save", value.artifact.status]);
      if (saves === 1) throw new Error("database unavailable");
      return value;
    }
  };
  const storage = createStorage(calls);
  const result = await publishArtifactPdf(createRecord(), repository, storage, renderPdf, fixedNow);
  assert.deepEqual(result, { ok: false, phase: "metadata_commit", failureStatePersisted: true });
  assert.deepEqual(calls, [["write", "new-key"], ["save", "pdf_ready"], ["delete", "aa/00000000-0000-4000-8000-000000000001.pdf"], ["save", "pdf_failed"]]);
});

test("failure-state persistence failure is explicit and never swallowed", async () => {
  const calls = [];
  const repository = { async save() { calls.push(["save"]); throw new Error("database unavailable"); } };
  const result = await publishArtifactPdf(createRecord(), repository, createStorage(calls), renderPdf, fixedNow);
  assert.deepEqual(result, { ok: false, phase: "metadata_commit", failureStatePersisted: false });
  assert.equal(calls.some(([action]) => action === "delete"), true);
  assert.equal(calls.filter(([action]) => action === "save").length, 2);
});

test("compensation failure preserves cleanup evidence in failed metadata", async () => {
  const saved = [];
  let calls = 0;
  const repository = {
    async save(value) {
      calls += 1;
      if (calls === 1) throw new Error("ready commit failed");
      saved.push(value);
      return value;
    }
  };
  const storage = createStorage([]);
  storage.deletePdf = async () => { throw new Error("filesystem unavailable"); };
  const result = await publishArtifactPdf(createRecord(), repository, storage, renderPdf, fixedNow);
  assert.deepEqual(result, { ok: false, phase: "metadata_commit_and_compensation", failureStatePersisted: true });
  assert.equal(saved[0].metadata.cleanupRequired, true);
  assert.equal(saved[0].storageKey, "aa/00000000-0000-4000-8000-000000000001.pdf");
});

test("repeated publish of a ready artifact is idempotent", async () => {
  const record = {
    ...createRecord(),
    storageKey: "aa/00000000-0000-4000-8000-000000000001.pdf",
    artifact: { ...createRecord().artifact, status: "pdf_ready", pdfExport: { status: "ready", message: "ready" } }
  };
  let writes = 0;
  let saves = 0;
  const storage = createStorage([]);
  storage.writePdf = async () => { writes += 1; throw new Error("must not write"); };
  const result = await publishArtifactPdf(record, { async save(value) { saves += 1; return value; } }, storage, renderPdf, fixedNow);
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(writes, 0);
  assert.equal(saves, 0);
});

/** @param calls 调用记录。 @returns 可注入 storage。 */
function createStorage(calls) {
  return {
    async writePdf() {
      calls.push(["write", "new-key"]);
      return {
        provider: "local",
        key: "aa/00000000-0000-4000-8000-000000000001.pdf",
        sizeBytes: 12,
        checksumSha256: "a".repeat(64)
      };
    },
    async readPdf() { return new Uint8Array(); },
    async deletePdf(key) { calls.push(["delete", key]); }
  };
}

/** @returns Artifact fixture。 */
function createRecord() {
  return {
    userId: "00000000-0000-4000-8000-000000000001",
    conversationId: "conversation-1",
    agentRunId: "run-1",
    kind: "research_report",
    mediaType: "text/html",
    metadata: {},
    updatedAt: "2026-07-25T00:00:00.000Z",
    artifact: {
      artifactId: "artifact-1",
      reportId: "plan-1",
      workflowRunId: "workflow-1",
      status: "html_preview_only",
      title: "报告",
      markdown: "# 报告",
      html: "<h1>报告</h1>",
      citations: [],
      citationVerification: { decision: "pass", verified: true, missingClaims: [], missingMetrics: [] },
      pdfExport: { status: "queued", message: "queued" },
      createdAt: "2026-07-25T00:00:00.000Z"
    }
  };
}

/** @returns PDF bytes。 */
function renderPdf() { return new TextEncoder().encode("%PDF"); }
/** @returns 固定时间。 */
function fixedNow() { return new Date("2026-07-25T01:00:00.000Z"); }
