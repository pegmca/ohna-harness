/**
 * 整屏 TUI 布局单测：输入框宽度必须严格等于终端列数。
 *
 * 背景（M6 整屏 TUI 验收缺陷）：早期实现把「屏宽 - 2」同时当作 box 的内容区宽度和
 * editor 的渲染宽度，editor 裁到 innerWidth 后 box 再加 2 内边距 + 2 边框，总宽变成
 * 「屏宽 + 2」，末 2 列（` │` / `╯`）被终端折行走样——输入尚未满屏就错位。
 * 这里用 reviewer 的复现场景（终端 82 列 + 200 字符输入）锁住这条约束。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@aiagent/term";
import { TuiApp } from "../dist/tui-app.js";

/**
 * 构造一个带指定输入内容的 TuiApp。
 *
 * 说明：editor 字段在 TS 里是 private，这里是编译后的 JS 运行时，可直接写入以模拟用户输入。
 *
 * @param value 输入框内容。
 * @param cursor 光标位置（缺省行尾）。
 * @returns TuiApp 实例。
 */
function appWithInput(value, cursor = value.length) {
  const tui = new TuiApp();
  tui.editor.value = value;
  tui.editor.cursor = cursor;
  return tui;
}

test("buildFrame：82 列终端 + 200 字符输入，没有任何行溢出（旧实现 84 列）", () => {
  const tui = appWithInput("x".repeat(200));
  tui.append("第一行对话\n第二行对话\n");
  const frame = tui.buildFrame(82, 24);

  for (const [i, line] of frame.entries()) {
    assert.ok(visibleWidth(line) <= 82, `第 ${i} 行宽 ${visibleWidth(line)} > 82：${JSON.stringify(line)}`);
  }
});

test("buildFrame：输入区三行（顶边框 / 输入行 / 下边框）宽度恒等于终端宽", () => {
  // 覆盖多种屏宽与输入长度组合：包含「距满屏还差几列」的临界情形。
  const cases = [
    [82, 76],
    [82, 77],
    [82, 78],
    [82, 200],
    [40, 200],
    [120, 300],
  ];
  for (const [width, inputLength] of cases) {
    const tui = appWithInput("y".repeat(inputLength), 0); // 光标在行首，覆盖「左侧裁切」分支
    const frame = tui.buildFrame(width, 24);
    const inputBox = frame.slice(-3);
    for (const [i, line] of inputBox.entries()) {
      assert.equal(visibleWidth(line), width, `屏宽 ${width} / 输入 ${inputLength} 字符的输入区第 ${i} 行`);
    }
  }
});
