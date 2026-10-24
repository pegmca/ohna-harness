/**
 * U1 / D-A2 渲染分流测试：renderFrame 对 user_message 帧按 source 分流——
 * source==="web" 渲染（终端订阅同一会话时显示 Web 端消息），source==="cli" 跳过
 * （本终端已本地回显，避免双打印）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderFrame, TERMINAL_RUN_STATUSES } from "../dist/cli/web-entry.js";

/** 捕获 renderFrame 对 web user_message 的直写输出。 */
function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

const noopTracker = { snapshot: () => ({ total: 0, cost: 0 }) };
const options = { workspaceRoot: process.cwd() };

test("user_message source=web 被渲染", () => {
  const out = captureStdout(() => {
    renderFrame(
      { type: "user_message", runId: "r1", payload: { messageId: "m1", content: "来自浏览器", runId: "r1", source: "web" } },
      noopTracker,
      options,
      null,
      () => {},
    );
  });
  assert.match(out, /来自浏览器/);
});

test("user_message source=cli 被跳过（不双打印）", () => {
  const out = captureStdout(() => {
    renderFrame(
      { type: "user_message", runId: "r1", payload: { messageId: "m1", content: "本地输入", runId: "r1", source: "cli" } },
      noopTracker,
      options,
      null,
      () => {},
    );
  });
  assert.equal(out, "", "cli 来源不应渲染");
});

test("TERMINAL_RUN_STATUSES 含终态集合", () => {
  assert.ok(TERMINAL_RUN_STATUSES.has("completed"));
  assert.ok(TERMINAL_RUN_STATUSES.has("failed"));
  assert.ok(TERMINAL_RUN_STATUSES.has("interrupted"));
});

test("agent 帧经 renderEvent 渲染（不静默丢弃，不抛错）", () => {
  assert.doesNotThrow(() => {
    renderFrame(
      {
        type: "message_start",
        runId: "r1",
        payload: { type: "message_start", message: { role: "assistant", content: [] } },
      },
      noopTracker,
      options,
      null,
      () => {},
    );
  });
});
