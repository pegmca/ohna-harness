import assert from "node:assert/strict";
import test from "node:test";

import { routeRuntimeRequest, toEventEnvelope } from "../dist/utility/routing.js";
import { PROTOCOL_VERSION } from "@aiagent/types";

/**
 * 路由层烟测（替代原 Task-1 `ping` 探活）：`routeRuntimeRequest` 是纯函数、无 Electron 依赖，
 * 可在 node 下直接断言「未知方法归一成 bad_request」「事件信封构造正确」。
 */
const noopRouter = {
  getHealth: async () => ({ status: "ok" }),
  getModelCatalog: async () => ({ models: [] }),
  shutdown: async () => undefined,
  registerWorkspace: async () => ({}),
  listWorkspaces: async () => [],
  releaseWorkspace: async () => undefined,
  startRun: async () => ({}),
  getRunSnapshot: async () => null,
  listRunsByConversation: async () => [],
  cancelRun: async () => null,
  resolveConfirmation: async () => ({}),
  createConversation: async () => ({}),
  listConversations: async () => [],
  updateConversation: async () => null,
  generateConversationTitle: async () => undefined,
  listMessages: async () => null,
};

test("routeRuntimeRequest 把未知方法归一成 bad_request", async () => {
  const res = await routeRuntimeRequest(noopRouter, {
    protocolVersion: PROTOCOL_VERSION,
    requestId: "s-1",
    method: "no.such",
    payload: {},
  });
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, "bad_request");
});

test("toEventEnvelope 构造带 subscriptionId 的事件信封", () => {
  const envelope = toEventEnvelope("sub-x", { kind: "agent_start" });
  assert.equal(envelope.protocolVersion, PROTOCOL_VERSION);
  assert.equal(envelope.subscriptionId, "sub-x");
  assert.deepEqual(envelope.event, { kind: "agent_start" });
});
