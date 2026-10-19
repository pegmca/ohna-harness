import test from "node:test";
import assert from "node:assert/strict";
import { Screen } from "../dist/index.js";

/**
 * 假终端：实现 Terminal 接口子集，记录写出的内容、clearScreen 次数，
 * 并捕获 resize 监听，便于无真实 TTY 地验证 Screen 的节流与幂等重绘。
 */
class FakeTerminal {
  constructor(cols = 80, rows = 24) {
    this.columns = cols;
    this.rows = rows;
    /** 所有写出的片段（clearScreen 也记一笔清屏序列），用于顺序断言。 */
    this.out = [];
    /** clearScreen 调用次数：节流证明的核心计数。 */
    this.clearCount = 0;
    /** 捕获的 resize 回调。 */
    this.resizeCb = null;
    /** 捕获的输入回调（由 Screen 注入）。 */
    this.inputCb = null;
  }

  start(onInput, onResize) {
    this.inputCb = onInput;
    this.resizeCb = onResize;
  }

  /** 模拟 stdin 收到数据，驱动 Screen 的输入透传。 */
  pushInput(data) {
    this.inputCb && this.inputCb(data);
  }

  stop() {}

  write(s) {
    this.out.push(s);
  }

  clearScreen() {
    this.clearCount += 1;
    this.out.push("\x1b[2J\x1b[H");
  }

  clearLine() {
    this.out.push("\x1b[K");
  }

  moveCursorUp(n = 1) {
    this.out.push(`\x1b[${n}A`);
  }

  moveCursorDown(n = 1) {
    this.out.push(`\x1b[${n}B`);
  }

  moveCursorToColumn(n = 1) {
    this.out.push(`\x1b[${n}G`);
  }
}

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test("requestRender 节流：同 tick 多次请求只触发一次 doRender（不风暴）", async () => {
  const t = new FakeTerminal();
  const s = new Screen(t);
  let renderCalls = 0;
  s.setRenderFn(() => {
    renderCalls += 1;
    return ["hello"];
  });
  s.start();

  // 同 tick 内连续请求
  s.requestRender();
  s.requestRender();
  s.requestRender();
  s.requestRender();

  // 定时器触发前不应渲染
  assert.equal(t.clearCount, 0);
  assert.equal(renderCalls, 0);

  await flush();

  // 只清屏一次、只生成一帧 —— 证明没有风暴
  assert.equal(t.clearCount, 1, "clearScreen 应只调用一次");
  assert.equal(renderCalls, 1, "renderFn 应只调用一次");

  s.stop();
});

test("首帧 doRender 输出以清屏序列开头且包含 renderFn 返回的行", async () => {
  const t = new FakeTerminal();
  const s = new Screen(t);
  s.setRenderFn(() => ["line-a", "line-b"]);
  s.start();
  s.requestRender();

  await flush();

  assert.equal(t.clearCount, 1);
  const full = t.out.join("");
  assert.ok(full.startsWith("\x1b[2J\x1b[H"), "输出应以清屏序列开头");
  assert.ok(full.includes("line-a"), "应包含第一行");
  assert.ok(full.includes("line-b"), "应包含第二行");

  s.stop();
});

test("force=true 会立即重绘且不依赖已排程的节流", async () => {
  const t = new FakeTerminal();
  const s = new Screen(t);
  let renderCalls = 0;
  s.setRenderFn(() => {
    renderCalls += 1;
    return ["x"];
  });
  s.start();

  s.requestRender(); // 进入节流窗口
  s.requestRender(true); // 强制：清掉已排程，立即排程

  await flush();

  // 至少有一次来自 force 的立即重绘
  assert.equal(renderCalls, 1);
  assert.equal(t.clearCount, 1);

  s.stop();
});

test("resize 回调只触发一次节流重绘", async () => {
  const t = new FakeTerminal();
  const s = new Screen(t);
  let renderCalls = 0;
  s.setRenderFn(() => {
    renderCalls += 1;
    return ["frame"];
  });
  s.start();

  // 模拟连续 resize（如拖动窗口）
  t.resizeCb && t.resizeCb();
  t.resizeCb && t.resizeCb();
  t.resizeCb && t.resizeCb();

  await flush();

  // 连续 resize 同 tick 内只重绘一次
  assert.equal(t.clearCount, 1);
  assert.equal(renderCalls, 1);

  s.stop();
});

test("输入透过 Screen 转发给 onInput 回调", () => {
  const t = new FakeTerminal();
  const s = new Screen(t);
  const received = [];
  s.setOnInput((data) => received.push(data));
  s.start();

  // Screen 不实现编辑，只把终端 stdin 数据透传给 onInput 回调
  t.pushInput("a");
  t.pushInput("\x1b[D");
  assert.deepEqual(received, ["a", "\x1b[D"]);

  s.stop();
});

