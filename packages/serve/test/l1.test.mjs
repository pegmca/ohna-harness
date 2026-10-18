/**
 * Phase 3 · L1 接管本地目录集成测试。
 *
 * 覆盖（05 §4）：
 * - L1-2 允许：write 触发 confirmation_requested → allow → 落盘；
 * - L1-3 拒绝：deny → 工具 block + isError，文件不变；
 * - L1-4 越界：read /etc/passwd → isError；
 * - L1-5 危险命令：bash rm -rf / → allow 后仍被 command policy 拒绝；
 * - L1-6 /api/local/fs 只读：list/read/tree 正常，写方法 404，敏感路径 403；
 * 另覆盖 autoApprove、只读工具不确认、确认超时、取消清理。
 *
 * 所有用例使用临时工作区 / 数据目录，stub 不联网。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createOhnaServer } from "../dist/index.js";
import { createToolStream } from "./support/stub-stream.mjs";

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
 * 创建带真实工作区文件的 L1 测试服务。
 *
 * @param {{streamFn: Function, autoApprove?: boolean, confirmTimeoutMs?: number}} options 选项。
 * @returns {Promise<object>} 测试上下文。
 */
async function createL1Server(options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-l1-"));
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "note.txt"), "原始内容\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "src", "a.txt"), "A\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, ".env"), "SECRET=1\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "node_modules", "pkg", "index.js"), "x\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, ".git", "config"), "[core]\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "binary.bin"), Buffer.from([0, 1, 2, 3, 255]));

  const server = await createOhnaServer({
    workspaceRoot,
    dataDir,
    model: MODEL,
    apiKey: "test-key",
    systemPrompt: "test system prompt",
    staticDir: path.join(root, "missing-web-dist"),
    streamFn: options.streamFn,
    autoApprove: options.autoApprove ?? false,
    ...(options.confirmTimeoutMs !== undefined
      ? { confirmTimeoutMs: options.confirmTimeoutMs }
      : {})
  });
  return { server, root, workspaceRoot, dataDir };
}

/**
 * 清理测试服务与临时目录。
 *
 * @param {object} context 测试上下文。
 */
async function dispose(context) {
  await context.server.shutdown();
  await context.server.close();
  await fs.rm(context.root, { recursive: true, force: true });
}

/**
 * 解析单个 SSE 帧。
 *
 * @param {string} raw 原始帧文本。
 * @returns {{id: number, event: object}|null} 帧或 null（心跳）。
 */
function parseSseFrame(raw) {
  if (!raw.includes("event: run_event")) return null;
  const lines = raw.split("\n");
  const idLine = lines.find((line) => line.startsWith("id:"));
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  return { id: Number(idLine?.slice(3).trim()), event: JSON.parse(data) };
}

/**
 * 读取 SSE，直到 predicate 命中或超时（返回已收到的事件）。
 *
 * @param {string} url SSE 地址。
 * @param {(event: object) => boolean} predicate 命中条件。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<object[]>} 收到的事件。
 */
