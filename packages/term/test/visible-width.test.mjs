/**
 * C1b `@aiagent/term` 可见宽度补测（C6）：
 * - 组合字符 / emoji / 补充平面 CJK 的边界行为；
 * - `truncateToWidth` 截断时颜色闭合（补 `\x1b[0m`、不切碎转义序列）。
 *
 * 说明：`visibleWidth` 采用「按码点近似」策略（零宽组合符号尚未合并、ZWJ 序列按各码点累加），
 * 本文件把该近似显式写进断言，避免将来误以为它是完整 Unicode 宽度实现。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { truncateToWidth, visibleWidth } from "../dist/index.js";

test("visibleWidth：ANSI 转义不占列", () => {
  assert.equal(visibleWidth("\x1b[38;2;1;2;3mhello\x1b[0m"), 5);
  assert.equal(visibleWidth("\x1b[7m>\x1b[27m ab"), 4);
});

test("visibleWidth：CJK 与补充平面 CJK 计 2 列", () => {
  assert.equal(visibleWidth("中文"), 4);
  assert.equal(visibleWidth("𠀀"), 2, "CJK 扩展 B（U+20000）应计 2 列");
  assert.equal(visibleWidth("a中"), 3);
});

test("visibleWidth：emoji 区间边界（U+1F300 起为 2 列）", () => {
  assert.equal(visibleWidth("\u{1F300}"), 2, "区间下界 emoji 计 2 列");
  assert.equal(visibleWidth("\u{1FAFF}"), 2, "区间上界 emoji 计 2 列");
  assert.equal(visibleWidth("\u{1F2FF}"), 1, "区间外码点计 1 列");
});

test("visibleWidth：控制字符计 0 列", () => {
  assert.equal(visibleWidth("a\u0001b"), 2, "C0 控制字符不占列");
  assert.equal(visibleWidth("a\u007fb"), 2, "DEL 不占列");
  assert.equal(visibleWidth("\u0085"), 0, "C1 控制字符（U+0080-U+009F）不占列");
});

test("visibleWidth：零宽组合符号按独立码点近似（已知近似）", () => {
  // 当前实现不把 U+0301 合并为 0 列，因此 "é"（e + 组合尖音符）近似为 2 列。
  assert.equal(visibleWidth("e\u0301"), 2, "组合尖音符近似计 1 列（未做 grapheme 合并）");
  assert.equal(visibleWidth("\u{1F468}\u200D\u{1F469}"), 5, "ZWJ 家庭序列按各码点累加近似");
});

test("truncateToWidth：截断含 ANSI 的行补复位，颜色不外泄", () => {
  const painted = "\x1b[31m中文abc\x1b[0m"; // 可见宽 7
  const cut = truncateToWidth(painted, 4);
  assert.equal(visibleWidth(cut), 4, "截断后可见宽恰为 4");
  assert.ok(cut.endsWith("\x1b[0m"), "截断后必须补一次 SGR 复位");
  const body = cut.replace(/\x1b\[0m$/, "");
  assert.ok(!/\x1b\[[0-9;?]*$/.test(body), `行尾不得残留半截转义：${JSON.stringify(body)}`);
});

test("truncateToWidth：未超宽时原样返回（不重复补复位）", () => {
  const painted = "\x1b[31mabcd\x1b[0m";
  assert.equal(truncateToWidth(painted, 4), painted);
  assert.equal(truncateToWidth("abcd", 4), "abcd");
});

test("truncateToWidth：宽字符放不下整格时停在边界（不切半）", () => {
  assert.equal(truncateToWidth("a中", 2), "a");
  assert.equal(truncateToWidth("中中", 2), "中");
  assert.equal(truncateToWidth("中中", 3), "中", "剩余 1 列放不下第二个宽字符");
});

test("truncateToWidth：多段着色截断后仍以复位结尾", () => {
  const painted = "\x1b[31mab\x1b[32mcdef\x1b[0m"; // 可见宽 6
  const cut = truncateToWidth(painted, 4);
  assert.equal(visibleWidth(cut), 4);
  assert.ok(cut.endsWith("\x1b[0m"), "跨颜色段截断仍应闭合");
  assert.ok(!/\x1b\[[0-9;?]*$/.test(cut.replace(/\x1b\[0m$/, "")), "不得残留半截转义");
});
