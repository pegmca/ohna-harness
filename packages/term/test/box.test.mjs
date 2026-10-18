import test from "node:test";
import assert from "node:assert/strict";
import { box, visibleWidth } from "../dist/index.js";

// 模拟 ohna-cli theme.paint 产出的带 ANSI 文本：\x1b[38;2;r;g;bm ... \x1b[0m
// 可见宽应为 "hello" = 5，转义序列不得计入边框宽度。
const painted = "\x1b[38;2;232;220;203mhello\x1b[0m";
const plain = "world!"; // 可见宽 6

test("box 产出首尾边框，且边框总宽 = 内容最大可见宽 + 内边距(2) + 边框(2)", () => {
  const result = box([painted, plain]);
  const top = result[0];
  const bottom = result[result.length - 1];

  // 内容区 = max(5,6) + 2（左右内边距）= 8，总可见宽 = 8 + 2 = 10
  assert.equal(visibleWidth(top), 10);
  assert.equal(visibleWidth(bottom), 10);

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
  assert.equal(visibleWidth(top), 10);

  // 直接验证 visibleWidth 剥离 ANSI
  assert.equal(visibleWidth(painted), 5);
  assert.equal(visibleWidth(plain), 6);
});

test("三行对齐：上边框 / 每个 body 行 / 下边框 visibleWidth 全部相等", () => {
  // 反色光标 `\x1b[7m…\x1b[27m` 模拟 ohna-cli 输入行；含 CJK 与空行，覆盖多种宽度来源。
  const cases = [
    [painted, plain],
    ["\x1b[7m> \x1b[27m", "abc"],
    ["中文宽度2倍", "x"],
    ["", "a", "longer line here"],
    ["\x1b[38;2;1;2;3m\x1b[7m中\x1b[27m\x1b[0m文"],
  ];

  for (const lines of cases) {
    const result = box(lines);
    // body 行数量与内容行一致（上下各 1 条边框）
    assert.equal(result.length, lines.length + 2);

    const widths = result.map((l) => visibleWidth(l));
    const expected = widths[0];
    for (const [i, w] of widths.entries()) {
      assert.equal(w, expected, `第 ${i} 行宽度 ${w} != 上边框宽度 ${expected}：${JSON.stringify(lines)}`);
    }
  }
});

test("三行对齐（显式 width + title）：ANSI 内容行同样与上下边框等宽", () => {
  const lines = ["\x1b[7m> hel\x1b[27mlo", "short"];
  const result = box(lines, { width: 20, title: "ohna" });
  assert.equal(result.length, lines.length + 2);

  const widths = result.map((l) => visibleWidth(l));
  // 内容区 20，总可见宽 22；所有行必须一致
  for (const w of widths) {
    assert.equal(w, 22);
  }
});

// 溢出回归（M6 整屏 TUI）：早期实现里显式 width 只是「建议值」，内容超宽时盒子被整体撑宽
// （contentWidth = max(width, 行宽+2)），导致按终端列数算好的布局行宽超出终端、被折行错位。
// 现在显式 width 是硬约束：超宽内容被截断，三行总可见宽恒等于 width + 2。
test("显式 width 是硬约束：超长内容被截断，总可见宽恒为 width + 2", () => {
  const longPainted = "\x1b[38;2;232;220;203m" + "x".repeat(300) + "\x1b[0m";
  const cases = [
    ["a".repeat(200), 20],
    ["x".repeat(79), 80],
    [longPainted, 30],
    ["中文宽度2倍".repeat(20), 13],
    ["\x1b[7m" + "b".repeat(100) + "\x1b[27m", 10],
  ];

  for (const [line, width] of cases) {
    const result = box([line], { width });
    assert.equal(result.length, 3);
    for (const [i, l] of result.entries()) {
      assert.equal(visibleWidth(l), width + 2, `width=${width} 的第 ${i} 行宽 ${visibleWidth(l)}`);
    }
    // ANSI 序列不得被切碎：截断后残余行里不应有半截转义（`\x1b[` 后必须有完整终字节）。
    const body = result[1];
    assert.ok(!/\x1b\[[0-9;?]*$/.test(body), `body 行尾残留半截转义：${JSON.stringify(body)}`);
    assert.ok(!/\x1b\][^\x07\x1b]*$/.test(body), `body 行尾残留未闭合 OSC：${JSON.stringify(body)}`);
  }
});

test("回归：终端宽 82 的输入框不得溢出（旧实现行宽 79/80 → 83/84）", () => {
  // 复现 ohna-cli TuiApp.buildFrame(82, 24) 的输入区：innerWidth = 82 - 2 = 80，
  // editor.render(innerWidth - 2) 产出最多 78 列的行；即使退化为 79/80 列也不许顶宽。
  const terminalWidth = 82;
  const innerWidth = terminalWidth - 2;
  for (const contentWidth of [78, 79, 80, 120]) {
    const result = box(["x".repeat(contentWidth)], { width: innerWidth, title: "ohna" });
    for (const [i, line] of result.entries()) {
      assert.equal(visibleWidth(line), terminalWidth, `内容 ${contentWidth} 列的第 ${i} 行溢出`);
    }
  }
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
