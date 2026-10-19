/**
 * serve 异步确认闸门单测（K1 改造后的公共契约）。
 *
 * 重点验证：改造为 createPermissionGate + 预设后，AsyncConfirmGate 的对外行为不变
 * ——只读不确认、mutate 产生事件、resolve 的 404/409 语义、超时原因与 autoApprove。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createAsyncConfirmGate } from "../dist/index.js";

/** 工具表：read 只读，write 有副作用。 */
const TOOLS = [
  { name: "read", effect: "read" },
  { name: "write", effect: "mutate" }
];

/**
 * 构造 beforeToolCall 的最小上下文。
 *
 * @param {string} name 工具名。
 * @param {object} args 参数。
 * @param {string} id toolCall id。
 * @returns {object} 上下文。
 */
function contextOf(name, args, id = "call-1") {
  return {
    assistantMessage: { role: "assistant", content: [], timestamp: 0 },
    toolCall: { type: "toolCall", id, name, arguments: args },
    args,
    context: { systemPrompt: "", messages: [], tools: TOOLS }
  };
}

test("只读工具直接放行，不产生确认事件", async () => {
  const emitted = [];
  const gate = createAsyncConfirmGate({ autoApprove: false, emit: (_runId, payload) => emitted.push(payload) });
  const result = await gate.createHook("run-read")(contextOf("read", { path: "a.txt" }));
  assert.equal(result, undefined);
  assert.equal(emitted.length, 0);
  assert.equal(gate.pendingCount("run-read"), 0);
});

test("mutate 工具挂起等待 resolve：allow 放行，重复提交返回 conflict", async () => {
  const emitted = [];
  const gate = createAsyncConfirmGate({ autoApprove: false, emit: (_runId, payload) => emitted.push(payload) });
  const pending = gate.createHook("run-1")(contextOf("write", { path: "a.txt" }));

  // 等 emit 的微任务完成，确保 pending 已登记、事件已发出。
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].toolName, "write");
  assert.match(emitted[0].summary, /写文件/);
  assert.equal(gate.pendingCount("run-1"), 1);

  assert.deepEqual(gate.resolve("run-1", "call-1", "allow"), { ok: true });
  assert.equal(await pending, undefined);
  assert.equal(gate.pendingCount("run-1"), 0);

  const again = gate.resolve("run-1", "call-1", "allow");
  assert.equal(again.ok, false);
  assert.equal(again.code, "conflict");
});

test("未知 toolCallId 返回 not_found", () => {
  const gate = createAsyncConfirmGate({ autoApprove: false, emit: () => {} });
  const result = gate.resolve("run-x", "missing", "allow");
  assert.equal(result.ok, false);
  assert.equal(result.code, "not_found");
});

test("超时自动 deny，且保留「超时」原因文案", async () => {
  const gate = createAsyncConfirmGate({
    autoApprove: false,
    timeoutMs: 20,
    emit: () => {}
  });
  const result = await gate.createHook("run-timeout")(contextOf("write", { path: "a.txt" }));
  assert.equal(result?.block, true);
  assert.match(result.reason, /超时/);
});

test("autoApprove（bypass）不产生事件，resolve 返回 auto_approve", async () => {
  const emitted = [];
  const gate = createAsyncConfirmGate({ autoApprove: true, emit: (_runId, payload) => emitted.push(payload) });
  const result = await gate.createHook("run-auto")(contextOf("write", { path: "a.txt" }));
  assert.equal(result, undefined);
  assert.equal(emitted.length, 0);

  const resolved = gate.resolve("run-auto", "call-1", "allow");
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "auto_approve");
});
