import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageEventStream } from "@aiagent/ai";
import { z } from "zod";
import { agentLoop, defaultConvertToLlm } from "../dist/index.js";

/** 构造一条 assistant 消息（测试用）。 */
function assistantMessage(content, stopReason = "stop") {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "mock-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now()
  };
}

function textMessage(text, stopReason = "stop") {
  return assistantMessage([{ type: "text", text }], stopReason);
}

function toolCallMessage(toolCalls, stopReason = "toolUse") {
  return assistantMessage(
    toolCalls.map((tc) => ({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.arguments })),
    stopReason
  );
}

function userMessage(text) {
  return { role: "user", content: text, timestamp: Date.now() };
}

const MODEL = {
  id: "mock-model",
  name: "Mock",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096
};

/** 构造按序返回 assistant 消息的 mock streamFn；calls 记录每次调用的入参。 */
function createMockStreamFn(responses, calls = []) {
  let index = 0;
  const streamFn = (model, context, options) => {
    calls.push({ model, context, options });
    const message = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        stream.push({ type: "done", reason: message.stopReason, message });
      }
    });
    return stream;
  };
  return { streamFn, calls };
}

/** 构造一个回显参数的简易 AgentTool。 */
function createEchoTool(name = "echo", extra = {}) {
  const executions = [];
  const tool = {
    name,
    description: "echo tool",
    label: name,
    parameters: z.object({ value: z.string() }),
    executions,
    async execute(toolCallId, params) {
      executions.push({ toolCallId, params });
      return { content: [{ type: "text", text: `echo:${params.value}` }], details: { value: params.value } };
    },
    ...extra
  };
  return tool;
}

function createConfig(streamFnOverrides = {}) {
  return { model: MODEL, convertToLlm: defaultConvertToLlm, ...streamFnOverrides };
}

function collectTools(results) {
  return results.filter((m) => m.role === "toolResult");
}

test("no toolCall: single turn ends with the assistant answer", async () => {
  const { streamFn, calls } = createMockStreamFn([textMessage("你好")]);
  const context = { systemPrompt: "sys", messages: [], tools: [createEchoTool()] };
  const stream = agentLoop([userMessage("hi")], context, createConfig(), undefined, streamFn);

  const events = [];
  for await (const event of stream) events.push(event);
  const newMessages = await stream.result();

  assert.equal(calls.length, 1);
  assert.equal(newMessages.length, 2);
  assert.equal(newMessages[0].role, "user");
  assert.equal(newMessages[1].role, "assistant");
  assert.equal(events[0].type, "agent_start");
  assert.equal(events[events.length - 1].type, "agent_end");
  // 工具 schema 经 toLlmTools 转成 JSON Schema 进入 LLM context。
  assert.equal(calls[0].context.tools[0].name, "echo");
  assert.equal(calls[0].context.tools[0].parameters.type, "object");
});

test("multi-turn tool calling: three rounds of toolCall then final answer", async () => {
  const tool = createEchoTool();
  const { streamFn, calls } = createMockStreamFn([
    toolCallMessage([{ id: "t1", name: "echo", arguments: { value: "a" } }]),
    toolCallMessage([{ id: "t2", name: "echo", arguments: { value: "b" } }]),
    toolCallMessage([{ id: "t3", name: "echo", arguments: { value: "c" } }]),
    textMessage("done")
  ]);
  const context = { systemPrompt: "sys", messages: [], tools: [tool] };
  const stream = agentLoop([userMessage("go")], context, createConfig(), undefined, streamFn);
  const newMessages = await stream.result();

  assert.equal(calls.length, 4);
  assert.equal(tool.executions.length, 3);
  const toolResults = collectTools(newMessages);
  assert.equal(toolResults.length, 3);
  assert.deepEqual(toolResults.map((m) => m.toolCallId), ["t1", "t2", "t3"]);
  assert.ok(toolResults.every((m) => !m.isError));
  // 每个 ToolResultMessage 都追加回上下文，下一轮 LLM 调用能看到。
  assert.ok(calls[1].context.messages.some((m) => m.role === "toolResult" && m.toolCallId === "t1"));
  assert.equal(newMessages[newMessages.length - 1].role, "assistant");
});

