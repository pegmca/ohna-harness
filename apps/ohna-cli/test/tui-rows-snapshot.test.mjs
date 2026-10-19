/**
 * C1b 行投影金样快照：固定 fixture 会话 × width 80 / 120。
 *
 * 采用内联字符串断言（不引入快照依赖），把布局回归显性化：
 * - low = 整段非文本活动折叠成一行摘要；
 * - medium = reasoning / exploration 折叠、activity 逐条；
 * - high = exploration / reasoning 默认展开。
 * 测试进程为非 TTY，`paint()` 自动降级为纯文本，因此可直接断言文本骨架。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@aiagent/term";
import { projectRows } from "../dist/ui/tui/rows.js";
import { activitySummary } from "../dist/ui/tui/classifier.js";

/**
 * 构造一条语义条目。
 *
 * @param kind 条目类别。
 * @param overrides 覆盖字段。
 * @returns TuiEntry。
 */
function entry(kind, overrides = {}) {
  return { id: overrides.id ?? `${kind}-0`, kind, status: "done", text: "", ...overrides };
}

/**
 * 构造一条已完成工具条目。
 *
 * @param name 工具名。
 * @param id 稳定 id。
 * @param args 工具入参。
 * @param resultText 结果文本。
 * @returns TuiEntry。
 */
function tool(name, id, args, resultText) {
  return entry("tool", {
    id,
    meta: { toolName: name, args, result: { content: [{ type: "text", text: resultText }] } },
  });
}

/** 固定 fixture：读 ×2 → bash → 已完成思考 → 流式正文。 */
function fixture() {
  return [
    entry("assistant", { id: "assistant-0", text: "我先看看仓库结构。" }),
    tool("read", "tool-1", { path: "README.md" }, "# ohna"),
    tool("read", "tool-2", { path: "AGENTS.md" }, "规则"),
    tool("bash", "tool-3", { command: "pnpm test" }, "154 tests pass"),
    entry("reasoning", { id: "reasoning-4", text: "再核对一下测试" }),
    entry("assistant", { id: "assistant-5", status: "streaming", text: "接下来我会修改渲染层。" }),
  ];
}

/**
 * 投影 fixture。
 *
 * @param verbosity 档位。
 * @param width 终端宽度。
 * @returns 行数组。
 */
function rows(verbosity, width) {
  return projectRows(fixture(), { verbosity, expanded: new Map(), width });
}

test("projectRows：low 档把整段非文本活动折叠为一行摘要", () => {
  assert.deepEqual(rows("low", 80), [
    "⏺ 我先看看仓库结构。",
    "+ 1 command, 1 thought, 2 reads",
    "⏺ 接下来我会修改渲染层。",
  ]);
});

test("projectRows：medium 档 reasoning/exploration 折叠、activity 逐条", () => {
  assert.deepEqual(rows("medium", 80), [
    "⏺ 我先看看仓库结构。",
    "+ 2 reads",
    "⏺ bash(pnpm test)",
    "  ⎿ 154 tests pass",
    "+ 1 thought",
    "⏺ 接下来我会修改渲染层。",
  ]);
});

test("projectRows：high 档 exploration/reasoning 默认展开", () => {
  assert.deepEqual(rows("high", 80), [
    "⏺ 我先看看仓库结构。",
    "− 2 reads",
    "  ⏺ read(README.md)",
    "    ⎿ # ohna",
    "  ⏺ read(AGENTS.md)",
    "    ⎿ 规则",
    "⏺ bash(pnpm test)",
    "  ⎿ 154 tests pass",
    "− 1 thought",
    "  ✻ 再核对一下测试",
    "⏺ 接下来我会修改渲染层。",
  ]);
});

test("projectRows：思考结束后 reasoning 组头为完成态一行摘要（+ N thoughts / active=false）", () => {
  const entries = [
    entry("reasoning", { id: "reasoning-0", text: "先分析" }),
    entry("reasoning", { id: "reasoning-1", text: "再核对" }),
  ];
  assert.equal(activitySummary(entries).active, false, "全部完成时不应有 active 标记");
  assert.deepEqual(
    projectRows(entries, { verbosity: "medium", expanded: new Map(), width: 80 }),
    ["+ 2 thoughts"],
    "完成态思考组应收起为一行 `+ N thoughts`，不再显示 spinner / 展开子项",
  );
});

test("projectRows：width 80/120 全部行不超宽，长 CJK 行按宽度截断", () => {
  const longLine = "长".repeat(80); // 160 列
  const entries = [entry("assistant", { id: "assistant-0", text: longLine })];
  const narrow = projectRows(entries, { verbosity: "medium", expanded: new Map(), width: 80 });
  const wide = projectRows(entries, { verbosity: "medium", expanded: new Map(), width: 120 });

  for (const line of [...narrow, ...wide]) assert.ok(visibleWidth(line) <= 120);
  assert.ok(visibleWidth(narrow[0]) <= 80, "80 列下首行不得超宽");
  assert.ok(visibleWidth(wide[0]) > visibleWidth(narrow[0]), "120 列应展示更多可见字符");
});

test("projectRows：expanded 覆盖默认折叠（medium 下展开 exploration 组）", () => {  const displayed = projectRows(fixture(), { verbosity: "medium", expanded: new Map([["tool-1:exploration", true]]), width: 80 });
  assert.deepEqual(displayed, [
    "⏺ 我先看看仓库结构。",
    "− 2 reads",
    "  ⏺ read(README.md)",
    "    ⎿ # ohna",
    "  ⏺ read(AGENTS.md)",
    "    ⎿ 规则",
    "⏺ bash(pnpm test)",
    "  ⎿ 154 tests pass",
    "+ 1 thought",
    "⏺ 接下来我会修改渲染层。",
  ]);
});

test("projectRows：超长工具结果折叠提示说明 ctrl+o 分组并指向 /export（M3）", () => {
  const bigResult = Array.from({ length: 200 }, (_, index) => `out-${index}`).join("\n");
  const entries = [
    entry("tool", {
      id: "tool-0",
      meta: { toolName: "bash", args: { command: "ls" }, result: { content: [{ type: "text", text: bigResult }] } },
    }),
  ];
  const joined = projectRows(entries, { verbosity: "medium", expanded: new Map(), width: 80 }).join("\n");
  assert.match(joined, /ctrl\+o 展开分组/);
  assert.match(joined, /完整输出见 \/export/);
  assert.ok(!joined.includes("out-50"), "中段内容不应出现");
});
