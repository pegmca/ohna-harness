/**
 * session-store 尾部加载单测（Phase C4）：
 * 大文件倒读、损坏行跳过、`n` 边界、CRLF / 无尾换行、跨 64KB 块的多字节字符，
 * 以及头部声明的 `messageCount` 与全量 `load` 的一致性。
 *
 * 全部用例注入 os.tmpdir() 下的临时目录，绝不触碰真实 `~/.ohna`。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFullHistory } from "../dist/session/session-flow.js";
import { createSessionStore } from "../dist/session/session-store.js";
import { readExact } from "../dist/session/session-tail.js";

/** 本文件创建的临时目录，统一在 after 清理。 */
const tempDirs = [];

/**
 * 创建已 realpath 规范化的临时目录。
 *
 * @returns 临时目录绝对路径。
 */
function makeTempDir() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohna-tail-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 构造一条 user 消息。
 *
 * @param text 文本内容。
 * @param timestamp 时间戳（用于区分消息身份）。
 * @returns user 消息对象。
 */
function userMessage(text, timestamp) {
  return { role: "user", content: text, timestamp };
}

/**
 * 把消息数组序列化为 JSONL 文本（首行可带会话头）。
 *
 * @param id 会话 id。
 * @param messages 消息数组。
 * @param options 换行符与是否保留末尾换行。
 * @returns 完整 JSONL 文本。
 */
function toJsonl(id, messages, options = {}) {
  const { eol = "\n", trailingNewline = true, messageCount = messages.length } = options;
  const lines = [
    JSON.stringify({
      type: "session",
      id,
      title: "尾部加载测试",
      createdAt: 1,
      updatedAt: 2,
      workspaceRoot: "/tmp/ws",
      messageCount,
    }),
    ...messages.map((message) => JSON.stringify({ type: "message", message })),
  ];
  return lines.join(eol) + (trailingNewline ? eol : "");
}

test("尾部加载：只解码最近 n 条，hasMore=true，元数据仍取头部声明总数", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  const messages = Array.from({ length: 30 }, (_, index) => userMessage(`消息-${index}`, index));
  writeFileSync(join(dir, "large.jsonl"), toJsonl("large", messages), "utf8");

  const tail = await store.loadSessionTail("large", 5);
  assert.ok(tail);
  assert.equal(tail.messages.length, 5);
  assert.deepEqual(
    tail.messages.map((message) => message.content),
    ["消息-25", "消息-26", "消息-27", "消息-28", "消息-29"],
  );
  assert.equal(tail.hasMore, true);
  // messageCount 是完整历史条数（30），不是本次解码的 5 条。
  assert.equal(tail.meta.messageCount, 30);
  assert.equal(tail.meta.id, "large");
  assert.equal(tail.meta.title, "尾部加载测试");
});

test("n >= 总条数：返回全部消息、hasMore=false，与全量 load 消息一致", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  const meta = await store.create({ title: "小会话", workspaceRoot: "/tmp/ws" });
  const messages = [userMessage("一", 1), userMessage("二", 2), userMessage("三", 3)];
  await store.save(meta.id, messages);

  const tail = await store.loadSessionTail(meta.id, 80);
  const full = await store.load(meta.id);
  assert.ok(tail);
  assert.ok(full);
  assert.equal(tail.hasMore, false);
  assert.deepEqual(tail.messages, full.messages);
  assert.equal(tail.meta.messageCount, 3);
});

test("n=0：不返回消息但正确报告 hasMore，不把头部当消息", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  writeFileSync(join(dir, "zero.jsonl"), toJsonl("zero", [userMessage("唯一消息", 1)]), "utf8");

  const tail = await store.loadSessionTail("zero", 0);
  assert.ok(tail);
  assert.deepEqual(tail.messages, []);
  assert.equal(tail.hasMore, true);
  assert.equal(tail.meta.messageCount, 1);
});

test("损坏行与空行按 load 规则跳过，不计入 n", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  const messages = Array.from({ length: 10 }, (_, index) => userMessage(`有效-${index}`, index));
  const lines = [
    JSON.stringify({
      type: "session",
      id: "broken-tail",
      title: "损坏容忍",
      createdAt: 1,
      updatedAt: 2,
      workspaceRoot: "/tmp/ws",
      messageCount: 10,
    }),
    ...messages.map((message) => JSON.stringify({ type: "message", message })),
    "{ 这不是 JSON",
    JSON.stringify({ type: "message", message: { role: "user" } }),
    "",
  ];
  writeFileSync(join(dir, "broken-tail.jsonl"), lines.join("\n") + "\n", "utf8");

  const tail = await store.loadSessionTail("broken-tail", 3);
  assert.ok(tail);
  assert.deepEqual(
    tail.messages.map((message) => message.content),
    ["有效-7", "有效-8", "有效-9"],
  );
  assert.equal(tail.hasMore, true);
});

test("CRLF 与末尾无换行：尾部记录仍完整解码", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  const messages = [userMessage("甲", 1), userMessage("乙", 2), userMessage("丙", 3)];
  writeFileSync(
    join(dir, "crlf.jsonl"),
    toJsonl("crlf", messages, { eol: "\r\n", trailingNewline: false }),
    "utf8",
  );

  const tail = await store.loadSessionTail("crlf", 2);
  assert.ok(tail);
  assert.deepEqual(
    tail.messages.map((message) => message.content),
    ["乙", "丙"],
  );
  assert.equal(tail.hasMore, true);
  assert.equal(tail.meta.messageCount, 3);
});

