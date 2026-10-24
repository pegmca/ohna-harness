/**
 * 权限卡单测（Phase C3）：按键解析（1/2/3 与 y/a/n、↑↓+Enter、Esc=deny）、
 * 渲染宽度截断、diff 高度预算与头尾折叠。
 *
 * 用真实 diff 文本构造卡片，断言纯函数输出，不依赖终端。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@aiagent/term";
import { configure, resetForTest } from "../dist/ui/theme.js";
import { PermissionCard } from "../dist/ui/tui/permission-card.js";

/** 造一张最小卡。 */
function makeCard(extra = {}) {
  return new PermissionCard({ tool: "write", summary: "write 写入文件：a.txt", ...extra });
}

test("按键：1/2/3 与 y/a/n 直选返回对应裁决", () => {
  assert.equal(makeCard().handleKey("1"), "allow");
  assert.equal(makeCard().handleKey("y"), "allow");
  assert.equal(makeCard().handleKey("2"), "session");
  assert.equal(makeCard().handleKey("a"), "session");
  assert.equal(makeCard().handleKey("3"), "deny");
  assert.equal(makeCard().handleKey("n"), "deny");
});

test("按键：未识别输入不结算（返回 null），选中共保持默认 0", () => {
  const card = makeCard();
  assert.equal(card.handleKey("x"), null);
  assert.equal(card.selected, 0);
});

test("按键：↑↓ 移动选中并以 Enter 结算，循环到首尾", () => {
  const down = makeCard();
  assert.equal(down.handleKey("\x1b[B"), null);
  assert.equal(down.selected, 1);
  assert.equal(down.handleKey("\r"), "session", "Enter 结算当前选中项");

  const wrap = makeCard();
  assert.equal(wrap.handleKey("\x1b[A"), null);
  assert.equal(wrap.selected, 2, "↑ 从首项回绕到末项");
  assert.equal(wrap.handleKey("\n"), "deny");
});

test("按键：Esc / Ctrl+C 是显式拒绝（不是挂起 hack）", () => {
  assert.equal(makeCard().handleKey("\x1b"), "deny");
  assert.equal(makeCard().handleKey("\x03"), "deny");
});

test("渲染：每行按 width 截断（含超长 diff 行）", () => {
  const long = `write 写入文件：${"x".repeat(300)}`;
  const card = new PermissionCard({ tool: "write", summary: long, diff: `+${"y".repeat(300)}` });
  const lines = card.render({ width: 40, maxRows: 10 });
  assert.ok(lines.length > 0);
  for (const [index, line] of lines.entries()) {
    assert.ok(visibleWidth(line) <= 40, `第 ${index} 行可见宽 ${visibleWidth(line)} > 40`);
  }
});

test("渲染：diff 预览受 maxRows 预算约束并走头尾折叠", () => {
  const diff = ["label.txt", "@@ -1,30 +1,30 @@", ...Array.from({ length: 30 }, (_, i) => `+line ${i}`)].join("\n");
  const card = new PermissionCard({ tool: "write", summary: "write 写入文件：a.txt", diff });
  const lines = card.render({ width: 80, maxRows: 6 });

  assert.ok(lines.length <= 6, `卡片总行数 ${lines.length} 不得超过预算 6`);
  const text = lines.join("\n");
  assert.match(text, /… \+\d+ 行/, "超长 diff 应以头尾折叠标记收尾");
  assert.match(text, /\[1\] 允许一次/, "选项行应始终保留");
  assert.ok(!lines.every((line) => line.includes("line ")), "折叠后不应显示全部 diff 行");
});

test("渲染：选中项以 selected 颜色块高亮，选中变化后高亮迁移", () => {
  const card = makeCard();
  configure({ forced: true });
  try {
    const first = card.render({ width: 80, maxRows: 6 }).join("\n");
    assert.match(first, /\x1b\[48;2;46;51;49;38;2;237;230;218m\[1\] 允许一次/);
    assert.match(first, /\x1b\[38;2;191;227;210m│ /, "卡片左边框 / 标题使用 focused");
    assert.doesNotMatch(first, /\x1b\[7m/, "选中态不再依赖反转视频");

    card.handleKey("\x1b[B");
    const second = card.render({ width: 80, maxRows: 6 }).join("\n");
    assert.match(second, /\x1b\[48;2;46;51;49;38;2;237;230;218m\[2\] 本会话一律/);
  } finally {
    resetForTest();
  }
});
