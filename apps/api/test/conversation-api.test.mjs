import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { ConversationRepositoryError } from "@aiagent/conversation";
import { createIdentityService, createInMemoryIdentityRepository } from "@aiagent/identity";
import { createApiServer } from "../dist/index.js";

function createRepositories() {
  const conversations = [];
  const messages = [];
  const conversationRepository = {
    async create(userId, input) {
      const now = input.now ?? new Date().toISOString();
      const value = { id: input.id ?? randomUUID(), userId, title: input.title, status: "active", createdAt: now, updatedAt: now, lastMessageAt: now };
      conversations.push(value);
      return value;
    },
    async list(userId, input = {}) {
      const offset = decodeCursor(input.cursor);
      const limit = input.limit ?? 50;
      const owned = conversations.filter((item) => item.userId === userId && item.status === (input.status ?? "active"));
      return { items: owned.slice(offset, offset + limit), nextCursor: offset + limit < owned.length ? encodeCursor(offset + limit) : undefined };
    },
    async find(userId, conversationId) {
      return conversations.find((item) => item.id === conversationId && item.userId === userId);
    },
    async updateTitle(userId, conversationId, title) {
      const item = await this.find(userId, conversationId);
      if (!item) throw notFound();
      item.title = title;
      return item;
    },
    async archive(userId, conversationId) {
      const item = await this.find(userId, conversationId);
      if (!item) throw notFound();
      item.status = "archived";
      item.archivedAt = new Date().toISOString();
      return item;
    }
  };
  const messageRepository = {
    async append(userId, input) {
      const item = { id: randomUUID(), userId, sequence: messages.length + 1, createdAt: new Date().toISOString(), ...input };
      messages.push(item);
      return item;
    },
    async appendUserMessageIdempotently(userId, input) {
      const existing = messages.find((item) => item.userId === userId && item.conversationId === input.conversationId && item.clientMessageId === input.clientMessageId);
      if (existing) return { outcome: "existing", message: existing };
      return { outcome: "created", message: await this.append(userId, input) };
    },
    async list(userId, input) {
      const offset = decodeCursor(input.cursor);
      const limit = input.limit ?? 50;
      const owned = messages.filter((item) => item.userId === userId && item.conversationId === input.conversationId);
      return { items: owned.slice(offset, offset + limit), nextCursor: offset + limit < owned.length ? encodeCursor(offset + limit) : undefined };
    },
    async find(userId, messageId) {
      return messages.find((item) => item.userId === userId && item.id === messageId);
    }
  };
  return { conversationRepository, messageRepository, conversations, messages };
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Number.isInteger(value.offset) || value.offset < 0) throw new Error();
    return value.offset;
  } catch {
    throw new ConversationRepositoryError("invalid_cursor", "Invalid pagination cursor.");
  }
}

function notFound() {
  return new ConversationRepositoryError("not_found", "Conversation resource was not found.");
}

async function createSession(app, visitorId) {
  const response = await app.inject({
    method: "POST",
    url: "/api/identity/bootstrap",
    payload: { visitorId, fingerprintVersion: "test-v1" }
  });
  return response.headers["set-cookie"].split(";")[0];
}

test("conversation API creates, paginates, archives, validates cursors and isolates users", async () => {
  const repositories = createRepositories();
  const app = createApiServer({
    ...repositories,
    requireIdentity: true,
    identityService: createIdentityService(createInMemoryIdentityRepository(), { fingerprintPepper: "conversation-api-test" })
  });
  const userA = await createSession(app, "visitor_user_a");
  const userB = await createSession(app, "visitor_user_b");

  const first = await app.inject({ method: "POST", url: "/api/conversations", headers: { cookie: userA }, payload: { title: "第一会话" } });
  const second = await app.inject({ method: "POST", url: "/api/conversations", headers: { cookie: userA }, payload: { title: "第二会话" } });
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
  assert.equal(page2.json().data.items[0].conversationId, second.json().data.conversationId);
  assert.equal(page2.json().data.items.some((item) => item.conversationId === foreign.json().data.conversationId), false);

  const invalid = await app.inject({ method: "GET", url: "/api/conversations?cursor=invalid", headers: { cookie: userA } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "bad_request");

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

test("run submission persists one idempotent user message for repeated clientMessageId", async () => {
  const repositories = createRepositories();
  const app = createApiServer({
    ...repositories,
    requireIdentity: true,
    identityService: createIdentityService(createInMemoryIdentityRepository(), { fingerprintPepper: "conversation-run-test" })
  });
  const cookie = await createSession(app, "visitor_run_user");
  const conversation = (await app.inject({
    method: "POST", url: "/api/conversations", headers: { cookie }, payload: { title: "重试" }
  })).json().data;
  const payload = {
    message: "查询净利润",
    conversationId: conversation.conversationId,
    clientMessageId: randomUUID(),
    mode: "auto",
    source: "composer"
  };
  assert.equal((await app.inject({ method: "POST", url: "/api/runs", headers: { cookie }, payload })).statusCode, 202);
  assert.equal((await app.inject({ method: "POST", url: "/api/runs", headers: { cookie }, payload })).statusCode, 202);
  assert.equal(repositories.messages.length, 1);
  await app.close();
});