test("超过 64KB 的 CJK 行跨倒读块边界仍逐字保真", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  const huge = "汉".repeat(40_000); // UTF-8 下约 120KB，必然横跨多个 64KB 倒读块。
  const messages = [userMessage("开头", 1), userMessage(huge, 2), userMessage("结尾", 3)];
  writeFileSync(join(dir, "huge.jsonl"), toJsonl("huge", messages), "utf8");

  const tail = await store.loadSessionTail("huge", 2);
  assert.ok(tail);
  assert.equal(tail.messages.length, 2);
  assert.equal(tail.messages[0].content, huge);
  assert.equal(tail.messages[1].content, "结尾");
  assert.equal(tail.hasMore, true);
});

test("头部损坏 / 缺失：退化为尾部消息重建标题，messageCount 为本次解码条数", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  const lines = [
    "{ 头部坏了",
    JSON.stringify({ type: "message", message: userMessage("尾部首条", 1) }),
    JSON.stringify({ type: "message", message: userMessage("尾部末条", 2) }),
  ];
  writeFileSync(join(dir, "noheader-tail.jsonl"), lines.join("\n") + "\n", "utf8");

  const tail = await store.loadSessionTail("noheader-tail", 5);
  assert.ok(tail);
  assert.equal(tail.meta.id, "noheader-tail");
  assert.equal(tail.meta.title, "尾部首条");
  assert.equal(tail.meta.messageCount, 2);
  assert.equal(tail.hasMore, false);
});

test("不存在的会话返回 null，非法 id 仍被拒绝", async () => {
  const store = createSessionStore({ dir: makeTempDir() });
  assert.equal(await store.loadSessionTail("missing", 10), null);
  await assert.rejects(() => store.loadSessionTail("../escape", 10), /非法会话 id/);
});

test("readExact：短读时按实际 bytesRead 循环补齐，不暴露未初始化字节（m1）", async () => {
  const data = Buffer.from("abcdefghij", "utf8");
  let calls = 0;
  // 假句柄：每次只返回 2 字节（模拟短读），验证循环补齐与按实际字节切片。
  const handle = {
    async read(buffer, offset, length, position) {
      calls += 1;
      const chunk = data.subarray(position, Math.min(position + 2, data.length));
      chunk.copy(buffer, offset);
      return { bytesRead: chunk.length, buffer };
    },
  };

  const got = await readExact(handle, data.length, 0);
  assert.equal(got.toString("utf8"), "abcdefghij", "短读必须被循环补齐到完整内容");
  assert.ok(calls >= 5, `应循环读取多轮，实际 ${calls} 次`);
  assert.equal(got.length, data.length, "返回值长度即实际读到的字节数");

  // 长度为 0 时立即返回空缓冲，不调用 read。
  const before = calls;
  const empty = await readExact(handle, 0, 0);
  assert.equal(empty.length, 0);
  assert.equal(calls, before, "length=0 不应触发读取");
});

test("ensureFullHistory：1000 条会话补载全量后 save 不再截断更早历史（C4 数据丢失回归）", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  const messages = Array.from({ length: 1000 }, (_, index) => userMessage(`长会话-${index}`, index));
  writeFileSync(join(dir, "huge-history.jsonl"), toJsonl("huge-history", messages), "utf8");

  const tail = await store.loadSessionTail("huge-history", 80);
  assert.ok(tail);
  assert.equal(tail.hasMore, true);
  assert.equal(tail.messages.length, 80);

  // 模拟 openSession 把 tail 放进内存 history。
  const history = [...tail.messages];
  const backfilled = await ensureFullHistory(store, "huge-history", history);
  assert.equal(backfilled, true);
  assert.equal(history.length, 1000, "补载后内存应为完整历史");
  assert.equal(history[0].content, "长会话-0", "更早消息必须回到内存");

  // 模拟 run 结束后 persistSession 的覆盖式 save（+1 条新消息）。
  history.push(userMessage("补载后的新消息", 1000));
  await store.save("huge-history", history);

  const rawLines = readFileSync(join(dir, "huge-history.jsonl"), "utf8").trimEnd().split("\n");
  assert.equal(rawLines.length, 1002, "头部 1 行 + 1001 条消息，不得只剩尾部");
  const full = await store.load("huge-history");
  assert.ok(full);
  assert.equal(full.messages.length, 1001);
  assert.equal(full.messages[0].content, "长会话-0");
  assert.equal(full.messages.at(-1).content, "补载后的新消息");
});

test("ensureFullHistory：补载时同样过滤 error/aborted assistant，且失败时不改动内存", async () => {
  const dir = makeTempDir();
  const store = createSessionStore({ dir });
  const messages = [
    userMessage("问题一", 1),
    {
      role: "assistant",
      content: [{ type: "text", text: "正常回答" }],
      stopReason: "stop",
      timestamp: 2,
    },
    {
      role: "assistant",
      content: [],
      stopReason: "aborted",
      timestamp: 3,
    },
    userMessage("问题二", 4),
    {
      role: "assistant",
      content: [],
      stopReason: "error",
      timestamp: 5,
    },
  ];
  writeFileSync(join(dir, "filtered.jsonl"), toJsonl("filtered", messages), "utf8");

  const history = [];
  assert.equal(await ensureFullHistory(store, "filtered", history), true);
  assert.deepEqual(
    history.map((message) => message.content),
    ["问题一", [{ type: "text", text: "正常回答" }], "问题二"],
    "error/aborted assistant 不应进入补载后的内存历史",
  );

  // 读取失败（会话不存在）：返回 false，且不能用空数组清掉调用方已有历史。
  const keep = [userMessage("保留我", 9)];
  const warnings = [];
  assert.equal(
    await ensureFullHistory(store, "missing", keep, (message) => warnings.push(message)),
    false,
  );
  assert.equal(keep.length, 1);
  assert.equal(keep[0].content, "保留我");
  assert.equal(warnings.length, 1);
});
