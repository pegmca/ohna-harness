import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDeterministicEmbedder,
  createMemoryStore,
  MEMORY_VECTOR_DIMENSIONS,
  PgVectorMemoryStore,
} from "../dist/index.js";

/**
 * 记录每次 query 调用的文本与参数，并按需返回预设行——不连真实 PG。
 * 同时可配置为抛错，以验证优雅降级。
 */
class MockExecutor {
  calls = [];
  rows = [];
  shouldThrow = false;

  async query(text, params) {
    this.calls.push({ text, params: params ?? [] });
    if (this.shouldThrow) throw new Error("boom");
    return { rows: this.rows };
  }

  lastCall() {
    return this.calls[this.calls.length - 1];
  }
}

function episode(id, content, type = "result") {
  return { id, timestamp: Date.now(), content, type };
}

test("确定性 embedder：固定 32 维、纯函数、词序无关", () => {
  const embed = createDeterministicEmbedder();
  const a = embed("alpha beta gamma");
  const b = embed("gamma beta alpha");
  assert.equal(a.length, MEMORY_VECTOR_DIMENSIONS);
  assert.deepEqual(a, b); // 顺序无关（bag-of-words）
  // L2 归一化：单位向量。
  const norm = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9);
});

test("saveEpisode 发出参数化 INSERT 且幂等 ON CONFLICT（向量以字面量参数传入）", async () => {
  const exec = new MockExecutor();
  const store = new PgVectorMemoryStore({ query: exec, ownerUserId: "u1" });
  await store.saveEpisode(episode("ep1", "hello world"));

  const call = exec.lastCall();
  assert.match(call.text, /insert\s+into\s+memory_episodes/i);
  assert.match(call.text, /on\s+conflict\s*\(id\)/i);
  assert.match(call.text, /\$5::public\.halfvec/i); // 向量以参数化字面量传入，非拼接
  assert.equal(call.params.length, 7);
  assert.match(call.params[4], /^\[.*\]$/); // 向量字面量格式
  assert.equal(call.params[0], "ep1");
  assert.equal(call.params[1], "u1");
});

test("retrieve 发出余弦最近邻查询并正确映射 score = 1 - distance", async () => {
  const exec = new MockExecutor();
  exec.rows = [
    { id: "r1", content: "matched", type: "result", metadata: { k: 1 }, score: 0.91 },
    { id: "r2", content: "other", type: "observation", metadata: null, score: 0.42 },
  ];
  const store = new PgVectorMemoryStore({ query: exec, ownerUserId: "u1" });
  const hits = await store.retrieve("query text", 3);

  const call = exec.lastCall();
  assert.match(call.text, /OPERATOR\(public\.<=>\)/i);
  assert.match(call.text, /is\s+not\s+distinct\s+from\s+\$1/i); // owner 过滤
  assert.match(call.text, /limit\s+\$3/i);
  assert.equal(call.params[2], 3); // k 透传
  assert.equal(hits.length, 2);
  assert.equal(hits[0].record.id, "r1");
  assert.equal(hits[0].score, 0.91); // score 直接来自 1 - distance
  assert.deepEqual(hits[0].record.metadata, { k: 1 });
});

test("retrieve 失败优雅降级返回空数组（不抛）", async () => {
  const exec = new MockExecutor();
  exec.shouldThrow = true;
  const store = new PgVectorMemoryStore({ query: exec });
  const hits = await store.retrieve("x");
  assert.deepEqual(hits, []);
});

test("listEpisodes 映射行并应用 owner 过滤", async () => {
  const exec = new MockExecutor();
  exec.rows = [
    { id: "e1", type: "decision", content: "decided", source_turn: 4, metadata: { a: 1 }, created_at: new Date("2026-01-02T00:00:00Z") },
  ];
  const store = new PgVectorMemoryStore({ query: exec, ownerUserId: null });
  const list = await store.listEpisodes();

  const call = exec.lastCall();
  assert.match(call.text, /from\s+memory_episodes/i);
  assert.match(call.text, /is\s+not\s+distinct\s+from\s+\$1/i);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "e1");
  assert.equal(list[0].type, "decision");
  assert.equal(list[0].sourceTurn, 4);
  assert.equal(list[0].timestamp, Date.parse("2026-01-02T00:00:00Z"));
  assert.deepEqual(list[0].metadata, { a: 1 });
});

test("listEpisodes 失败优雅降级返回空数组", async () => {
  const exec = new MockExecutor();
  exec.shouldThrow = true;
  const store = new PgVectorMemoryStore({ query: exec });
  assert.deepEqual(await store.listEpisodes(), []);
});

test("saveEpisode 失败不抛出（fire-and-forget 安全）", async () => {
  const exec = new MockExecutor();
  exec.shouldThrow = true;
  const store = new PgVectorMemoryStore({ query: exec });
  await assert.doesNotReject(() => store.saveEpisode(episode("ep1", "x")));
});

test("工作记忆保持进程内：summary 覆盖、facts 按 key 合并", () => {
  const store = new PgVectorMemoryStore({ query: new MockExecutor() });
  store.updateWorkingMemory({ summary: "s1", facts: [{ key: "k1", value: "v1" }] });
  store.updateWorkingMemory({ facts: [{ key: "k1", value: "v1-updated" }, { key: "k2", value: "v2" }] });

  const wm = store.getWorkingMemory();
  assert.equal(wm.summary, "s1");
  assert.equal(wm.facts.length, 2);
  const k1 = wm.facts.find((f) => f.key === "k1");
  assert.equal(k1.value, "v1-updated"); // 同名覆盖
  // 返回防御性副本，外部修改不影响内部状态。
  wm.facts.push({ key: "k3", value: "v3" });
  assert.equal(store.getWorkingMemory().facts.length, 2);
});

test("工厂 createMemoryStore({ kind: 'pg' }) 要求 query，否则抛清晰错误", () => {
  assert.throws(() => createMemoryStore("pg", {}), /query/);
  const store = createMemoryStore("pg", { query: new MockExecutor() });
  assert.ok(store instanceof PgVectorMemoryStore);
});
