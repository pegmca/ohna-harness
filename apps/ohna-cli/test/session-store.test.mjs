/**
 * session-store 单测：JSONL 往返、损坏行跳过、原子写、id 安全与列表排序。
 *
 * 全部用例都注入 os.tmpdir() 下的临时目录，绝不触碰真实 `~/.ohna`。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore, deriveSessionTitle } from "../dist/session-store.js";

/** 本文件创建的临时目录，统一在 after 清理。 */
const tempDirs = [];

/**
 * 创建已 realpath 规范化的临时目录。
 *
 * @returns 临时目录绝对路径。
 */
function makeTempDir() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohna-session-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 构造一条 user 消息。 */
function userMessage(text, timestamp = 1) {
  return { role: "user", content: text, timestamp };
}

/** 构造一条 assistant 消息（字段与 @aiagent/ai 的 AssistantMessage 对齐）。 */
function assistantMessage(text, timestamp = 2) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-chat",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

/** 构造一条工具结果消息。 */
function toolResultMessage(toolCallId, text, timestamp = 3) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

test("save/load 往返：元数据、user/assistant/toolResult 与 CompactionMessage 全部保真", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  const messages = [
    {
      role: "compaction",
      summary: "此前讨论了 session store 的原子写",
      tokensBefore: 12000,
      summarizedMessageCount: 4,
      timestamp: 10,
    },
    userMessage("实现会话持久化，并说明原子写的取舍"),
    assistantMessage("已完成 JSONL store。"),
    toolResultMessage("call-1", "file content"),
  ];

  const meta = await store.create({ title: "会话持久化", workspaceRoot: "/tmp/ws" });
  await store.save(meta.id, messages, {
    title: "会话持久化",
    workspaceRoot: "/tmp/ws",
    usage: { input: 10, output: 5, total: 15, cost: 0.001 },
  });

  const loaded = await store.load(meta.id);
  assert.ok(loaded);
  assert.deepEqual(loaded.messages, messages);
  assert.equal(loaded.meta.id, meta.id);
  assert.equal(loaded.meta.title, "会话持久化");
  assert.equal(loaded.meta.workspaceRoot, "/tmp/ws");
  assert.equal(loaded.meta.messageCount, 4);
  assert.deepEqual(loaded.meta.usage, { input: 10, output: 5, total: 15, cost: 0.001 });
});

test("user content 块数组往返：@ 文件引用落盘后保真，并参与标题推导", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  // F-6：user message 的 content 可能是 [原文本, 文件块]；JSONL 必须原样保存，
  // load 的形状校验（isContentValue）也必须接受数组，否则恢复会话会丢掉引用内容。
  const content = [
    { type: "text", text: "解释 @src/a.ts" },
    { type: "text", text: "文件 src/a.ts：\nexport const a = 1;" },
  ];
  const meta = await store.create({ messages: [{ role: "user", content, timestamp: 1 }] });
  const loaded = await store.load(meta.id);
  assert.ok(loaded);
  assert.deepEqual(loaded.messages[0].content, content);
  const title = deriveSessionTitle(loaded.messages);
  assert.ok(title.startsWith("解释 @src/a.ts 文件 src/a.ts："));
  assert.equal(title.length, 40, "标题仍按 40 字符截断");
});

