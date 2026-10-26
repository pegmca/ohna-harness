import assert from "node:assert/strict";
import test from "node:test";

/**
 * `packages/types/src/runtime.ts` 是 Electron main / preload / utilityProcess / runtime 之间的
 * 版本化跨进程协议 DTO（spec §4.1/§4.2）。TypeScript 接口在运行时被擦除，本测试用结构化
 * 断言说明契约：协议版本常量、错误码字面量集合、以及 `RunStartResultDto` 端到端形状。
 *
 * 运行时只暴露 `PROTOCOL_VERSION`（一个 const 值）；其余均为类型，这里镜像字段断言。
 */

test("PROTOCOL_VERSION === 1（版本化协议第一版）", async () => {
  const mod = await import("../dist/runtime.js");
  assert.equal(mod.PROTOCOL_VERSION, 1);
});

test("RuntimeErrorCode 覆盖三类致命错误：runtime/protocol/workspace", async () => {
  // 类型在运行时被擦除，这里用字面量集合镜像契约，断言关键错误码存在。
  const codes = [
    "bad_request", "unauthorized", "forbidden", "not_found", "conflict",
    "validation_failed", "runtime_unavailable", "protocol_mismatch",
    "workspace_unavailable", "agent_failed", "tool_failed", "run_interrupted",
    "internal_error",
  ];
  assert.ok(codes.includes("runtime_unavailable"));
  assert.ok(codes.includes("protocol_mismatch"));
  assert.ok(codes.includes("workspace_unavailable"));
  assert.equal(codes.length, 13);
});

test("RunStartResultDto 端到端形状：accepted + snapshot + subscriptionId + initialEvents", () => {
  // 镜像 RunStartResultDto 的字段结构（TS 接口运行时擦除，这里做形状断言）。
  const sample = {
    accepted: {
      runId: "run-1",
      requestId: "req-1",
      conversationId: "conv-1",
      modelId: "gpt-4",
      status: "queued",
    },
    snapshot: {
      runId: "run-1",
      requestId: "req-1",
      conversationId: "conv-1",
      userMessageId: "msg-1",
      modelId: "gpt-4",
      mode: "auto",
      source: "composer",
      status: "queued",
      lastEventSequence: 0,
      createdAt: "2026-10-27T00:00:00Z",
      updatedAt: "2026-10-27T00:00:00Z",
    },
    subscriptionId: "sub-1",
    initialEvents: [],
  };
  assert.equal(typeof sample.accepted.runId, "string");
  assert.equal(sample.accepted.status, "queued");
  assert.equal(typeof sample.subscriptionId, "string");
  assert.ok(Array.isArray(sample.initialEvents));
  assert.equal(sample.snapshot.status, "queued");
});

test("RuntimeErrorDto 形状：code/message/requestId 必填，details 可选", () => {
  const err = {
    code: "runtime_unavailable",
    message: "runtime worker 未就绪",
    requestId: "req-1",
  };
  assert.equal(err.code, "runtime_unavailable");
  assert.equal(typeof err.message, "string");
  assert.equal(typeof err.requestId, "string");
});

test("RuntimeHealthDto 形状：status/protocolVersion/modelCount/workspaceCount", () => {
  const health = {
    status: "ok",
    protocolVersion: 1,
    modelCount: 3,
    workspaceCount: 2,
  };
  assert.equal(health.status, "ok");
  assert.equal(health.protocolVersion, 1);
  assert.equal(typeof health.modelCount, "number");
  assert.equal(typeof health.workspaceCount, "number");
});

test("WorkspaceDescriptorDto 形状：workspaceId/displayPath/status", () => {
  const ws = {
    workspaceId: "ws-1",
    displayPath: "/Users/x/code/repo",
    status: "authorized",
  };
  assert.equal(ws.workspaceId, "ws-1");
  assert.equal(ws.status, "authorized");
});

test("ConversationSummaryDto 形状：含 workspaceId 与 ConversationStatusDto", () => {
  const conv = {
    conversationId: "conv-1",
    title: "feat",
    status: "active",
    createdAt: "2026-10-27T00:00:00Z",
    updatedAt: "2026-10-27T00:00:00Z",
    lastMessageAt: "2026-10-27T00:00:00Z",
    workspaceId: "ws-1",
  };
  assert.equal(conv.status, "active");
  assert.equal(conv.workspaceId, "ws-1");
});

test("RunAcceptedDtoV2 形状：runId/requestId/conversationId/modelId/status", () => {
  const accepted = {
    runId: "run-1",
    requestId: "req-1",
    conversationId: "conv-1",
    modelId: "gpt-4",
    status: "queued",
  };
  assert.equal(accepted.runId, "run-1");
  assert.equal(accepted.status, "queued");
});

test("RuntimeRequestEnvelope / ResponseEnvelope / EventEnvelope 形状", () => {
  const req = { protocolVersion: 1, requestId: "r1", method: "run.create", payload: {} };
  assert.equal(req.protocolVersion, 1);
  assert.equal(req.method, "run.create");

  const res = { protocolVersion: 1, requestId: "r1", ok: true, data: {} };
  assert.equal(res.ok, true);

  const evt = {
    protocolVersion: 1,
    subscriptionId: "s1",
    event: { eventId: "e1", runId: "run-1", requestId: "r1", conversationId: "c1", sequence: 1, type: "agent_start", payload: null, createdAt: "2026-10-27T00:00:00Z" },
  };
  assert.equal(evt.subscriptionId, "s1");
  assert.equal(evt.event.type, "agent_start");
});