async function readSseUntil(url, predicate, timeoutMs = 3_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const response = await fetch(url, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const frame = parseSseFrame(raw);
        if (!frame) continue;
        events.push(frame.event);
        if (predicate(frame.event)) {
          controller.abort();
          return events;
        }
      }
    }
    return events;
  } catch (error) {
    if (error?.name === "AbortError") return events;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读取 run 的 JSONL 事件（去掉 run_meta 首行）。
 *
 * @param {string} dataDir 数据目录。
 * @param {string} runId run id。
 * @returns {Promise<object[]>} 事件数组。
 */
async function readRunEvents(dataDir, runId) {
  const raw = await fs.readFile(path.join(dataDir, "runs", `${runId}.jsonl`), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((line) => line.type !== "run_meta");
}

/**
 * 轮询直到 run 进入终态。
 *
 * @param {object} server 服务。
 * @param {string} url 服务地址。
 * @param {string} runId run id。
 * @returns {Promise<object>} 终态快照。
 */
async function waitForTerminal(server, url, runId) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(`${url}/api/runs/${runId}`);
    const snapshot = response ? (await response.json()).data : undefined;
    if (snapshot && ["completed", "failed", "cancelled", "interrupted"].includes(snapshot.status)) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not reach terminal state.");
}

/**
 * 发起 POST JSON 请求。
 *
 * @param {string} url 地址。
 * @param {unknown} payload 请求体。
 * @returns {Promise<Response>} 响应。
 */
function postJson(url, payload) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

/**
 * 创建 run 并返回 accepted DTO。
 *
 * @param {string} url 服务地址。
 * @param {string} message 用户消息。
 * @returns {Promise<object>} accepted DTO。
 */
async function startRun(url, message) {
  const response = await postJson(`${url}/api/runs`, { message });
  assert.equal(response.status, 202);
  return (await response.json()).data;
}

/**
 * 等待 `confirmation_requested` 帧。
 *
 * @param {string} url 服务地址。
 * @param {object} accepted accepted DTO。
 * @returns {Promise<object>} confirmation payload。
 */
async function waitForConfirmation(url, accepted) {
  const events = await readSseUntil(
    `${url}${accepted.eventsUrl}`,
    (event) => event.type === "confirmation_requested" || event.type === "run_status"
  );
  const confirmation = events.find((event) => event.type === "confirmation_requested");
  assert.ok(confirmation, "应收到 confirmation_requested 事件");
  return confirmation.payload;
}

/**
 * 读取会话中第一条 toolResult 的线性消息。
 *
 * @param {object} server 服务。
 * @param {string} conversationId 会话 id。
 * @returns {Promise<object|undefined>} toolResult 消息。
 */
async function firstToolResult(server, conversationId) {
  const response = await server.app.inject({
    method: "GET",
    url: `/api/conversations/${conversationId}/messages`
  });
  return response.json().data.items.find((message) => message.role === "toolResult");
}

test("L1-2 允许：write 触发 confirmation_requested → allow → 文件落盘", async () => {
  const context = await createL1Server({ streamFn: createToolStream() });
  try {
    const { server, workspaceRoot, dataDir } = context;
    const { url } = await server.listen(0);
    const accepted = await startRun(url, "请改文件");

    const confirmation = await waitForConfirmation(url, accepted);
    assert.equal(confirmation.toolName, "write");
    assert.equal(confirmation.args.path, "note.txt");
    assert.match(confirmation.summary, /写文件/);
    assert.ok(confirmation.toolCallId);

    const decision = await postJson(
      `${url}/api/runs/${accepted.runId}/confirmations/${confirmation.toolCallId}`,
      { decision: "allow" }
    );
    assert.equal(decision.status, 200);
    const decisionBody = await decision.json();
    assert.equal(decisionBody.data.decision, "allow");

    const snapshot = await waitForTerminal(server, url, accepted.runId);
    assert.equal(snapshot.status, "completed");
    assert.equal(await fs.readFile(path.join(workspaceRoot, "note.txt"), "utf8"), "改好了\n");

    const events = await readRunEvents(dataDir, accepted.runId);
    const persisted = events.find((event) => event.type === "confirmation_requested");
    assert.ok(persisted, "confirmation_requested 必须落盘");
    assert.equal(persisted.payload.toolCallId, confirmation.toolCallId);
    const sequences = events.map((event) => event.sequence);
    assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right));
    const toolEnd = events.find((event) => event.type === "tool_execution_end");
    assert.equal(toolEnd.payload.isError, false);
  } finally {
    await dispose(context);
  }
});

test("L1-3 拒绝：deny → 工具 block + isError，文件不变", async () => {
  const context = await createL1Server({ streamFn: createToolStream() });
  try {
    const { server, workspaceRoot, dataDir } = context;
    const { url } = await server.listen(0);
    const accepted = await startRun(url, "请改文件");

    const confirmation = await waitForConfirmation(url, accepted);
    const decision = await postJson(
      `${url}/api/runs/${accepted.runId}/confirmations/${confirmation.toolCallId}`,
      { decision: "deny" }
    );
    assert.equal(decision.status, 200);

    const snapshot = await waitForTerminal(server, url, accepted.runId);
    assert.equal(snapshot.status, "completed");
    assert.equal(await fs.readFile(path.join(workspaceRoot, "note.txt"), "utf8"), "原始内容\n");

    const toolResult = await firstToolResult(server, accepted.conversationId);
    assert.ok(toolResult, "会话中应有 toolResult");
    assert.equal(toolResult.content.isError, true);
    assert.match(toolResult.content.content[0].text, /用户拒绝/);

    const events = await readRunEvents(dataDir, accepted.runId);
    const toolEnd = events.find((event) => event.type === "tool_execution_end");
    assert.equal(toolEnd.payload.isError, true);
  } finally {
    await dispose(context);
  }
});

