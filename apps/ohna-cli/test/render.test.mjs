/**
 * 渲染层折叠单测：超长 tool_execution_end 文本被折叠且含 `… +N 行` 标记；错误保留前 400 字符；
 * write 的写前 diff 预览（新文件全 +）；符号已换为 ⏺ / ⎿ / ✗（M6 主题）；非 TTY 输出无 ANSI。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageTracker, foldOutput, renderEvent, renderToolDiff } from "../dist/ui/render.js";

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

test("foldOutput：超长输出被折叠且含 `… +N 行` 标记", () => {
  const longText = Array.from({ length: 200 }, (_, index) => `line-${index}`).join("\n");
  const folded = foldOutput(longText);
  assert.match(folded, /\+(\d+) 行/);
  assert.match(folded, /^line-0\n/m, "应保留头部");
  assert.match(folded, /line-199\s*$/m, "应保留尾部");
  assert.doesNotMatch(folded, /line-50/, "中段内容不应出现");

  // 短文本原样返回。
  assert.equal(foldOutput("short"), "short");
});

test("renderEvent：超长 bash 结果折叠、isError 保留完整前 400 字符", () => {
  const tracker = createUsageTracker();
  const longOutput = Array.from({ length: 100 }, (_, index) => `out-${index}`).join("\n");

  const success = captureStdout(() =>
    renderEvent(
      { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: longOutput }] }, isError: false },
      tracker,
      {},
    ),
  );
  assert.match(success, /⎿/);
  assert.match(success, /\+(\d+) 行/);

  const errorText = "E".repeat(600);
  const failure = captureStdout(() =>
    renderEvent(
      { type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: { content: [{ type: "text", text: errorText }] }, isError: true },
      tracker,
      {},
    ),
  );
  assert.match(failure, /⎿.*✗.*E{400}/);
  assert.equal(failure.includes("E".repeat(401)), false, "错误信息应截断在 400 字符");
});

test("renderToolDiff：write 新文件打印全 + diff；edit 在磁盘内容上做替换", () => {
  const root = mkdtempSync(join(tmpdir(), "ohna-render-"));
  try {
    // write：磁盘上不存在 → 新文件 diff。
    const writeDiff = renderToolDiff("write", { path: join(root, "new.txt"), content: "hello\nworld" }, { workspaceRoot: root });
    assert.match(writeDiff, /@@ -0,0 \+1,2 @@/);
    assert.match(writeDiff, /\+hello/);
    assert.match(writeDiff, /\+world/);

    // edit：磁盘存在目标内容 → 生成替换后的 diff。
    writeFileSync(join(root, "app.ts"), "const a = 1;\n");
    const editDiff = renderToolDiff("edit", { path: "app.ts", oldText: "const a = 1;", newText: "const a = 2;" }, { workspaceRoot: root });
    assert.match(editDiff, /-const a = 1;/);
    assert.match(editDiff, /\+const a = 2;/);

    // edit：磁盘无匹配 → 不出 diff（工具层会报错）。
    const noMatch = renderToolDiff("edit", { path: "app.ts", oldText: "不存在的文本", newText: "x" }, { workspaceRoot: root });
    assert.equal(noMatch, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderEvent：write 的 tool_execution_start 在确认前打印 diff", () => {
  const root = mkdtempSync(join(tmpdir(), "ohna-render-"));
  try {
    const out = captureStdout(() =>
      renderEvent(
        { type: "tool_execution_start", toolCallId: "t3", toolName: "write", args: { path: join(root, "note.txt"), content: "正文" } },
        createUsageTracker(),
        { workspaceRoot: root },
      ),
    );
    assert.match(out, /⏺ write\(/);
    assert.match(out, /\+正文/, "diff 应出现在 tool_execution_start 的输出里");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderEvent：懒打点——首个 text_delta 打 ⏺，纯 tool-call 消息不打", () => {
  // 文本消息：首个 text_delta 打 ⏺。
  const tracker = createUsageTracker();
  const withText = captureStdout(() => {
    renderEvent({ type: "message_start", message: { role: "assistant", content: [] } }, tracker, {});
    renderEvent(
      { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "你好" } },
      tracker,
      {},
    );
    renderEvent(
      { type: "message_end", message: { role: "assistant", content: [], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } },
      tracker,
      {},
    );
  });
  assert.match(withText, /⏺ 你好/);

  // 纯 tool-call 消息：无 text_delta，不产生悬空 ⏺ 行。
  const tracker2 = createUsageTracker();
  const pureTool = captureStdout(() => {
    renderEvent({ type: "message_start", message: { role: "assistant", content: [] } }, tracker2, {});
    renderEvent(
      { type: "message_update", message: {}, assistantMessageEvent: { type: "toolcall_delta" } },
      tracker2,
      {},
    );
    renderEvent(
      { type: "message_end", message: { role: "assistant", content: [], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } },
      tracker2,
      {},
    );
  });
  assert.doesNotMatch(pureTool, /⏺/, "纯 tool-call 消息不应打 ⏺");
});

test("renderEvent：非 TTY 输出不含任何 \\x1b 转义", () => {  const tracker = createUsageTracker();
  const out = captureStdout(() => {
    renderEvent({ type: "agent_start" }, tracker, {});
    renderEvent({ type: "message_start", message: { role: "assistant", content: [] } }, tracker, {});
    renderEvent(
      { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "你好" } },
      tracker,
      {},
    );
    renderEvent(
      { type: "message_end", message: { role: "assistant", content: [], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } },
      tracker,
      {},
    );
    renderEvent(
      { type: "tool_execution_start", toolCallId: "t4", toolName: "bash", args: { command: "ls" } },
      tracker,
      {},
    );
    renderEvent(
      { type: "tool_execution_end", toolCallId: "t4", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false },
      tracker,
      {},
    );
    renderEvent({ type: "agent_end", messages: [] }, tracker, {});
  });
  assert.equal(out.includes("\x1b"), false, "非 TTY 渲染不得产生 ANSI 转义序列");
});

test("foldOutput：非 TTY 提示指向 /export（M3），不再出现不可执行的 ctrl+o", () => {
  const longText = Array.from({ length: 200 }, (_, index) => `line-${index}`).join("\n");
  const defaultHint = foldOutput(longText);
  assert.match(defaultHint, /完整输出见 \/export/);
  assert.doesNotMatch(defaultHint, /ctrl\+o/, "非 TTY 打印路径不应出现 ctrl+o 提示");

  // TUI 路径显式传入自己的文案（rows.ts 的调用），折叠逻辑不复制。
  const tuiHint = foldOutput(longText, "（ctrl+o 展开分组 · 完整输出见 /export）");
  assert.match(tuiHint, /ctrl\+o 展开分组/);
  assert.match(tuiHint, /完整输出见 \/export/);
});

test("renderEvent：超长 bash 结果的折叠提示只指向 /export（M3）", () => {
  const tracker = createUsageTracker();
  const longOutput = Array.from({ length: 100 }, (_, index) => `out-${index}`).join("\n");
  const out = captureStdout(() =>
    renderEvent(
      { type: "tool_execution_end", toolCallId: "m3", toolName: "bash", result: { content: [{ type: "text", text: longOutput }] }, isError: false },
      tracker,
      {},
    ),
  );
  assert.match(out, /完整输出见 \/export/);
  assert.doesNotMatch(out, /ctrl\+o/);
});
