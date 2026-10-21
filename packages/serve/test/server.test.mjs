/**
 * serve 集成测试：Fastify inject + 本地 stub StreamFn，不联网、不写真实 home。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createOhnaServer } from "../dist/index.js";
import { createSlowStream, createTextStream } from "./support/stub-stream.mjs";

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
 * @returns {Promise<{server: object, root: string, workspaceRoot: string, dataDir: string}>}
 */
async function createTestServer(streamFn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-serve-server-"));
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  const staticDir = path.join(root, "web-dist"); // 不存在：强制走内置占位页
  await fs.mkdir(workspaceRoot, { recursive: true });
  const server = await createOhnaServer({
    workspaceRoot,
    dataDir,
    model: MODEL,
    apiKey: "test-key",
    systemPrompt: "test system prompt",
    tools: [],
    staticDir,
    streamFn
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
 * 轮询直到 run 进入终态。
 *
 * @param {object} server 服务。
 * @param {string} snapshotUrl 快照地址。
 * @returns {Promise<object>} 终态快照。
 */
async function waitForTerminal(server, snapshotUrl) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await server.app.inject({ method: "GET", url: snapshotUrl });
    const snapshot = response.json().data;
    if (["completed", "failed", "cancelled", "interrupted"].includes(snapshot?.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not reach terminal state.");
}

/**
 * 解析 SSE 响应体中的 run_event 帧（含 id）。
 *
 * @param {string} body SSE 文本。
 * @returns {{id: number, event: object}[]} 帧数组。
 */
function parseSseFrames(body) {
  return body
    .split("\n\n")
    .filter((frame) => frame.includes("event: run_event"))
    .map((frame) => {
      const lines = frame.split("\n");
      const idLine = lines.find((line) => line.startsWith("id:"));
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      return { id: Number(idLine?.slice(3).trim()), event: JSON.parse(data) };
    });
}

/**
 * 解析 SSE 响应体中的 run_event 帧。
 *
 * @param {string} body SSE 文本。
 * @returns {object[]} 事件数组。
 */
function parseSseEvents(body) {
  return parseSseFrames(body).map((frame) => frame.event);
}

test("health / identity / models / conversations / 静态占位页", async () => {
  const context = await createTestServer(createTextStream());
  try {
    const { server, workspaceRoot, dataDir } = context;

    const health = (await server.app.inject({ method: "GET", url: "/api/health" })).json();
    assert.equal(health.mode, "local");
    assert.equal(health.workspaceRoot, workspaceRoot);
    assert.equal(health.dataDir, dataDir);
    assert.deepEqual(health.model, { id: "stub-model", provider: "mock" });

    const identity = (await server.app.inject({ method: "GET", url: "/api/identity/me" })).json();
    assert.equal(identity.ok, true);
    assert.equal(identity.data.userId, "local-user");
    assert.equal(identity.data.qqBot.enabled, false);

    const models = (await server.app.inject({ method: "GET", url: "/api/models" })).json();
    assert.equal(models.data.defaultModelId, "stub-model");
    assert.equal(models.data.models[0].provider, "mock");

    const createdResponse = await server.app.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "会话 A" }
    });
    assert.equal(createdResponse.statusCode, 201);
    const conversation = createdResponse.json().data;
    assert.equal(conversation.title, "会话 A");

    const list = (await server.app.inject({ method: "GET", url: "/api/conversations" })).json();
    assert.equal(list.data.items.length, 1);
    // TC-L1-01：DTO 必填透出产生该会话的工作区根目录（web 侧栏按它分组）。
    assert.equal(list.data.items[0].workspaceRoot, workspaceRoot);
    assert.equal(conversation.workspaceRoot, workspaceRoot);

    // 工作区过滤：本工作区命中、其他工作区返回空（web composer 选会话用，侧栏仍取全量）。
    const sameWorkspace = (
      await server.app.inject({
        method: "GET",
        url: `/api/conversations?workspaceRoot=${encodeURIComponent(workspaceRoot)}`
      })
    ).json();
    assert.equal(sameWorkspace.data.items.length, 1);
    const otherWorkspace = (
      await server.app.inject({
        method: "GET",
        url: `/api/conversations?workspaceRoot=${encodeURIComponent(`${workspaceRoot}-other`)}`
      })
    ).json();
    assert.equal(otherWorkspace.data.items.length, 0);

    const renamed = (
      await server.app.inject({
        method: "PATCH",
        url: `/api/conversations/${conversation.conversationId}`,
        payload: { title: "改名" }
      })
    ).json();
    assert.equal(renamed.data.title, "改名");

    const archived = (
      await server.app.inject({
        method: "PATCH",
        url: `/api/conversations/${conversation.conversationId}`,
        payload: { archive: true }
      })
    ).json();
    assert.equal(archived.data.status, "archived");
    assert.equal(
      (await server.app.inject({ method: "GET", url: "/api/conversations" })).json().data.items.length,
      0
    );

    const page = (
      await server.app.inject({
        method: "GET",
        url: `/api/conversations/${conversation.conversationId}/messages`
      })
    ).json();
    assert.deepEqual(page.data.items, []);

    const home = await server.app.inject({ method: "GET", url: "/" });
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /ohna/);
    assert.ok(home.body.includes(workspaceRoot));

    const missing = await server.app.inject({ method: "GET", url: "/api/nope" });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().ok, false);
  } finally {
    await dispose(context);
  }
});

