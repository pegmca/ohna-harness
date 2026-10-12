// agentLoop ↔ 真实 stdio MCP server 的 e2e 集成测试（确定性、不依赖网络）。
//
// 这条测试真实跑通：
//   agentLoop → createCombinedAgentTools（启动 packages/mcp/src/stdio.ts 的 dist/stdio.js，
//   注册 search_filings / get_financial_metrics / get_market_data）→ discoverMcpAgentTools
//   → execute（经 MCP adapter 调真实 server）→ 工具结果按 <untrusted_context> 约定回喂。
//
// 验收要点：
//   (a) combined.mcpAvailable === true 且含 search_filings；
//   (b) 事件流出现 tool_execution_end(toolName=search_filings, isError=false)；
//   (c) 工具结果 details.data.source === "mock_rag_runtime"（真实 server 已执行）。
//
// 第二个 test case 演示「外部/社区 server 经同一 AgentTool 契约并入」：
//   用 createCombinedAgentTools({ extraServers:[echo-demo] }) 启动确定性 in-repo echo server，
//   断言 extraServers 与合并 tools 中出现 echo_demo。
//
// 注意：本文件为 .mjs，直接由 node 运行，不做类型检查；因此只导入运行时值，
// 类型约束由实现方（TS）保证。StreamFn / mock message / config 严格对标
// packages/eval/src/loop-runner.ts 的 createFixtureStreamFn / createMockAssistantMessage / EVAL_MODEL。
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentLoop, defaultConvertToLlm } from "@aiagent/agent";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { createCombinedAgentTools } from "@aiagent/mcp";

// eval 专用 mock 模型条目（api 仅占位，mock streamFn 不会发起 HTTP 请求）。
const MOCK_MODEL = {
  id: "eval-mock",
  name: "Eval Mock Agent",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://localhost/eval-mock",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

// 每轮 mock usage：非零以便 token 预算累计逻辑被真实执行（若将来启用）。
const TURN_USAGE = {
  input: 120,
  output: 80,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 200,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * 组装一条完整的 mock AssistantMessage（toolUse / stop）。
 * @param {object} spec - { toolCall?, text?, stopReason }
 * @returns {object} AssistantMessage
 */
function makeAssistantMessage({ toolCall, text, stopReason }) {
  const content = toolCall
    ? [{ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments }]
    : [{ type: "text", text: text ?? "" }];
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: MOCK_MODEL.id,
    usage: TURN_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

/**
 * 确定性 mock StreamFn：第一轮返回 search_filings 工具调用（toolUse），
 * 第二轮（工具结果回喂后）返回含检索关键词的最终文本（stop）。
 * 事件序列对齐真实 provider：start → done。
 * @returns {() => import("@aiagent/ai").AssistantMessageEventStream}
 */
function createMockStreamFn() {
  let turn = 0;
  return () => {
    const isToolTurn = turn === 0;
    turn += 1;
    const message = isToolTurn
      ? makeAssistantMessage({
          toolCall: {
            id: "call_search",
            name: "search_filings",
            arguments: { companyId: "000001.SZ", query: "资产质量 不良贷款率", topK: 2 },
          },
          stopReason: "toolUse",
        })
      : makeAssistantMessage({
          text: "根据检索结果，平安银行 2025 年末不良贷款率为 1.02%，资产质量保持稳健。",
          stopReason: "stop",
        });
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
    });
    return stream;
  };
}

test("agentLoop executes MCP search_filings through the real stdio server and feeds back untrusted context", async () => {
  const combined = await createCombinedAgentTools();
  try {
    // (a) MCP 可用且含 search_filings。
    assert.equal(combined.mcpAvailable, true);
    assert.ok(combined.mcpToolNames.includes("search_filings"));

    const query = "平安银行资产质量如何？不良贷款率多少？";
    const context = {
      systemPrompt: "你是金融研究助手，需要证据时调用工具。",
      messages: [],
      tools: combined.tools,
    };

    // 安全计数器：累计 turn 数，超过阈值即停止，防止 mock 流失效时失控。
    let turnCount = 0;
    const config = {
      model: MOCK_MODEL,
      convertToLlm: defaultConvertToLlm,
      shouldStopAfterTurn: () => {
        turnCount += 1;
        return turnCount > 4;
      },
    };

    const events = [];
    const streamFn = createMockStreamFn();
    const signal = new AbortController().signal;
    const loop = agentLoop(
      [{ role: "user", content: query, timestamp: Date.now() }],
      context,
      config,
      signal,
      streamFn
    );
    for await (const event of loop) {
      events.push(event);
    }

    // (b) 事件流出现 search_filings 的工具执行结束且未出错。
    const toolEnd = events.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "search_filings"
    );
    assert.ok(toolEnd, "expected tool_execution_end for search_filings");
    assert.equal(toolEnd.isError, false);

    // (c) 工具结果来自真实 server（mock_rag_runtime）；同时最终回答非空且含关键词。
    assert.equal(toolEnd.result.details?.data?.source, "mock_rag_runtime");

    const agentEnd = events.find((event) => event.type === "agent_end");
    assert.ok(agentEnd, "expected agent_end");
    const finalAssistant = [...agentEnd.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    assert.ok(finalAssistant, "expected a final assistant message");
    const answerText = finalAssistant.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    assert.ok(answerText.length > 0, "final answer should be non-empty");
    assert.match(answerText, /不良贷款率/);
  } finally {
    // 务必释放底层 MCP client 与子进程。
    await combined.close();
  }
});

test("createCombinedAgentTools merges an external echo MCP server without breaking the default path", async () => {
  const echoServerPath = new URL("./fixtures/echo-stdio-server.mjs", import.meta.url).pathname;
  const result = await createCombinedAgentTools({
    extraServers: [{ command: process.execPath, args: [echoServerPath], clientName: "echo-demo" }],
  });
  try {
    // 默认路径（内置 server）行为不变。
    assert.equal(result.mcpAvailable, true);
    assert.ok(result.mcpToolNames.includes("search_filings"));

    // 外部 echo server 接入成功，且其工具经同一 AgentTool 契约并入。
    const extra = result.extraServers.find((server) => server.serverName === "echo-demo");
    assert.ok(extra, "expected echo-demo in extraServers");
    assert.equal(extra.ok, true);
    assert.ok(extra.toolNames.includes("echo_demo"));
    assert.ok(result.tools.some((tool) => tool.name === "echo_demo"));
  } finally {
    await result.close();
  }
});
