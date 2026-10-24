/**
 * serve 预算透传单测（docs/v1.4/06 §Phase A1 / TC-A1-01 / TC-A1-02）与确认决议共用生命周期（TC-A1-03）。
 *
 * 覆盖三项：
 * 1. maxTurns=2 → 第 2 轮后事件流出现终态 run_status 且 status=interrupted，不悬挂；
 * 2. maxCost=0 → 不调用模型（llm_call 不出现），run 直接终态 interrupted；
 * 3. 写工具触发 confirmation_requested，进程内句柄 resolveConfirmation 决议后 run 继续
 *    （验证终端与 Web 共用同一挂起 / 决议生命周期，A3-B 之前的镜像通道已退役）。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { createCodingToolRegistry } from "@aiagent/coding";
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
 * @param {string} stopReason 停止原因。
 * @returns {object} AssistantMessage。
 */
function assistantMessage(text, stopReason = "stop") {
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
    stopReason,
    timestamp: Date.now()
  };
}

/**
 * 多轮工具流：每轮都产出 read 工具调用（只读直接放行），由 maxTurns 在第 2 轮后拦截。
 * 用于验证 maxTurns 在第 2 轮后干净收尾（interrupted 而非 completed）。
 *
 * 工具在 `tools:[]` 下不存在，会回喂 isError 的 toolResult，但仍计入 toolResults，
 * 不影响轮次计数与预算停止判定。
 *
 * @returns {Function} StreamFn。
 */
function createMultiToolStream() {
  return (_model, _context) => {
    const stream = createAssistantMessageEventStream();
    const message = assistantMessage("");
    const emit = (msg) => {
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...msg, content: [] } });
        msg.content.forEach((block, contentIndex) => {
          if (block.type === "text") {
            stream.push({ type: "text_start", contentIndex, partial: msg });
            stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: msg });
            stream.push({ type: "text_end", contentIndex, content: block.text, partial: msg });
          } else {
            stream.push({ type: "toolcall_start", contentIndex, partial: msg });
            stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: msg });
          }
        });
        stream.push({
          type: "done",
          reason: msg.stopReason === "toolUse" ? "toolUse" : "stop",
          message: msg
        });
      });
      return stream;
    };
    // 始终产出工具调用：每轮都有 hasToolCall / toolResults，直到 maxTurns 拦截。
    const toolCall = {
      type: "toolCall",
      id: `stub_call_${Math.random().toString(36).slice(2)}`,
      name: "read",
      arguments: { path: "note.txt" }
    };
    return emit({ ...assistantMessage(""), content: [toolCall], stopReason: "toolUse" });
  };
}

/**
 * 写工具流：首轮产出 write 工具调用（触发确认），拿到 toolResult 后以文本收尾。
 * 用于验证 confirmation_requested 与进程内决议后 run 继续（TC-A1-03）。
 *
 * @returns {Function} StreamFn。
 */
function createWriteThenTextStream() {
  return (_model, context) => {
    const stream = createAssistantMessageEventStream();
    const emit = (msg) => {
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...msg, content: [] } });
        msg.content.forEach((block, contentIndex) => {
          if (block.type === "text") {
            stream.push({ type: "text_start", contentIndex, partial: msg });
            stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: msg });
            stream.push({ type: "text_end", contentIndex, content: block.text, partial: msg });
          } else {
            stream.push({ type: "toolcall_start", contentIndex, partial: msg });
            stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: msg });
          }
        });
        stream.push({
          type: "done",
          reason: msg.stopReason === "toolUse" ? "toolUse" : "stop",
          message: msg
        });
      });
      return stream;
    };
    const messages = context.messages ?? [];
    const last = messages[messages.length - 1];
    if (last?.role === "toolResult") {
      return emit(assistantMessage("（测试替身）工具执行完成，本轮收尾。"));
    }
    const toolCall = {
      type: "toolCall",
      id: `stub_write_${Math.random().toString(36).slice(2)}`,
      name: "write",
      arguments: { path: "note.txt", content: "内容" }
    };
    return emit({ ...assistantMessage(""), content: [toolCall], stopReason: "toolUse" });
  };
}

/**
 * 创建隔离的测试服务。
 *
 * @param {Function} streamFn 测试 StreamFn。
 * @param {object} [options] 测试选项。
 * @param {boolean} [options.useRealTools] 注入真实编码工具（触发确认闸门所需）。
 * @returns {Promise<object>} 测试上下文（含 workspaceRoot / dataDir）。
 */
