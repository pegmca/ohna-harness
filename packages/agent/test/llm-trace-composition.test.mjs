/**
 * v2.0 采集层扩展测试：`estimateComposition` + `createLlmTraceStreamFn` 的
 * composition / window / observer.agentId 行为（docs/v2.0/04 §1.1 / §1.2 / §1.4 / §8）。
 *
 * 与 `llm-trace.test.mjs`（W1 既有契约）分工：那边锁「记录形状与失败语义」，
 * 这边锁「v2.0 新增的窗口构成口径」——固定输入 → 固定构成，逐类断言，
 * 系数表漂移时直接红。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageEventStream } from "@aiagent/ai";
import { createLlmTraceStreamFn, estimateComposition } from "../dist/index.js";

/** 采集窗口参数（构造 wrapper 时注入，必填）。 */
const WINDOW = { contextWindow: 128000, maxTokens: 4096, reserveTokens: 16384 };

const MODEL = {
  id: "mock-model",
  name: "Mock",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://localhost:9999",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

/**
 * 构造一条 assistant 消息（最小形状）。
 *
 * @param content content blocks。
 * @param stopReason 终止原因。
 * @returns AssistantMessage。
 */
function assistantMessage(content, stopReason = "stop") {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "mock-model",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

/**
 * 消费包装后的流并收集事件。
 *
 * @param stream 事件流。
 * @returns 事件数组。
 */
async function drain(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

/**
 * 构造一个「在 provider 位置调用钩子」的 base StreamFn。
 *
 * @param options.invokePayload 是否调用 onPayload（false 模拟未发请求即失败）。
 * @param options.throwing 是否同步 throw。
 * @returns { base, }
 */
function makeBase({ invokePayload = true, throwing = null } = {}) {
  return (model, context, options) => {
    if (throwing) throw throwing;
    const stream = new AssistantMessageEventStream();
    queueMicrotask(async () => {
      if (invokePayload) {
        await options?.onPayload?.({ model: model.id, stream: true }, model);
        await options?.onResponse?.({ status: 200, headers: {} }, model);
      }
      stream.push({ type: "done", reason: "stop", message: assistantMessage([{ type: "text", text: "ok" }]) });
    });
    return stream;
  };
}

// ---------------------------------------------------------------------------
// estimateComposition：固定输入 → 固定构成（04 §1.4 系数表）
// ---------------------------------------------------------------------------

/** 期望值手算依据：全部按 chars ÷ 4 向上取整，tools 按 {name,description,inputSchema} JSON 长度。 */
const FIXTURE_SYSTEM = "abcde"; // 5 chars → ceil(5/4) = 2
const FIXTURE_TOOLS = [
  // JSON.stringify({name:"echo",description:"d",inputSchema:{}}) = {"name":"echo","description":"d","inputSchema":{}} → 52 chars
  { name: "echo", description: "d", parameters: {} },
  // JSON.stringify({name:"read",description:"r",inputSchema:{"type":"object"}}) = 69 chars
  { name: "read", description: "r", parameters: { type: "object" } },
];
const TOOLS_JSON_CHARS =
  '{"name":"echo","description":"d","inputSchema":{}}'.length +
  '{"name":"read","description":"r","inputSchema":{"type":"object"}}'.length;

const FIXTURE_MESSAGES = [
  { role: "user", content: "hello world!", timestamp: 1 }, // 12 chars → 3
  {
    role: "assistant",
    content: [
      { type: "text", text: "ok" }, // 2 chars
      { type: "toolCall", id: "c1", name: "echo", arguments: { value: "x" } }, // JSON 序列化长度
    ],
    timestamp: 2,
  },
  {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "echo",
    content: [{ type: "text", text: "done" }], // 4 chars → 1
    isError: false,
    timestamp: 3,
  },
];

test("estimateComposition：固定输入 → 固定五分类构成（分块口径逐类命中）", () => {
  const composition = estimateComposition(FIXTURE_SYSTEM, FIXTURE_MESSAGES, FIXTURE_TOOLS);

  const toolCallChars = JSON.stringify({
    type: "toolCall",
    id: "c1",
    name: "echo",
    arguments: { value: "x" },
  }).length;

  assert.equal(composition.system, Math.ceil(5 / 4)); // 2
  assert.equal(composition.tools, Math.ceil(TOOLS_JSON_CHARS / 4));
  assert.equal(composition.user, Math.ceil(12 / 4)); // 3
  assert.equal(composition.assistant, Math.ceil((2 + toolCallChars) / 4));
  assert.equal(composition.toolResult, Math.ceil(4 / 4)); // 1
  assert.equal(
    composition.total,
    composition.system + composition.tools + composition.user + composition.assistant + composition.toolResult,
  );
});

test("estimateComposition：空输入全 0（不产生 NaN / 负数）", () => {
  assert.deepEqual(estimateComposition(undefined, [], undefined), {
    system: 0,
    tools: 0,
    user: 0,
    assistant: 0,
    toolResult: 0,
    total: 0,
  });
});

test("estimateComposition：user 消息为纯字符串形态时按文本块计量", () => {
  const composition = estimateComposition(undefined, [{ role: "user", content: "abcd", timestamp: 1 }], []);
  assert.equal(composition.user, 1);
  assert.equal(composition.total, 1);
});

test("estimateComposition：其余块（image 等）按其 JSON 序列化长度计量", () => {
  const image = { type: "image", data: "AAAA", mimeType: "image/png" };
  const composition = estimateComposition(
    undefined,
    [{ role: "toolResult", toolCallId: "c", toolName: "shot", content: [image], isError: false, timestamp: 1 }],
    undefined,
  );
  assert.equal(composition.toolResult, Math.ceil(JSON.stringify(image).length / 4));
});

test("estimateComposition：纯函数——不修改入参", () => {
  const messages = structuredClone(FIXTURE_MESSAGES);
  const tools = structuredClone(FIXTURE_TOOLS);
  const before = JSON.stringify({ messages, tools });
  estimateComposition(FIXTURE_SYSTEM, messages, tools);
  assert.equal(JSON.stringify({ messages, tools }), before);
});

// ---------------------------------------------------------------------------
// createLlmTraceStreamFn：window / composition / observer
// ---------------------------------------------------------------------------

test("createLlmTraceStreamFn：window 原样带入，composition 与 estimateComposition 一致", async () => {
  const records = [];
  const context = {
    systemPrompt: FIXTURE_SYSTEM,
    messages: FIXTURE_MESSAGES,
    tools: FIXTURE_TOOLS,
  };
  const wrapped = createLlmTraceStreamFn(
    makeBase(),
    (record) => records.push(record),
    undefined,
    { window: WINDOW },
  );
  await drain(wrapped(MODEL, context));

  assert.equal(records.length, 1);
  const record = records[0];
  assert.deepEqual(record.window, WINDOW);
  assert.deepEqual(record.composition, estimateComposition(FIXTURE_SYSTEM, FIXTURE_MESSAGES, FIXTURE_TOOLS));
  // 未注入 observer 时不写 agentId（交给消费侧归 supervisor 根节点）。
  assert.equal(record.agentId, undefined);
});

test("createLlmTraceStreamFn：observer.agentId 写入记录，且不进入 provider 请求体", async () => {
  const records = [];
  const payloads = [];
  const base = (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(async () => {
      const payload = { model: model.id, stream: true };
      // 模拟 adapter：只按自身字段构造请求体，observer 只存在于 options 上。
      payloads.push(payload);
      await options?.onPayload?.(payload, model);
      stream.push({ type: "done", reason: "stop", message: assistantMessage([{ type: "text", text: "ok" }]) });
    });
    return stream;
  };
  const wrapped = createLlmTraceStreamFn(
    base,
    (record) => records.push(record),
    undefined,
    { window: WINDOW },
  );
  await drain(
    wrapped(
      MODEL,
      { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { observer: { agentId: "bull-reviewer" } },
    ),
  );

  assert.equal(records[0].agentId, "bull-reviewer");
  assert.equal("observer" in payloads[0], false, "observer 不得混入 provider 请求体");
  assert.equal(records[0].request.providerPayload.observer, undefined);
});

test("createLlmTraceStreamFn：错误路径（同步 throw）composition 缺省、agentId 保留归因、window 仍在", async () => {
  const records = [];
  const boom = new Error("upstream exploded");
  const wrapped = createLlmTraceStreamFn(makeBase({ throwing: boom }), (record) => records.push(record), undefined, {
    window: WINDOW,
  });

  assert.throws(
    () => wrapped(MODEL, { systemPrompt: "s", messages: [] }, { observer: { agentId: "critic" } }),
    (error) => error === boom,
  );

  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.error.message, "upstream exploded");
  // 未到达 onPayload → 构成无从计算（可空字段忠实建模运行时事实）。
  assert.equal(record.composition, undefined);
  // agentId 是发起方属性、来自 options.observer：即便请求未发出，失败调用仍须可归因。
  assert.equal(record.agentId, "critic");
  // window 与请求成败无关：构造 wrapper 时即注入，必须在场。
  assert.deepEqual(record.window, WINDOW);
});

test("createLlmTraceStreamFn：未调 onPayload 即正常收尾时 composition 缺省、window 仍在", async () => {
  const records = [];
  const wrapped = createLlmTraceStreamFn(makeBase({ invokePayload: false }), (record) => records.push(record), undefined, {
    window: WINDOW,
  });
  await drain(wrapped(MODEL, { systemPrompt: "s", messages: [] }));

  assert.ok(records[0].response, "done 到达应有响应摘要");
  assert.equal(records[0].composition, undefined);
  assert.deepEqual(records[0].window, WINDOW);
});
