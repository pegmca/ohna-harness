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
import { ensureFullHistory } from "../dist/session/session-flow.js";
import { createUsageTracker } from "../dist/session/usage.js";
import { setOutputSink } from "../dist/ui/render.js";
import {
  clearSession,
  compactNow,
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

test("/resume <id>：交互切换直接全量加载，不留下 tail 后缀（C4）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ohna-resume-full-"));
  try {
    const { ctx, store, getSessionId } = makeContext(dir);
    const messages = Array.from({ length: 200 }, (_, index) => ({
      role: "user",
      content: `历史-${index}`,
      timestamp: index,
    }));
    await store.create({ id: "long-switch", title: "长会话", workspaceRoot: dir, messages });
    takeOutput();

    await resumeSession(ctx, "long-switch");
    assert.equal(getSessionId(), "long-switch");
    assert.equal(ctx.history.length, 200, "切换后内存应就是完整历史");
    assert.equal(ctx.history[0].content, "历史-0");
    assert.match(takeOutput(), /已切换到会话 long-switch（200 条消息/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 构造一个 tail 载入的长会话上下文（history 只有最近 80 条）。
 *
 * @param dir 临时目录。
 * @param id 会话 id。
 * @param count 磁盘上的完整消息条数。
 * @returns 上下文、store 与 tail 载入的历史。
 */
async function makeTailContext(dir, id, count) {
  const { ctx, store } = makeContext(dir);
  const messages = Array.from({ length: count }, (_, index) => ({
    role: "user",
    content: `第 ${index} 条 ${"上下文".repeat(40)}`,
    timestamp: index,
  }));
  await store.create({ id, title: "长会话", workspaceRoot: dir, messages });
  // 小窗口确保 /compact 一定触发，从而覆盖「压缩后立即落盘」路径。
  const model = { model: { id: "small", provider: "test", contextWindow: 100 }, apiKey: "k" };
  ctx.getModel = () => model;
  const tail = await store.loadSessionTail(id, 80);
  assert.ok(tail);
  assert.equal(tail.hasMore, true);
  ctx.history.push(...tail.messages);
  ctx.setSessionId(id);
  takeOutput();
  return { ctx, store, tail };
}

test("/compact：tail 会话先补载全量再压缩落盘（messageCountBefore 为 200 而非 80）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ohna-compact-tail-"));
  try {
    const { ctx, store } = await makeTailContext(dir, "long-compact", 200);
    assert.equal(ctx.history.length, 80, "前置条件：内存只有 tail");
    let ensureCalls = 0;
    ctx.ensureFullHistory = async () => {
      ensureCalls += 1;
      assert.equal(await ensureFullHistory(store, "long-compact", ctx.history), true);
    };

    await compactNow(ctx);
    assert.equal(ensureCalls, 1, "落盘前应调用注入的补载器一次");
    assert.match(takeOutput(), /200 条 →/, "压缩必须基于完整历史");
    const disk = await store.load("long-compact");
    assert.ok(disk);
    assert.ok(disk.messages.length < 200, "应确实发生压缩");
    assert.equal(disk.meta.messageCount, disk.messages.length, "压缩结果已落盘");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/compact：未注入 ensureFullHistory 时回退到全量 load（命令模块不依赖 REPL）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ohna-compact-fallback-"));
  try {
    const { ctx } = await makeTailContext(dir, "long-fallback", 120);
    assert.equal(ctx.ensureFullHistory, undefined);

    await compactNow(ctx);
    assert.equal(ctx.history.length < 120, true, "压缩后内存应是合并后的历史");
    assert.match(takeOutput(), /120 条 →/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/compact：补载失败时取消压缩且不落盘（防止 tail 覆盖更早历史）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ohna-compact-guard-"));
  try {
    const { ctx, store } = await makeTailContext(dir, "long-guard", 200);
    const before = ctx.history.length;
    ctx.ensureFullHistory = async () => {
      throw new Error("磁盘不可读");
    };

    await compactNow(ctx);
    const text = takeOutput();
    assert.match(text, /已取消压缩/);
    assert.match(text, /磁盘不可读/);
    assert.equal(ctx.history.length, before, "失败时不得改动内存历史");
    const disk = await store.load("long-guard");
    assert.ok(disk);
    assert.equal(disk.messages.length, 200, "磁盘会话必须保持完整");
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

test("/status：tail 未补载时标注「已加载最近 N 条」而非完整条数（m2）", () => {
  const { ctx } = makeContext("/tmp/ohna-status-tail");
  ctx.history.push(
    ...Array.from({ length: 80 }, (_, index) => ({ role: "user", content: `消息-${index}`, timestamp: index })),
  );
  ctx.isFullHistoryLoaded = () => false;
  takeOutput();
  printStatus(ctx);
  const text = takeOutput();
  assert.match(text, /消息：已加载最近 80 条（完整历史未载入）/, "tail 恢复时不得把 80 当作会话总数");
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

test("/clear：清空 history 并进入待创建态（不 eager 落盘新会话）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ohna-clear-"));
  try {
    const { ctx, store, getSessionId } = makeContext(dir);
    ctx.history.push({ role: "user", content: "hi", timestamp: 1 });
    takeOutput();
    await clearSession(ctx);
    assert.equal(ctx.history.length, 0, "history 应被清空");
    assert.match(takeOutput(), /已清空上下文/);
    // BUG 空会话落盘：/clear 后 sessionId 应回到 pending 占位空串，而非立即分配新 id。
    assert.equal(getSessionId(), "", "会话应回到「待创建」占位空串");
    assert.equal(ctx.getTitle(), undefined, "标题应回到「新会话」占位");
    // 首条真实消息发送前不得落盘：store 目录仍为空，无任何空会话出现。
    const metas = await store.list();
    assert.equal(metas.length, 0, "不得产生落盘会话（空会话不应出现在磁盘/侧栏）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
