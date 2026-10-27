/**
 * BUG-002 方案 2 · 服务端按会话切换工作区上下文集成测试。
 *
 * 覆盖：
 * - 主工作区会话：run 复用注入的 systemPrompt / tools（单工作区语义与 MCP/测试注入零变化）；
 * - 跨工作区会话：run 按会话持久化的 workspaceRoot 动态装配编码工具 + 编码系统提示词。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { createOhnaServer, LocalSessionStore } from "../dist/index.js";
import { assistantMessage } from "./support/stub-stream.mjs";

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
 * 捕获每次对话请求的 systemPrompt 与 tools 后，返回一段确定性文本收尾。
 *
 * @param {object[]} captured 捕获的上下文（systemPrompt / tools）。
 * @returns {Function} StreamFn。
 */
function createCapturingStream(captured) {
  return (_model, context) => {
    captured.push({ systemPrompt: context.systemPrompt, tools: context.tools ?? [] });
    const stream = createAssistantMessageEventStream();
    const message = assistantMessage("ok");
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
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

test("BUG-002: 跨工作区会话按持久化 workspaceRoot 装配编码上下文，主工作区复用注入项", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-serve-wsctx-"));
  const workspaceRoot = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other-workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(otherWorkspace, { recursive: true });

  const captured = [];
  const server = await createOhnaServer({
    workspaceRoot,
    dataDir,
    model: MODEL,
    apiKey: "test-key",
    // 主工作区注入明确的 systemPrompt 与空工具集：验证种子缓存复用注入项而非重建。
    systemPrompt: "test system prompt",
    tools: [],
    staticDir: path.join(root, "missing-web-dist"),
    streamFn: createCapturingStream(captured)
  });

  try {
    // 主工作区会话：resolveWorkspace 命中种子，必须复用注入的 systemPrompt / tools。
    const mainConversation = await server.createConversation("主工作区");
    const mainRun = await server.createRun({
      conversationId: mainConversation.conversationId,
      message: "你好"
    });
    const mainSnapshot = await waitForTerminal(server, mainRun.accepted.runId);
    assert.equal(mainSnapshot.status, "completed");

    // 直接经同一 dataDir 的 session store 造一个「持久化 workspaceRoot 指向其它目录」的会话，
    // 模拟用户此前在别的项目目录下建立、后续要续写的跨工作区会话。
    const sessionStore = new LocalSessionStore(path.join(dataDir, "sessions"));
    const otherMeta = await sessionStore.create({ title: "跨工作区会话", workspaceRoot: otherWorkspace, workspaceId: otherWorkspace });

    const otherRun = await server.createRun({
      conversationId: otherMeta.id,
      message: "继续"
    });
    const otherSnapshot = await waitForTerminal(server, otherRun.accepted.runId);
    assert.equal(otherSnapshot.status, "completed");

    assert.equal(captured.length, 2, "应有两次对话请求");
    // 主工作区：复用注入项（systemPrompt 与空工具集不被重建）。
    assert.equal(captured[0].systemPrompt, "test system prompt");
    assert.equal(captured[0].tools.length, 0);
    // 跨工作区：按其它工作区装配编码系统提示词（文案内嵌 cwd）与完整编码工具集。
    assert.ok(
      captured[1].systemPrompt.includes(otherWorkspace),
      `跨工作区 systemPrompt 应内嵌 ${otherWorkspace}，实际：${captured[1].systemPrompt}`,
    );
    assert.equal(captured[1].tools.length, 7, "跨工作区应装配完整编码工具集（7 个）");
  } finally {
    await server.shutdown();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
