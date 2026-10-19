/**
 * 跨 chunk 输入序列拼装器单测（B2）。
 *
 * 覆盖 reviewer 的复现场景：
 * - 完整 CSI 不延迟（即时返回）；
 * - 拆分 CSI（`\x1b` + `[A`）拼回一个完整序列，绝不把半截 `\x1b` 当 Esc；
 * - 拆分 bracketed paste 起止标记；
 * - lone Esc 超时兜底分发；
 * - 连续 chunk 逐字节拼装；
 * - `dispose()` 清理定时器。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TIMEOUT_MS, InputAssembler } from "../dist/ui/tui/input-assembler.js";

/** 等待若干毫秒（超时兜底断言用）。 @param ms 毫秒。 @returns Promise。 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 构造一个记录超时分发的拼装器。
 *
 * @param timeoutMs 超时毫秒（测试用较短值）。
 * @returns `{ assembler, flushed }`（flushed 为超时分发列表）。
 */
function make(timeoutMs = 10) {
  const flushed = [];
  const assembler = new InputAssembler({ onFlush: (data) => flushed.push(data), timeoutMs });
  return { assembler, flushed };
}

test("完整序列立即返回，不延迟（CSI / 两字节 Alt+键 / 普通文本）", () => {
  const { assembler, flushed } = make();
  assert.deepEqual(assembler.feed("\x1b[A"), ["\x1b[A"], "完整 CSI 应立即分发");
  assert.deepEqual(assembler.feed("\x1bA"), ["\x1bA"], "两字节 Alt+键应立即分发");
  assert.deepEqual(assembler.feed("hello"), ["hello"], "普通文本段应立即分发");
  assert.deepEqual(flushed, [], "完整序列不应触发超时兜底");
});

test("拆分 CSI：\\x1b + [A 拼回一个方向键，而非 Esc + 字符", () => {
  const { assembler, flushed } = make();
  assert.deepEqual(assembler.feed("\x1b"), [], "半截 ESC 先缓冲");
  assert.deepEqual(assembler.feed("[A"), ["\x1b[A"], "补全后应作为一个完整 CSI 分发");
  assert.deepEqual(flushed, [], "拼装成功则不应再走超时兜底");
});

test("连续 chunk 逐字节拼装：\\x1b + [ + 1 + ~ 拼出 Home", () => {
  const { assembler } = make();
  assert.deepEqual(assembler.feed("\x1b"), []);
  assert.deepEqual(assembler.feed("["), []);
  assert.deepEqual(assembler.feed("1"), []);
  assert.deepEqual(assembler.feed("~"), ["\x1b[1~"]);
});

test("拆分 bracketed paste：起止标记跨 chunk 也能还原", () => {
  const { assembler } = make();
  assert.deepEqual(assembler.feed("\x1b[20"), [], "被切开的起始标记先缓冲");
  assert.deepEqual(
    assembler.feed("0~hello\x1b[201~"),
    ["\x1b[200~", "hello", "\x1b[201~"],
    "起始标记 + 粘贴内容 + 结束标记逐段还原",
  );
});

test("lone Esc 超时后原样分发（Esc 不失效）", async () => {
  const { assembler, flushed } = make(10);
  assert.deepEqual(assembler.feed("\x1b"), [], "单个 ESC 不确定是 Esc 还是 CSI 前缀，先缓冲");
  await wait(30);
  assert.deepEqual(flushed, ["\x1b"], "超时后应把 pending 原样分发为 Esc 手势");
});

test("超时前到来下一 chunk 时取消兜底（不重复分发）", async () => {
  const { assembler, flushed } = make(10);
  assert.deepEqual(assembler.feed("\x1b"), []);
  assert.deepEqual(assembler.feed("[B"), ["\x1b[B"]);
  await wait(30);
  assert.deepEqual(flushed, [], "已拼装完成的序列不应再走超时兜底");
});

test("\\x1b\\x1b：首个独立 Esc 立即分发，第二个走超时（双击仍先后到达）", async () => {
  const { assembler, flushed } = make(10);
  assert.deepEqual(assembler.feed("\x1b\x1b"), ["\x1b"], "首个 ESC 后紧跟 ESC，必为独立 Esc");
  await wait(30);
  assert.deepEqual(flushed, ["\x1b"], "第二个 ESC 超时兜底分发，落在双击窗口内");
});

test("普通文本与转义序列混排，保持顺序且不丢字节", () => {
  const { assembler } = make();
  assert.deepEqual(assembler.feed("a\x1b[Db\x1b"), ["a", "\x1b[D", "b"], "尾部半截 ESC 缓冲待拼");
});

test("dispose 清理定时器：停机后不再有悬挂分发", async () => {
  const { assembler, flushed } = make(10);
  assembler.feed("\x1b");
  assembler.dispose();
  await wait(30);
  assert.deepEqual(flushed, [], "dispose 后定时器应被清理");
});

test("默认超时在文档约定区间（约 25–50ms）", () => {
  assert.ok(DEFAULT_TIMEOUT_MS >= 25 && DEFAULT_TIMEOUT_MS <= 50, `默认超时 ${DEFAULT_TIMEOUT_MS}ms 应在 25–50ms`);
});
