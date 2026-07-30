import assert from "node:assert/strict";
import { agentLoop, defaultConvertToLlm } from "../packages/agent/dist/index.js";
import { createDefaultToolRegistry } from "../packages/tools/dist/index.js";
import { createAssistantMessageEventStream } from "../packages/ai/dist/index.js";

/**
 * 验证 pi 化阶段 2 的 agentLoop 手动检查入口（替代旧 intent-router/agent-loop 验证）。
 *
 * 覆盖：无 toolCall 单轮结束、toolCall → ToolResult 回喂 → 二轮收尾、
 * 事件序列完整性（agent_start → turn → tool_execution → agent_end）。
 * 使用注入的脚本化 streamFn，无需真实模型与 API key。
 *
 * 运行方式：先 pnpm build，再 node test/verify-agent-loop.mjs
 *
 * @returns Promise<void>
 */
async function main() {
  const cases = [await verifySingleTurnChat(), await verifyToolCallLoop()];
  const summary = {
    ok: cases.every((item) => item.ok),
    checkedAt: new Date().toISOString(),
    cases
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

/** 验证普通问答单轮结束，不产生工具调用。 */
async function verifySingleTurnChat() {
  const events = [];
  const stream = agentLoop(
    [userMessage("解释一下 ROE 是什么？")],
    { systemPrompt: "test", messages: [], tools: createDefaultToolRegistry().list() },
    { model: mockModel(), convertToLlm: defaultConvertToLlm },
    undefined,
    scriptedStreamFn([[{ type: "text", text: "ROE 是净资产收益率。" }]])
  );
  for await (const event of stream) events.push(event.type);

  assert.deepEqual(events, ["agent_start", "turn_start", "message_start", "message_end", "message_start", "message_update", "message_update", "message_end", "turn_end", "agent_end"]);
  const messages = await stream.result();
  assert.equal(messages.at(-1).role, "assistant");
  return { name: "single_turn_chat", ok: true, events };
}

/** 验证 toolCall → ToolResultMessage 回喂 → 第二轮文本收尾的完整多轮。 */
async function verifyToolCallLoop() {
  const events = [];
  const stream = agentLoop(
    [userMessage("帮我算一下 12*4 等于多少？")],
    { systemPrompt: "test", messages: [], tools: createDefaultToolRegistry().list() },
    { model: mockModel(), convertToLlm: defaultConvertToLlm },
    undefined,
    scriptedStreamFn([
      [{ type: "toolCall", id: "call_1", name: "calculator", arguments: { expression: "12*4" } }],
      [{ type: "text", text: "12*4 = 48。" }]
    ])
  );
  for await (const event of stream) {
    events.push(event.type === "tool_execution_end" ? `tool_execution_end:${event.toolName}:${event.isError}` : event.type);
  }

  assert.equal(events.includes("tool_execution_start"), true);
  assert.equal(events.includes("tool_execution_end:calculator:false"), true);
  assert.equal(events[0], "agent_start");
  assert.equal(events.at(-1), "agent_end");
  const messages = await stream.result();
  const toolResult = messages.find((message) => message.role === "toolResult");
  assert.equal(toolResult?.toolName, "calculator");
  assert.equal(toolResult?.isError, false);
  return { name: "tool_call_loop", ok: true, events };
}

/** 构造一条 user 消息。 */
function userMessage(text) {
  return { role: "user", content: text, timestamp: Date.now() };
}

/** Mock 模型目录条目（api 占位，脚本化 streamFn 不会发起 HTTP）。 */
function mockModel() {
  return {
    id: "scripted-mock",
    name: "Scripted Mock",
    api: "openai-completions",
    provider: "mock",
    baseUrl: "http://localhost/mock",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096
  };
}

/**
 * 生成脚本化 streamFn：每次调用按序吐出预先编排的 AssistantMessage 内容块。
 *
 * @param script 每轮的内容块数组（text 块收尾 stop，toolCall 块收尾 toolUse）。
 * @returns 满足 StreamFn 契约的函数。
 */
function scriptedStreamFn(script) {
  let turn = 0;
  return () => {
    const blocks = script[Math.min(turn, script.length - 1)];
    turn += 1;
    const hasToolCall = blocks.some((block) => block.type === "toolCall");
    const message = {
      role: "assistant",
      content: blocks,
      api: "openai-completions",
      provider: "mock",
      model: "scripted-mock",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: hasToolCall ? "toolUse" : "stop",
      timestamp: Date.now()
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...message, content: [] } });
    blocks.forEach((block, contentIndex) => {
      if (block.type === "text") {
        stream.push({ type: "text_start", contentIndex, partial: message });
        stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
      } else {
        stream.push({ type: "toolcall_start", contentIndex, partial: message });
        stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
      }
    });
    stream.push({ type: "done", reason: hasToolCall ? "toolUse" : "stop", message });
    return stream;
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
