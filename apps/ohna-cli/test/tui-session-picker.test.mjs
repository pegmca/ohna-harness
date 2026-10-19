/**
 * `/resume` 会话选择器单测：候选截断、键盘导航、Enter 选中、Esc 取消、可打印字符交回编辑器。
 *
 * 选择器是纯状态机（不持有终端），因此可以直接用字符序列驱动，不需要真实 TTY。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SessionPicker, MAX_SESSION_PICKER_ITEMS } from "../dist/ui/tui/tui-session-picker.js";

/**
 * 构造一个会话条目。
 *
 * @param n 序号（用于生成稳定的 id / 标题 / 时间）。
 * @returns 选择器条目。
 */
function item(n) {
  return {
    id: `id-${n}-0000-0000-0000-000000000000`,
    title: `会话 ${n}`,
    updatedAt: Date.UTC(2025, 9, 19, 12, 0) + n * 1000,
    messageCount: n,
  };
}

test("openWith：截断到上限并展示标题 / 短 id / 时间", () => {
  const picker = new SessionPicker();
  picker.openWith(Array.from({ length: MAX_SESSION_PICKER_ITEMS + 3 }, (_, i) => item(i + 1)));
  assert.equal(picker.isOpen(), true);

  const lines = picker.buildLines();
  assert.match(lines[0], /选择会话/);
  assert.equal(lines.length, MAX_SESSION_PICKER_ITEMS + 2, "header + 10 条 + footer");
  assert.match(lines[1], /会话 1/);
  assert.match(lines[1], /id-1-000/);
  assert.ok(lines[1].startsWith("\x1b[7m"), "首行默认选中");
});

test("handleKey：↑/↓ 移动选中，Enter 返回 id 并关闭", () => {
  const picker = new SessionPicker();
  picker.openWith([item(1), item(2)]);

  picker.handleKey("\x1b[B");
  assert.ok(picker.buildLines()[2].startsWith("\x1b[7m"), "下移后第二行选中");

  const result = picker.handleKey("\r");
  assert.equal(result.consumed, true);
  assert.equal(result.selectedId, item(2).id);
  assert.equal(picker.isOpen(), false);
});

test("handleKey：Esc 关闭；可打印字符关闭并交回编辑器", () => {
  const picker = new SessionPicker();
  picker.openWith([item(1)]);
  const esc = picker.handleKey("\x1b");
  assert.equal(esc.consumed, true);
  assert.equal(picker.isOpen(), false);

  picker.openWith([item(1)]);
  const printable = picker.handleKey("x");
  assert.equal(printable.consumed, false);
  assert.equal(picker.isOpen(), false);
});

test("openWith：空列表不打开", () => {
  const picker = new SessionPicker();
  picker.openWith([]);
  assert.equal(picker.isOpen(), false);
  assert.deepEqual(picker.buildLines(), []);
});