test("parallel batch: two toolCalls execute concurrently and results follow source order", async () => {
  const starts = [];
  const finishes = [];
  const tool = {
    name: "slow_echo",
    description: "slow echo",
    label: "slow_echo",
    parameters: z.object({ value: z.string() }),
    async execute(toolCallId, params) {
      starts.push(toolCallId);
      await new Promise((resolve) => setTimeout(resolve, params.value === "first" ? 30 : 5));
      finishes.push(toolCallId);
      return { content: [{ type: "text", text: params.value }], details: {} };
    }
  };
  const { streamFn } = createMockStreamFn([
    toolCallMessage([
      { id: "p1", name: "slow_echo", arguments: { value: "first" } },
      { id: "p2", name: "slow_echo", arguments: { value: "second" } }
    ]),
    textMessage("done")
  ]);
  const context = { systemPrompt: "sys", messages: [], tools: [tool] };
  const stream = agentLoop([userMessage("go")], context, createConfig(), undefined, streamFn);
  const newMessages = await stream.result();

  // 并发执行：两个都开始之后才有完成；完成序与源序不同（second 更快）。
  assert.deepEqual(starts.sort(), ["p1", "p2"]);
  assert.deepEqual(finishes, ["p2", "p1"]);
  // 回喂顺序仍按 assistant 源顺序。
  const toolResults = collectTools(newMessages);
  assert.deepEqual(toolResults.map((m) => m.toolCallId), ["p1", "p2"]);
});

