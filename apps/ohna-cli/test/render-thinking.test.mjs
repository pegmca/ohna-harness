/**
 * F-3 thinking 降级展示单测：spinner 被整屏模式禁用时，默认模式追加一次 `✻ 思考中…`。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createUsageTracker, foldOutput, renderEvent, reprintRecentFolded, resetFoldCache, setVerbose } from "../dist/render.js";
import { setSpinnerEnabled } from "../dist/spinner.js";

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

test("resetFoldCache：/clear /resume 后 ctrl+o 不再重打上一会话的折叠块", () => {
  const longText = Array.from({ length: 200 }, (_, index) => `line-${index}`).join("\n");
  foldOutput(longText);
  resetFoldCache();
  setVerbose(true);
  const out = captureStdout(() => reprintRecentFolded());
  setVerbose(false);
  assert.match(out, /还没有折叠过工具输出/);
  assert.doesNotMatch(out, /line-50/, "已清理的全文不得再被重打");
});
