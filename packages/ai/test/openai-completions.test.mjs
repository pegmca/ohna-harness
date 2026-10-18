import assert from "node:assert/strict";
import test from "node:test";
import { stream, streamSimple } from "../dist/index.js";

// 测试用模型：openai-completions 协议，fake baseUrl，fetch 由测试注入。
const model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test-provider",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192
};

const context = {
  messages: [{ role: "user", content: "你好", timestamp: 1 }]
};

/** 把 chunk 列表编码为 SSE Response。 */
function sseResponse(chunks) {
  const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new TextEncoder().encode(lines), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

/** 收集事件流全部事件。 */
async function collect(eventStream) {
  const events = [];
  for await (const event of eventStream) {
    events.push(event);
  }
  return events;
}

test("纯文本流式回复：start → text_start/delta/end → done，usage 透传", async () => {
  let capturedInit;
  const fetchImpl = async (url, init) => {
    capturedInit = init;
    assert.equal(url, "https://example.test/v1/chat/completions");
    return sseResponse([
      { id: "chatcmpl-1", model: "test-model", choices: [{ delta: { content: "你" }, finish_reason: null }] },
      { id: "chatcmpl-1", model: "test-model", choices: [{ delta: { content: "好" }, finish_reason: null }] },
      {
        id: "chatcmpl-1",
        model: "test-model",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens_details: { reasoning_tokens: 0 }
        }
      }
    ]);
  };

  const eventStream = stream(model, context, { apiKey: "k", fetch: fetchImpl });
  const events = await collect(eventStream);
  const finalMessage = await eventStream.result();

  // 请求构造断言：authorization、stream、usage 开关。
  assert.equal(capturedInit.headers.authorization, "Bearer k");
  const payload = JSON.parse(capturedInit.body);
  assert.equal(payload.model, "test-model");
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.stream_options, { include_usage: true });
  assert.deepEqual(payload.messages, [{ role: "user", content: "你好" }]);

  // 事件序列逐字段对齐 pi AssistantMessageEvent 协议。
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "text_start", "text_delta", "text_delta", "text_end", "done"]
  );
  assert.equal(events[1].contentIndex, 0);
  assert.deepEqual(
    events.slice(2, 4).map((event) => [event.contentIndex, event.delta]),
    [
      [0, "你"],
      [0, "好"]
    ]
  );
  // 每个事件携带当前累积的完整 partial message。
  assert.equal(events[3].partial.content[0].text, "你好");
  assert.equal(events[4].content, "你好");

  const done = events[5];
  assert.equal(done.reason, "stop");
  assert.equal(done.message.stopReason, "stop");
  assert.equal(done.message.content[0].type, "text");
  assert.equal(done.message.content[0].text, "你好");
  assert.equal(done.message.responseId, "chatcmpl-1");
  // usage 透传：cached_tokens 计为 cacheRead 并从 input 扣除。
  assert.deepEqual(done.message.usage, {
    input: 6,
    output: 5,
    cacheRead: 4,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  });
  // result() 在 done 时 resolve 出最终消息。
  assert.equal(finalMessage, done.message);
});

test("单 tool_call 增量拼接：toolcall_start/delta/end，参数容错解析", async () => {
  const fetchImpl = async () =>
    sseResponse([
      {
        id: "c1",
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_price", arguments: '{"symbol":' } }] }, finish_reason: null }
        ]
      },
      {
        id: "c1",
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"600519"}' } }] }, finish_reason: null }]
      },
      { id: "c1", choices: [{ delta: {}, finish_reason: "tool_calls" }] }
    ]);

  const events = await collect(stream(model, context, { apiKey: "k", fetch: fetchImpl }));

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"]
  );
  assert.equal(events[1].contentIndex, 0);
  assert.deepEqual(
    events.slice(2, 4).map((event) => event.delta),
    ['{"symbol":', '"600519"}']
  );
  // 增量过程中 arguments 是部分解析结果，toolcall_end 时是完整对象。
  const toolcallEnd = events[4];
  assert.equal(toolcallEnd.toolCall.id, "call_1");
  assert.equal(toolcallEnd.toolCall.name, "get_price");
  assert.deepEqual(toolcallEnd.toolCall.arguments, { symbol: "600519" });
  assert.equal(events[5].reason, "toolUse");
  assert.equal(events[5].message.stopReason, "toolUse");
});

test("多 tool_call 增量拼接：按 index 归块，交错增量互不串扰", async () => {
  const fetchImpl = async () =>
    sseResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "a", function: { name: "t1", arguments: '{"x":' } },
                { index: 1, id: "b", function: { name: "t2", arguments: '{"y":2}' } }
              ]
            },
            finish_reason: null
          }
        ]
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
    ]);

  const events = await collect(stream(model, context, { apiKey: "k", fetch: fetchImpl }));

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_end",
      "toolcall_end",
      "done"
    ]
  );
  assert.equal(events[1].contentIndex, 0);
  assert.equal(events[3].contentIndex, 1);
  // 第三个 delta 属于 index 0 的块（contentIndex 0），即使它到达时块 1 已存在。
  assert.equal(events[5].contentIndex, 0);
  assert.equal(events[5].delta, "1}");
  // 收尾按块顺序推 toolcall_end。
  assert.deepEqual(events[6].toolCall.arguments, { x: 1 });
  assert.equal(events[6].toolCall.name, "t1");
  assert.deepEqual(events[7].toolCall.arguments, { y: 2 });
  assert.equal(events[7].toolCall.name, "t2");
  assert.equal(events[8].reason, "toolUse");
});

