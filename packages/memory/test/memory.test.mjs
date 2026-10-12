import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryStore,
  createMemoryRetrieveHook,
  createMemoryWriteHook,
  InMemoryMemoryStore,
  JsonlMemoryStore,
} from "../dist/index.js";

/** 构造一条 episode 的便捷函数（仅测试用）。 */
function episode(id, content, type = "result") {
  return { id, timestamp: Date.now(), content, type };
}

test("InMemory store 保存/检索 round-trip 与相关性排序", async () => {
  const store = new InMemoryMemoryStore();
  await store.saveEpisode(episode("1", "苹果公司 2024 年营收 创历史新高 利润 增长"));
  await store.saveEpisode(episode("2", "特斯拉 股价 下跌 新能源汽车 竞争 加剧"));
  await store.saveEpisode(episode("3", "美联储 加息 通胀 宏观经济")); // 噪声

  const results = await store.retrieve("苹果 营收 利润", 2);
  assert.equal(results.length, 2);
  // 与「苹果 营收 利润」最相关的是 episode 1。
  assert.equal(results[0].record.id, "1");
  assert.ok(results[0].score > results[1].score);
  assert.ok(results[0].score > 0);
});

test("InMemory 工作记忆更新：summary 覆盖、facts 按 key 合并", async () => {
  const store = new InMemoryMemoryStore();
  store.updateWorkingMemory({ summary: "用户偏好 A 股", facts: [{ key: "market", value: "CN" }] });
  store.updateWorkingMemory({ facts: [{ key: "market", value: "HK" }, { key: "risk", value: "low" }] });

  const wm = store.getWorkingMemory();
  assert.equal(wm.summary, "用户偏好 A 股");
  assert.deepEqual(wm.facts, [
    { key: "market", value: "HK" },
    { key: "risk", value: "low" },
  ]);
});

test("Jsonl store 持久化保存/检索 round-trip（跨实例加载）", async () => {
  const filePath = join(tmpdir(), `mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const workingFilePath = `${filePath}.working.json`;

  const writer = new JsonlMemoryStore({ filePath, workingFilePath });
  await writer.saveEpisode(episode("a", "贵州茅台 白酒 龙头 业绩 稳定"));
  await writer.saveEpisode(episode("b", "宁德时代 动力电池 新能源"));
  writer.updateWorkingMemory({ summary: "关注消费与新能源", facts: [{ key: "sector", value: "消费" }] });

  // 全新实例从同一文件加载，验证持久化。
  const reader = new JsonlMemoryStore({ filePath, workingFilePath });
  const all = await reader.listEpisodes();
  assert.equal(all.length, 2);

  const results = await reader.retrieve("白酒 龙头 业绩", 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].record.id, "a");

  const wm = reader.getWorkingMemory();
  assert.equal(wm.summary, "关注消费与新能源");
  assert.deepEqual(wm.facts, [{ key: "sector", value: "消费" }]);

  await fs.rm(filePath, { force: true });
  await fs.rm(workingFilePath, { force: true });
});

test("createMemoryStore 工厂：memory 与 jsonl 两种 kind", async () => {
  const mem = createMemoryStore("memory");
  assert.ok(mem instanceof InMemoryMemoryStore);

  const filePath = join(tmpdir(), `mem-factory-${Date.now()}.jsonl`);
  const jsonl = createMemoryStore("jsonl", { filePath });
  assert.ok(jsonl instanceof JsonlMemoryStore);

  assert.throws(() => createMemoryStore("jsonl", {}), /filePath/);

  await fs.rm(filePath, { force: true });
});

test("检索 Hook：transformContext 在预算内注入前导 user 消息（不污染原数组）", async () => {
  const store = new InMemoryMemoryStore();
  await store.saveEpisode(episode("1", "英伟达 GPU 数据中心 需求 强劲 营收 超预期"));
  await store.saveEpisode(episode("2", "可口可乐 饮料 季度 平淡")); // 噪声

  const hook = createMemoryRetrieveHook(store);

  const original = [{ role: "user", content: "英伟达 营收 怎么样", timestamp: Date.now() }];
  const out = await hook([...original]);

  // 注入返回新数组，原数组不被修改（瞬时注入，不污染持久历史）。
  assert.equal(original.length, 1);
  assert.equal(out.length, 2);
  // 检索记忆作为队首前导 user 消息注入。
  assert.equal(out[0].role, "user");
  assert.match(out[0].content, /\[检索记忆\]/);
  assert.match(out[0].content, /英伟达/);
  // 原始用户消息仍在。
  assert.equal(out[1].role, "user");
  assert.match(out[1].content, /英伟达 营收 怎么样/);
});

test("检索 Hook：低相关时无结果不注入（返回原数组）", async () => {
  const store = new InMemoryMemoryStore();
  await store.saveEpisode(episode("1", "完全无关的历史记忆 足球 篮球 比赛"));

  const hook = createMemoryRetrieveHook(store, { budget: { minScore: 0.2 } });
  const messages = [{ role: "user", content: "量子计算 最新进展", timestamp: Date.now() }];
  const out = await hook(messages);
  // 无相关记忆 -> 不注入，返回原数组。
  assert.equal(out.length, 1);
  assert.equal(messages.length, 1); // 原数组不变
});

test("写回 Hook：afterToolCall 把成功工具结果写回为 episode", async () => {
  const store = new InMemoryMemoryStore();
  const hook = createMemoryWriteHook(store);

  const afterContext = {
    assistantMessage: {},
    toolCall: {},
    args: { ticker: "AAPL" },
    result: {
      content: [{ type: "text", text: "查询到 AAPL 最新价 200 美元 市值 3 万亿" }],
      details: { price: 200 },
      isError: false,
    },
    isError: false,
    context: { messages: [] },
  };

  const result = hook(afterContext);
  assert.equal(result, undefined); // 纯副作用，不覆盖工具结果

  const episodes = await store.listEpisodes();
  assert.equal(episodes.length, 1);
  assert.match(episodes[0].content, /AAPL 最新价 200/);
  assert.equal(episodes[0].type, "result");
  assert.deepEqual(episodes[0].metadata.toolArgs, { ticker: "AAPL" });
  assert.equal(episodes[0].metadata.isError, false);
});

test("写回 Hook：默认不记录错误结果", async () => {
  const store = new InMemoryMemoryStore();
  const hook = createMemoryWriteHook(store);

  hook({
    args: {},
    result: { content: [{ type: "text", text: "失败详情" }], isError: true },
    isError: true,
    context: { messages: [] },
  });

  const episodes = await store.listEpisodes();
  assert.equal(episodes.length, 0);
});
