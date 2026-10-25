/**
 * C1a 语义条目归约器单测：AgentEvent 序列 → TuiEntry 断言。
 *
 * 覆盖（v1.4 计划 Phase C1 交付项 11 / C6）：
 * - 流式 text_delta 只 patch 同一条 assistant 条目，不重复建条目；
 * - thinking_start / thinking_delta 维护 reasoning 条目并累积原文；
 * - tool_execution_start/end 的 running → done / error 状态迁移与结果回填；
 * - message_end stopReason=error → status=error + errorMessage；
 * - agent_end 产出 usage notice（数字骨架保持纯文本）与 run 生命周期变更顺序；
 * - id 稳定唯一、reset() 清空。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createUsageTracker } from "../dist/session/usage.js";
import { StreamReducer } from "../dist/ui/stream/reducer.js";

/** assistant 消息的公共 usage 形状。 */
function usage() {
  return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** 构造 assistant message_start 事件。 */
function messageStart() {
  return { type: "message_start", message: { role: "assistant", content: [] } };
}

/** 构造文本增量事件。 */
function textDelta(delta) {
  return { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta } };
}

/** 构造 thinking_start 事件。 */
function thinkingStart() {
  return { type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_start" } };
}

/** 构造 thinking_delta 事件。 */
function thinkingDelta(delta) {
  return { type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", delta } };
}

/**
 * v2.0 边界事件身份（docs/v2.0/04 §1.3）：agent_start / agent_end / turn_start / turn_end
 * 一律携带身份字段，归约器不得因为「多出字段」改变行为。
 *
 * @param patch 覆盖字段。
 * @returns 根身份。
 */
function identity(patch = {}) {
  return { agentId: "supervisor", label: "supervisor", role: "supervisor", modelId: "stub-model", ...patch };
}

/** 构造带身份的 agent_start 事件。 */
function agentStart(patch = {}) {
  return { type: "agent_start", ...identity(patch) };
}

/** 构造带身份的 agent_end 事件。 */
function agentEnd(patch = {}) {
  return { type: "agent_end", agentId: "supervisor", messages: [], ...patch };
}

/** 构造 assistant message_end 事件。 */
function messageEnd(stopReason = "stop") {
  return {
    type: "message_end",
    message: { role: "assistant", content: [], usage: usage(), stopReason, ...(stopReason === "error" ? { errorMessage: "provider 503" } : {}) },
  };
}

/**
 * 用事件序列驱动归约器并收集变更。
 *
 * @param events AgentEvent 序列。
 * @returns 归约器、用量累计器与变更列表。
 */
function run(events) {
  const changes = [];
  const tracker = createUsageTracker();
  const reducer = new StreamReducer({ onChange: (change) => changes.push(change) });
  for (const event of events) reducer.apply(event, tracker);
  return { reducer, tracker, changes };
}

test("text_delta 只 patch 当前 assistant 条目，不新建条目", () => {
  const { reducer, changes } = run([messageStart(), textDelta("你好"), textDelta("，世界")]);
  const entries = reducer.entries();
  assert.equal(entries.length, 1, "两个 delta 应只有一条 assistant 条目");
  assert.equal(entries[0].kind, "assistant");
  assert.equal(entries[0].status, "streaming");
  assert.equal(entries[0].text, "你好，世界", "text 应累积全部增量");

  const patches = changes.filter((change) => change.type === "entry-patched");
  assert.equal(patches.length, 2);
  assert.deepEqual(
    patches.map((change) => change.textDelta),
    ["你好", "，世界"],
    "每个补丁应携带对应增量，供打印 presenter 逐段输出",
  );
  assert.ok(patches.every((change) => change.entry.id === entries[0].id), "补丁必须命中同一 id");
});

test("thinking_start / thinking_delta 维护 reasoning 条目并累积原文", () => {
  const { reducer } = run([messageStart(), thinkingStart(), thinkingDelta("先想"), thinkingDelta("再想")]);
  const reasoning = reducer.entries().find((entry) => entry.kind === "reasoning");
  assert.ok(reasoning, "应产出 reasoning 条目");
  assert.equal(reasoning.status, "streaming");
  assert.equal(reasoning.text, "先想再想");
  assert.equal(reducer.entries().filter((entry) => entry.kind === "reasoning").length, 1, "同一段思考不重复建条目");
});

test("reasoning 在首个 text_delta（正文开始）时收尾为 done，只 patch 同一条目", () => {
  const { reducer, changes } = run([messageStart(), thinkingStart(), thinkingDelta("想想"), textDelta("正文")]);
  const reasonings = reducer.entries().filter((entry) => entry.kind === "reasoning");
  assert.equal(reasonings.length, 1, "收尾不得新建 reasoning 条目");
  assert.equal(reasonings[0].status, "done", "正文开始即思考结束");

  const patches = changes.filter(
    (change) => change.type === "entry-patched" && change.entry.kind === "reasoning" && change.textDelta === undefined,
  );
  assert.equal(patches.length, 1, "应恰好广播一次终态补丁（无 textDelta）");
  assert.equal(patches[0].entry.id, reasonings[0].id, "补丁命中同一条目");
});

test("reasoning 在 tool_execution_start（被工具调用打断）时收尾为 done", () => {
  const { reducer } = run([
    messageStart(),
    thinkingStart(),
    thinkingDelta("想想"),
    { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} },
  ]);
  assert.equal(reducer.entries().find((entry) => entry.kind === "reasoning").status, "done");
});

test("reasoning 在 message_end 兜底收尾为 done（纯思考消息）", () => {
  const { reducer } = run([messageStart(), thinkingStart(), thinkingDelta("想想"), messageEnd()]);
  assert.equal(reducer.entries().find((entry) => entry.kind === "reasoning").status, "done");
});

test("reasoning 在 agent_end 兜底收尾为 done（异常事件序）", () => {
  const { reducer } = run([messageStart(), thinkingStart(), thinkingDelta("想想"), agentEnd()]);
  assert.equal(reducer.entries().find((entry) => entry.kind === "reasoning").status, "done");
});

test("连续 thinking_start 各自成段：新段开启前旧段先收尾", () => {
  const { reducer } = run([
    messageStart(),
    thinkingStart(),
    thinkingDelta("第一段"),
    thinkingStart(),
    thinkingDelta("第二段"),
  ]);
  const reasonings = reducer.entries().filter((entry) => entry.kind === "reasoning");
  assert.equal(reasonings.length, 2, "两段思考应是两条独立条目");
  assert.equal(reasonings[0].status, "done", "旧段在新段开启前收尾");
  assert.equal(reasonings[0].text, "第一段");
  assert.equal(reasonings[1].status, "streaming", "新段仍在流式");
});

test("tool_execution_start → end：running → done 并回填结果", () => {
  const { reducer } = run([
    { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false },
  ]);
  const tool = reducer.entries().find((entry) => entry.kind === "tool");
  assert.ok(tool);
  assert.equal(tool.status, "done");
  assert.equal(tool.meta.toolCallId, "t1");
  assert.equal(tool.meta.toolName, "bash");
  assert.deepEqual(tool.meta.args, { command: "ls" });
  assert.deepEqual(tool.meta.result, { content: [{ type: "text", text: "ok" }] });
  assert.equal(tool.meta.isError, false);
});

test("tool_execution_end(isError) → status=error", () => {
  const { reducer } = run([
    { type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: {} },
    { type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: "boom", isError: true },
  ]);
  const tool = reducer.entries().find((entry) => entry.kind === "tool");
  assert.equal(tool.status, "error");
  assert.equal(tool.meta.isError, true);
  assert.equal(tool.meta.result, "boom");
});

test("未见 start 的 tool_execution_end 也落一个终态条目（兜底不丢结果）", () => {
  const { reducer } = run([{ type: "tool_execution_end", toolCallId: "t3", toolName: "bash", result: "only-end", isError: false }]);
  assert.equal(reducer.entries().length, 1);
  assert.equal(reducer.entries()[0].status, "done");
  assert.equal(reducer.entries()[0].meta.result, "only-end");
});

test("message_end stopReason=error → assistant status=error 且保存 errorMessage", () => {
  const { reducer } = run([messageStart(), textDelta("片段"), messageEnd("error")]);
  const assistant = reducer.entries().find((entry) => entry.kind === "assistant");
  assert.equal(assistant.status, "error");
  assert.equal(assistant.meta.stopReason, "error");
  assert.equal(assistant.meta.errorMessage, "provider 503");
});

test("agent_end：先 run-end，再产出 usage notice（纯文本数字骨架）", () => {
  const { reducer, changes } = run([messageStart(), textDelta("hi"), messageEnd(), agentEnd()]);
  const notices = reducer.entries().filter((entry) => entry.kind === "notice");
  assert.equal(notices.length, 1, "有 usage 时应产出一条 notice");
  assert.match(notices[0].text, /累计 token: 2/);

  const runEndIndex = changes.findIndex((change) => change.type === "run-end");
  const noticeIndex = changes.findIndex((change) => change.type === "entry-added" && change.entry.kind === "notice");
  assert.ok(runEndIndex >= 0, "应有 run-end 变更");
  assert.ok(noticeIndex > runEndIndex, "usage notice 必须在 run-end（停帧）之后");
});

test("agent_end.error → 产出 error 条目（code + message）", () => {
  const { reducer } = run([agentEnd({ error: { code: "agent_loop_aborted", message: "已中断" } })]);
  const error = reducer.entries().find((entry) => entry.kind === "error");
  assert.ok(error);
  assert.equal(error.status, "error");
  assert.equal(error.meta.code, "agent_loop_aborted");
  assert.equal(error.meta.errorMessage, "已中断");
});

test("条目 id 稳定唯一，reset() 清空全部状态", () => {
  const { reducer } = run([
    messageStart(),
    textDelta("a"),
    { type: "tool_execution_start", toolCallId: "t4", toolName: "read", args: {} },
  ]);
  const ids = reducer.entries().map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "id 必须唯一");
  assert.deepEqual(ids, ["assistant-0", "tool-1"], "id 采用 `${kind}-${序号}` 稳定格式");

  reducer.reset();
  assert.equal(reducer.entries().length, 0);
});

