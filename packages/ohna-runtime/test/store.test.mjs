/**
 * JSONL store 往返测试：不启动 HTTP，也不调用模型。
 *
 * 从 packages/serve/test/store.test.mjs 迁入，引用改为本包 dist 产物。
 * 原 `toConversationDto` 来自 serve 路由层（不在 runtime 包职责内），
 * 这里改为内联断言：只验证 store 透出的 SessionMeta.workspaceRoot 字段与
 * 落盘值一致——这正是原测试经 DTO 想验证的点。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { LocalMessageStore } from "../dist/store/message-store.js";
import { LocalRunStore } from "../dist/store/run-store.js";
import { LocalSessionStore } from "../dist/store/session-store.js";

/**
 * 创建临时数据目录。
 *
 * @returns {Promise<string>} 目录路径。
 */
async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ohna-runtime-store-"));
}

/**
 * 构造一条 canonical run event。
 *
 * @param {string} runId run id。
 * @param {number} sequence 序号。
 * @param {string} type 事件类型。
 * @param {unknown} payload 负载。
 * @returns {object} RunStreamEventDtoV2。
 */
function runEvent(runId, sequence, type, payload) {
  return {
    eventId: `event-${sequence}`,
    runId,
    requestId: "req-1",
    conversationId: "conv-1",
    sequence,
    type,
    payload,
    createdAt: new Date(2026, 0, 1, 0, 0, sequence).toISOString()
  };
}