test("两帧完全相同：第二次 doRender 不写入任何内容、不清屏", async () => {
  const t = new FakeTerminal();
  const s = new Screen(t);
  s.setRenderFn(() => ["stable-a", "stable-b"]);
  s.start();

  s.requestRender();
  await flush();
  const writesAfterFirst = t.out.length;
  assert.equal(t.clearCount, 1);

  s.requestRender();
  await flush();

  // 差分语义：内容一字不差时连光标移动都不写，stdout 零增量。
  assert.equal(t.out.length, writesAfterFirst, "相同帧不应产生额外写入");
  assert.equal(t.clearCount, 1, "相同帧不应再次清屏");

  s.stop();
});

test("仅最后一行变化：只重写该行，不重写未变化行", async () => {
  const t = new FakeTerminal();
  const s = new Screen(t);
  let frame = ["line-a", "line-b"];
  s.setRenderFn(() => frame);
  s.start();

  s.requestRender();
  await flush();
  const writesAfterFirst = t.out.length;

  frame = ["line-a", "line-b2"];
  s.requestRender();
  await flush();

  const diffOutput = t.out.slice(writesAfterFirst).join("");
  assert.ok(diffOutput.includes("line-b2"), "应重写变化的最后一行");
  assert.ok(!diffOutput.includes("line-a"), "未变化的行不应被重写");
  assert.equal(t.clearCount, 1, "常规行差分不应整屏清屏");

  s.stop();
});

test("行数减少：末尾多余行被 clearLine 逐行清除", async () => {
  const t = new FakeTerminal();
  const s = new Screen(t);
  let frame = ["one", "two", "three"];
  s.setRenderFn(() => frame);
  s.start();

  s.requestRender();
  await flush();
  const writesAfterFirst = t.out.length;

  frame = ["one"];
  s.requestRender();
  await flush();

  const diffChunks = t.out.slice(writesAfterFirst);
  const clearLines = diffChunks.filter((chunk) => chunk === "\x1b[K").length;
  assert.equal(clearLines, 2, "两行残留应各被 clearLine 清除一次");
  assert.equal(t.clearCount, 1, "行数减少不应整屏清屏");
  const joined = diffChunks.join("");
  assert.ok(!joined.includes("two") && !joined.includes("three"), "不应重写被删除的行");

  s.stop();
});

test("resize（列数或行数变化）触发全量重绘：clearScreen 再次调用且所有行重写", async () => {  const t = new FakeTerminal(80, 24);
  const s = new Screen(t);
  s.setRenderFn(() => ["r1", "r2"]);
  s.start();

  s.requestRender();
  await flush();
  assert.equal(t.clearCount, 1);

  // 变宽
  let writesBefore = t.out.length;
  t.columns = 100;
  t.resizeCb && t.resizeCb();
  await flush();

  assert.equal(t.clearCount, 2, "列数变化应触发全量清屏重绘");
  const afterWidth = t.out.slice(writesBefore).join("");
  assert.ok(afterWidth.startsWith("\x1b[2J\x1b[H"), "全量重绘应以清屏开头");
  assert.ok(afterWidth.includes("r1") && afterWidth.includes("r2"), "所有行都应重写");

  // 变高
  writesBefore = t.out.length;
  t.rows = 40;
  t.resizeCb && t.resizeCb();
  await flush();

  assert.equal(t.clearCount, 3, "行数变化也应触发全量清屏重绘");
  const afterHeight = t.out.slice(writesBefore).join("");
  assert.ok(afterHeight.startsWith("\x1b[2J\x1b[H"), "行数变化后的全量重绘应以清屏开头");

  s.stop();
});

test("renderFn 返回行数超过 rows 时只写前 rows 行（M1 防御性钳制）", async () => {
  const t = new FakeTerminal(80, 3); // 屏高仅 3 行
  const s = new Screen(t);
  let frame = ["l1", "l2", "l3", "l4", "l5"];
  s.setRenderFn(() => frame);
  s.start();

  // 全量重绘路径：超过屏高的行必须被丢弃。
  s.requestRender();
  await flush();
  const full = t.out.join("");
  assert.equal(t.clearCount, 1);
  assert.ok(full.includes("l1") && full.includes("l3"), "屏高内的行应写出");
  assert.ok(!full.includes("l4") && !full.includes("l5"), "超过 rows 的行必须被丢弃");

  // 差分路径同样受限：新帧即便返回更多行，也只比较 / 重写前 rows 行。
  const before = t.out.length;
  frame = ["a1", "a2", "a3", "a4", "a5"];
  s.requestRender();
  await flush();
  const diff = t.out.slice(before).join("");
  assert.ok(diff.includes("a1") && diff.includes("a3"), "变化行应重写");
  assert.ok(!diff.includes("a4") && !diff.includes("a5"), "差分不得写出超过屏高的行");

  s.stop();
});
