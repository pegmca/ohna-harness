/**
 * C1b 分类器单测：`entryPath` 三档差异、相邻同 kind 合并、activitySummary 计数、busyLabel。
 *
 * 覆盖 v1.4 计划 Phase C1 交付项 11 的 classifier 部分：
 * - 相邻合并（read ×2 合并成组、bash 打断后开新组）；
 * - summary 计数（command / edit / thought / read）只计已完成条目；
 * - low / medium / high 分类差异（low 全部 activity、medium/high 三类）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPLORATION_TOOLS,
  activitySummary,
  busyLabel,
  entryGroupKind,
  entryPath,
} from "../dist/ui/tui/classifier.js";
import { groupEntries } from "../dist/ui/tui/grouping.js";
import { mergeGroups, splitGroups } from "../dist/ui/tui/grouping.js";

/**
 * 构造一条语义条目。
 *
 * @param kind 条目类别。
 * @param overrides 覆盖字段（status / text / meta）。
 * @returns TuiEntry。
 */
function entry(kind, overrides = {}) {
  return { id: `${kind}-0`, kind, status: "done", text: "", ...overrides };
}

/**
 * 构造一条工具条目。
 *
 * @param toolName 工具名。
 * @param overrides 覆盖字段。
 * @returns TuiEntry。
 */
function tool(toolName, overrides = {}) {
  return entry("tool", { meta: { toolName, args: {} }, ...overrides });
}

test("entryGroupKind：read/grep/find/ls 为 exploration，bash/write/edit 为 activity", () => {
  for (const name of ["read", "grep", "find", "ls"]) {
    assert.equal(entryGroupKind(tool(name)), "exploration", `${name} 应为 exploration`);
    assert.ok(EXPLORATION_TOOLS.has(name));
  }
  for (const name of ["bash", "write", "edit"]) {
    assert.equal(entryGroupKind(tool(name)), "activity", `${name} 应为 activity`);
  }
  assert.equal(entryGroupKind(tool("unknown-tool")), "activity", "未知工具保守归入 activity");
  assert.equal(entryGroupKind(entry("assistant")), undefined, "文本条目独立成行");
  assert.equal(entryGroupKind(entry("reasoning")), "reasoning");
});

test("entryPath：low 把所有非文本条目统一折进 activity，文本条目独立", () => {
  assert.deepEqual(entryPath(entry("reasoning"), "low"), ["activity"]);
  assert.deepEqual(entryPath(tool("read"), "low"), ["activity"]);
  assert.deepEqual(entryPath(tool("bash"), "low"), ["activity"]);
  assert.deepEqual(entryPath(entry("assistant"), "low"), []);
  assert.deepEqual(entryPath(entry("notice"), "medium"), []);
});

test("entryPath：medium / high 走三分类（reasoning / exploration / activity）", () => {
  for (const verbosity of ["medium", "high"]) {
    assert.deepEqual(entryPath(entry("reasoning"), verbosity), ["reasoning"]);
    assert.deepEqual(entryPath(tool("read"), verbosity), ["exploration"]);
    assert.deepEqual(entryPath(tool("grep"), verbosity), ["exploration"]);
    assert.deepEqual(entryPath(tool("bash"), verbosity), ["activity"]);
  }
});

test("相邻合并：连续 read 合并成组，bash 打断后开启新组", () => {
  const entries = [tool("read"), tool("read"), tool("bash"), tool("read")];
  const tree = groupEntries(entries, (e) => entryPath(e, "medium"));
  assert.equal(tree.length, 3);
  assert.equal(tree[0].type, "group");
  assert.equal(tree[0].kind, "exploration");
  assert.equal(tree[0].size, 2, "两个相邻 read 合并，size 为叶子数");
  assert.equal(tree[1].kind, "activity");
  assert.equal(tree[2].kind, "exploration", "bash 打断后 read 另起新组");
  assert.equal(tree[2].size, 1);
});

test("相邻合并：low 档连续工具 + 思考折叠为一个 activity 组", () => {
  const entries = [tool("read"), tool("bash"), entry("reasoning", { text: "想一下" })];
  const tree = groupEntries(entries, (e) => entryPath(e, "low"));
  assert.equal(tree.length, 1);
  assert.equal(tree[0].type, "group");
  assert.equal(tree[0].kind, "activity");
  assert.equal(tree[0].size, 3);
});

test("activitySummary：只计已完成条目，运行中走 busyLabel", () => {
  const finished = [
    tool("bash"),
    tool("edit"),
    tool("read"),
    entry("reasoning", { text: "先分析" }),
  ];
  const running = tool("bash", { status: "running" });
  const summary = activitySummary([...finished, running]);
  assert.equal(summary.label, "1 command, 1 edit, 1 thought, 1 read", "运行中的 bash 不计入计数");
  assert.equal(summary.active, true);

  const onlyRunning = activitySummary([running]);
  assert.equal(onlyRunning.label, "", "没有任何已完成条目时 label 为空");
  assert.equal(onlyRunning.active, true);
});

test("activitySummary：复数与未知工具归入 tool 桶", () => {
  const summary = activitySummary([tool("read"), tool("read"), tool("weird"), tool("write")]);
  assert.equal(summary.label, "1 edit, 2 reads, 1 tool");
});

test("busyLabel：运行中给出稳定文案，终态为空", () => {
  assert.equal(busyLabel(tool("bash", { status: "running" })), "Running bash…");
  assert.equal(busyLabel(entry("reasoning", { status: "streaming" })), "Thinking…");
  assert.equal(busyLabel(tool("bash", { status: "done" })), "");
  assert.equal(busyLabel(entry("reasoning", { status: "done" })), "");
});

test("分组树：mergeGroups 在接缝处合并，未触及子树保持对象身份", () => {
  const left = groupEntries([tool("read", { id: "a" })], (e) => entryPath(e, "medium"));
  const right = groupEntries([tool("read", { id: "b" })], (e) => entryPath(e, "medium"));
  const merged = mergeGroups(left, right);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].kind, "exploration");
  assert.equal(merged[0].size, 2);
  assert.equal(merged[0].children[0], left[0].children[0], "左子树叶子保持原引用");
  assert.equal(merged[0].children[1], right[0].children[0], "右子树叶子保持原引用");
});

test("分组树：splitGroups 按叶子偏移切分，切开的组可再次拼接还原", () => {
  const entries = [tool("read", { id: "a" }), tool("read", { id: "b" }), tool("read", { id: "c" })];
  const tree = groupEntries(entries, (e) => entryPath(e, "medium"));
  const [left, right] = splitGroups(tree, 2);
  assert.equal(left[0].size, 2);
  assert.equal(right[0].size, 1);
  const merged = mergeGroups(left, right);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].size, 3);
  assert.throws(() => splitGroups(tree, 99), RangeError);
});
