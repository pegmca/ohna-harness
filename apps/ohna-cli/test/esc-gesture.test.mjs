/**
 * Esc 手势纯函数单测：只有独立 / 连续 Esc 才算中断手势，功能键与 Alt+键整体交回编辑器。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ESC_DOUBLE_WINDOW_MS, isDoubleEscape, splitLeadingEscapes } from "../dist/ui/tui/esc-gesture.js";

test("splitLeadingEscapes：单个 ESC 是独立 Esc", () => {
  assert.deepEqual(splitLeadingEscapes("\x1b"), { escapes: 1, remainder: "" });
});

test("splitLeadingEscapes：连续 ESC 逐个计数（双击）", () => {
  assert.deepEqual(splitLeadingEscapes("\x1b\x1b"), { escapes: 2, remainder: "" });
});

test("splitLeadingEscapes：方向键 / 功能键 / Alt+键整体交回编辑器", () => {
  assert.deepEqual(splitLeadingEscapes("\x1b[A"), { escapes: 0, remainder: "\x1b[A" });
  assert.deepEqual(splitLeadingEscapes("\x1bO"), { escapes: 0, remainder: "\x1bO" });
  assert.deepEqual(splitLeadingEscapes("\x1bA"), { escapes: 0, remainder: "\x1bA" });
  assert.deepEqual(splitLeadingEscapes("abc"), { escapes: 0, remainder: "abc" });
});

test("splitLeadingEscapes：Esc 前缀后跟其它键时，只消费独立部分", () => {
  assert.deepEqual(splitLeadingEscapes("\x1b\x1bA"), { escapes: 1, remainder: "\x1bA" });
});

test("isDoubleEscape：严格小于 500ms 才算双击，0 表示无历史", () => {
  assert.equal(isDoubleEscape(0, 100), false);
  assert.equal(isDoubleEscape(1000, 1000), true);
  assert.equal(isDoubleEscape(1000, 1000 + ESC_DOUBLE_WINDOW_MS - 1), true);
  assert.equal(isDoubleEscape(1000, 1000 + ESC_DOUBLE_WINDOW_MS), false);
});
