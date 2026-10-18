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

test("doRender 输出以清屏序列开头且包含 renderFn 返回的行", async () => {
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
