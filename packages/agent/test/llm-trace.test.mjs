/**
 * W1 采集层测试（docs/v1.4/02-web-llm-trace.md §5 TC-W1-01..06）。
 *
 * FakeStreamFn 模式对齐 agent-loop.test.mjs：手工构造 AssistantMessageEventStream，
 * 并在「provider 位置」调用 options.onPayload / onResponse，模拟协议 adapter 的真实调用顺序。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageEventStream } from "@aiagent/ai";
import { createLlmTraceStreamFn, estimateComposition } from "../dist/index.js";

/** 构造 assistant 消息（测试用最小形状）。 */
function assistantMessage(content, stopReason = "stop", extra = {}) {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "mock-model",
    responseId: "resp_1",
    responseModel: "mock-model-2026",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 3,
      cacheWrite: 4,
      reasoning: 5,
      totalTokens: 30,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason,
    timestamp: Date.now(),
    ...extra,
  };
}

function userMessage(text) {
  return { role: "user", content: text, timestamp: Date.now() };
}

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

const CONTEXT = {
  systemPrompt: "system-prompt",
  messages: [userMessage("hello")],
  tools: [{ name: "echo", description: "echo tool", parameters: { type: "object", properties: { value: { type: "string" } } } }],
};

/** v2.0 采集窗口参数（构造 wrapper 时注入；`window` 必填，docs/v2.0/04 §1.1）。 */
const WINDOW = { contextWindow: 128000, maxTokens: 4096, reserveTokens: 16384 };

/**
 * 构造采集选项：`window` 自 v2.0 起必填。
 *
 * @param extra 额外选项（如 observer）。
 * @returns 可直接传给 createLlmTraceStreamFn 的 options。
 */
function traceOptions(extra = {}) {
  return { window: WINDOW, ...extra };
}

/**
 * 每个用例拿独立上下文：runner 可能把 context 交给被测代码并发生突变，
 * 共享同一对象会让用例之间互相污染（TC-W1-06 就是刻意突变它）。
 *
 * @returns 深拷贝的 Context。
 */
function freshContext() {
  return structuredClone(CONTEXT);
}

const OPTIONS = { temperature: 0.3, maxTokens: 512, reasoning: "low", maxRetries: 2, toolChoice: "auto" };

/**
 * 消费包装后的流并收集透传事件；返回事件序列。
 *
 * @param stream 包装后返回的事件流。
 * @returns 透传的完整事件数组。
 */
