/**
 * 长会话挂载预算单测（Phase C4）：
 * `rowWeight` 的折叠 / 展开 / 摊平语义，尾部对齐切片，以及 PageUp / PageDown / toBottom
 * 的滚动状态机（回填、回收、步长、顶部夹紧）。
 *
 * 用例只依赖纯函数，不启动终端；行内容含 ANSI，断言统一用 {@link plain} 去色。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { groupEntries } from "../dist/ui/tui/grouping.js";
import { entryPath } from "../dist/ui/tui/classifier.js";
import {
  BACKFILL_CHUNK,
  TRANSCRIPT_TAIL_ROWS,
  buildTranscriptNodes,
  mountTranscript,
  nextScroll,
} from "../dist/ui/tui/mount.js";
import { groupID, rowWeight } from "../dist/ui/tui/rows.js";
import { transcriptView } from "../dist/ui/tui/transcript.js";
import { buildStatusLine } from "../dist/ui/tui/panels.js";

/** 去掉 ANSI SGR 序列，便于断言可见文本。 */
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * 去掉 ANSI 与首尾空白。
 *
 * @param line 已上色的终端行。
 * @returns 纯文本。
 */
function plain(line) {
  return line.replace(ANSI, "").trim();
}

/**
 * 构造一条语义条目。
 *
 * @param id 稳定 id。
 * @param kind 条目类别。
 * @param text 原文（tool 通常为空）。
 * @param meta 可选元数据。
 * @returns TuiEntry。
 */
function entry(id, kind, text = "", meta) {
  return { id, kind, status: "done", text, ...(meta ? { meta } : {}) };
}

/**
 * 构造 user 文本条目。
 *
 * @param index 序号（同时作为 id 与文本）。
 * @returns user 条目。
 */
function user(index) {
  return entry(`u-${index}`, "user", `u-${index}`);
}

/**
 * 构造只读工具条目（默认归入 exploration）。
 *
 * 使用 `running` 状态让单条工具只渲染 1 行（done 还会追加结果行），
 * 这样展开组的行数恒为「组头 + 子项数」，便于断言挂载预算。
 *
 * @param id 稳定 id。
 * @param name 工具名。
 * @returns tool 条目。
 */
function tool(id, name = "read") {
  return { id, kind: "tool", status: "running", text: "", meta: { toolName: name } };
}

/**
 * 构造一个独立的 exploration 折叠组（3 条 read）。
 *
 * 逐组调用 `groupEntries` 再拼接，避免相邻组被合并成一个 60 叶子的大组；
 * 这样“同屏可见多少组”才是可断言的。
 *
 * @param index 组序号。
 * @returns 单元素根节点数组。
 */
function explorationGroup(index) {
  const leaves = [0, 1, 2].map((leaf) => tool(`t-${index}-${leaf}`));
  return groupEntries(leaves, (item) => entryPath(item, "medium"));
}

/**
 * 组合挂载输入。
 *
 * @param nodes 顶层分组节点。
 * @param options 预算 / 滚动 / 展开状态。
 * @returns mountTranscript 输入对象。
 */
function mountInput(nodes, options = {}) {
  const {
    budget = 8,
    backfill = 0,
    historyOffset = 0,
    verbosity = "medium",
    expanded = new Map(),
    width = 120,
  } = options;
  return { nodes, verbosity, expanded, width, budget, backfill, historyOffset };
}

test("rowWeight：叶子=1，折叠组=1，展开组=1+Σ子权重", () => {
  const userNode = buildTranscriptNodes([user(0)], "medium")[0];
  assert.equal(rowWeight(userNode, "medium", new Map()), 1);

  const group = explorationGroup(0)[0];
  assert.equal(group.type, "group");
  assert.equal(rowWeight(group, "medium", new Map()), 1);

  const expanded = new Map([[groupID(group), true]]);
  assert.equal(rowWeight(group, "medium", expanded), 1 + 3);
});

test("rowWeight：medium 的 activity 摊平（无组头）= 子项之和；low 全折叠=1", () => {
  const activity = buildTranscriptNodes([tool("b-1", "bash"), tool("b-2", "bash")], "medium")[0];
  assert.equal(activity.type, "group");
  assert.equal(activity.kind, "activity");
  assert.equal(rowWeight(activity, "medium", new Map()), 2);

  const low = buildTranscriptNodes(
    [entry("r-1", "reasoning", "想"), tool("t-1", "read"), tool("b-1", "bash")],
    "low",
  )[0];
  assert.equal(low.type, "group");
  assert.equal(low.kind, "activity");
  assert.equal(rowWeight(low, "low", new Map()), 1);
});

