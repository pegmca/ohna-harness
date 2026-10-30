import assert from "node:assert/strict";
import test from "node:test";

import { routeRuntimeRequest } from "../dist/utility/routing.js";
import { PROTOCOL_VERSION } from "@aiagent/types";

/**
 * 断言 IPC 边界把对象 payload 解包成 runtime 期望的字符串/查询对象。
 *
 * preload 发送 `{ conversationId }` 等包装对象；若 routing 直接把整个 payload 当 ID，
 * runtime 会收到 `[object Object]`，会话反查永远找不到工作区。
 */

function capture(overrides = {}) {
  const calls = [];
  const runtime = {
    getHealth: async () => ({}),
    getModelCatalog: async () => ({}),
    shutdown: async () => undefined,
    registerWorkspace: async () => ({}),
    listWorkspaces: async () => [],
    releaseWorkspace: async () => undefined,
    startRun: async () => ({}),
    getRunSnapshot: async (runId) => {
      calls.push(["getRunSnapshot", runId]);
      return null;
    },
    listRunsByConversation: async (conversationId) => {
      calls.push(["listRunsByConversation", conversationId]);
      return [];
    },
    cancelRun: async (runId) => {
      calls.push(["cancelRun", runId]);
      return null;
    },
    resolveConfirmation: async () => ({}),
    createConversation: async () => ({}),
    listConversations: async (query) => {
      calls.push(["listConversations", query]);
      return [];
    },
    updateConversation: async () => null,
    generateConversationTitle: async () => undefined,
    listMessages: async () => null,
    ...overrides,
  };
  return { runtime, calls };
}

function request(method, payload) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: `req-${method}`,
    method,
    payload,
  };
}

test("runs.list 把 { conversationId } 解包为字符串会话 ID", async () => {
  const { runtime, calls } = capture();
  const response = await routeRuntimeRequest(runtime, request("runs.list", { conversationId: "conv-1" }));

  assert.equal(response.ok, true);
  assert.deepEqual(calls, [["listRunsByConversation", "conv-1"]]);
});

test("runs.snapshot / runs.cancel 把 { runId } 解包为字符串 run ID", async () => {
  const { runtime, calls } = capture();

  await routeRuntimeRequest(runtime, request("runs.snapshot", { runId: "run-1" }));
  await routeRuntimeRequest(runtime, request("runs.cancel", { runId: "run-2" }));

  assert.deepEqual(calls, [
    ["getRunSnapshot", "run-1"],
    ["cancelRun", "run-2"],
  ]);
});

test("runs.list 对非字符串会话 ID 返回结构化 bad_request 且不触达 runtime", async () => {
  const { runtime, calls } = capture();
  const response = await routeRuntimeRequest(runtime, request("runs.list", { conversationId: { bad: true } }));

  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "bad_request");
  assert.deepEqual(calls, []);
});

test("conversations.list 解包 { query } 而不是把包装对象整体透传", async () => {
  const { runtime, calls } = capture();

  await routeRuntimeRequest(runtime, request("conversations.list", { query: { workspaceId: "ws-1" } }));
  await routeRuntimeRequest(runtime, request("conversations.list", {}));

  assert.deepEqual(calls, [
    ["listConversations", { workspaceId: "ws-1" }],
    ["listConversations", undefined],
  ]);
});