test("sequential tool in batch degrades the whole batch to serial execution", async () => {
  const order = [];
  const makeTool = (name, executionMode) => ({
    name,
    description: name,
    label: name,
    parameters: z.object({ value: z.string() }),
    ...(executionMode ? { executionMode } : {}),
    async execute(toolCallId) {
      order.push(`start:${toolCallId}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`end:${toolCallId}`);
      return { content: [{ type: "text", text: "ok" }], details: {} };
    }
  });
  const { streamFn } = createMockStreamFn([
    toolCallMessage([
      { id: "s1", name: "seq_tool", arguments: { value: "a" } },
      { id: "s2", name: "par_tool", arguments: { value: "b" } }
    ]),
    textMessage("done")
  ]);
  const context = { systemPrompt: "sys", messages: [], tools: [makeTool("seq_tool", "sequential"), makeTool("par_tool")] };
  const stream = agentLoop([userMessage("go")], context, createConfig(), undefined, streamFn);
  await stream.result();

  assert.deepEqual(order, ["start:s1", "end:s1", "start:s2", "end:s2"]);
});

test("beforeToolCall block: tool not executed, error fed back to the model", async () => {
  const tool = createEchoTool();
  const { streamFn } = createMockStreamFn([
    toolCallMessage([{ id: "b1", name: "echo", arguments: { value: "x" } }]),
    textMessage("understood")
  ]);
  const context = { systemPrompt: "sys", messages: [], tools: [tool] };
  const config = createConfig({
    beforeToolCall: async () => ({ block: true, reason: "denied by policy" })
  });
  const stream = agentLoop([userMessage("go")], context, config, undefined, streamFn);
  const newMessages = await stream.result();

  assert.equal(tool.executions.length, 0);
  const [toolResult] = collectTools(newMessages);
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content[0].text, /denied by policy/);
});

test("prepareNextTurn can swap the model for the next turn", async () => {
  const tool = createEchoTool();
  const nextModel = { ...MODEL, id: "mock-model-2" };
  const { streamFn, calls } = createMockStreamFn([
    toolCallMessage([{ id: "n1", name: "echo", arguments: { value: "a" } }]),
    textMessage("done")
  ]);
  let prepareCalls = 0;
  const config = createConfig({
    prepareNextTurn: () => {
      prepareCalls += 1;
      return prepareCalls === 1 ? { model: nextModel } : undefined;
    }
  });
  const context = { systemPrompt: "sys", messages: [], tools: [tool] };
  const stream = agentLoop([userMessage("go")], context, config, undefined, streamFn);
  await stream.result();

  assert.equal(calls.length, 2);
  assert.equal(calls[0].model.id, "mock-model");
  assert.equal(calls[1].model.id, "mock-model-2");
});

test("shouldStopAfterTurn exits gracefully after the current turn", async () => {
  const tool = createEchoTool();
  const { streamFn, calls } = createMockStreamFn([
    toolCallMessage([{ id: "q1", name: "echo", arguments: { value: "a" } }]),
    textMessage("should not be used")
  ]);
  const config = createConfig({ shouldStopAfterTurn: () => true });
  const context = { systemPrompt: "sys", messages: [], tools: [tool] };
  const stream = agentLoop([userMessage("go")], context, config, undefined, streamFn);
  const newMessages = await stream.result();

  // 工具正常执行完，但不再发起第二次 LLM 调用。
  assert.equal(calls.length, 1);
  assert.equal(tool.executions.length, 1);
  assert.equal(newMessages[newMessages.length - 1].role, "toolResult");
});

test("steering messages are injected before the next turn", async () => {
  const tool = createEchoTool();
  const { streamFn, calls } = createMockStreamFn([
    toolCallMessage([{ id: "g1", name: "echo", arguments: { value: "a" } }]),
    textMessage("done")
  ]);
  let steeringPulled = false;
  const config = createConfig({
    getSteeringMessages: async () => {
      if (steeringPulled) return [];
      steeringPulled = true;
      return [userMessage("追加约束")];
    }
  });
  const context = { systemPrompt: "sys", messages: [], tools: [tool] };
  const stream = agentLoop([userMessage("go")], context, config, undefined, streamFn);
  const newMessages = await stream.result();

  assert.ok(newMessages.some((m) => m.role === "user" && m.content === "追加约束"));
  assert.ok(calls[1].context.messages.some((m) => m.role === "user" && m.content === "追加约束"));
});

test("stopReason length: the whole tool batch is rejected, not executed", async () => {
  const tool = createEchoTool();
  const { streamFn, calls } = createMockStreamFn([
    toolCallMessage([{ id: "l1", name: "echo", arguments: { value: "a" } }], "length"),
    textMessage("retried")
  ]);
  const context = { systemPrompt: "sys", messages: [], tools: [tool] };
  const stream = agentLoop([userMessage("go")], context, createConfig(), undefined, streamFn);
  const newMessages = await stream.result();

  assert.equal(tool.executions.length, 0);
  const [toolResult] = collectTools(newMessages);
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content[0].text, /truncated|Re-issue/);
  // 错误回喂后 loop 继续，第二轮正常完成。
  assert.equal(calls.length, 2);
});

test("unknown tool and invalid arguments become isError results, loop keeps going", async () => {
  const tool = createEchoTool();
  const { streamFn } = createMockStreamFn([
    toolCallMessage([
      { id: "e1", name: "missing_tool", arguments: {} },
      { id: "e2", name: "echo", arguments: { wrong: 1 } }
    ]),
    textMessage("recovered")
  ]);
  const context = { systemPrompt: "sys", messages: [], tools: [tool] };
  const stream = agentLoop([userMessage("go")], context, createConfig(), undefined, streamFn);
  const newMessages = await stream.result();

  const toolResults = collectTools(newMessages);
  assert.equal(toolResults.length, 2);
  assert.ok(toolResults.every((m) => m.isError));
  assert.match(toolResults[0].content[0].text, /not found/);
  assert.match(toolResults[1].content[0].text, /Invalid arguments/);
  assert.equal(newMessages[newMessages.length - 1].role, "assistant");
});

test("stream error stops the loop with agent_end", async () => {
  const { streamFn, calls } = createMockStreamFn([textMessage("boom", "error")]);
  const context = { systemPrompt: "sys", messages: [], tools: [] };
  const stream = agentLoop([userMessage("go")], context, createConfig(), undefined, streamFn);
  const newMessages = await stream.result();

  assert.equal(calls.length, 1);
  assert.equal(newMessages[newMessages.length - 1].stopReason, "error");
});

test("tool that throws becomes an isError ToolResultMessage", async () => {
  const tool = {
    name: "boom",
    description: "boom",
    label: "boom",
    parameters: z.object({ value: z.string() }),
    async execute() {
      throw new Error("kaput");
    }
  };
  const { streamFn } = createMockStreamFn([
    toolCallMessage([{ id: "x1", name: "boom", arguments: { value: "a" } }]),
    textMessage("handled")
  ]);
  const context = { systemPrompt: "sys", messages: [], tools: [tool] };
  const stream = agentLoop([userMessage("go")], context, createConfig(), undefined, streamFn);
  const newMessages = await stream.result();

  const [toolResult] = collectTools(newMessages);
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content[0].text, /kaput/);
});