test("rowWeight：high 下 exploration 默认展开（组头 + 子项）", () => {
  const group = explorationGroup(0)[0];
  assert.equal(rowWeight(group, "high", new Map()), 1 + 3);
  // 显式折叠覆盖 verbosity 默认值。
  assert.equal(rowWeight(group, "high", new Map([[groupID(group), false]])), 1);
});

test("尾部对齐切片：budget 只截取最后 budget 行，默认贴底", () => {
  const entries = Array.from({ length: 10 }, (_, index) => user(index));
  const mount = mountTranscript(mountInput(buildTranscriptNodes(entries, "medium"), { budget: 4 }));

  assert.deepEqual(
    mount.lines.map(plain),
    ["❯ u-6", "❯ u-7", "❯ u-8", "❯ u-9"],
  );
  assert.equal(mount.maxOffset, 6);
  assert.equal(mount.mountedRows, 10);
  assert.equal(mount.hiddenEntries, 6);
  assert.equal(mount.hasMore, false);
});

test("historyOffset：窗口从底部向上偏移，并夹紧到 maxOffset", () => {
  const nodes = buildTranscriptNodes(
    Array.from({ length: 10 }, (_, index) => user(index)),
    "medium",
  );
  const middle = mountTranscript(mountInput(nodes, { budget: 4, historyOffset: 3 }));
  assert.deepEqual(middle.lines.map(plain), ["❯ u-3", "❯ u-4", "❯ u-5", "❯ u-6"]);

  const clamped = mountTranscript(mountInput(nodes, { budget: 4, historyOffset: 999 }));
  assert.deepEqual(
    clamped.lines.map(plain),
    ["❯ u-0", "❯ u-1", "❯ u-2", "❯ u-3"],
  );
});

test("折叠组按权重挂载：budget=8 可见 8 个折叠组（每组恒 1 行）", () => {
  const nodes = Array.from({ length: 20 }, (_, index) => explorationGroup(index)[0]);
  const mount = mountTranscript(mountInput(nodes, { budget: 8 }));

  assert.equal(mount.lines.length, 8);
  // 20 个顶层组，可见 8 行 => 12 组被隐藏；每组 size=3。
  assert.equal(mount.hiddenEntries, 12 * 3);
  assert.equal(mount.mountedRows, 20);
  assert.equal(mount.hasMore, false);
});

test("展开组按真实行占位：同样的 budget=8 只可见 2 个组", () => {
  const nodes = Array.from({ length: 20 }, (_, index) => explorationGroup(index)[0]);
  const expanded = new Map(nodes.map((node) => [groupID(node), true]));
  const mount = mountTranscript(mountInput(nodes, { budget: 8, expanded }));

  assert.equal(mount.mountedRows, 12 * 4, "权重 1+3，budget+40 行最多挂 12 组");
  assert.equal(mount.lines.length, 8);
  assert.equal(mount.hiddenEntries, 18 * 3);
  // 可见 8 行 = 2 个完整展开组（组头 + 3 子项），因此可见 6 条工具行。
  assert.equal(mount.lines.map(plain).filter((line) => line.includes("read(")).length, 6);
});

test("空会话：不产生行，也不报告历史", () => {
  const mount = mountTranscript(mountInput([], { budget: 10 }));
  assert.deepEqual(mount.lines, []);
  assert.equal(mount.hiddenEntries, 0);
  assert.equal(mount.hasMore, false);
  assert.equal(mount.mountedRows, 0);
});

test("PageUp 在挂载区内按半页上移，且不触发回填", () => {
  const nodes = buildTranscriptNodes(
    Array.from({ length: 10 }, (_, index) => user(index)),
    "medium",
  );
  const base = mountInput(nodes, { budget: 4 });
  const next = nextScroll({ ...base, direction: "up" });

  assert.deepEqual(next, { historyOffset: 2, backfill: 0 });
  const mount = mountTranscript({ ...base, ...next });
  assert.deepEqual(mount.lines.map(plain), ["❯ u-4", "❯ u-5", "❯ u-6", "❯ u-7"]);
});

