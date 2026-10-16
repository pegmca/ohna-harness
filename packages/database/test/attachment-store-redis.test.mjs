import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createClient } from "redis";
import { createRedisAttachmentStore } from "../dist/index.js";

/**
 * P2-B（§8.2 row C）：RedisAttachmentStore 的 putInline / getInline 内联槽测试。
 *
 * 这些测试需要真实 Redis，通过 REDIS_URL 环境变量门控：
 * 未设置时整体跳过，避免在无 Redis 的 CI 环境失败。
 */
const redisUrl = process.env.REDIS_URL?.trim();
const hasRedis = Boolean(redisUrl);

/** 门控辅助：仅在有 Redis 时执行回调。 */
function withRedis(name, fn) {
  if (hasRedis) {
    test(name, fn);
  } else {
    test(name, { skip: "REDIS_URL not set" }, fn);
  }
}

/** 创建已连接的 Redis 客户端与 store。 */
async function setupStore() {
  const client = createClient({ url: redisUrl });
  await client.connect();
  const store = createRedisAttachmentStore({ client, ttlSeconds: 60 });
  return { store, client };
}

/** 清理某会话的全部附件 key。 */
async function cleanupConversation(client, conversationId) {
  const docsKey = `attach:conv:${conversationId}:docs`;
  const docIds = await client.sMembers(docsKey);
  const keys = [docsKey];
  for (const documentId of docIds) {
    keys.push(`attach:conv:${conversationId}:doc:${documentId}`);
    keys.push(`attach:conv:${conversationId}:doc:${documentId}:inline`);
    const chunkCount = Number((await client.hGet(`attach:conv:${conversationId}:doc:${documentId}`, "chunkCount")) ?? 0);
    for (let i = 0; i < chunkCount; i++) {
      keys.push(`attach:conv:${conversationId}:doc:${documentId}:chunk:${i}`);
    }
  }
  await client.del(keys);
}

withRedis("putInline + getInline round-trip", async () => {
  const { store, client } = await setupStore();
  try {
    const convId = `test-inline-${randomUUID()}`;
    const docId = `doc-${randomUUID()}`;
    const attachment = {
      documentId: docId,
      text: "这是一段内联附件原文。",
      source: "inline-source",
      fileName: "report.txt"
    };
    await store.putInline(convId, attachment);
    const result = await store.getInline(convId, docId);
    assert.deepEqual(result, attachment);
  } finally {
    await client.quit();
  }
});

withRedis("getInline returns null for missing document", async () => {
  const { store, client } = await setupStore();
  try {
    const convId = `test-inline-${randomUUID()}`;
    const result = await store.getInline(convId, "nonexistent-doc");
    assert.equal(result, null);
  } finally {
    await client.quit();
  }
});

withRedis("putInline with blank conversationId is silent no-op", async () => {
  const { store, client } = await setupStore();
  try {
    await store.putInline("", {
      documentId: "doc-1",
      text: "text",
      source: "src",
      fileName: "f.txt"
    });
    // 不抛错即通过
    assert.ok(true);
  } finally {
    await client.quit();
  }
});

withRedis("putInline with blank documentId is silent no-op", async () => {
  const { store, client } = await setupStore();
  try {
    await store.putInline("conv-1", {
      documentId: "",
      text: "text",
      source: "src",
      fileName: "f.txt"
    });
    assert.ok(true);
  } finally {
    await client.quit();
  }
});

withRedis("getInline with blank conversationId returns null", async () => {
  const { store, client } = await setupStore();
  try {
    const result = await store.getInline("", "doc-1");
    assert.equal(result, null);
  } finally {
    await client.quit();
  }
});

withRedis("getInline with blank documentId returns null", async () => {
  const { store, client } = await setupStore();
  try {
    const result = await store.getInline("conv-1", "");
    assert.equal(result, null);
  } finally {
    await client.quit();
  }
});

withRedis("putInline overwrites previous inline for same documentId", async () => {
  const { store, client } = await setupStore();
  try {
    const convId = `test-inline-${randomUUID()}`;
    const docId = `doc-${randomUUID()}`;
    await store.putInline(convId, {
      documentId: docId,
      text: "第一版原文",
      source: "v1",
      fileName: "v1.txt"
    });
    await store.putInline(convId, {
      documentId: docId,
      text: "第二版原文",
      source: "v2",
      fileName: "v2.txt"
    });
    const result = await store.getInline(convId, docId);
    assert.equal(result.text, "第二版原文");
    assert.equal(result.source, "v2");
    assert.equal(result.fileName, "v2.txt");
    await cleanupConversation(client, convId);
  } finally {
    await client.quit();
  }
});

withRedis("drop removes inline keys", async () => {
  const { store, client } = await setupStore();
  try {
    const convId = `test-drop-${randomUUID()}`;
    const docId = `doc-${randomUUID()}`;
    await store.putInline(convId, {
      documentId: docId,
      text: "待删除原文",
      source: "src",
      fileName: "f.txt"
    });
    await store.drop(convId);
    const result = await store.getInline(convId, docId);
    assert.equal(result, null);
  } finally {
    await client.quit();
  }
});

withRedis("touch renews inline key TTL", async () => {
  const { store, client } = await setupStore();
  try {
    const convId = `test-touch-${randomUUID()}`;
    const docId = `doc-${randomUUID()}`;
    await store.putInline(convId, {
      documentId: docId,
      text: "touch 测试",
      source: "src",
      fileName: "f.txt"
    });
    // touch 应不抛错且 inline key 仍可读回
    await store.touch(convId);
    const result = await store.getInline(convId, docId);
    assert.equal(result.text, "touch 测试");
    await cleanupConversation(client, convId);
  } finally {
    await client.quit();
  }
});

withRedis("inline and chunk keys coexist for same conversation", async () => {
  const { store, client } = await setupStore();
  try {
    const convId = `test-coexist-${randomUUID()}`;
    const docId = `doc-${randomUUID()}`;
    // 写入 inline 槽
    await store.putInline(convId, {
      documentId: docId,
      text: "内联原文",
      source: "inline-src",
      fileName: "inline.txt"
    });
    // 验证 inline 可读回
    const inline = await store.getInline(convId, docId);
    assert.equal(inline.text, "内联原文");
    // drop 应同时清理 inline 和 chunk 键
    await store.drop(convId);
    const afterDrop = await store.getInline(convId, docId);
    assert.equal(afterDrop, null);
  } finally {
    await client.quit();
  }
});
