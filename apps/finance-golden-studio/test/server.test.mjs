/**
 * Finance Golden Studio 本地 HTTP API 契约测试。
 *
 * 服务在随机端口真实监听，所有读写都在隔离临时工作区与真实 PDF 上完成，
 * 覆盖路径边界、请求体限制、稳定错误信封、草稿往返、范围下载和确认动作。
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { createGoldenStudioServer } from "../src/server/http.ts";
import {
  cleanupWorkflowFixtures,
  makeGoldenCase,
  makeWorkflowConfig,
  writeAnchoredPdf,
  writeGolden,
  writeManifest,
  writePdf
} from "./workflow-fixtures.mjs";

let config;
const pdfPath = "600000.SH/annual/2025.pdf";
let studioServer;
let baseUrl;

beforeEach(async () => {
  await cleanup();
  config = makeWorkflowConfig();
  writeManifest(config, [
    {
      ticker: "600000.SH",
      report_type: "annual",
      period: "2025",
      file_path: pdfPath
    }
  ]);
  writeAnchoredPdf(config, pdfPath);
  writeGolden(config, [makeGoldenCase()]);
  mkdirSync(join(config.workspaceRoot, "outside"), { recursive: true });
  writeFileSync(join(config.workspaceRoot, "outside", "secret.pdf"), "%PDF-secret");

  studioServer = createGoldenStudioServer(config, { maxBodyBytes: 1024 });
  const address = await studioServer.listen(0, "127.0.0.1");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await cleanup();
});

test("GET /api/batches 返回经核心聚合的批次摘要", async () => {
  const fixtureDraft = makeDraft("fin-D001");
  await request("/api/batches/batch-a/drafts/fin-D001", {
    method: "PUT",
    body: JSON.stringify({ draft: fixtureDraft })
  });

  const response = await request("/api/batches");
  const body = await response.json();

  assertApiSuccess(response, body);
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

  assertApiSuccess(savedResponse, saved);
  assertApiSuccess(loadedResponse, loaded);
  assert.equal(loaded.data.id, "fin-D002");
  assert.equal(loaded.data.query, draft.query);
  assert.equal(loaded.data._draft.batch, "draft-roundtrip");
  assert.equal(Number.isNaN(Date.parse(loaded.data._draft.savedAt)), false);
  assert.equal(loaded.data._draft.filePath.endsWith("fin-D002.jsonl"), true);
  assert.deepEqual(await readDraftFromCore("draft-roundtrip", "fin-D002"), loaded.data);
});

test("草稿路由匹配 batches/:batch/drafts/:id 五个路径段", async () => {
  const response = await request("/api/batches/route-shape/drafts/fin-D016");

  assert.equal(response.status, 404);
  assertStructuredError(await response.json(), 404, "draft_not_found");
});

test("畸形草稿 PUT 在核心写入前被拒绝且原始字节不变", async () => {
  const originalDraft = makeDraft("fin-D013");
  const savedResponse = await request(
    "/api/batches/draft-overwrite/drafts/fin-D013",
    {
      method: "PUT",
      body: JSON.stringify({ draft: originalDraft })
    }
  );
  const saved = await savedResponse.json();
  assertApiSuccess(savedResponse, saved);
  const filePath = join(config.draftRoot, "draft-overwrite", "fin-D013.jsonl");
  const original = readFileSync(filePath, "utf8");

  const malformed = await request(
    "/api/batches/draft-overwrite/drafts/fin-D013",
    {
      method: "PUT",
      body: JSON.stringify({ draft: { id: "fin-D013" } })
    }
  );
  const body = await malformed.json();

  assert.equal(malformed.status, 409);
  assertStructuredError(body, 409, "draft_corrupt");
  assert.equal(body.error.details.field, "query");
  assert.equal(readFileSync(filePath, "utf8"), original);
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

test("promote 缺少确认时不写入 golden", async () => {
  const draft = {
    ...makeDraft("fin-D014"),
    _draft: { approved: true }
  };
  const saved = await request("/api/batches/unconfirmed/drafts/fin-D014", {
    method: "PUT",
    body: JSON.stringify({ draft })
  });
  assertApiSuccess(saved, await saved.json());
  const goldenBefore = readFileSync(config.goldenPath, "utf8");

  const response = await request("/api/actions/promote", {
    method: "POST",
    body: JSON.stringify({ batch: "unconfirmed" })
  });

  assert.equal(response.status, 400);
  assertStructuredError(await response.json(), 400, "confirmation_required");
  assert.equal(readFileSync(config.goldenPath, "utf8"), goldenBefore);
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

test("validate 动作返回带 action 与 result 的完整校验报告", async () => {
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

  assertApiSuccess(response, body);
  assert.equal(body.data.action, "validate");
  assert.equal(body.data.result.batch, "validate-actions");
  assert.equal(body.data.result.validation.ok, true);
  assert.ok(Array.isArray(body.data.result.validation.keywordResults));
});

test("validate 动作支持当前草稿范围且不返回其他草稿的问题", async () => {
  await request("/api/batches/scoped-actions/drafts/fin-D017", {
    method: "PUT",
    body: JSON.stringify({ draft: makeDraft("fin-D017") })
  });
  await request("/api/batches/scoped-actions/drafts/fin-D018", {
    method: "PUT",
    body: JSON.stringify({
      draft: { ...makeDraft("fin-D018"), expected_keywords: [] }
    })
  });

  const response = await request("/api/actions/validate", {
    method: "POST",
    body: JSON.stringify({
      confirm: true,
      scope: "draft",
      batch: "scoped-actions",
      id: "fin-D017"
    })
  });
  const body = await response.json();

  assertApiSuccess(response, body);
  assert.equal(body.data.action, "validate");
  assert.equal(body.data.result.batch, "scoped-actions");
  assert.equal(body.data.result.id, "fin-D017");
  assert.equal(body.data.result.validation.ok, true);
  assert.deepEqual(body.data.result.validation.errors, []);
});

test("promote 动作经确认后只发布核心判定可发布的草稿", async () => {
  const approvedDraft = {
    ...makeDraft("fin-D004"),
    _draft: { approved: true }
  };
  const saved = await request("/api/batches/promote-actions/drafts/fin-D004", {
    method: "PUT",
    body: JSON.stringify({ draft: approvedDraft })
  });
  assertApiSuccess(saved, await saved.json());

  const response = await request("/api/actions/promote", {
    method: "POST",
    body: JSON.stringify({ confirm: true, batch: "promote-actions" })
  });
  const body = await response.json();

  assertApiSuccess(response, body);
  assert.equal(body.data.action, "promote");
  assert.equal(body.data.result.promotedCount, 1);
  assert.equal(body.data.result.promoted[0].draftId, "fin-D004");
  assert.equal(readFileSync(config.goldenPath, "utf8").includes('"_draft"'), false);
});

test("重复 promote 同一请求不追加新 ID 或备份", async () => {
  const draft = {
    ...makeDraft("fin-D015"),
    _draft: { approved: true }
  };
  const saved = await request("/api/batches/promote-retry/drafts/fin-D015", {
    method: "PUT",
    body: JSON.stringify({ draft })
  });
  assertApiSuccess(saved, await saved.json());

  const firstResponse = await request("/api/actions/promote", {
    method: "POST",
    body: JSON.stringify({ confirm: true, batch: "promote-retry" })
  });
  const first = await firstResponse.json();
  assertApiSuccess(firstResponse, first);
  const goldenAfterFirst = readFileSync(config.goldenPath, "utf8");
  const backupsAfterFirst = readdirSync(config.backupRoot).length;

  const retryResponse = await request("/api/actions/promote", {
    method: "POST",
    body: JSON.stringify({ confirm: true, batch: "promote-retry" })
  });
  const retry = await retryResponse.json();

  assertApiSuccess(retryResponse, retry);
  assert.equal(retry.data.action, "promote");
  assert.equal(retry.data.result.promotedCount, 0);
  assert.deepEqual(retry.data.result.promoted, [
    { draftId: "fin-D015", goldenId: first.data.result.promoted[0].goldenId }
  ]);
  assert.equal(readFileSync(config.goldenPath, "utf8"), goldenAfterFirst);
  assert.equal(readdirSync(config.backupRoot).length, backupsAfterFirst);
});

test("generate 动作返回结构化报告且不把完整数据集回传", async () => {
  const generatedDraft = {
    ...makeDraft("fin-D017"),
    _draft: { approved: true }
  };
  const saved = await request("/api/batches/generate-actions/drafts/fin-D017", {
    method: "PUT",
    body: JSON.stringify({ draft: generatedDraft })
  });
  assertApiSuccess(saved, await saved.json());
  const promotedResponse = await request("/api/actions/promote", {
    method: "POST",
    body: JSON.stringify({ confirm: true, batch: "generate-actions" })
  });
  const promoted = await promotedResponse.json();
  assertApiSuccess(promotedResponse, promoted);
  assert.equal(promoted.data.action, "promote");
  assert.equal(promoted.data.result.promotedCount, 1);

  const response = await request("/api/actions/generate", {
    method: "POST",
    body: JSON.stringify({ confirm: true })
  });
  const body = await response.json();

  assertApiSuccess(response, body);
  assert.equal(body.data.action, "generate");
  assert.equal(body.data.result.caseCount, 2);
  assert.equal(body.data.result.dataset.cases, 2);
  assert.equal(body.data.result.outputPath, config.generatedPath);
});

test("golden 与 settings GET 只返回当前工作区的真实状态和只读路径", async () => {
  const goldenResponse = await request("/api/golden");
  const settingsResponse = await request("/api/settings");
  const golden = await goldenResponse.json();
  const settings = await settingsResponse.json();

  assertApiSuccess(goldenResponse, golden);
  assert.equal(golden.data.authored.path, config.goldenPath);
  assert.equal(golden.data.authored.caseCount, 1);
  assert.equal(golden.data.authored.validation.ok, true);
  assert.deepEqual(golden.data.generated, {
    path: config.generatedPath,
    exists: false,
    freshness: "missing"
  });

  assertApiSuccess(settingsResponse, settings);
  assert.deepEqual(settings.data, {
    workspaceRoot: config.workspaceRoot,
    corpusRoot: config.corpusRoot,
    manifestPath: config.manifestPath,
    goldenPath: config.goldenPath,
    generatedPath: config.generatedPath
  });
});

test("golden GET 对损坏的生成物明确报错而不伪装为未生成", async () => {
  mkdirSync(join(config.workspaceRoot, "datasets", "finance"), { recursive: true });
  writeFileSync(config.generatedPath, '{"cases":', "utf8");

  const response = await request("/api/golden");

  assert.equal(response.status, 409);
  assertStructuredError(await response.json(), 409, "invalid_request");
});

test("golden GET 以源文件与生成物的真实修改时间区分 fresh 与 stale", async () => {
  mkdirSync(join(config.workspaceRoot, "datasets", "finance"), { recursive: true });
  writeFileSync(
    config.generatedPath,
    JSON.stringify({
      datasetVersion: "finance-rag-golden-v1.0.0",
      cases: [{ id: "fin-001" }]
    }),
    "utf8"
  );
  const current = new Date(statSync(config.goldenPath).mtimeMs);
  utimesSync(config.goldenPath, current, current);

  utimesSync(config.generatedPath, current, current);
  const equalResponse = await request("/api/golden");
  const equalBody = await equalResponse.json();
  assertApiSuccess(equalResponse, equalBody);
  assert.equal(equalBody.data.generated.freshness, "fresh");
  assert.equal(
    Number.isNaN(Date.parse(equalBody.data.generated.sourceModifiedAt)),
    false
  );

  const older = new Date(current.getTime() - 60_000);
  utimesSync(config.generatedPath, older, older);
  const staleResponse = await request("/api/golden");
  const staleBody = await staleResponse.json();
  assertApiSuccess(staleResponse, staleBody);
  assert.equal(staleBody.data.generated.freshness, "stale");

  const newer = new Date(current.getTime() + 60_000);
  utimesSync(config.generatedPath, newer, newer);
  const newerResponse = await request("/api/golden");
  const newerBody = await newerResponse.json();
  assertApiSuccess(newerResponse, newerBody);
  assert.equal(newerBody.data.generated.freshness, "fresh");
});

test("mine 动作要求候选数组并在确认后写入真实草稿批次", async () => {
  const missingCandidates = await request("/api/actions/mine", {
    method: "POST",
    body: JSON.stringify({ confirm: true, batch: "mined-batch" })
  });
  assert.equal(missingCandidates.status, 400);
  assertStructuredError(
    await missingCandidates.json(),
    400,
    "invalid_request"
  );

  const response = await request("/api/actions/mine", {
    method: "POST",
    body: JSON.stringify({
      confirm: true,
      batch: "mined-batch",
      candidates: [
        {
          ticker: "600000.SH",
          report_type: "annual",
          period: "2025",
          type: "numeric_fact"
        }
      ]
    })
  });
  const body = await response.json();

  assertApiSuccess(response, body);
  assert.equal(body.data.action, "mine");
  assert.equal(body.data.result.batch, "mined-batch");
  assert.equal(body.data.result.draftedCount, 1);
  const batchResponse = await request("/api/batches/mined-batch/drafts");
  const batch = await batchResponse.json();
  assertApiSuccess(batchResponse, batch);
  assert.equal(batch.data[0].id, "fin-D001");
});

test("证据端点返回解析投影，PDF 流支持完整与 Range 读取", async () => {
  const evidenceResponse = await request(
    `/api/evidence?path=${encodeURIComponent(pdfPath)}`
  );
  const evidence = await evidenceResponse.json();
  const bytes = readFileSync(join(config.corpusRoot, pdfPath));

  assertApiSuccess(evidenceResponse, evidence);
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
      connection: "close",
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
 * 同时断言 HTTP 成功状态与业务信封成功。
 *
 * @param {Response} response 原始响应。
 * @param {object} body 已解析响应体。
 */
function assertApiSuccess(response, body) {
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
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

/**
 * 关闭当前测试服务并清理其工作区。
 *
 * @returns {Promise<void>} 清理完成。
 */
async function cleanup() {
  await studioServer?.close().catch(() => undefined);
  studioServer = undefined;
  cleanupWorkflowFixtures();
  if (config) {
    rmSync(join(config.workspaceRoot, "outside"), { recursive: true, force: true });
  }
  config = undefined;
  baseUrl = undefined;
}
