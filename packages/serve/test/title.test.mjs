/**
 * serve 语义会话标题生成（BUG-002）与 generate-title 端点冒烟测试。
 *
 * 覆盖：
 * - createTitleGenerator：成功返回语义标题、空返回降级 undefined、error/aborted 降级；
 * - HTTP 端点：POST /api/conversations/:id/generate-title 成功落盘语义标题、
 *   生成失败返回现有截断标题（静默降级）、非法输入 400、会话不存在 404。
 *
 * 标题调用不真实联网：streamFn 注入桩，按 systemPrompt 文案识别「标题生成」调用。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { createOhnaServer } from "../dist/index.js";
import { createTitleGenerator } from "../dist/run/title.js";

/** 小窗口模型：标题生成只需一次短调用。 */
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

/** 标题生成调用识别文案（与 title.ts 的 TITLE_SYSTEM_PROMPT 前缀一致）。 */
const TITLE_MARKER = "你是会话标题生成器";

/**
 * 构造返回指定标题的 StreamFn：标题调用返回语义标题，其余调用返回空。
 *
 * @param {string|undefined} title 语义标题；undefined 表示「空返回」。
 * @param {string} stopReason 终止原因（默认 stop）。
 * @returns {Function} StreamFn。
 */
function createTitleStream(title, stopReason = "stop") {
  return (model, context) => {
    const stream = createAssistantMessageEventStream();
    if (context.systemPrompt?.includes(TITLE_MARKER)) {
      const text = title ?? "";
      const message = {
        role: "assistant",
        content: [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason,
        ...(stopReason === "error" ? { errorMessage: "mock title error" } : {}),
        timestamp: Date.now()
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        if (text) {
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        }
        stream.push({ type: "done", reason: stopReason, message });
      });
      return stream;
    }
    // 非标题调用：返回空完成。
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now()
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

test("createTitleGenerator：成功返回语义标题", async () => {
  const generator = createTitleGenerator({ model: MODEL, apiKey: "k", streamFn: createTitleStream("重构鉴权模块") });
  const title = await generator("帮我重构一下当前的鉴权模块，把 token 校验抽出来");
  assert.equal(title, "重构鉴权模块");
});

test("createTitleGenerator：空返回降级 undefined", async () => {
  const generator = createTitleGenerator({ model: MODEL, apiKey: "k", streamFn: createTitleStream(undefined) });
  const title = await generator("任何输入");
  assert.equal(title, undefined);
});

test("createTitleGenerator：error 终止降级 undefined", async () => {
  const generator = createTitleGenerator({ model: MODEL, apiKey: "k", streamFn: createTitleStream("标题", "error") });
  const title = await generator("任何输入");
  assert.equal(title, undefined);
});

test("createTitleGenerator：超长标题被截断到 20 字符", async () => {
  const generator = createTitleGenerator({ model: MODEL, apiKey: "k", streamFn: createTitleStream("这是一个非常非常非常长的标题用来测试截断逻辑是否正常工作") });
  const title = await generator("任何输入");
  assert.ok(title.length <= 20, `标题长度 ${title.length} 应 <= 20`);
});

/**
 * 创建隔离测试服务。
 *
 * @param {Function} streamFn StreamFn。
 * @returns {Promise<{server: object, root: string}>}
 */
async function createTestServer(streamFn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-serve-title-"));
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

test("generate-title 端点：成功落盘语义标题", async () => {
  const { server, root } = await createTestServer(createTitleStream("修复登录超时"));
  try {
    const conversation = await server.createConversation("截断标题占位");
    const res = await server.app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.conversationId}/generate-title`,
      payload: { text: "登录接口偶发超时，帮忙定位一下超时原因" }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.title, "修复登录超时");

    // 列表应反映更新后的标题。
    const list = await server.listConversations();
    assert.equal(list.find((c) => c.conversationId === conversation.conversationId).title, "修复登录超时");
  } finally {
    await server.shutdown();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("generate-title 端点：生成失败返回现有截断标题（静默降级）", async () => {
  const { server, root } = await createTestServer(createTitleStream(undefined));
  try {
    const conversation = await server.createConversation("保留标题");
    const res = await server.app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.conversationId}/generate-title`,
      payload: { text: "任意用户消息" }
    });
    assert.equal(res.statusCode, 404, "runtime 生成失败时返回 undefined → serve 404");
  } finally {
    await server.shutdown();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("generate-title 端点：非法输入 400 / 会话不存在 404", async () => {
  const { server, root } = await createTestServer(createTitleStream("标题"));
  try {
    const conversation = await server.createConversation("x");
    const missing = await server.app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.conversationId}/generate-title`,
      payload: {}
    });
    assert.equal(missing.statusCode, 400);

    const notFound = await server.app.inject({
      method: "POST",
      url: "/api/conversations/does-not-exist/generate-title",
      payload: { text: "任意" }
    });
    assert.equal(notFound.statusCode, 404);
  } finally {
    await server.shutdown();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