test("header.usage 逐字段校验：任一字段非法则整体丢弃，避免 NaN 进入预算（D4）", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  const headerBase = {
    type: "session",
    id: "usage-shape",
    title: "用量校验",
    createdAt: 1,
    updatedAt: 2,
    workspaceRoot: "/tmp/ws",
    messageCount: 1,
  };
  const messageLine = JSON.stringify({ type: "message", message: userMessage("用量会话") });

  // 合法 usage 原样恢复。
  writeFileSync(
    join(dir, "usage-ok.jsonl"),
    [
      JSON.stringify({ ...headerBase, id: "usage-ok", usage: { input: 10, output: 5, total: 15, cost: 0.01 } }),
      messageLine,
    ].join("\n") + "\n",
    "utf8",
  );
  const ok = await store.load("usage-ok");
  assert.deepEqual(ok.meta.usage, { input: 10, output: 5, total: 15, cost: 0.01 });

  // 各字段分别非法（负数 / 字符串 / null / 缺字段）：整体丢弃。
  const invalidUsages = [
    { input: -1, output: 5, total: 15, cost: 0.01 },
    { input: 10, output: "5", total: 15, cost: 0.01 },
    { input: 10, output: 5, total: 15, cost: null },
    { input: 10, output: 5, total: 15 },
  ];
  for (const [index, usage] of invalidUsages.entries()) {
    const id = `usage-bad-${index}`;
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [JSON.stringify({ ...headerBase, id, usage }), messageLine].join("\n") + "\n",
      "utf8",
    );
    const loaded = await store.load(id);
    assert.equal(loaded.meta.usage, undefined, `非法 usage #${index} 应整体丢弃`);
  }
});

test("文件格式：首行 session 元数据，后续每行一条 message，可直接 cat", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  const meta = await store.create({ title: "格式检查", workspaceRoot: "/tmp/ws" });
  await store.save(meta.id, [userMessage("hello"), assistantMessage("hi")]);

  const file = join(dir, `${meta.id}.jsonl`);
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 3);
  const header = JSON.parse(lines[0]);
  assert.equal(header.type, "session");
  assert.equal(header.id, meta.id);
  assert.equal(header.title, "格式检查");
  assert.equal(header.messageCount, 2);
  assert.equal(JSON.parse(lines[1]).type, "message");
  assert.equal(JSON.parse(lines[1]).message.role, "user");
  assert.equal(JSON.parse(lines[2]).message.role, "assistant");
});

test("原子写：save 后无临时文件残留，目标文件完整可读", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  const meta = await store.create({ title: "原子写", workspaceRoot: "/tmp/ws" });
  await store.save(meta.id, [userMessage("a"), assistantMessage("b")]);

  const entries = readdirSync(dir);
  assert.equal(entries.some((entry) => entry.includes(".tmp-")), false);
  assert.equal(entries.includes(`${meta.id}.jsonl`), true);
  const raw = readFileSync(join(dir, `${meta.id}.jsonl`), "utf8");
  assert.equal(raw.endsWith("\n"), true);
  assert.equal(raw.split("\n").filter(Boolean).length, 3);
});

test("load 跳过损坏行与结构不符行，仍返回可用消息", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  const file = join(dir, "broken.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", id: "broken", title: "损坏容忍", createdAt: 1, updatedAt: 2, workspaceRoot: "/tmp/ws", messageCount: 9 }),
      "{ this is not json",
      JSON.stringify({ type: "message", message: userMessage("第一条") }),
      JSON.stringify({ type: "unknown", payload: 1 }),
      JSON.stringify({ type: "message", message: "not-an-object" }),
      JSON.stringify({ type: "message", message: assistantMessage("第二条") }),
      "",
    ].join("\n"),
    "utf8",
  );

  const loaded = await store.load("broken");
  assert.ok(loaded);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0].role, "user");
  assert.equal(loaded.messages[1].role, "assistant");
  assert.equal(loaded.meta.messageCount, 2);
});

test("头部损坏但消息可用时用消息重建元数据", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  writeFileSync(
    join(dir, "noheader.jsonl"),
    [JSON.stringify({ type: "message", message: userMessage("重建标题的消息") })].join("\n") + "\n",
    "utf8",
  );

  const loaded = await store.load("noheader");
  assert.ok(loaded);
  assert.equal(loaded.meta.id, "noheader");
  assert.equal(loaded.meta.title, "重建标题的消息");
  assert.equal(loaded.messages.length, 1);
});

