/**
 * 输入路由模式栈单测（Phase C2）：模式优先级、穿透、弹栈恢复、confirm 独占与全局键裁决。
 *
 * 用假模式记录 `handle` 调用顺序，无需真实终端。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { InputRouter, isTransientMode } from "../dist/ui/tui/input-router.js";
import { isEscapeKey, matchesKey, paletteFooter } from "../dist/ui/tui/keymap.js";

/** 构造一个记录调用的假模式。 */
function mode(id, options = {}) {
  const calls = [];
  return {
    id,
    calls,
    handle(data) {
      calls.push(data);
      return options.handled?.(data) ?? true;
    },
    exclusive: options.exclusive,
    onExit: options.onExit,
  };
}

test("模式优先级：栈顶先消费，未消费才穿透到下一层", () => {
  const router = new InputRouter();
  const bottom = mode("editor");
  const top = mode("palette", { handled: (data) => data === "x" });
  router.push(bottom);
  router.push(top);

  assert.equal(router.dispatch("x"), true);
  assert.deepEqual(top.calls, ["x"]);
  assert.deepEqual(bottom.calls, [], "顶栈已消费时不得穿透");

  assert.equal(router.dispatch("y"), true, "落到底栈仍算消费");
  assert.deepEqual(bottom.calls, ["y"], "顶栈未消费时应穿透");
});

test("弹栈恢复：Esc 关闭弹出模式并触发 onExit，后续按键回到下一层", () => {
  const router = new InputRouter();
  const bottom = mode("editor");
  let exited = 0;
  const top = mode("file-palette", { onExit: () => (exited += 1) });
  router.push(bottom);
  router.push(top);
  assert.deepEqual(router.stack(), ["editor", "file-palette"]);

  assert.equal(router.dispatch("\x1b"), true);
  assert.equal(exited, 1, "弹栈应触发 onExit");
  assert.deepEqual(router.stack(), ["editor"]);

  router.dispatch("a");
  assert.deepEqual(bottom.calls, ["a"], "弹栈后按键回到 editor");
});

test("confirm 独占：顶栈为 exclusive 时吞掉一切，且不穿透、不触发全局键", () => {
  let interrupts = 0;
  const router = new InputRouter({ onInterrupt: () => (interrupts += 1) });
  const bottom = mode("editor");
  const confirm = mode("confirm", { exclusive: true, handled: () => false });
  router.push(bottom);
  router.push(confirm);

  assert.equal(router.dispatch("\x03"), true, "Ctrl+C 被 confirm 独占");
  assert.equal(router.dispatch("x"), true);
  assert.equal(interrupts, 0, "confirm 期间不得触发全局中断");
  assert.deepEqual(bottom.calls, [], "confirm 期间不得穿透到 editor");
});

test("全局键裁决：Ctrl+O / Shift+Tab / Esc 在无弹出模式时回调宿主，不落 editor", () => {
  const events = [];
  const router = new InputRouter({
    onVerbose: () => events.push("verbose"),
    onModeCycle: () => events.push("mode"),
    onEscape: () => events.push("escape"),
  });
  const bottom = mode("editor");
  router.push(bottom);

  assert.equal(router.dispatch("\x0f"), true);
  assert.equal(router.dispatch("\x1b[Z"), true);
  assert.equal(router.dispatch("\x1b"), true);
  assert.deepEqual(events, ["verbose", "mode", "escape"]);
  assert.deepEqual(bottom.calls, [], "全局键不再优先落 editor");
});

test("全局键裁决：Ctrl+C 无弹出模式时中断；有弹出模式时先关闭模式", () => {
  let interrupts = 0;
  const router = new InputRouter({ onInterrupt: () => (interrupts += 1) });
  router.push(mode("editor"));
  assert.equal(router.dispatch("\x03"), true);
  assert.equal(interrupts, 1);

  let exited = 0;
  router.push(mode("session-picker", { onExit: () => (exited += 1) }));
  assert.equal(router.dispatch("\x03"), true);
  assert.equal(exited, 1, "弹出模式应被关闭");
  assert.equal(interrupts, 1, "关闭弹出模式不应额外触发中断");
});

test("双击 Esc：连续 Esc 逐次交给宿主累积双击窗口", () => {
  let escapes = 0;
  const router = new InputRouter({ onEscape: () => (escapes += 1) });
  router.push(mode("editor"));
  assert.equal(router.dispatch("\x1b\x1b"), true);
  assert.equal(escapes, 2, "两个 Esc 字节应产生两次 onEscape 回调");
});

test("Esc 判定与键名匹配：方向键不被误判为 Esc", () => {
  assert.equal(isEscapeKey("\x1b"), true);
  assert.equal(isEscapeKey("\x1b\x1b"), true);
  assert.equal(isEscapeKey("\x1b[A"), false, "方向键是 CSI 序列，不是独立 Esc");
  assert.equal(matchesKey("up/down", "\x1b[A"), true);
  assert.equal(matchesKey("up/down", "\x1b[B"), true);
  assert.equal(matchesKey("up/down", "\x1b[C"), false);
  assert.equal(matchesKey("ctrl+o", "\x0f"), true);
});

test("palette footer 从 keymap 生成", () => {
  assert.equal(paletteFooter(), "↑/↓ 选择 · Tab 补全 · Enter 执行 · Esc 关闭");
});

test("isTransientMode：picker / palette / file-palette 为弹出模式，editor / confirm 不是", () => {
  assert.equal(isTransientMode("session-picker"), true);
  assert.equal(isTransientMode("palette"), true);
  assert.equal(isTransientMode("file-palette"), true);
  assert.equal(isTransientMode("editor"), false);
  assert.equal(isTransientMode("confirm"), false);
});
