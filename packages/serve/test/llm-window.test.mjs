/**
 * serve 侧 v2.0 采集接线验收（docs/v2.0/04 §1.1 / §2.2 的最小面）。
 *
 * 托管 run 的 `llm_call` 记录**必须**带 `window`（模型窗口 + 输出预算 + 压缩预留），
 * 否则 web 的上下文占比面板无从计算；W2（§2.2 接线）之后还必须带 `agentId`
 * （主线程 = supervisor 根身份）。
 *
 * 断言口径：`window.contextWindow` 来自模型目录；`reserveTokens` 必须等于
 * `resolveCompactionSettings(contextWindow).reserveTokens`——即与 run 前压缩共用同一函数，
 * 防止两侧出现两套预留口径。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { resolveCompactionSettings, SUPERVISOR_AGENT_ID } from "@aiagent/agent";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { createOhnaServer } from "../dist/index.js";

const MODEL = {
  id: "stub-model",
  name: "Stub Model",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://127.0.0.1/mock",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096
};

/**
 * 构造一条 assistant 消息。
 *
 * @param {string} text 文本。
 * @returns {object} AssistantMessage。
 */
function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "mock",
    model: "stub-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  };
}

/**
 * 单轮文本流（在 adapter 位置调用 onPayload，模拟真实请求体构造时机）。
 *
 * @returns {Function} StreamFn。
 */
function createTextStream() {
  return (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    const message = assistantMessage("采集窗口参数已就绪。");
    queueMicrotask(async () => {
      // onPayload 在真实 adapter 里于「构造请求体之后、发 POST 之前」触发；
      // 采集层的 composition 正是在此现算。
      await options?.onPayload?.({ model: MODEL.id, stream: true }, MODEL);
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "采集窗口参数已就绪。", partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: "采集窗口参数已就绪。", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

/**
 * 创建隔离的测试服务。
 *
 * @param {Function} streamFn 测试 StreamFn。
 * @returns {Promise<object>} 测试上下文。
 */
async function createTestServer(streamFn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-serve-window-"));
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
  return { server, root };
}

/**
 * 清理服务与临时目录。
 *
 * @param {object} context 测试上下文。
 */
async function dispose(context) {
  await context.server.shutdown();
  await context.server.close();
  await fs.rm(context.root, { recursive: true, force: true });
}

/**
 * 解析 SSE 响应体中的 run_event 帧。
 *
 * @param {string} body SSE 文本。
 * @returns {object[]} 事件数组。
 */
function parseSseEvents(body) {
  return body
    .split("\n\n")
    .filter((frame) => frame.includes("event: run_event"))
    .map((frame) => {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      return JSON.parse(data);
    });
}

/**
 * 轮询直到 run 进入终态。
 *
 * @param {object} server 服务。
 * @param {string} snapshotUrl 快照地址。
 * @returns {Promise<object>} 终态快照。
 */
async function waitForTerminal(server, snapshotUrl) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = (await server.app.inject({ method: "GET", url: snapshotUrl })).json().data;
    if (["completed", "failed", "cancelled", "interrupted"].includes(snapshot?.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not reach terminal state.");
}

test("[v2.0] 托管 run 的 llm_call 记录带 window（窗口 / 输出预算 / 压缩预留）", async () => {
  const context = await createTestServer(createTextStream());
  try {
    const { server } = context;
    const conversation = await server.createConversation("窗口参数");
    const created = await server.createRun({ conversationId: conversation.conversationId, message: "你好" });
    await waitForTerminal(server, created.accepted.snapshotUrl);

    const sse = await server.app.inject({ method: "GET", url: created.accepted.eventsUrl });
    assert.equal(sse.statusCode, 200);
    const events = parseSseEvents(sse.body);
    const llmCall = events.find((event) => event.type === "llm_call");
    assert.ok(llmCall, "托管 run 必须产出一条 llm_call");

    const expectedReserve = resolveCompactionSettings(MODEL.contextWindow).reserveTokens;
    assert.deepEqual(llmCall.payload.window, {
      contextWindow: MODEL.contextWindow,
      maxTokens: MODEL.maxTokens,
      reserveTokens: expectedReserve
    });
    // W2（docs/v2.0/04 §2.2）接线后：主线程 loop 的 streamFn 薄转发补 `observer.agentId`，
    // 因此托管 run 的 llm_call **必须**带 supervisor 身份——「缺省归因」不再成立。
    assert.equal(llmCall.payload.agentId, SUPERVISOR_AGENT_ID);
    // onPayload 已被调用 → composition 应存在，且 total 等于五项之和。
    const composition = llmCall.payload.composition;
    assert.ok(composition, "onPayload 到达后应现算 composition");
    assert.equal(
      composition.total,
      composition.system + composition.tools + composition.user + composition.assistant + composition.toolResult
    );
  } finally {
    await dispose(context);
  }
});