async function drain(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("TC-W1-01: done 收尾时记录请求/响应完整形状", async () => {
  const records = [];
  const base = (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(async () => {
      stream.push({ type: "start", partial: assistantMessage([]) });
      // 模拟 adapter：构造请求体 → onPayload 观察 → 发 POST → onResponse 观察状态。
      const payload = { model: model.id, messages: context.messages, stream: true, temperature: options.temperature };
      await options.onPayload?.(payload, model);
      await options.onResponse?.({ status: 200, headers: {} }, model);
      stream.push({ type: "text_start", contentIndex: 0, partial: assistantMessage([{ type: "text", text: "hi" }]) });
      const final = assistantMessage([{ type: "text", text: "hi" }]);
      stream.push({ type: "done", reason: "stop", message: final });
    });
    return stream;
  };

  const wrapped = createLlmTraceStreamFn(base, (record) => records.push(record), undefined, traceOptions());
  const events = await drain(wrapped(MODEL, freshContext(), OPTIONS));

  // 透传：事件数量与顺序保持（start / text_start / done），done 之后 result() 可解析。
  assert.deepEqual(events.map((e) => e.type), ["start", "text_start", "done"]);

  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(typeof record.callId, "string");
  assert.equal(record.callId.length, 36);
  assert.equal(record.callIndex, 1);
  assert.ok(Number.isFinite(record.startedAt));
  assert.equal(typeof record.durationMs, "number");
  assert.equal(record.attemptCount, 1);

  const request = record.request;
  assert.equal(request.provider, "mock");
  assert.equal(request.api, "openai-completions");
  assert.equal(request.modelId, "mock-model");
  assert.equal(request.baseUrl, "http://localhost:9999");
  assert.equal(request.systemPrompt, "system-prompt");
  assert.equal(request.messages[0].content, "hello");
  assert.equal(request.tools[0].name, "echo");
  assert.equal(request.tools[0].inputSchema.type, "object");
  assert.equal(request.temperature, 0.3);
  assert.equal(request.maxTokens, 512);
  assert.equal(request.reasoning, "low");
  assert.equal(request.toolChoice, "auto");
  assert.equal(request.retries, 2);
  assert.equal(request.providerPayload.model, "mock-model");
  assert.equal(request.providerPayload.stream, true);
  assert.equal(request.providerPayload.messages[0].content, "hello");

  const response = record.response;
  assert.equal(response.status, 200);
  assert.equal(response.finishReason, "stop");
  assert.equal(response.responseId, "resp_1");
  assert.equal(response.responseModel, "mock-model-2026");
  assert.equal(response.usage.input, 10);
  assert.equal(response.usage.output, 20);
  assert.equal(response.usage.cacheRead, 3);
  assert.equal(response.usage.cacheWrite, 4);
  assert.equal(response.usage.reasoning, 5);
  assert.equal(response.usage.totalTokens, 30);
  assert.equal(response.usage.cost.total, 0.003);
  assert.equal(response.message.content[0].text, "hi");
  assert.equal(record.error, undefined);
});

test("TC-W1-02: 链式 onPayload 先执行调用方钩子，再观察替换后的最终 payload", async () => {
  const records = [];
  const order = [];
  const base = (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(async () => {
      // 模拟 provider 内重试：同一调用内 3 次构造请求体，每次都走 onPayload。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await options.onPayload?.({ model: model.id, attempt }, model);
      }
      stream.push({ type: "done", reason: "stop", message: assistantMessage([{ type: "text", text: "ok" }]) });
    });
    return stream;
  };

  const wrapped = createLlmTraceStreamFn(base, (record) => records.push(record), undefined, traceOptions());
  await drain(
    wrapped(MODEL, freshContext(), {
      onPayload: async (payload) => {
        order.push("caller");
        return { ...payload, injected: true };
      },
    })
  );

  assert.deepEqual(order, ["caller", "caller", "caller"]);
  assert.equal(records[0].attemptCount, 3);
  // 观察到的是调用方替换后的最终值，而不是 adapter 原始 payload。
  assert.equal(records[0].request.providerPayload.injected, true);
  assert.equal(records[0].request.providerPayload.attempt, 2);
});

test("TC-W1-03: error 终态聚合 error 与响应摘要", async () => {
  const records = [];
  const failed = assistantMessage([], "error", { errorMessage: "provider exploded" });
  const base = () => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: failed });
      stream.push({ type: "error", reason: "error", error: failed });
    });
    return stream;
  };

  const wrapped = createLlmTraceStreamFn(base, (record) => records.push(record), undefined, traceOptions());
  await drain(wrapped(MODEL, freshContext()));

  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.error.message, "provider exploded");
  assert.equal(record.error.stopReason, "error");
  assert.equal(record.response.finishReason, "error");
  assert.equal(record.response.message.errorMessage, "provider exploded");
  assert.equal(typeof record.durationMs, "number");
});

test("TC-W1-04: 上游同步 throw 先记账再原样重抛同一错误对象", async () => {
  const records = [];
  const boom = new Error("upstream exploded");
  const wrapped = createLlmTraceStreamFn(
    () => {
      throw boom;
    },
    (record) => records.push(record),
    undefined,
    traceOptions()
  );

  assert.throws(
    () => wrapped(MODEL, freshContext(), OPTIONS),
    (error) => error === boom
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].error.message, "upstream exploded");
  assert.equal(records[0].request.modelId, "mock-model");
});

test("TC-W1-05: 无终态事件即结束（abort）时发出 error 记录且不悬挂", async () => {
  const records = [];
  const base = () => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: assistantMessage([]) });
      stream.end();
    });
    return stream;
  };

  const wrapped = createLlmTraceStreamFn(base, (record) => records.push(record), undefined, traceOptions());
  const events = await drain(wrapped(MODEL, freshContext(), { signal: undefined }));

  assert.deepEqual(events.map((e) => e.type), ["start"]);
  assert.equal(records.length, 1);
  assert.equal(records[0].error.message, "stream ended without terminal event");
  assert.equal(records[0].response, undefined);
});

test("TC-W1-05b: abort 且无终态事件时 error.stopReason 标记 aborted", async () => {
  const records = [];
  const controller = new AbortController();
  const base = () => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: assistantMessage([]) });
      stream.end();
    });
    return stream;
  };

  const wrapped = createLlmTraceStreamFn(base, (record) => records.push(record), undefined, traceOptions());
  controller.abort();
  await drain(wrapped(MODEL, freshContext(), { signal: controller.signal }));

  assert.equal(records.length, 1);
  assert.equal(records[0].error.stopReason, "aborted");
  assert.equal(records[0].error.message, "stream ended without terminal event");
});