test("4xx/5xx → 结构化 error 事件（stopReason error + errorMessage）", async () => {
  const fetch400 = async () =>
    new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400, statusText: "Bad Request" });

  const events400 = await collect(stream(model, context, { apiKey: "k", fetch: fetch400 }));
  assert.deepEqual(
    events400.map((event) => event.type),
    ["error"]
  );
  assert.equal(events400[0].reason, "error");
  assert.equal(events400[0].error.stopReason, "error");
  assert.match(events400[0].error.errorMessage, /400/);
  assert.match(events400[0].error.errorMessage, /bad request/);

  const fetch503 = async () => new Response("service unavailable", { status: 503 });
  const eventStream = stream(model, context, { apiKey: "k", fetch: fetch503, maxRetries: 0 });
  const events503 = await collect(eventStream);
  assert.equal(events503.at(-1).type, "error");
  assert.match(events503.at(-1).error.errorMessage, /503/);
  // result() 在 error 时 resolve 出带 stopReason "error" 的最终消息。
  const finalMessage = await eventStream.result();
  assert.equal(finalMessage.stopReason, "error");
});

test("429 可重试：retry-after-ms 头控制等待，第二次成功", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("rate limited", { status: 429, headers: { "retry-after-ms": "1" } });
    }
    return sseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
  };

  const events = await collect(stream(model, context, { apiKey: "k", fetch: fetchImpl, maxRetries: 1 }));
  assert.equal(calls, 2);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).message.content[0].text, "ok");
});

test("AbortSignal 中断收尾：stopReason aborted，保留半条消息", async () => {
  const controller = new AbortController();
  const fetchImpl = async (url, init) => {
    const body = new ReadableStream({
      start(streamController) {
        const chunk = { id: "c1", choices: [{ delta: { content: "半" }, finish_reason: null }] };
        streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
        // 模拟真实 fetch：signal 中断时 body 流报错，之后不再产生数据。
        init.signal?.addEventListener("abort", () => {
          streamController.error(new Error("This operation was aborted"));
        });
      }
    });
    return new Response(body, { status: 200 });
  };

  const eventStream = stream(model, context, { apiKey: "k", fetch: fetchImpl, signal: controller.signal });
  const events = [];
  for await (const event of eventStream) {
    events.push(event);
    if (event.type === "text_delta") {
      controller.abort();
    }
  }

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "text_start", "text_delta", "error"]
  );
  const error = events.at(-1);
  assert.equal(error.reason, "aborted");
  assert.equal(error.error.stopReason, "aborted");
  // 半条消息保留在最终 AssistantMessage 上。
  assert.equal(error.error.content[0].text, "半");
  const finalMessage = await eventStream.result();
  assert.equal(finalMessage.stopReason, "aborted");
});

test("streamSimple：maxTokens 上下文钳制 + reasoning 档位映射进请求", async () => {
  let capturedBody;
  const reasoningModel = { ...model, reasoning: true };
  const fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return sseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
  };

  await collect(streamSimple(reasoningModel, context, { apiKey: "k", fetch: fetchImpl, reasoning: "high" }));
  assert.equal(capturedBody.reasoning_effort, "high");
  // contextWindow 128000 - 估算上下文 - 4096 安全余量，钳制后小于模型 maxTokens 的场景此处不触发。
  assert.equal(capturedBody.max_completion_tokens, 8192);
});

test("anthropic / google 类型桩：调用即产生结构化 error 事件", async () => {
  const anthropicModel = { ...model, api: "anthropic-messages" };
  const events = await collect(stream(anthropicModel, context, { apiKey: "k" }));
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "error"]
  );
  assert.equal(events[1].reason, "error");
  assert.match(events[1].error.errorMessage, /anthropic-messages/);
  assert.match(events[1].error.errorMessage, /尚未启用/);

  const googleModel = { ...model, api: "google-generative-ai" };
  const eventStream = streamSimple(googleModel, context, { apiKey: "k" });
  const finalMessage = await eventStream.result();
  assert.equal(finalMessage.stopReason, "error");
  assert.match(finalMessage.errorMessage, /google-generative-ai/);
});

test("瞬态网络错误（fetch rejection）可重试：status 缺失视为瞬态", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      // 裸 fetch 的连接层失败：不带 status/headers 的 TypeError。
      throw new TypeError("fetch failed");
    }
    return sseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
  };

  const events = await collect(stream(model, context, { apiKey: "k", fetch: fetchImpl, maxRetries: 1, maxRetryDelayMs: 0 }));
  assert.equal(calls, 2);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).message.content[0].text, "ok");
});