test("L1-4 越界：read /etc/passwd 被路径策略拒绝且不回正文", async () => {
  const context = await createL1Server({ streamFn: createToolStream() });
  try {
    const { server, dataDir } = context;
    const { url } = await server.listen(0);
    const accepted = await startRun(url, "越界读取");
    const snapshot = await waitForTerminal(server, url, accepted.runId);
    assert.equal(snapshot.status, "completed");

    const events = await readRunEvents(dataDir, accepted.runId);
    const toolEnd = events.find((event) => event.type === "tool_execution_end");
    assert.equal(toolEnd.payload.isError, true);
    const text = toolEnd.payload.result.content[0].text;
    assert.match(text, /outside|denied/i);
    assert.equal(text.includes("root:"), false);
  } finally {
    await dispose(context);
  }
});

test("L1-5 危险命令：allow 后仍被 command policy 拒绝", async () => {
  const context = await createL1Server({ streamFn: createToolStream() });
  try {
    const { server, dataDir } = context;
    const { url } = await server.listen(0);
    const accepted = await startRun(url, "执行危险命令");

    const confirmation = await waitForConfirmation(url, accepted);
    assert.equal(confirmation.toolName, "bash");
    assert.match(confirmation.summary, /执行命令 rm -rf \//);
    const decision = await postJson(
      `${url}/api/runs/${accepted.runId}/confirmations/${confirmation.toolCallId}`,
      { decision: "allow" }
    );
    assert.equal(decision.status, 200);

    const snapshot = await waitForTerminal(server, url, accepted.runId);
    assert.equal(snapshot.status, "completed");
    const events = await readRunEvents(dataDir, accepted.runId);
    const toolEnd = events.find((event) => event.type === "tool_execution_end");
    assert.equal(toolEnd.payload.isError, true);
    assert.match(toolEnd.payload.result.content[0].text, /blocked|not allowed|rm|denied/i);
  } finally {
    await dispose(context);
  }
});

test("L1-6 /api/local/fs：list/read/tree 只读；写方法 404；越界与 .env 403", async () => {
  const context = await createL1Server({ streamFn: createToolStream() });
  try {
    const { server } = context;
    const { url } = await server.listen(0);
    const fsUrl = (query) => `${url}/api/local/fs?${query}`;

    const list = await fetch(fsUrl("path=.&mode=list")).then((response) => response.json());
    assert.equal(list.ok, true);
    assert.equal(list.data.path, ".");
    const names = list.data.entries.map((entry) => entry.name);
    assert.ok(names.includes("note.txt"));
    assert.ok(names.includes("src"));
    assert.equal(names.includes(".env"), false, "敏感文件不应出现在列表中");
    assert.equal(names.includes("node_modules"), false, "denied 目录不应出现在列表中");
    const note = list.data.entries.find((entry) => entry.name === "note.txt");
    assert.equal(note.type, "file");
    assert.equal(note.size, Buffer.byteLength("原始内容\n"));

    const read = await fetch(fsUrl("path=note.txt&mode=read")).then((response) => response.json());
    assert.equal(read.ok, true);
    assert.equal(read.data.content, "原始内容\n");
    assert.equal(read.data.binary, false);
    assert.equal(read.data.truncated, false);

    const binary = await fetch(fsUrl("path=binary.bin&mode=read")).then((response) => response.json());
    assert.equal(binary.data.binary, true);
    assert.equal(binary.data.content, "");

    const tree = await fetch(fsUrl("path=.&mode=tree&depth=3")).then((response) => response.json());
    assert.equal(tree.ok, true);
    assert.equal(tree.data.type, "directory");
    const treeNames = (tree.data.children ?? []).map((child) => child.path);
    assert.ok(treeNames.includes("note.txt"));
    assert.ok(treeNames.includes("src"));
    assert.equal(treeNames.includes("node_modules"), false);
    assert.equal(treeNames.includes(".git"), false);
    const srcNode = tree.data.children.find((child) => child.path === "src");
    assert.equal(srcNode.children[0].path, "src/a.txt");

    const deniedEnv = await fetch(fsUrl("path=.env&mode=read"));
    assert.equal(deniedEnv.status, 403);
    assert.equal((await deniedEnv.json()).error.code, "forbidden");

    const deniedOutside = await fetch(fsUrl("path=../../etc/passwd&mode=read"));
    assert.equal(deniedOutside.status, 403);

    const missing = await fetch(fsUrl("path=nope.txt&mode=read"));
    assert.equal(missing.status, 404);

    const badMode = await fetch(fsUrl("path=.&mode=write"));
    assert.equal(badMode.status, 400);

    const badDepth = await fetch(fsUrl("path=.&mode=tree&depth=9"));
    assert.equal(badDepth.status, 400);

    const writeAttempt = await postJson(`${url}/api/local/fs`, { path: "note.txt", content: "hack" });
    assert.ok([404, 405].includes(writeAttempt.status), "fs 端点不得提供写方法");
    assert.equal(await fs.readFile(path.join(context.workspaceRoot, "note.txt"), "utf8"), "原始内容\n");
  } finally {
    await dispose(context);
  }
});

test("autoApprove：write 不产生 confirmation_requested，直接落盘", async () => {
  const context = await createL1Server({
    streamFn: createToolStream(),
    autoApprove: true
  });
  try {
    const { server, workspaceRoot, dataDir } = context;
    const { url } = await server.listen(0);
    const accepted = await startRun(url, "请改文件");
    const snapshot = await waitForTerminal(server, url, accepted.runId);
    assert.equal(snapshot.status, "completed");
    assert.equal(await fs.readFile(path.join(workspaceRoot, "note.txt"), "utf8"), "改好了\n");

    const events = await readRunEvents(dataDir, accepted.runId);
    assert.equal(
      events.some((event) => event.type === "confirmation_requested"),
      false,
      "自动批准模式不应产生确认事件"
    );
  } finally {
    await dispose(context);
  }
});

test("只读工具（read/ls）永不产生 confirmation_requested", async () => {
  const context = await createL1Server({ streamFn: createToolStream() });
  try {
    const { server, dataDir } = context;
    const { url } = await server.listen(0);
    const accepted = await startRun(url, "读取文件");
    const snapshot = await waitForTerminal(server, url, accepted.runId);
    assert.equal(snapshot.status, "completed");

    const events = await readRunEvents(dataDir, accepted.runId);
    assert.equal(events.some((event) => event.type === "confirmation_requested"), false);
    const toolEnd = events.find((event) => event.type === "tool_execution_end");
    assert.equal(toolEnd.payload.isError, false);
    assert.match(toolEnd.payload.result.content[0].text, /原始内容/);

    // L1-1：ls 同样是只读，不产生确认。
    const listed = await startRun(url, "列出目录");
    const listedSnapshot = await waitForTerminal(server, url, listed.runId);
    assert.equal(listedSnapshot.status, "completed");
    const listEvents = await readRunEvents(dataDir, listed.runId);
    assert.equal(listEvents.some((event) => event.type === "confirmation_requested"), false);
    const listToolEnd = listEvents.find((event) => event.type === "tool_execution_end");
    assert.equal(listToolEnd.payload.isError, false);
    assert.match(listToolEnd.payload.result.content[0].text, /note\.txt/);
  } finally {
    await dispose(context);
  }
});

test("确认超时：未点确认自动 deny，回喂 isError", async () => {
  const context = await createL1Server({
    streamFn: createToolStream(),
    confirmTimeoutMs: 50
  });
  try {
    const { server, workspaceRoot } = context;
    const { url } = await server.listen(0);
    const accepted = await startRun(url, "请改文件");
    const snapshot = await waitForTerminal(server, url, accepted.runId);
    assert.equal(snapshot.status, "completed");
    assert.equal(await fs.readFile(path.join(workspaceRoot, "note.txt"), "utf8"), "原始内容\n");

    const toolResult = await firstToolResult(server, accepted.conversationId);
    assert.equal(toolResult.content.isError, true);
    assert.match(toolResult.content.content[0].text, /超时/);
  } finally {
    await dispose(context);
  }
});

test("取消 run：挂起的确认被清理，DELETE 不悬挂", async () => {
  const context = await createL1Server({ streamFn: createToolStream() });
  try {
    const { server, workspaceRoot, dataDir } = context;
    const { url } = await server.listen(0);
    const accepted = await startRun(url, "请改文件");
    const confirmation = await waitForConfirmation(url, accepted);

    const cancelled = await fetch(`${url}/api/runs/${accepted.runId}`, { method: "DELETE" });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).data.status, "interrupted");

    // 取消后重复确认必须是结构化拒绝，而不是让服务挂住。
    const late = await postJson(
      `${url}/api/runs/${accepted.runId}/confirmations/${confirmation.toolCallId}`,
      { decision: "allow" }
    );
    assert.equal(late.status, 409);

    assert.equal(await fs.readFile(path.join(workspaceRoot, "note.txt"), "utf8"), "原始内容\n");
    const events = await readRunEvents(dataDir, accepted.runId);
    assert.equal(events.some((event) => event.type === "confirmation_requested"), true);
    assert.equal(
      events.some((event) => event.type === "run_status" && event.payload.status === "interrupted"),
      true
    );
  } finally {
    await dispose(context);
  }
});