test("reset() 后 id 序号继续递增，不复用（M2：避免旧会话 expanded key 命中）", () => {
  const reducer = new StreamReducer();
  const first = reducer.appendNotice("第一条");
  assert.equal(first.id, "notice-0");

  reducer.reset();
  const afterReset = reducer.appendNotice("第二条");
  assert.notEqual(afterReset.id, first.id, "reset 后新条目 id 不得与旧会话复用");
  assert.equal(afterReset.id, "notice-1", "序号单调递增、不归零");
});

test("appendUser：产出 user 语义条目（M3）", () => {
  const reducer = new StreamReducer();
  const entry = reducer.appendUser("你好");
  assert.equal(entry.kind, "user");
  assert.equal(entry.status, "done");
  assert.equal(entry.text, "你好");
  assert.equal(reducer.entries()[0], entry);
});

test("v2.0 身份事件：带 agentId/turnIndex 的边界事件不改变归约行为", () => {
  // 同一个 run 里出现 supervisor 与子代理两种身份的边界事件（子代理事件经
  // TeamControllerOptions.onSubagentEvent 透传到同一总线后形态完全相同）。
  const { reducer, changes } = run([
    agentStart(),
    { type: "turn_start", agentId: "supervisor", turnIndex: 0 },
    messageStart(),
    textDelta("主线回复"),
    messageEnd(),
    { type: "turn_end", agentId: "supervisor", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] },
    // 子代理的边界事件：CLI 终端不单列（只有 llm_call 以 notice 形态展示），不得产生额外条目。
    agentStart({ agentId: "analyst", parentId: "supervisor", label: "analyst", role: "研究员" }),
    { type: "turn_start", agentId: "analyst", turnIndex: 0 },
    { type: "turn_end", agentId: "analyst", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] },
    agentEnd({ agentId: "analyst" }),
    agentEnd(),
  ]);

  const entries = reducer.entries();
  // 当前 presenter 语义：每次 agent_end 都产出一条 usage notice（子代理的边界事件同样触发），
  // 身份字段与 turn_* 本身不产生条目——这是既有行为，本用例锁「不因新增身份字段而改变」。
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["assistant", "notice", "notice"],
  );
  assert.equal(entries[0].text, "主线回复");
  // run-start / run-end 各一次（子代理的 agent_start 也会触发，但那是 presenter 语义，不是条目）。
  assert.equal(changes.filter((change) => change.type === "run-start").length, 2);
  assert.equal(changes.filter((change) => change.type === "run-end").length, 2);
});
