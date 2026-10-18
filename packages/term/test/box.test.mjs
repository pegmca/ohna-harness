import test from "node:test";
import assert from "node:assert/strict";
import { box, visibleWidth } from "../dist/index.js";

// 模拟 ohna-cli theme.paint 产出的带 ANSI 文本：\x1b[38;2;r;g;bm ... \x1b[0m
// 可见宽应为 "hello" = 5，转义序列不得计入边框宽度。
const painted = "\x1b[38;2;232;220;203mhello\x1b[0m";
const plain = "world!"; // 可见宽 6

test("box 产出首尾边框，且边框总宽 = 内容最大可见宽 + 2", () => {
  const result = box([painted, plain]);
  const top = result[0];
  const bottom = result[result.length - 1];

  // 总可见宽 = max(5,6) + 2 = 8
  assert.equal(visibleWidth(top), 8);
  assert.equal(visibleWidth(bottom), 8);

  // 边框字符正确
  assert.equal(top[0], "╭");
  assert.equal(top[top.length - 1], "╮");
  assert.equal(bottom[0], "╰");
  assert.equal(bottom[bottom.length - 1], "╯");
});

test("含 ANSI 的行不影响边框宽度计算（visibleWidth 剥离转义）", () => {
  // 仅带 ANSI 的短文本，内容最大可见宽应来自 plain=6
  const result = box([painted, plain]);
  const top = result[0];
  assert.equal(visibleWidth(top), 8);

  // 直接验证 visibleWidth 剥离 ANSI
  assert.equal(visibleWidth(painted), 5);
  assert.equal(visibleWidth(plain), 6);
});

test("box 行数 = 内容行数 + 上下边框（2 行）", () => {
  const result = box([painted, plain, "ccc"]);
  assert.equal(result.length, 5);
});

test("空内容：盒子宽度为 2（仅左右边框）", () => {
  const result = box([]);
  assert.equal(result.length, 2);
  assert.equal(visibleWidth(result[0]), 2);
});

test("显式 width 覆盖内容自动宽度", () => {
  const result = box(["a"], { width: 10 });
  // 内容区 10，盒子总宽 12
  assert.equal(visibleWidth(result[0]), 12);
});

test("title 渲染在顶边，盒子总宽 = max(内容宽, 标题占用宽) + 2", () => {
  const result = box(["hi"], { title: "T" });
  const top = result[0];
  assert.equal(top[0], "╭");
  assert.equal(top[top.length - 1], "╮");
  assert.ok(top.includes("T"));
  // 内容宽 2 < 标题占用宽 4，盒子被标题撑宽，总宽应为 6
  assert.equal(visibleWidth(top), 6);
});
