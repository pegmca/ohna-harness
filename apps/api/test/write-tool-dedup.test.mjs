import assert from "node:assert/strict";
import test from "node:test";
import z from "zod";
import { wrapWriteToolWithDedup } from "../dist/application/run-service.js";
import { createInMemoryToolResultStore } from "../dist/adapters/in-memory-run-runtime.js";

/**
 * 构造一个带副作用计数器的写类工具替身（模拟 generate_report 这类有副作用的工具）。
 * 每次真实 execute 都会让 counter.count+1，用于断言"重排是否重复执行副作用"。
 */
function makeWriteTool(counter, name = "generate_report") {
  return {
    name,
    description: "generate a report (test double)",
    label: "Report",
    parameters: z.object({ subject: z.string() }),
    async execute(_toolCallId, params) {
      counter.count += 1;
      return { content: [{ type: "text", text: `report:${params.subject}` }], details: {} };
    }
  };
}

test("at-least-once 重排复用已落库写类工具结果，不重复副作用（P1 修复核心证据）", async () => {
  const store = createInMemoryToolResultStore();
  const counter = { count: 0 };
  const wrapped = wrapWriteToolWithDedup(makeWriteTool(counter), "run-1", store, ["generate_report"]);

  // 首次执行（模拟正常 run）：模型生成的 toolCall.id 为 "tc-a"。
  const args = { subject: "宁德时代" };
  const first = await wrapped.execute("tc-a", args);
  assert.equal(counter.count, 1, "首次执行应触发真实副作用");
  assert.equal(first.content[0].text, "report:宁德时代");

  // 续跑恢复（at-least-once 重排）：模型重新生成非可复现的 toolCall.id "tc-b"，但参数完全一致。
  // 修复前以 toolCall.id 去重 → 查找必 miss → 再次执行 → 重复副作用。
  // 修复后以「工具名 + 参数哈希」确定性键去重 → 命中已落库结果 → 不重放。
  const second = await wrapped.execute("tc-b", args);
  assert.equal(counter.count, 1, "重排不应再次执行写类工具副作用");
  assert.equal(second.content[0].text, "report:宁德时代");

  // 不同参数应仍独立执行（去重键随参数变化，互不影响）。
  await wrapped.execute("tc-c", { subject: "比亚迪" });
  assert.equal(counter.count, 2, "不同参数应仍真实执行");
});

test("参数 key 顺序不同但语义相同 → 仍判定为同一去重键", async () => {
  const store = createInMemoryToolResultStore();
  const counter = { count: 0 };
  const wrapped = wrapWriteToolWithDedup(makeWriteTool(counter), "run-2", store, ["generate_report"]);
  await wrapped.execute("a", { subject: "X", topK: 5 });
  // 语义相同但 key 顺序不同：JSON 对对象 key 顺序敏感，确定性哈希须稳定。
  await wrapped.execute("b", { topK: 5, subject: "X" });
  assert.equal(counter.count, 1, "key 顺序不同的等价参数应复用同一去重键");
});

test("非写类工具不被去重包裹（原样返回）", async () => {
  const store = createInMemoryToolResultStore();
  const tool = makeWriteTool({ count: 0 }, "lookup"); // 不在 writeToolNames 中
  const wrapped = wrapWriteToolWithDedup(tool, "run-3", store, ["generate_report"]);
  assert.equal(wrapped, tool, "未命中 writeToolNames 的工具应原样返回，不被包裹");
});
