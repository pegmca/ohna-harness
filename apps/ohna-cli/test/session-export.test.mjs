/**
 * F-8 `/export`：Markdown 格式（文本 / 工具调用 / 工具结果截断）与路径边界。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { exportSessionMarkdown, formatSessionMarkdown } from "../dist/session-export.js";

/** assistant 消息的最小合法形状。 */
const assistant = {
  role: "assistant",
  api: "openai-completions",
  provider: "test",
  model: "test-model",
  usage: {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: 2,
};

test("formatSessionMarkdown：包含标题、用户 / 助手 / 工具调用与结果截断", () => {
  const markdown = formatSessionMarkdown(
    {
      sessionId: "s1",
      title: "测试会话",
      model: "test-model",
      usage: { input: 1, output: 2, total: 3, cost: 0.5, reasoning: 1 },
      messages: [
        { role: "user", content: [{ type: "text", text: "请列目录" }], timestamp: 1 },
        {
          ...assistant,
          content: [
            { type: "text", text: "好的" },
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "x".repeat(1000) }],
          isError: false,
          timestamp: 3,
        },
      ],
    },
    new Date("2026-01-02T03:04:05.000Z"),
  );

  assert.match(markdown, /^# ohna 会话导出/);
  assert.match(markdown, /- 标题：测试会话/);
  assert.match(markdown, /- 模型：test-model/);
  assert.match(markdown, /2026-01-02T03:04:05.000Z/);
  assert.match(markdown, /推理 1/);
  assert.match(markdown, /## 用户[\s\S]*请列目录/);
  assert.match(markdown, /## 助手[\s\S]*好的/);
  assert.match(markdown, /### 工具调用 `bash`[\s\S]*"command":"ls"/);
  assert.match(markdown, /## 工具结果 `bash`/);
  assert.match(markdown, /已截断 200 字符/, "1000 字工具结果截断到 800");
});

test("exportSessionMarkdown：写入指定目录并返回路径", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ohna-export-"));
  try {
    const result = await exportSessionMarkdown(
      {
        sessionId: "abc_123",
        model: "m",
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
      },
      { dir, now: new Date("2026-01-01T00:00:00.000Z") },
    );
    assert.equal(result.ok, true);
    assert.equal(result.path, path.join(dir, "abc_123.md"));
    const content = await readFile(result.path, "utf8");
    assert.match(content, /hi/);
    if (process.platform !== "win32") {
      const info = await stat(result.path);
      assert.equal(info.mode & 0o777, 0o600, "导出文件只允许当前用户读写");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("exportSessionMarkdown：非法 sessionId 拒绝写入（防路径逃逸）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ohna-export-"));
  try {
    const result = await exportSessionMarkdown(
      { sessionId: "../escape", model: "m", messages: [] },
      { dir },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /非法会话 id/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