test("流式 run：202 → completed 快照 → user+assistant 消息 → SSE/JSONL 可回放", async () => {
  const context = await createTestServer(createTextStream("你好，我是 ohna。"));
  try {
    const { server, dataDir } = context;
    const response = await server.app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { message: "介绍一下你自己" }
    });
    assert.equal(response.statusCode, 202);
    const accepted = response.json().data;
    assert.equal(accepted.status, "running");
    assert.equal(accepted.eventsUrl, `/api/runs/${accepted.runId}/events`);
    assert.equal(accepted.snapshotUrl, `/api/runs/${accepted.runId}`);

    const snapshot = await waitForTerminal(server, accepted.snapshotUrl);
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.lastEventSequence > 0, true);

    const messages = (
      await server.app.inject({
        method: "GET",
        url: `/api/conversations/${accepted.conversationId}/messages`
      })
    ).json().data.items;
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
    assert.deepEqual(messages.map((message) => message.sequence), [1, 2]);
    assert.equal(messages[1].content[0].text, "你好，我是 ohna。");

    const sse = await server.app.inject({ method: "GET", url: accepted.eventsUrl });
    assert.equal(sse.statusCode, 200);
    assert.match(sse.headers["content-type"], /text\/event-stream/);
    assert.match(sse.body, /event: run_event/);
    assert.match(sse.body, /"type":"agent_end"/);
    const frames = parseSseFrames(sse.body);
    assert.equal(frames.length > 0, true);
    assert.deepEqual(
      frames.map((frame) => frame.id),
      [...frames.map((frame) => frame.id)].sort((left, right) => left - right)
    );
    // agent_end 只是普通帧；终态 run_status 必须投递，且与快照高水位一致。
    const terminal = frames.at(-1);
    assert.equal(terminal.event.type, "run_status");
    assert.equal(terminal.event.payload.status, "completed");
    assert.equal(terminal.id, snapshot.lastEventSequence);
    assert.equal(terminal.id, terminal.event.sequence);
    assert.equal(frames.some((frame) => frame.event.type === "agent_end"), true);

    const file = path.join(dataDir, "runs", `${accepted.runId}.jsonl`);
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(lines[0].type, "run_meta");
    const persisted = lines.slice(1);
    assert.equal(persisted.some((event) => event.type === "message_update"), false);
    assert.equal(persisted.at(-1).type, "run_status");
    assert.equal(persisted.at(-1).payload.status, "completed");
    const sequences = persisted.map((event) => event.sequence);
    assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right));
  } finally {
    await dispose(context);
  }
});

