/**
 * F-3 thinking 降级展示 / C1 presenter 状态重置单测。
 *
 * 覆盖：
 * - spinner 被整屏模式禁用时，默认模式追加一次 `✻ 思考中…`；
 * - spinner 启用（非 TTY）时 thinking 交给 spinner，正文不重复提示；
 * - verbose（verbosity=high）时 thinking 走灰色斜体块，不打印占位行；
 * - C1 新语义：`resetPresentation()` 清空归约条目（折叠全文缓存已随 ctrl+o 重打语义删除）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createUsageTracker,
  printPresenter,
  renderEvent,
  resetPresentation,
  setSpinnerEnabled,
  setVerbose,
} from "../dist/ui/render.js";

/** 捕获 stdout 的工具函数。 */
function captureStdout(run) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

/** 构造 thinking_start 事件。 */
function thinkingStart() {
  return {
    type: "message_update",
    message: {},
    assistantMessageEvent: { type: "thinking_start" },
  };
}

test("spinner 禁用（TTY 整屏）：每条 assistant 消息只追加一次思考提示", () => {
  setSpinnerEnabled(false);
  setVerbose(false);
  const out = captureStdout(() => {
    renderEvent({ type: "message_start", message: { role: "assistant", content: [] } }, createUsageTracker(), {});
    renderEvent(thinkingStart(), createUsageTracker(), {});
    renderEvent(thinkingStart(), createUsageTracker(), {});
  });
  assert.match(out, /✻ 思考中…/);
  assert.equal(out.match(/思考中/g)?.length, 1, "同一消息内多段 thinking 不重复提示");
  setSpinnerEnabled(true);
});

test("spinner 启用（非 TTY）：thinking 交给 spinner，不追加提示行", () => {
  setSpinnerEnabled(true);
  setVerbose(false);
  const out = captureStdout(() => {
    renderEvent({ type: "message_start", message: { role: "assistant", content: [] } }, createUsageTracker(), {});
    renderEvent(thinkingStart(), createUsageTracker(), {});
  });
  assert.doesNotMatch(out, /思考中/, "spinner 模式下正文不应重复打印思考提示");
});

test("verbose：thinking 不进占位行，留给灰色斜体块", () => {
  setSpinnerEnabled(false);
  setVerbose(true);
  const out = captureStdout(() => {
    renderEvent({ type: "message_start", message: { role: "assistant", content: [] } }, createUsageTracker(), {});
    renderEvent(thinkingStart(), createUsageTracker(), {});
  });
  assert.doesNotMatch(out, /思考中/, "verbose 下应由 thinking_delta 的斜体块呈现");
  setVerbose(false);
  setSpinnerEnabled(true);
});

test("resetPresentation：/clear /resume 后 presenter 不残留上一会话条目", () => {
  // 先造一条 assistant 流式条目，确认归约器确实持有内容。
  renderEvent(
    { type: "message_start", message: { role: "assistant", content: [] } },
    createUsageTracker(),
    {},
  );
  renderEvent(
    { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "上一会话正文" } },
    createUsageTracker(),
    {},
  );
  assert.ok(printPresenter.entries().length > 0, "重置前应有上一会话的条目");

  // C1：会话切换调用 resetPresentation，条目与打印布局状态一并清空（折叠全文缓存已删除）。
  resetPresentation();
  assert.equal(printPresenter.entries().length, 0, "重置后不得残留上一会话条目");

  // 新会话重新开始时应从干净状态输出（不叠加旧内容）。
  const out = captureStdout(() => {
    renderEvent(
      { type: "message_start", message: { role: "assistant", content: [] } },
      createUsageTracker(),
      {},
    );
    renderEvent(
      { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "新会话首句" } },
      createUsageTracker(),
      {},
    );
  });
  assert.match(out, /⏺ 新会话首句/);
  assert.doesNotMatch(out, /上一会话正文/, "旧会话内容不得混入新会话输出");
  resetPresentation();
});
