import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiServer } from "../dist/index.js";
import { createInMemoryApiTestRuntime } from "../dist/adapters/in-memory-test-runtime.js";

async function createSession(app, visitorId) {
  const response = await app.inject({
    method: "POST",
    url: "/api/identity/bootstrap",
    payload: { visitorId, fingerprintVersion: "test-v1" }
  });
  return response.headers["set-cookie"].split(";")[0];
}

async function waitForTerminal(app, snapshotUrl, headers) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: "GET", url: snapshotUrl, headers });
    const snapshot = response.json().data;
    if (["completed", "failed", "cancelled", "interrupted"].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not reach terminal state.");
}

test("conversation API creates, paginates, archives, validates cursors and isolates users", async () => {
  const app = createApiServer({ ...createInMemoryApiTestRuntime(), requireIdentity: true });
  const userA = await createSession(app, "visitor_user_a");
  const userB = await createSession(app, "visitor_user_b");

  const first = await app.inject({ method: "POST", url: "/api/conversations", headers: { cookie: userA }, payload: { title: "第一会话" } });
  await app.inject({ method: "POST", url: "/api/conversations", headers: { cookie: userA }, payload: { title: "第二会话" } });
  const foreign = await app.inject({ method: "POST", url: "/api/conversations", headers: { cookie: userB }, payload: { title: "其他用户" } });
  assert.equal(first.statusCode, 201);
  assert.equal("userId" in first.json().data, false);

  const page1 = await app.inject({ method: "GET", url: "/api/conversations?limit=1", headers: { cookie: userA } });
  assert.equal(page1.json().data.items.length, 1);
  const page2 = await app.inject({
    method: "GET",
    url: `/api/conversations?limit=1&cursor=${encodeURIComponent(page1.json().data.nextCursor)}`,
    headers: { cookie: userA }
  });
  assert.equal(page2.json().data.items.length, 1);
  assert.equal(page2.json().data.items.some((item) => item.conversationId === foreign.json().data.conversationId), false);

  const invalid = await app.inject({ method: "GET", url: "/api/conversations?cursor=invalid", headers: { cookie: userA } });
  assert.equal(invalid.statusCode, 400);

  const archived = await app.inject({
    method: "PATCH",
    url: `/api/conversations/${first.json().data.conversationId}`,
    headers: { cookie: userA },
    payload: { archive: true }
  });
  assert.equal(archived.json().data.status, "archived");

  const forbiddenRead = await app.inject({
    method: "GET",
    url: `/api/conversations/${foreign.json().data.conversationId}/messages`,
    headers: { cookie: userA }
  });
  assert.equal(forbiddenRead.statusCode, 404);
  assert.equal(forbiddenRead.json().error.code, "not_found");
  await app.close();
});

test("run 完成后消息列表返回线性 Message DTO（content 原样透传）", async () => {
  const app = createApiServer({ ...createInMemoryApiTestRuntime(), requireIdentity: true });
  const cookie = await createSession(app, "visitor_messages_user");
  const conversation = (await app.inject({
    method: "POST", url: "/api/conversations", headers: { cookie }, payload: { title: "消息列表" }
  })).json().data;

  const accepted = (await app.inject({
    method: "POST", url: "/api/runs", headers: { cookie },
    payload: { message: "你好", conversationId: conversation.conversationId, clientMessageId: "msg-list-1", mode: "auto", source: "composer" }
  })).json().data;
  await waitForTerminal(app, accepted.snapshotUrl, { cookie });

  const response = await app.inject({
    method: "GET", url: `/api/conversations/${conversation.conversationId}/messages`, headers: { cookie }
  });
  assert.equal(response.statusCode, 200);
  const items = response.json().data.items;
  assert.deepEqual(items.map((message) => message.role), ["user", "assistant"]);
  assert.equal(items[0].content, "你好");
  assert.equal(items[0].messageType, "normal");
  assert.equal(typeof items[1].content[0].text, "string");
  assert.equal("userId" in items[0], false);
  assert.equal("clientMessageId" in items[0], false);
  await app.close();
});
