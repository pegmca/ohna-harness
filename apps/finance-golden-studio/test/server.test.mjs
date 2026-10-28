/**
 * Finance Golden Studio 本地 HTTP API 契约测试。
 *
 * 服务在随机端口真实监听，所有读写都在隔离临时工作区与真实 PDF 上完成，
 * 覆盖路径边界、请求体限制、稳定错误信封、草稿往返、范围下载和确认动作。
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { createGoldenStudioServer } from "../src/server/http.ts";
import {
  cleanupWorkflowFixtures,
  makeGoldenCase,
  makeWorkflowConfig,
  writeGolden,
  writeManifest,
  writePdf
} from "./workflow-fixtures.mjs";

const config = makeWorkflowConfig();
const pdfPath = "600000.SH/annual/2025.pdf";
let studioServer;
let baseUrl;

before(async () => {
  writeManifest(config, [
    {
      ticker: "600000.SH",
      report_type: "annual",
      period: "2025",
      file_path: pdfPath
    }
  ]);
  writePdf(config, pdfPath, "Revenue 100");
  writeGolden(config, [makeGoldenCase()]);
  mkdirSync(join(config.workspaceRoot, "outside"), { recursive: true });
  writeFileSync(join(config.workspaceRoot, "outside", "secret.pdf"), "%PDF-secret");

  studioServer = createGoldenStudioServer(config, { maxBodyBytes: 1024 });
  const address = await studioServer.listen(0, "127.0.0.1");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await studioServer?.close();
  cleanupWorkflowFixtures();
  rmSync(join(config.workspaceRoot, "outside"), { recursive: true, force: true });
});

test("GET /api/batches 返回经核心聚合的批次摘要", async () => {
  const fixtureDraft = makeDraft("fin-D001");
  await request("/api/batches/batch-a/drafts/fin-D001", {
    method: "PUT",
    body: JSON.stringify({ draft: fixtureDraft })
  });

  const response = await request("/api/batches");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.data, [
    {
      name: "batch-a",
      draftCount: 1,
      approvedCount: 0,
      pendingCount: 1,
      corruptCount: 0
    }
  ]);
});

test("草稿 PUT/GET 往返保留完整作者内容并刷新服务端本地状态", async () => {
  const draft = makeDraft("fin-D002");

  const savedResponse = await request("/api/batches/draft-roundtrip/drafts/fin-D002", {
    method: "PUT",
    body: JSON.stringify({ draft })
  });
  const saved = await savedResponse.json();
  const loadedResponse = await request(
    "/api/batches/draft-roundtrip/drafts/fin-D002"
  );
  const loaded = await loadedResponse.json();

  assert.equal(savedResponse.status, 200);
  assert.equal(saved.ok, true);
  assert.equal(loadedResponse.status, 200);
  assert.equal(loaded.data.id, "fin-D002");
  assert.equal(loaded.data.query, draft.query);
  assert.equal(loaded.data._draft.batch, "draft-roundtrip");
  assert.equal(Number.isNaN(Date.parse(loaded.data._draft.savedAt)), false);
  assert.equal(loaded.data._draft.filePath.endsWith("fin-D002.jsonl"), true);
  assert.deepEqual(await readDraftFromCore("draft-roundtrip", "fin-D002"), loaded.data);
});

test("批次和草稿路径穿越在任何核心调用前被拒绝", async () => {
  const batchResponse = await request(
    "/api/batches/..%5Cescape/drafts?path=/tmp/outside"
  );
  const idResponse = await request(
    "/api/batches/batch-a/drafts/..%5Csecret"
  );

  assertStructuredError(await batchResponse.json(), 400, "invalid_batch_name");
  assertStructuredError(await idResponse.json(), 400, "invalid_draft_id");
});

test("未知 API 路由返回 404 与稳定错误信封", async () => {
  const response = await request("/api/not-a-route");
  const body = await response.json();

  assert.equal(response.status, 404);
  assertStructuredError(body, 404, "not_found");
});

test("未知 HTTP 方法返回 405 且标明允许方法", async () => {
  const response = await request("/api/batches", { method: "POST" });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  assertStructuredError(await response.json(), 405, "method_not_allowed");
});

test("非法 JSON 与超出上限的请求体返回结构化 4xx", async () => {
  const malformed = await request("/api/actions/validate", {
    method: "POST",
    body: '{"confirm":'
  });
  const oversized = await request("/api/actions/validate", {
    method: "POST",
    body: JSON.stringify({ confirm: true, padding: "x".repeat(2048) })
  });

  assert.equal(malformed.status, 400);
  assertStructuredError(await malformed.json(), 400, "invalid_json");
  assert.equal(oversized.status, 413);
  assertStructuredError(await oversized.json(), 413, "request_too_large");
});

test("动作端点要求显式 confirm:true，拒绝缺失或非布尔确认", async () => {
  const missing = await request("/api/actions/promote", {
    method: "POST",
    body: JSON.stringify({ batch: "batch-a" })
  });
  const falseConfirmation = await request("/api/actions/generate", {
    method: "POST",
    body: JSON.stringify({ confirm: false })
  });

  assert.equal(missing.status, 400);
  assertStructuredError(await missing.json(), 400, "confirmation_required");
  assertStructuredError(
    await falseConfirmation.json(),
    400,
    "confirmation_required"
  );
});

test("server 拒绝非 loopback 监听地址，避免暴露本地工作区写接口", async () => {
  const exposed = createGoldenStudioServer(config);
  try {
    await assert.rejects(exposed.listen(0, "0.0.0.0"), (error) => {
      assert.equal(error.code, "invalid_request");
      assert.equal(error.status, 400);
      return true;
    });
  } finally {
    await exposed.close().catch(() => undefined);
  }
});

test("validate 拒绝相互矛盾的 scope 与 batch 组合", async () => {
  const response = await request("/api/actions/validate", {
    method: "POST",
    body: JSON.stringify({
      confirm: true,
      scope: "golden",
      batch: "batch-a"
    })
  });

  assert.equal(response.status, 400);
  assertStructuredError(await response.json(), 400, "invalid_request");
});

test("validate 动作委托核心并返回完整校验报告", async () => {
  const draft = {
    ...makeDraft("fin-D003"),
    _draft: { approved: true, validation: { ok: true } }
  };
  await request("/api/batches/validate-actions/drafts/fin-D003", {
    method: "PUT",
    body: JSON.stringify({ draft })
  });

  const response = await request("/api/actions/validate", {
    method: "POST",
    body: JSON.stringify({
      confirm: true,
      scope: "batch",
      batch: "validate-actions"
    })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.batch, "validate-actions");
  assert.equal(body.data.validation.ok, true);
  assert.ok(Array.isArray(body.data.validation.keywordResults));
});

test("promote 动作经确认后只发布核心判定可发布的草稿", async () => {
  const draft = {
    ...makeDraft("fin-D004"),
    _draft: { approved: true }
  };
  await request("/api/batches/promote-actions/drafts/fin-D004", {
    method: "PUT",
    body: JSON.stringify({ draft })
  });

  const response = await request("/api/actions/promote", {
    method: "POST",
    body: JSON.stringify({ confirm: true, batch: "promote-actions" })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.promotedCount, 1);
  assert.equal(body.data.promoted[0].draftId, "fin-D004");
  assert.equal(readFileSync(config.goldenPath, "utf8").includes('"_draft"'), false);
});

test("generate 动作返回结构化报告且不把完整数据集回传", async () => {
  const response = await request("/api/actions/generate", {
    method: "POST",
    body: JSON.stringify({ confirm: true })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.caseCount, 2);
  assert.equal(body.data.dataset.cases, 2);
  assert.equal(body.data.outputPath, config.generatedPath);
});

test("证据端点返回解析投影，PDF 流支持完整与 Range 读取", async () => {
  const evidenceResponse = await request(
    `/api/evidence?path=${encodeURIComponent(pdfPath)}`
  );
  const evidence = await evidenceResponse.json();
  const bytes = readFileSync(join(config.corpusRoot, pdfPath));

  assert.equal(evidenceResponse.status, 200);
  assert.equal(evidence.data.filePath, pdfPath);
  assert.ok(evidence.data.blocks.some((block) => block.text.includes("Revenue 100")));

  const pdfResponse = await request(
    `/api/evidence/content?path=${encodeURIComponent(pdfPath)}`
  );
  assert.equal(pdfResponse.status, 200);
  assert.equal(pdfResponse.headers.get("content-type"), "application/pdf");
  assert.equal(pdfResponse.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(
    Buffer.from(await pdfResponse.arrayBuffer()),
    bytes
  );

  const rangeResponse = await request(
    `/api/evidence/content?path=${encodeURIComponent(pdfPath)}`,
    { headers: { range: "bytes=0-7" } }
  );
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get("content-range"), `bytes 0-7/${bytes.length}`);
  assert.deepEqual(Buffer.from(await rangeResponse.arrayBuffer()), bytes.subarray(0, 8));
});

test("PDF 流只允许 manifest 中的 corpus PDF，并拒绝越界和非法 Range", async () => {
  const traversal = await request(
    `/api/evidence/content?path=${encodeURIComponent("../outside/secret.pdf")}`
  );
  const outside = await request(
    `/api/evidence/content?path=${encodeURIComponent("outside/secret.pdf")}`
  );
  const unknown = await request(
    `/api/evidence/content?path=${encodeURIComponent("missing/report.pdf")}`
  );
  const invalidRange = await request(
    `/api/evidence/content?path=${encodeURIComponent(pdfPath)}`,
    { headers: { range: "bytes=999999-" } }
  );

  assertStructuredError(await traversal.json(), 400, "path_outside_root");
  assertStructuredError(await outside.json(), 404, "evidence_not_found");
  assertStructuredError(await unknown.json(), 404, "evidence_not_found");
  assert.equal(invalidRange.status, 416);
  assertStructuredError(await invalidRange.json(), 416, "range_not_satisfiable");
});

test("缺失草稿与损坏草稿通过同一错误信封映射 HTTP 状态", async () => {
  const missing = await request("/api/batches/missing/drafts/fin-D404");
  const corruptPath = join(
    config.draftRoot,
    "corrupt",
    "fin-D005.jsonl"
  );
  mkdirSync(join(config.draftRoot, "corrupt"), { recursive: true });
  writeFileSync(corruptPath, "{bad-json\n", "utf8");
  const corrupt = await request("/api/batches/corrupt/drafts/fin-D005");

  assert.equal(missing.status, 404);
  assertStructuredError(await missing.json(), 404, "draft_not_found");
  assert.equal(corrupt.status, 409);
  assertStructuredError(await corrupt.json(), 409, "draft_corrupt");
});

/**
 * 发起真实 HTTP 请求。
 *
 * @param {string} path API 路径。
 * @param {RequestInit} init 可选请求配置。
 * @returns {Promise<Response>} 原始响应。
 */
async function request(path, init = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
}

/**
 * 断言统一错误信封。
 *
 * @param {object} body 响应 JSON。
 * @param {number} status 预期 HTTP 状态。
 * @param {string} code 预期稳定错误码。
 */
function assertStructuredError(body, status, code) {
  assert.equal(body.ok, false);
  assert.equal(body.error.status, status);
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
  assert.equal(typeof body.error.details, "object");
}

/**
 * 通过核心读取草稿，独立确认 HTTP 往返落盘结果。
 *
 * @param {string} batch 批次名。
 * @param {string} id 草稿 ID。
 * @returns {Promise<object>} 核心读取的草稿。
 */
async function readDraftFromCore(batch, id) {
  const { readDraft } = await import("../src/core/drafts.ts");
  return readDraft(config, batch, id);
}

/**
 * 构造可通过 HTTP 保存边界的最小完整草稿。
 *
 * @param {string} id 草稿 ID。
 * @returns {object} 草稿。
 */
function makeDraft(id) {
  return {
    ...makeGoldenCase(),
    id,
    query: `Draft ${id}?`,
    _draft: {}
  };
}