test("session store: create/list/get/touch/update + 损坏行跳过", async () => {
  const dir = await tempDir();
  try {
    const store = new LocalSessionStore(path.join(dir, "sessions"));
    const created = await store.create({ title: "  Hello   World  ", workspaceRoot: "/tmp/ws" });
    assert.equal(created.title, "Hello World");
    assert.equal(created.status, "active");

    // 同 id create 幂等：不覆盖已有标题。
    const again = await store.create({ id: created.id, title: "另一个标题", workspaceRoot: "/tmp/ws" });
    assert.equal(again.title, "Hello World");

    await store.touch(created.id);
    const touched = await store.get(created.id);
    assert.ok(touched.updatedAt >= created.updatedAt);

    await store.update(created.id, { title: "改名后的会话" });
    assert.equal((await store.get(created.id)).title, "改名后的会话");

    await store.update(created.id, { status: "archived" });
    assert.equal((await store.list()).length, 0);
    assert.equal((await store.list({ includeArchived: true })).length, 1);
    assert.equal((await store.get(created.id)).status, "archived");

    // 损坏行 / 非法 id 不应影响读模型或越权读取。
    await fs.appendFile(path.join(dir, "sessions", "index.jsonl"), "{not-json}\n", "utf8");
    assert.equal((await store.list({ includeArchived: true })).length, 1);
    assert.equal(await store.get("../etc/passwd"), null);
    await store.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("session store: workspaceRoot 必填透出，缺字段/空串的坏行被跳过", async () => {
  const dir = await tempDir();
  try {
    const store = new LocalSessionStore(path.join(dir, "sessions"));
    // 正常写入带 workspaceRoot 的会话，store 透出该字段。
    const created = await store.create({ title: "带工作区的会话", workspaceRoot: "/work/a" });
    assert.equal(created.workspaceRoot, "/work/a");
    // 原 serve 测试经 toConversationDto 验证 DTO 透出 workspaceRoot；
    // runtime 包不含路由层 DTO，这里直接断言 store 返回的元数据字段即可覆盖同一意图。
    assert.equal(created.workspaceRoot, "/work/a");

    // 直接往索引追加：缺 workspaceRoot 与空串 workspaceRoot 两行坏数据（阻断性升级，无空串兜底）。
    await fs.appendFile(path.join(dir, "sessions", "index.jsonl"), JSON.stringify({
      type: "session",
      id: "no-ws",
      title: "缺工作区",
      createdAt: new Date(2026, 0, 1).toISOString(),
      updatedAt: new Date(2026, 0, 1).toISOString(),
      status: "active"
    }) + "\n", "utf8");
    await fs.appendFile(path.join(dir, "sessions", "index.jsonl"), JSON.stringify({
      type: "session",
      id: "empty-ws",
      title: "空工作区",
      createdAt: new Date(2026, 0, 1).toISOString(),
      updatedAt: new Date(2026, 0, 1).toISOString(),
      workspaceRoot: "",
      status: "active"
    }) + "\n", "utf8");

    const all = await store.list({ includeArchived: true });
    const ids = all.map((item) => item.id);
    assert.ok(ids.includes(created.id), "正常会话仍可读");
    assert.equal(ids.includes("no-ws"), false, "缺 workspaceRoot 的坏行应被跳过");
    assert.equal(ids.includes("empty-ws"), false, "空串 workspaceRoot 的坏行应被跳过");
    await store.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("message store: sequence 从 1 递增、游标分页、损坏行跳过", async () => {
  const dir = await tempDir();
  try {
    const store = new LocalMessageStore(path.join(dir, "conversations"));
    await store.ensureConversation("conv-1", "测试会话");

    const user = await store.append("conv-1", { role: "user", content: "你好" });
    const assistant = await store.append("conv-1", {
      role: "assistant",
      content: [{ type: "text", text: "你好呀" }],
      modelId: "stub-model",
      stopReason: "stop",
      usage: { input: 1, output: 1, totalTokens: 2 }
    });
    const tool = await store.append("conv-1", {
      role: "toolResult",
      content: {
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "file" }],
        isError: false
      }
    });

    assert.deepEqual([user.sequence, assistant.sequence, tool.sequence], [1, 2, 3]);
    assert.deepEqual((await store.list("conv-1")).map((item) => item.role), ["user", "assistant", "toolResult"]);

    const firstPage = await store.listPage("conv-1", { limit: 2 });
    assert.deepEqual(firstPage.items.map((item) => item.sequence), [1, 2]);
    assert.equal(firstPage.nextCursor, "2");

    const secondPage = await store.listPage("conv-1", { afterSequence: 2, limit: 2 });
    assert.deepEqual(secondPage.items.map((item) => item.sequence), [3]);
    assert.equal(secondPage.nextCursor, undefined);

    // 首行是元数据；损坏行不影响后续读取。
    const file = path.join(dir, "conversations", "conv-1.jsonl");
    const raw = await fs.readFile(file, "utf8");
    assert.equal(JSON.parse(raw.split("\n")[0]).type, "conversation_meta");
    await fs.appendFile(file, "半个 JSON\n{broken\n", "utf8");
    assert.equal((await store.list("conv-1")).length, 3);

    // id 白名单：非法 id 不读任意文件。
    assert.deepEqual(await store.list("../secret"), []);
    await store.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("run store: JSONL 只做模式脱敏，replay 正文完整保留", async () => {
  const dir = await tempDir();
  try {
    const store = new LocalRunStore(path.join(dir, "runs"));
    const runId = "run-redact";
    await store.create({
      runId,
      requestId: "req-redact",
      conversationId: "conv-redact",
      modelId: "stub-model",
      mode: "auto",
      source: "composer",
      userMessageId: "msg-redact",
      createdAt: new Date(2026, 0, 1).toISOString()
    });

    const assistantText = "这是助手的长回答。".repeat(75); // 675 字，超过旧的 500 字截断阈值
    const toolText = "工具输出内容".repeat(100); // 600 字

    await store.appendEvent(
      runId,
      runEvent(runId, 1, "message_end", {
        type: "message_end",
        message: { role: "user", content: "你好" }
      })
    );
    await store.appendEvent(
      runId,
      runEvent(runId, 2, "message_end", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: assistantText }] }
      })
    );
    await store.appendEvent(
      runId,
      runEvent(runId, 3, "tool_execution_end", {
        result: { content: [{ type: "text", text: toolText }] }
      })
    );
    await store.appendEvent(
      runId,
      runEvent(runId, 4, "message_end", {
        note: "Authorization: Bearer abc.def-123456",
        apiKey: "sk-12345678901234567890"
      })
    );

    const events = await store.listEvents(runId);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);

    // 用户提问、长回答、长工具结果都不能被整体替换或截断。
    assert.equal(events[0].payload.message.content, "你好");
    assert.equal(events[1].payload.message.content[0].text, assistantText);
    assert.equal(events[2].payload.result.content[0].text, toolText);
    assert.equal(assistantText.length, 675);
    assert.equal(toolText.length, 600);

    // secret 仍按模式替换，且不出现旧实现的 `[truncated]` 标记。
    assert.match(events[3].payload.note, /Bearer \[redacted\]/);
    assert.equal(events[3].payload.note.includes("abc.def-123456"), false);
    assert.equal(JSON.stringify(events).includes("sk-12345678901234567890"), false);
    assert.equal(JSON.stringify(events).includes("[truncated]"), false);

    const raw = await fs.readFile(path.join(dir, "runs", `${runId}.jsonl`), "utf8");
    assert.equal(raw.includes(assistantText), true);
    assert.equal(raw.includes(toolText), true);
    await store.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("run store: message_update 不落盘、payload 脱敏、快照重建", async () => {
  const dir = await tempDir();
  try {
    const store = new LocalRunStore(path.join(dir, "runs"));
    const runId = "run-1";
    await store.create({
      runId,
      requestId: "req-1",
      conversationId: "conv-1",
      modelId: "stub-model",
      mode: "auto",
      source: "composer",
      userMessageId: "msg-1",
      createdAt: new Date(2026, 0, 1).toISOString()
    });

    await store.appendEvent(runId, runEvent(runId, 1, "agent_start", { type: "agent_start" }));
    // 瞬态增量：占 sequence，但不落盘。
    await store.appendEvent(runId, runEvent(runId, 2, "message_update", { delta: "x" }));
    await store.appendEvent(
      runId,
      runEvent(runId, 3, "message_end", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "完成" }] },
        // 脱敏验证：持久化副本不应包含真实 key。
        apiKey: "sk-12345678901234567890"
      })
    );
    await store.appendEvent(runId, runEvent(runId, 4, "run_status", { status: "completed" }));

    const events = await store.listEvents(runId);
    assert.deepEqual(events.map((event) => event.sequence), [1, 3, 4]);
    assert.equal(events.some((event) => event.type === "message_update"), false);

    const snapshot = await store.getRun(runId);
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.lastEventSequence, 4);
    assert.equal(snapshot.conversationId, "conv-1");
    assert.equal(snapshot.userMessageId, "msg-1");

    const file = path.join(dir, "runs", `${runId}.jsonl`);
    const raw = await fs.readFile(file, "utf8");
    assert.equal(raw.includes("sk-12345678901234567890"), false);
    assert.equal(raw.includes('"type":"message_update"'), false);
    for (const line of raw.split("\n").filter(Boolean)) {
      JSON.parse(line); // cat 可读：每行都是完整 JSON
    }

    // 损坏行跳过。
    await fs.appendFile(file, "{half\n", "utf8");
    assert.equal((await store.listEvents(runId)).length, 3);

    // 没有终态事件的 run 在重启后视为 interrupted。
    await store.create({
      runId: "run-2",
      requestId: "req-2",
      conversationId: "conv-2",
      modelId: "stub-model",
      mode: "auto",
      source: "composer",
      userMessageId: "msg-2",
      createdAt: new Date(2026, 0, 1).toISOString()
    });
    await store.appendEvent("run-2", runEvent("run-2", 1, "agent_start", { type: "agent_start" }));
    assert.equal((await store.getRun("run-2")).status, "interrupted");
    await store.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