test("TC-W1-05c: StreamFn 返回 rejected Promise 时补 error 终态并记账（不产生未处理 rejection）", async () => {
  const records = [];
  const wrapped = createLlmTraceStreamFn(
    () => Promise.reject(new Error("connector exploded")),
    (record) => records.push(record),
    undefined,
    traceOptions()
  );

  const events = await drain(wrapped(MODEL, freshContext()));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].error.errorMessage, "connector exploded");
  assert.equal(records.length, 1);
  assert.equal(records[0].error.message, "connector exploded");
});

test("TC-W1-02b: 调用方 onResponse 链式生效，wrapper 记录最终 status", async () => {
  const records = [];
  const order = [];
  const base = (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(async () => {
      await options?.onPayload?.({ model: model.id }, model);
      await options?.onResponse?.({ status: 201, headers: {} }, model);
      stream.push({ type: "done", reason: "stop", message: assistantMessage([{ type: "text", text: "ok" }]) });
    });
    return stream;
  };

  const wrapped = createLlmTraceStreamFn(base, (record) => records.push(record), undefined, traceOptions());
  await drain(
    wrapped(MODEL, freshContext(), {
      onResponse: (response) => {
        order.push(`caller:${response.status}`);
      },
    })
  );

  assert.deepEqual(order, ["caller:201"]);
  assert.equal(records[0].response.status, 201);
});

test("TC-W1-06: request 快照深拷贝，流式期突变不污染已记录内容", async () => {
  const records = [];
  const base = (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    const payload = { model: "original-model", messages: [{ role: "user", content: "original" }] };
    queueMicrotask(async () => {
      await options.onPayload?.(payload, model);
      // onPayload 之后（流式期间）原对象被复用/改写的典型场景。
      payload.model = "mutated-model";
      payload.messages[0].content = "mutated";
      context.messages[0].content = "mutated-context";
      stream.push({ type: "done", reason: "stop", message: assistantMessage([{ type: "text", text: "ok" }]) });
    });
    return stream;
  };

  const wrapped = createLlmTraceStreamFn(base, (record) => records.push(record), undefined, traceOptions());
  await drain(wrapped(MODEL, freshContext()));

  const request = records[0].request;
  assert.equal(request.messages[0].content, "hello");
  assert.equal(request.providerPayload.model, "original-model");
  assert.equal(request.providerPayload.messages[0].content, "original");
});

test("sink 抛错不打断流，且 callIndex 在同一 wrapper 内递增", async () => {
  const base = () => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message: assistantMessage([{ type: "text", text: "ok" }]) });
    });
    return stream;
  };
  const indices = [];
  const wrapped = createLlmTraceStreamFn(base, (record) => {
    indices.push(record.callIndex);
    throw new Error("sink failure");
  }, undefined, traceOptions());

  const first = await drain(wrapped(MODEL, freshContext()));
  const second = await drain(wrapped(MODEL, freshContext()));

  assert.equal(first.at(-1).type, "done");
  assert.equal(second.at(-1).type, "done");
  assert.deepEqual(indices, [1, 2]);
});

test("N-b①: async sink reject 不产生 unhandledRejection", async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const base = () => {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message: assistantMessage([{ type: "text", text: "ok" }]) });
      });
      return stream;
    };
    const wrapped = createLlmTraceStreamFn(base, async () => {
      throw new Error("async sink failure");
    }, undefined, traceOptions());

    const events = await drain(wrapped(MODEL, freshContext()));
    // 给 unhandledRejection 检测留一个事件循环轮次。
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(events.at(-1).type, "done");
    assert.deepEqual(rejections, [], "sink 的 rejection 必须被吞掉");
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("N-b②: baseUrl 内嵌凭据/查询串在落盘前被剥除", async () => {
  const records = [];
  const wrapped = createLlmTraceStreamFn(
    () => {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message: assistantMessage([{ type: "text", text: "ok" }]) });
      });
      return stream;
    },
    (record) => records.push(record),
    undefined,
    traceOptions()
  );

  await drain(
    wrapped(
      { ...MODEL, baseUrl: "https://user:token@gateway.example/v1?api_key=sk-xxx" },
      freshContext()
    )
  );

  assert.equal(records[0].request.baseUrl, "https://gateway.example/v1");
});
