/**
 * truncateToWidth 单测：按可见列宽截断单行（宽字符算 2 列、ANSI 转义算 0 列）。
 *
 * 覆盖四项契约：不超宽原样返回（不额外补复位）、ANSI 整段搬运不占列、CJK 全角按 2 列、
 * 超宽截断且行内含转义时补 `\x1b[0m` 防着色泄漏。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { truncateToWidth, visibleWidth } from "../dist/index.js";

test("truncateToWidth：不超宽时原样返回（不额外补复位）", () => {
  assert.equal(truncateToWidth("hello", 10), "hello");
  const painted = "\x1b[38;2;1;2;3mhi\x1b[0m";
  // visibleWidth = 2，等于 maxWidth，不截断、不追加复位。
  assert.equal(truncateToWidth(painted, 2), painted);
});

test("truncateToWidth：ANSI 转义整段搬运不占列", () => {
  const painted = "\x1b[38;2;232;220;203mabcdef\x1b[0m";
  assert.equal(visibleWidth(painted), 6);
  const cut = truncateToWidth(painted, 3);
  assert.equal(visibleWidth(cut), 3, "截断后可见宽应恰为 3");
  assert.ok(cut.startsWith("\x1b[38;2;232;220;203m"), "起始 SGR 前缀应整段保留");
  assert.ok(cut.endsWith("abc\x1b[0m"), "截断后应补复位防着色泄漏");
  // 无半截转义残留：去掉末尾复位后，剩余的 \x1b[... 必须都有完整终字节。
  const body = cut.replace(/\x1b\[0m$/, "");
  assert.ok(!/\x1b\[[0-9;?]*$/.test(body), `body 行尾残留半截转义：${JSON.stringify(body)}`);
});

test("truncateToWidth：CJK 全角按 2 列截断", () => {
  const s = "中文ab"; // 中2 + 文2 + a1 + b1 = 6
  assert.equal(visibleWidth(s), 6);
  assert.equal(truncateToWidth(s, 4), "中文");
  assert.equal(truncateToWidth(s, 5), "中文a");
});

test("truncateToWidth：宽字符放不下整格则停止（不切半）", () => {
  const s = "a中"; // 1 + 2 = 3
  assert.equal(truncateToWidth(s, 2), "a", "剩 1 列放不下 2 列的「中」，应停在 a");
  assert.equal(truncateToWidth(s, 1), "a");
});

test("truncateToWidth：无转义的纯文本截断不补复位", () => {
  assert.equal(truncateToWidth("abcdef", 3), "abc");
});

test("truncateToWidth：全 ANSI 无可见字符时因不超宽原样返回", () => {
  const painted = "\x1b[31m\x1b[0m";
  assert.equal(visibleWidth(painted), 0);
  assert.equal(truncateToWidth(painted, 0), painted);
});
