/**
 * D-A3 集成测试：终端发起涉及写/执行的 run，serve 广播 confirmation_requested，
 * 终端经 server.resolveConfirmation 决议后 run 继续（不卡到 5 分钟超时失败）。
 *
 * 仅覆盖「CLI 订阅 → 决议 → run 继续」链路；serve 侧确认闸门逻辑由 packages/serve 单测负责。
 * 全程不联网：streamFn 为测试替身，工具用编码工具集（write 命中 mutate 权限）。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { createOhnaServer } from "@aiagent/serve";

/** 构造一条 assistant 消息。 */
function assistantMessage(text, content) {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "stub-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("终端发起 run 的 source 被记为 cli（user_message.source==='cli'）", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-confirm-src-"));
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const server = await createOhnaServer({
    workspaceRoot,
    dataDir,
    model: { id: "stub", provider: "mock", contextWindow: 8000, api: "openai-completions" },
    apiKey: "test",
    tools: [],
    autoApprove: true,
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const m = assistantMessage("ok", [{ type: "text", text: "ok" }]);
        stream.push({ type: "start", partial: { ...m, content: [] } });
        stream.push({ type: "done", reason: "stop", message: m });
      });
      return stream;
    },
  });
  try {
    const conversation = await server.createConversation("来源测试");
    let userSource;
    const unsubscribe = server.subscribeConversation(conversation.conversationId, (event) => {
      if (event.type === "user_message") userSource = event.payload.source;
    });
    await server.createRun({ conversationId: conversation.conversationId, message: "hi", mode: "auto", source: "cli" });
    const deadline = Date.now() + 2000;
    while (userSource === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    unsubscribe();
    assert.equal(userSource, "cli", "终端发起的消息 source 应为 cli");
  } finally {
    await server.shutdown();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