test("AbortError 不被重试：signal 中断直接走 aborted 收尾", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.equal(init.signal.aborted, true);
    const error = new Error("This operation was aborted");
    error.name = "AbortError";
    throw error;
  };

  const events = await collect(
    stream(model, context, { apiKey: "k", fetch: fetchImpl, signal: controller.signal, maxRetries: 3 })
  );
  assert.equal(calls, 1);
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).reason, "aborted");
});

test("tool_call 续传 chunk 省略 index/id 时回退到最近一个块", async () => {
  const fetchImpl = async () =>
    sseResponse([
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "a", function: { name: "t1", arguments: '{"x":' } }] }, finish_reason: null }
        ]
      },
      // 续传 chunk 不带 index/id（部分兼容端点行为），应并入上一个块而非新建。
      { choices: [{ delta: { tool_calls: [{ function: { arguments: "1}" } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
    ]);

  const events = await collect(stream(model, context, { apiKey: "k", fetch: fetchImpl }));

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"]
  );
  assert.equal(events[2].contentIndex, 0);
  assert.equal(events[3].contentIndex, 0);
  assert.equal(events[3].delta, "1}");
  assert.deepEqual(events[4].toolCall.arguments, { x: 1 });
  assert.equal(events[5].message.content.length, 1);
});

test("请求头大小写归一：大写 Authorization 覆盖默认 authorization，null 抑制头", async () => {
  let capturedInit;
  const modelWithHeaders = { ...model, headers: { "x-provider": "p", "x-drop-me": "gone" } };
  const fetchImpl = async (url, init) => {
    capturedInit = init;
    return sseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
  };

  await collect(
    stream(modelWithHeaders, context, {
      fetch: fetchImpl,
      headers: { Authorization: "Bearer custom", "X-Drop-Me": null }
    })
  );

  const authKeys = Object.keys(capturedInit.headers).filter((key) => key.toLowerCase() === "authorization");
  assert.deepEqual(authKeys, ["Authorization"]);
  assert.equal(capturedInit.headers.Authorization, "Bearer custom");
  assert.equal(capturedInit.headers["x-provider"], "p");
  // null 抑制（大小写不同也生效）。
  assert.equal(Object.keys(capturedInit.headers).some((key) => key.toLowerCase() === "x-drop-me"), false);
});

test("streamSimple 透传 toolChoice 到 tool_choice", async () => {
  let capturedBody;
  const fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return sseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
  };

  const contextWithTool = {
    messages: context.messages,
    tools: [{ name: "t1", description: "d", parameters: { type: "object" } }]
  };
  await collect(streamSimple(model, contextWithTool, { apiKey: "k", fetch: fetchImpl, toolChoice: "auto" }));
  assert.equal(capturedBody.tool_choice, "auto");
});

test("SSE 分块与 CRLF：data 行跨网络 chunk 截断、\\r\\n 行尾均能正确解析", async () => {
  const chunks = [
    { choices: [{ delta: { content: "拼接" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] }
  ];
  const sseText = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
  const encoded = new TextEncoder().encode(sseText);
  // 从一个 data 行中间切成两段，模拟网络分片。
  const cut = Math.floor(encoded.length / 3);
  const fetchImpl = async () =>
    new Response(
      new ReadableStream({
        start(streamController) {
          streamController.enqueue(encoded.slice(0, cut));
          streamController.enqueue(encoded.slice(cut));
          streamController.close();
        }
      }),
      { status: 200 }
    );

  const events = await collect(stream(model, context, { apiKey: "k", fetch: fetchImpl }));
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).message.content[0].text, "拼接");
});

test("流终止但无 finish_reason → 结构化 error 事件", async () => {
  const fetchImpl = async () =>
    sseResponse([{ choices: [{ delta: { content: "半截" }, finish_reason: null }] }]);

  const events = await collect(stream(model, context, { apiKey: "k", fetch: fetchImpl }));
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).reason, "error");
  assert.match(events.at(-1).error.errorMessage, /finish_reason/);
  // 已收到的内容保留在最终消息上。
  assert.equal(events.at(-1).error.content[0].text, "半截");
});

test("choice.usage 回退：chunk.usage 缺失时从 choice.usage 取（Moonshot 形态）", async () => {
  const fetchImpl = async () =>
    sseResponse([
      {
        choices: [
          {
            delta: { content: "ok" },
            finish_reason: "stop",
            usage: { prompt_tokens: 8, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } }
          }
        ]
      }
    ]);

  const events = await collect(stream(model, context, { apiKey: "k", fetch: fetchImpl }));
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.deepEqual(done.message.usage, {
    input: 5,
    output: 2,
    cacheRead: 3,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  });
});

test("usage.cost：按 model.cost（$/百万 token）在 done 前换算", async () => {
  const pricedModel = { ...model, cost: { input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0 } };
  const fetchImpl = async () =>
    sseResponse([
      {
        id: "chatcmpl-cost",
        model: "test-model",
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 500_000,
          prompt_tokens_details: { cached_tokens: 0 }
        }
      }
    ]);

  const events = await collect(stream(pricedModel, context, { apiKey: "k", fetch: fetchImpl }));
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.deepEqual(done.message.usage.cost, {
    input: 0.5,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    total: 1.5
  });
});