async function createTestServer(streamFn, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-serve-budget-"));
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const server = await createOhnaServer({
    workspaceRoot,
    dataDir,
    model: MODEL,
    apiKey: "test-key",
    systemPrompt: "test system prompt",
    // 默认无工具：工具调用回喂 isError 但不触发确认；确认用例注入真实工具。
    tools: options.useRealTools ? createCodingToolRegistry(workspaceRoot) : [],
    staticDir: path.join(root, "web-dist"),
    streamFn
  });
  return { server, root, workspaceRoot, dataDir };
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

/**
 * 解析 SSE 响应体中的 run_event 帧。
 *
 * @param {string} body SSE 文本。
 * @returns {object[]} 事件数组（按出现顺序）。
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
 * 取某 run 的完整事件流（SSE 全量回放，含已持久化的 user_message 首帧）。
 *
 * @param {object} server 服务。
 * @param {string} eventsUrl 事件流地址。
 * @returns {Promise<object[]>} 事件数组。
 */
async function collectEvents(server, eventsUrl) {
  const sse = await server.app.inject({ method: "GET", url: eventsUrl });
  assert.equal(sse.statusCode, 200);
  return parseSseEvents(sse.body);
}

test("TC-A1-01: maxTurns=2 在第 2 轮后干净收尾为 interrupted，不悬挂", async () => {
  const context = await createTestServer(createMultiToolStream());
  try {
    const { server } = context;
    const conversation = await server.createConversation("预算-轮次");
    const created = await server.createRun({
      conversationId: conversation.conversationId,
      message: "连续调用两次工具",
      maxTurns: 2
    });

    const snapshot = await waitForTerminal(server, created.accepted.snapshotUrl);
    const events = await collectEvents(server, created.accepted.eventsUrl);

    // 终态为 interrupted（预算护栏），而非 completed / 悬挂。
    assert.equal(snapshot.status, "interrupted");
    const terminal = events.at(-1);
    assert.equal(terminal.type, "run_status");
    assert.equal(terminal.payload.status, "interrupted");
    // 事件流中确有 agent 循环发生（证明不是「根本没跑」），只是被轮次护栏拦下。
    assert.ok(events.some((event) => event.type === "agent_start"));
    assert.equal(events.some((event) => event.type === "agent_end"), false, "interrupted 不应有 agent_end");
  } finally {
    await dispose(context);
  }
});

test("TC-A1-02: maxCost=0 不调用模型，run 直接终态 interrupted", async () => {
  const context = await createTestServer(createMultiToolStream());
  try {
    const { server } = context;
    const conversation = await server.createConversation("预算-成本");
    const created = await server.createRun({
      conversationId: conversation.conversationId,
      message: "零预算",
      maxCost: 0
    });

    const snapshot = await waitForTerminal(server, created.accepted.snapshotUrl);
    const events = await collectEvents(server, created.accepted.eventsUrl);

    // 预算在 run 前即被触发：终态 interrupted，且从未调用模型（无 llm_call）。
    assert.equal(snapshot.status, "interrupted");
    assert.equal(
      events.some((event) => event.type === "llm_call"),
      false,
      "零预算时不应产生任何 llm_call"
    );
    // user_message 仍会广播（createRun 落盘后、execute 之前），但不会有 agent/lm 帧。
    assert.ok(events.some((event) => event.type === "user_message"));
    assert.equal(events.at(-1).type, "run_status");
    assert.equal(events.some((event) => event.type === "agent_start"), false, "零预算不应进入 agent 循环");
  } finally {
    await dispose(context);
  }
});

test("TC-A1-03: 写工具触发 confirmation_requested，进程内 resolveConfirmation 决议后 run 继续", async () => {
  // 注入真实编码工具：write 是 mutate，经权限闸门裁决为 ask → 触发确认（tools:[] 时
  // 工具不存在，beforeToolCall 不会调用，故必须注入真实工具）。
  const context = await createTestServer(createWriteThenTextStream(), { useRealTools: true });
  try {
    const { server } = context;
    const conversation = await server.createConversation("预算-确认");
    const created = await server.createRun({
      conversationId: conversation.conversationId,
      message: "写个文件"
      // autoApprove 默认 false：write 需确认。
    });

    const live = [];
    const unsubscribe = server.subscribeRun(created.accepted.runId, (event) => live.push(event));

    // 等待确认请求出现（工具执行前挂起）。
    let confirmation = null;
    for (let attempt = 0; attempt < 200 && !confirmation; attempt += 1) {
      confirmation = live.find((event) => event.type === "confirmation_requested");
      if (!confirmation) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(confirmation, "写工具应触发 confirmation_requested");
    assert.equal(confirmation.payload.toolName, "write");

    // 进程内句柄决议（等价 Web 的确认路由）：allow 放行，run 继续。
    const result = server.resolveConfirmation(
      created.accepted.runId,
      confirmation.payload.toolCallId,
      "allow"
    );
    assert.equal(result.ok, true, "进程内决议应成功（与 Web 共用同一挂起/决议生命周期）");

    // 决议后 run 不被悬挂，继续到终态（completed）。
    const snapshot = await waitForTerminal(server, created.accepted.snapshotUrl);
    unsubscribe();
    assert.equal(snapshot.status, "completed");
  } finally {
    await dispose(context);
  }
});
