/**
 * serve 会话级 compaction（L3-3）与进程内句柄冒烟测试。
 *
 * 覆盖：
 * - L3-3：大输出导致超窗 → run 前压缩 → conversations JSONL 出现 compaction 消息
 *   → 第二次 run 的请求体确实变小且落在窗口内；
 * - 句柄冒烟：createConversation / listConversations / createRun / subscribeRun
 *   / subscribeConversation（--web 共享事件流的底层能力）。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { createOhnaServer } from "../dist/index.js";

/** 小窗口模型：让两次 run 之间的压缩真实触发。 */
const MODEL = {
  id: "stub-model",
  name: "Stub Model",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://127.0.0.1/mock",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 6_000,
  maxTokens: 4_096
};

/** 超长回复：约 40KB 文本 ≈ 10k token，必然超过 6k 窗口的阈值。 */
const BIG_TEXT = "A".repeat(40_000);

/**
 * 测试 StreamFn：摘要调用返回短摘要；对话调用返回超长文本并记录请求体。
 *
 * @param {object[]} captured 对话请求的消息序列记录。
 * @returns {Function} StreamFn。
 */
function createBigTextStream(captured) {
  return (model, context) => {
    const stream = createAssistantMessageEventStream();
    if (context.systemPrompt?.includes("上下文压缩器")) {
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "这是压缩摘要" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now()
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: message.content[0].text, partial: message });
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    }
    captured.push(JSON.stringify(context.messages).length);
    const message = {
      role: "assistant",
      content: [{ type: "text", text: BIG_TEXT }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 10_000, output: 10_000, cacheRead: 0, cacheWrite: 0, totalTokens: 20_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now()
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "text_delta", contentIndex: 0, delta: BIG_TEXT, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: BIG_TEXT, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

/**
 * 创建隔离的测试服务。
 *
 * @param {Function} streamFn StreamFn。
 * @returns {Promise<{server: object, root: string, dataDir: string}>}
 */
async function createTestServer(streamFn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-serve-compact-"));
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const server = await createOhnaServer({
    workspaceRoot,
    dataDir,
    model: MODEL,
    apiKey: "test-key",
    systemPrompt: "test system prompt",
    tools: [],
    staticDir: path.join(root, "web-dist"),
    streamFn
  });
  return { server, root, dataDir };
}

/**
 * 等待 run 到达终态。
 *
 * @param {object} server 服务句柄。
 * @param {string} runId run id。
 * @returns {Promise<object>} 终态快照。
 */
async function waitForTerminal(server, runId) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = await server.app.inject({ method: "GET", url: `/api/runs/${runId}` });
    const data = snapshot.json().data;
    if (["completed", "failed", "cancelled", "interrupted"].includes(data?.status)) return data;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not reach terminal state.");
}

test("L3-3: run 前压缩把 compaction 消息落盘且第二次 run 请求体落在窗口内", async () => {
  const captured = [];
  const { server, root, dataDir } = await createTestServer(createBigTextStream(captured));
  try {
    const conversation = await server.createConversation("压缩测试");
    // 第一次 run：历史为空不压缩；回复本身超长，把历史顶过阈值。
    const first = await server.createRun({ conversationId: conversation.conversationId, message: "第一次" });
    const firstSnapshot = await waitForTerminal(server, first.accepted.runId);
    assert.equal(firstSnapshot.status, "completed");

    // 第二次 run：载入超长历史 → run 前压缩 → 请求体必须落在窗口内。
    const second = await server.createRun({ conversationId: conversation.conversationId, message: "第二次" });
    const secondSnapshot = await waitForTerminal(server, second.accepted.runId);
    assert.equal(secondSnapshot.status, "completed");

    assert.equal(captured.length, 2, "应有两次对话请求");
    const secondRequestTokens = Math.ceil(captured[1] / 4);
    assert.ok(
      secondRequestTokens <= MODEL.contextWindow,
      `第二次 run 请求 chars/4=${secondRequestTokens} 应 <= 窗口 ${MODEL.contextWindow}`,
    );
    assert.ok(captured[1] < captured[0] + 40_000, "第二次请求体不应原样携带全部超长历史");

    // conversations JSONL 出现 compaction 消息。
    const files = await fs.readdir(path.join(dataDir, "conversations"));
    const jsonl = await fs.readFile(path.join(dataDir, "conversations", files[0]), "utf8");
    const lines = jsonl.trimEnd().split("\n").map((line) => JSON.parse(line));
    const compactionLines = lines.filter((line) => line.messageType === "compaction");
    assert.ok(compactionLines.length >= 1, "应存在 messageType=compaction 的持久化消息");
    assert.equal(compactionLines[0].role, "user");
    assert.ok(String(compactionLines[0].content).includes("这是压缩摘要"));

    // 线性消息端点也能读到该消息（浏览器「历史已压缩」分隔条的数据源）。
    const page = await server.app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.conversationId}/messages`
    });
    const items = page.json().data.items;
    assert.ok(items.some((item) => item.messageType === "compaction"));
  } finally {
    await server.shutdown();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("句柄冒烟：createConversation / subscribeRun / subscribeConversation", async () => {
  const captured = [];
  const { server, root } = await createTestServer(createBigTextStream(captured));
  try {
    const conversation = await server.createConversation("句柄冒烟");
    assert.ok(conversation.conversationId);
    const list = await server.listConversations();
    assert.ok(list.some((item) => item.conversationId === conversation.conversationId));

    // 会话级订阅先于 run 建立：run 的事件必须全部到达终端侧 listener。
    const events = [];
    let terminal = null;
    const unsubscribe = server.subscribeConversation(conversation.conversationId, (event) => {
      events.push(event);
      if (event.type === "run_status") terminal = event.payload.status;
    });

    const accepted = await server.createRun({ conversationId: conversation.conversationId, message: "你好" });
    for (let attempt = 0; attempt < 300 && terminal === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    unsubscribe();
    assert.equal(terminal, "completed", "订阅应收到 run_status 终态");
    assert.ok(events.some((event) => event.type === "agent_end"), "订阅应收到 agent_end");

    // subscribeRun 对已结束 run 是 noop（退订函数可安全调用）。
    const stop = server.subscribeRun(accepted.accepted.runId, () => {});
    stop();
  } finally {
    await server.shutdown();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