test("load 按 role 校验最小形状：role-only / 缺字段 / compaction 无 summary 均跳过（P2-7）", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  const file = join(dir, "shape.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify({
        type: "session",
        id: "shape",
        title: "形状校验",
        createdAt: 1,
        updatedAt: 2,
        workspaceRoot: "/tmp/ws",
        messageCount: 9,
      }),
      // 只有 role：全部跳过。
      JSON.stringify({ type: "message", message: { role: "user" } }),
      JSON.stringify({ type: "message", message: { role: "assistant" } }),
      JSON.stringify({ type: "message", message: { role: "toolResult", content: [] } }),
      JSON.stringify({ type: "message", message: { role: "compaction" } }),
      // toolResult 缺 content / compaction summary 非字符串。
      JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "c1" } }),
      JSON.stringify({ type: "message", message: { role: "compaction", summary: 42 } }),
      // 合法消息保留。
      JSON.stringify({ type: "message", message: userMessage("有效用户") }),
      JSON.stringify({ type: "message", message: assistantMessage("有效助手") }),
      JSON.stringify({ type: "message", message: toolResultMessage("c2", "有效结果") }),
      "",
    ].join("\n"),
    "utf8",
  );

  const loaded = await store.load("shape");
  assert.ok(loaded);
  assert.deepEqual(
    loaded.messages.map((message) => message.role),
    ["user", "assistant", "toolResult"],
  );
  assert.equal(loaded.meta.messageCount, 3);
});

test("头部缺字段用安全默认值，id 缺失时按无头部重建（P2-7）", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });

  // id 存在但 title/timestamps/workspaceRoot 缺失或类型错误：安全默认。
  writeFileSync(
    join(dir, "partial.jsonl"),
    [
      JSON.stringify({ type: "session", id: "partial", title: 123, createdAt: "bad" }),
      JSON.stringify({ type: "message", message: userMessage("用于重建标题") }),
    ].join("\n") + "\n",
    "utf8",
  );
  const partial = await store.load("partial");
  assert.ok(partial);
  assert.equal(partial.meta.title, "用于重建标题");
  assert.equal(partial.meta.createdAt, 0);
  assert.equal(partial.meta.updatedAt, 0);
  assert.equal(partial.meta.workspaceRoot, "");

  // id 缺失：该行不算 header，整份文件按消息重建元数据。
  writeFileSync(
    join(dir, "noid.jsonl"),
    [
      JSON.stringify({ type: "session", title: "没有 id", createdAt: 1, updatedAt: 2 }),
      JSON.stringify({ type: "message", message: userMessage("重建标题") }),
    ].join("\n") + "\n",
    "utf8",
  );
  const noid = await store.load("noid");
  assert.ok(noid);
  assert.equal(noid.meta.id, "noid");
  assert.equal(noid.meta.title, "重建标题");
  assert.equal(noid.meta.createdAt, 0);
  assert.equal(noid.meta.messageCount, 1);
});

test("list 按 updatedAt 倒序", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  const first = await store.create({ title: "A", workspaceRoot: "/tmp/ws" });
  const second = await store.create({ title: "B", workspaceRoot: "/tmp/ws" });
  // 再次保存 A，使其 updatedAt 晚于 B。
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.save(first.id, [userMessage("A updated")]);

  const list = await store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, first.id);
  assert.equal(list[1].id, second.id);
  assert.ok(list[0].updatedAt >= list[1].updatedAt);
});

test("id 路径安全：非法 id 在 load/save/create 时拒绝", async () => {
  const store = createSessionStore({ dir: makeTempDir() });
  await assert.rejects(() => store.load("../escape"), /非法会话 id/);
  await assert.rejects(() => store.save("a/b", []), /非法会话 id/);
  await assert.rejects(() => store.create({ id: ".." }), /非法会话 id/);
  await assert.rejects(() => store.create({ id: "a.b" }), /非法会话 id/);
});

test("标题推导：首条 user 文本压缩空白后截 40 字符；无 user 返回 undefined", () => {
  assert.equal(deriveSessionTitle([userMessage("  多行\n文本   标题  ")]), "多行 文本 标题");
  const long = "x".repeat(60);
  assert.equal(deriveSessionTitle([userMessage(long)]).length, 40);
  assert.equal(deriveSessionTitle([assistantMessage("只有助手消息")]), undefined);
});

test("空目录 list 返回空数组；不存在的会话 load 返回 null", async () => {
  const store = createSessionStore({ dir: join(makeTempDir(), "not-created-yet") });
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.load("missing"), null);
});