test("取消 run：DELETE → interrupted 快照；SSE 终态为 run_status interrupted，无 agent_end", async () => {  const context = await createTestServer(createSlowStream());
  try {
    const { server, dataDir } = context;
    const accepted = (
      await server.app.inject({
        method: "POST",
        url: "/api/runs",
        payload: { message: "慢慢想" }
      })
    ).json().data;

    // 等 stream 进入挂起状态，再同时观察 live SSE 与取消。
    await new Promise((resolve) => setTimeout(resolve, 40));
    const ssePromise = server.app.inject({ method: "GET", url: accepted.eventsUrl });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const cancelled = await server.app.inject({
      method: "DELETE",
      url: `/api/runs/${accepted.runId}`
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().data.status, "interrupted");

    const sse = await ssePromise;
    const frames = parseSseFrames(sse.body);
    const terminal = frames.at(-1);
    assert.equal(terminal.event.type, "run_status");
    assert.equal(terminal.event.payload.status, "interrupted");
    assert.equal(frames.some((frame) => frame.event.type === "agent_end"), false);

    const snapshot = (await server.app.inject({ method: "GET", url: accepted.snapshotUrl })).json().data;
    assert.equal(snapshot.status, "interrupted");
    assert.equal(terminal.id, snapshot.lastEventSequence);

    const raw = await fs.readFile(path.join(dataDir, "runs", `${accepted.runId}.jsonl`), "utf8");
    assert.equal(raw.includes('"status":"interrupted"'), true);
    assert.equal(raw.includes('"type":"agent_end"'), false);
  } finally {
    await dispose(context);
  }
});

test("shutdown 中断在途 run：快照与 JSONL 均为 interrupted（L0-5）", async () => {
  const context = await createTestServer(createSlowStream());
  try {
    const { server, dataDir } = context;
    const accepted = (
      await server.app.inject({
        method: "POST",
        url: "/api/runs",
        payload: { message: "关闭时仍在运行" }
      })
    ).json().data;

    await new Promise((resolve) => setTimeout(resolve, 40));
    await server.shutdown();

    const snapshot = (await server.app.inject({ method: "GET", url: accepted.snapshotUrl })).json().data;
    assert.equal(snapshot.status, "interrupted");
    const raw = await fs.readFile(path.join(dataDir, "runs", `${accepted.runId}.jsonl`), "utf8");
    assert.equal(raw.includes('"status":"interrupted"'), true);
    assert.equal(raw.includes('"type":"agent_end"'), false);
  } finally {
    await dispose(context);
  }
});

test("真实 HTTP：绑定 127.0.0.1、fetch SSE、DELETE 取消结束连接", async () => {
  const context = await createTestServer(createSlowStream());
  try {
    const { port, url } = await context.server.listen(0);
    assert.equal(port > 0, true);
    assert.equal(url, `http://127.0.0.1:${port}`);

    const health = await fetch(`${url}/api/health`).then((response) => response.json());
    assert.equal(health.mode, "local");

    const accepted = await fetch(`${url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "真实 HTTP 取消" })
    })
      .then((response) => response.json())
      .then((result) => result.data);

    // 先建立 SSE，确保 live 订阅存在；取消后服务端应主动 end，text() 才会返回。
    const sseResponse = await fetch(`${url}${accepted.eventsUrl}`, {
      headers: { accept: "text/event-stream" }
    });
    assert.equal(sseResponse.status, 200);
    const sseBodyPromise = sseResponse.text();

    await new Promise((resolve) => setTimeout(resolve, 40));
    const cancelled = await fetch(`${url}/api/runs/${accepted.runId}`, { method: "DELETE" }).then((response) =>
      response.json()
    );
    assert.equal(cancelled.data.status, "interrupted");

    const events = parseSseEvents(await sseBodyPromise);
    assert.equal(events.at(-1).type, "run_status");
    assert.equal(events.at(-1).payload.status, "interrupted");
    assert.equal(events.some((event) => event.type === "agent_end"), false);

    const snapshot = await fetch(`${url}${accepted.snapshotUrl}`).then((response) => response.json());
    assert.equal(snapshot.data.status, "interrupted");
  } finally {
    await dispose(context);
  }
});
