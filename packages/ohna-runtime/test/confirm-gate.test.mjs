import assert from "node:assert/strict";
import test from "node:test";
import { createAsyncConfirmGate } from "../dist/confirm-gate.js";

/** 构造可自动批准 write 的权限 context，供真实 PermissionGate 走 ask 分支。 */
function writeContext() {
  return {
    assistantMessage: {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-timeout",
        name: "write",
        arguments: { path: "timeout.md", content: "x" }
      }],
      api: "openai-completions",
      provider: "mock",
      model: "mock",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "toolUse",
      timestamp: Date.now()
    },
    toolCall: {
      id: "call-timeout",
      name: "write",
      arguments: { path: "timeout.md", content: "x" }
    },
    args: { path: "timeout.md", content: "x" },
    context: {
      systemPrompt: "",
      messages: [],
      tools: [{
        name: "write",
        description: "write file",
        effect: "mutate",
        parameters: { type: "object" },
        execute: async () => ({ content: [] })
      }]
    }
  };
}

test("确认超时会自动拒绝并清空 pending，后续提交返回 conflict", async () => {
  const emitted = [];
  const gate = createAsyncConfirmGate({
    autoApprove: false,
    timeoutMs: 10,
    emit: (_runId, payload) => emitted.push(payload)
  });
  const result = await gate.createHook("run-timeout")(writeContext());

  assert.equal(result.block, true);
  assert.match(result.reason ?? "", /确认超时/);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].toolCallId, "call-timeout");
  assert.equal(gate.pendingCount("run-timeout"), 0);
  assert.deepEqual(gate.resolve("run-timeout", "call-timeout", "allow"), {
    ok: false,
    code: "conflict",
    message: "该工具调用已完成确认，无法重复提交。"
  });
});