test("PageUp 到顶后回填一批：视图只上移半页，不跳到新挂载区顶端", () => {
  const entries = Array.from({ length: 100 }, (_, index) => user(index));
  const nodes = buildTranscriptNodes(entries, "medium");
  const base = mountInput(nodes, { budget: 4 });

  const before = mountTranscript(base);
  assert.equal(before.hasMore, true);
  assert.equal(before.maxOffset, TRANSCRIPT_TAIL_ROWS, "默认挂载 budget + 40 行");
  const top = mountTranscript({ ...base, historyOffset: before.maxOffset });
  assert.deepEqual(top.lines.map(plain), ["❯ u-56", "❯ u-57", "❯ u-58", "❯ u-59"]);

  const next = nextScroll({ ...base, historyOffset: before.maxOffset, direction: "up" });
  // 回填 60 行，但 offset 只增加一页（budget/2=2），保持正常滚动步长。
  assert.equal(next.backfill, BACKFILL_CHUNK);
  assert.equal(next.historyOffset, before.maxOffset + 2);
  const after = mountTranscript({ ...base, ...next });
  assert.deepEqual(after.lines.map(plain), ["❯ u-54", "❯ u-55", "❯ u-56", "❯ u-57"]);
});

test("PageUp 连续滚动到绝对顶部后夹紧，hasMore 变 false", () => {
  const nodes = buildTranscriptNodes(
    Array.from({ length: 100 }, (_, index) => user(index)),
    "medium",
  );
  let scroll = { historyOffset: 0, backfill: 0 };
  for (let index = 0; index < 100; index += 1) {
    scroll = nextScroll({ ...mountInput(nodes, { budget: 4 }), ...scroll, direction: "up" });
  }

  assert.equal(scroll.historyOffset, 96);
  const mount = mountTranscript({ ...mountInput(nodes, { budget: 4 }), ...scroll });
  assert.equal(mount.hasMore, false);
  assert.deepEqual(
    mount.lines.map(plain),
    ["❯ u-0", "❯ u-1", "❯ u-2", "❯ u-3"],
  );
});

test("PageDown：先在挂载区内下移；贴底后逐批回收 backfill", () => {
  const nodes = buildTranscriptNodes(
    Array.from({ length: 100 }, (_, index) => user(index)),
    "medium",
  );
  const base = mountInput(nodes, { budget: 4, backfill: 2 * BACKFILL_CHUNK });

  const first = nextScroll({ ...base, historyOffset: 3, direction: "down" });
  assert.deepEqual(first, { historyOffset: 1, backfill: 2 * BACKFILL_CHUNK });

  const recycleOne = nextScroll({ ...base, historyOffset: 0, direction: "down" });
  assert.deepEqual(recycleOne, { historyOffset: 0, backfill: BACKFILL_CHUNK });
  const recycleAll = nextScroll({ ...base, ...recycleOne, direction: "down" });
  assert.deepEqual(recycleAll, { historyOffset: 0, backfill: 0 });
});

test("仅回收 backfill 不改变贴底可见内容", () => {
  const nodes = buildTranscriptNodes(
    Array.from({ length: 100 }, (_, index) => user(index)),
    "medium",
  );
  const before = mountTranscript(mountInput(nodes, { budget: 4, backfill: BACKFILL_CHUNK }));
  const after = mountTranscript(mountInput(nodes, { budget: 4, backfill: 0 }));
  assert.deepEqual(after.lines, before.lines);
});

test("toBottom：offset 归零，保留已回填的挂载区", () => {
  const nodes = buildTranscriptNodes(
    Array.from({ length: 100 }, (_, index) => user(index)),
    "medium",
  );
  const next = nextScroll({
    ...mountInput(nodes, { budget: 4, backfill: BACKFILL_CHUNK, historyOffset: 30 }),
    direction: "bottom",
  });
  assert.deepEqual(next, { historyOffset: 0, backfill: BACKFILL_CHUNK });
});

test("transcriptView 把隐藏条目数合并进状态行数据", () => {
  const entries = Array.from({ length: 20 }, (_, index) => user(index));
  const input = {
    entries,
    verbosity: "medium",
    expanded: new Map(),
    width: 80,
    budget: 8,
    backfill: 0,
    historyOffset: 0,
  };
  const status = { model: "test-model", contextPercent: 50 };

  const view = transcriptView(input, status);
  assert.equal(view.lines.length, 8);
  assert.equal(view.status.historyAbove, 12);
  assert.match(plain(buildStatusLine(view.status, 80)), /↑ 历史 12 条/);
  // 原状态字段不被就地修改。
  assert.equal(status.historyAbove, undefined);

  const all = transcriptView({ ...input, budget: 40 }, status);
  assert.equal(all.status, status);
  assert.equal(all.status.historyAbove, undefined);
});
