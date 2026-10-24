/**
 * user_message 帧单测（docs/v1.4/06 §Phase U1 / TC-U1-01）。
 *
 * 断言 `createRun` 后事件流含 `type:"user_message"`，其 sequence 早于 `agent_start`；
 * payload 含 messageId / content / runId / source；source 按 input.source 区分：
 * composer / report_button → "web"，其它（cli）→ "cli"。
 *
 * 通过 SSE 全量回放收集事件（含 user_message 首帧，已持久化），不依赖 live 订阅时序。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createOhnaServer } from "../dist/index.js";
import { createTextStream } from "./support/stub-stream.mjs";

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
 * 创建隔离的测试服务。
 *
 * @param {Function} streamFn 测试 StreamFn。
 * @returns {Promise<object>} 测试上下文。
 */
async function createTestServer(streamFn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-serve-user-msg-"));
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

test("TC-U1-01: user_message 帧产出，sequence 早于 agent_start，payload 完整", async () => {
  const context = await createTestServer(createTextStream("你好，我是 ohna。"));
  try {
    const { server } = context;
    const conversation = await server.createConversation("用户消息-Web");
    const created = await server.createRun({
      conversationId: conversation.conversationId,
      message: "介绍一下你自己",
      source: "composer"
    });

    const events = await collectEvents(server, created.accepted.eventsUrl);
    await waitForTerminal(server, created.accepted.snapshotUrl);

    const userMessage = events.find((event) => event.type === "user_message");
    assert.ok(userMessage, "事件流必须含 user_message 帧");
    // sequence 早于 agent_start。
    const agentStart = events.find((event) => event.type === "agent_start");
    assert.ok(agentStart, "事件流必须含 agent_start 帧");
    assert.ok(
      userMessage.sequence < agentStart.sequence,
      "user_message 的 sequence 应早于 agent_start"
    );
    // 作为首帧，其 sequence 应为 1（落盘后、loop 启动前广播）。
    assert.equal(userMessage.sequence, 1);

    // payload 完整：messageId / content / runId / source。
    const payload = userMessage.payload;
    assert.equal(typeof payload.messageId, "string");
    assert.ok(payload.messageId.length > 0, "messageId 应为非空字符串");
    assert.equal(payload.content, "介绍一下你自己");
    assert.equal(payload.runId, created.accepted.runId);
    assert.equal(payload.source, "web");
  } finally {
    await dispose(context);
  }
});

test("TC-U1-01: report_button 来源同样映射为 web", async () => {
  const context = await createTestServer(createTextStream("生成报告。"));
  try {
    const { server } = context;
    const conversation = await server.createConversation("用户消息-Report");
    const created = await server.createRun({
      conversationId: conversation.conversationId,
      message: "生成一份报告",
      source: "report_button"
    });

    const events = await collectEvents(server, created.accepted.eventsUrl);
    await waitForTerminal(server, created.accepted.snapshotUrl);

    const userMessage = events.find((event) => event.type === "user_message");
    assert.ok(userMessage, "report_button 来源也应产出 user_message 帧");
    assert.equal(userMessage.payload.source, "web");
  } finally {
    await dispose(context);
  }
});

test("TC-U1-01: cli 来源映射为 cli（终端发起，绕过 Web 组件名）", async () => {
  const context = await createTestServer(createTextStream("终端发起。"));
  try {
    const { server } = context;
    const conversation = await server.createConversation("用户消息-CLI");
    // 运行时传入 source:"cli"（CLI --prompt 单次模式路径）：公共类型未收紧到该值，
    // 但 RunManager 的映射逻辑据此区分来源端，验证「终端发起记 cli」。
    const created = await server.createRun({
      conversationId: conversation.conversationId,
      message: "终端输入",
      source: "cli"
    });

    const events = await collectEvents(server, created.accepted.eventsUrl);
    await waitForTerminal(server, created.accepted.snapshotUrl);

    const userMessage = events.find((event) => event.type === "user_message");
    assert.ok(userMessage, "cli 来源也应产出 user_message 帧");
    assert.equal(userMessage.payload.source, "cli");
  } finally {
    await dispose(context);
  }
});

test("TC-U1-01: user_message 帧持久化且可经 SSE 回放（首帧续传 afterSequence=0）", async () => {
  const context = await createTestServer(createTextStream("回放验证。"));
  try {
    const { server, dataDir } = context;
    const conversation = await server.createConversation("用户消息-回放");
    const created = await server.createRun({
      conversationId: conversation.conversationId,
      message: "可回放的消息",
      source: "composer"
    });
    await waitForTerminal(server, created.accepted.snapshotUrl);

    // 磁盘 run 事件文件：user_message 是首条持久化事件（sequence=1）。
    const lines = (
      await fs.readFile(path.join(dataDir, "runs", `${created.accepted.runId}.jsonl`), "utf8")
    )
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    assert.equal(lines[0].type, "run_meta");
    const userMessageLine = lines.find((line) => line.type === "user_message");
    assert.ok(userMessageLine, "user_message 应被持久化");
    assert.equal(userMessageLine.sequence, 1);
    assert.equal(userMessageLine.payload.source, "web");
    assert.equal(userMessageLine.payload.content, "可回放的消息");

    // SSE 回放：从首帧开始可恢复整条事件流。
    const sse = await server.app.inject({
      method: "GET",
      url: `/api/runs/${created.accepted.runId}/events`
    });
    assert.equal(sse.statusCode, 200);
    assert.ok(sse.body.includes('"type":"user_message"'));
  } finally {
    await dispose(context);
  }
});
