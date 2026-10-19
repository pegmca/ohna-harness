/**
 * F-8 会话命令：`/resume fork` 新会话与旧会话保留、`/status` / `/mcp` 快照。
 *
 * 输出经 render 的 `write()` 汇聚到 outputSink，测试直接捕获文本断言，不污染终端。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSessionStore } from "../dist/session/session-store.js";
import { createUsageTracker } from "../dist/session/usage.js";
import { setOutputSink } from "../dist/ui/render.js";
import {
  clearSession,
  printMcp,
  printStatus,
  resumeSession,
} from "../dist/commands/session-commands.js";

/** 本轮测试捕获到的全部输出。 */
const output = [];
setOutputSink((text) => output.push(text));

/**
 * 取出并清空捕获输出。
 *
 * @returns 拼接后的文本。
 */
function takeOutput() {
  return output.splice(0, output.length).join("");
}

/**
 * 构造会话命令上下文。
 *
 * @param dir 工作区目录（同时作为 store 目录）。
 * @returns 上下文与读取当前会话 id 的函数。
 */
function makeContext(dir) {
  const store = createSessionStore({ dir });
  const history = [];
  const tracker = createUsageTracker();
  let sessionId = "current";
  let title;
  const model = { model: { id: "test-model", provider: "test", contextWindow: 1000 }, apiKey: "k" };
  const ctx = {
    tools: [],
    store,
    tracker,
    setup: {
      systemPrompt: "",
      autoApprove: false,
      cwd: dir,
      summarizer: async () => "",
    },
    history,
    getModel: () => model,
    setModel: () => {},
    getSessionId: () => sessionId,
    setSessionId: (id) => {
      sessionId = id;
    },
    getTitle: () => title,
    setTitle: (value) => {
      title = value;
    },
    getPermissionPreset: () => "default",
    mcpServerNames: ["srv-a"],
    mcpToolNames: new Set(["mcp_tool"]),
    teamToolNames: new Set(["TeamCreate"]),
  };
  return { ctx, store, getSessionId: () => sessionId };
}

test("/resume fork：复制旧消息到新会话，旧会话文件保留", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ohna-fork-"));
  try {
    const { ctx, store, getSessionId } = makeContext(dir);
    await store.create({
      id: "old",
      title: "旧会话",
      workspaceRoot: dir,
      usage: { input: 1, output: 2, total: 3, cost: 0.01 },
      messages: [
        { role: "user", content: "旧问题", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "旧回答" }], timestamp: 2 },
      ],
    });
    takeOutput();

    await resumeSession(ctx, "fork old");
    const created = takeOutput();
    const newId = getSessionId();

    assert.notEqual(newId, "old");
    assert.match(created, /已 fork 自 old/);
    assert.match(created, new RegExp(`新会话 ${newId}`));
    assert.equal(ctx.history.length, 2, "新会话应载入旧消息");
    assert.equal(ctx.history[0].content, "旧问题");
    assert.equal(ctx.tracker.snapshot().total, 3, "fork 继承旧用量快照");

    const metas = await store.list();
    assert.equal(metas.length, 2, "旧会话 + 新会话");
    const old = await store.load("old");
    assert.ok(old, "旧会话文件必须保留");
    assert.equal(old.messages.length, 2);
    const forked = await store.load(newId);
    assert.ok(forked);
    assert.equal(forked.messages.length, 2);
    assert.equal(forked.meta.title, "旧会话");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/resume fork：旧会话没有 usage 时清零当前成本", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ohna-fork-"));
  try {
    const { ctx, store } = makeContext(dir);
    await store.create({
      id: "no-usage",
      title: "无用量",
      workspaceRoot: dir,
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });
    // 当前会话已产生成本；fork 一个没有 usage 的旧会话后不得继承。
    ctx.tracker.add({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    });
    takeOutput();
    await resumeSession(ctx, "fork no-usage");
    assert.equal(ctx.tracker.snapshot().total, 0);
    assert.equal(ctx.tracker.snapshot().cost, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/resume fork 缺少 id：只提示用法，不改变当前会话", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ohna-fork-"));
  try {
    const { ctx, getSessionId } = makeContext(dir);
    takeOutput();
    await resumeSession(ctx, "fork");
    assert.match(takeOutput(), /用法：\/resume fork <id>/);
    assert.equal(getSessionId(), "current");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/status：输出模型、会话、消息数、用量、MCP、Team 与权限", () => {
  const dir = "/tmp/ohna-status";
  const { ctx } = makeContext(dir);
  ctx.history.push({ role: "user", content: "hi", timestamp: 1 });
  ctx.tracker.add({
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 2,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
  });
  takeOutput();
  printStatus(ctx);
  const text = takeOutput();
  assert.match(text, /模型：test-model（profile: test）/);
  assert.match(text, /消息：1 条/);
  assert.match(text, /推理 2/);
  assert.match(text, /MCP：1 个 server（srv-a）· 1 个工具/);
  assert.match(text, /Team：已启用（1 个工具）/);
  assert.match(text, /权限：default/);
});

test("/mcp：未接入时给出明确提示；已接入时列出 server 与工具", () => {
  const dir = "/tmp/ohna-mcp";
  const { ctx } = makeContext(dir);
  takeOutput();
  printMcp(ctx);
  assert.match(takeOutput(), /srv-a/);

  printMcp({ ...ctx, mcpServerNames: [], mcpToolNames: new Set() });
  assert.match(takeOutput(), /未接入 MCP server/);
});

test("/clear：清空 history 并创建新会话", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ohna-clear-"));
  try {
    const { ctx, store, getSessionId } = makeContext(dir);
    ctx.history.push({ role: "user", content: "hi", timestamp: 1 });
    takeOutput();
    await clearSession(ctx);
    assert.equal(ctx.history.length, 0);
    assert.match(takeOutput(), /已清空上下文/);
    assert.notEqual(getSessionId(), "current");
    assert.ok(await store.load(getSessionId()));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
