/**
 * Esc 手势纯函数单测：双击窗口判定（跨 chunk 转义序列拼装由 input-assembler 负责）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ESC_DOUBLE_WINDOW_MS, isDoubleEscape } from "../dist/ui/tui/esc-gesture.js";

test("isDoubleEscape：严格小于 500ms 才算双击，0 表示无历史", () => {
  assert.equal(isDoubleEscape(0, 100), false);
  assert.equal(isDoubleEscape(1000, 1000), true);
  assert.equal(isDoubleEscape(1000, 1000 + ESC_DOUBLE_WINDOW_MS - 1), true);
  assert.equal(isDoubleEscape(1000, 1000 + ESC_DOUBLE_WINDOW_MS), false);
});
