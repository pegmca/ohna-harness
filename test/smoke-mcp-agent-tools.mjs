/**
 * 手工冒烟（阶段 5 MCP 回迁）：真实 stdio MCP server（本仓库内置 financial server）
 * → discoverMcpAgentTools 产出 AgentTool 数组并入 agentLoop config.tools
 * → MockModel 发起一轮 search_filings 工具调用 → 事件落 run_events。
 *
 * 断言点：
 * 1. mcp_tool_discovered 经 sink 写入 run_events（在 run 非终态时追加，对齐装配层 publish 语义）；
 * 2. tool_execution_start/end 事件来自真实 MCP 工具调用且未出错；
 * 3. 回喂模型的工具输出经 <untrusted_context> 二次封装（MockModel 会在最终答复中原样引用）。
 *
 * 运行方式：先 pnpm --filter @aiagent/finance-api build（依赖包已构建），再 node test/smoke-mcp-agent-tools.mjs。
 * 与 smoke-report-tool.mjs 的差异：本脚本直接装配 run application service（手动调度器），
 * 以便在 run 仍处 queued 时演示 discovery 事件落库；不需要 PostgreSQL。
 */
import assert from "node:assert/strict";
import { createMcpStdioClient, discoverMcpAgentTools } from "../packages/mcp/dist/index.js";
import { createDefaultToolRegistry } from "../packages/tools/dist/index.js";
import { createInMemoryApiTestRuntime } from "../apps/finance-api/dist/adapters/in-memory-test-runtime.js";
import {
  createInMemoryExecutionRegistry,
  createInMemoryRunEventBus
} from "../apps/finance-api/dist/adapters/in-memory-run-runtime.js";
// 使用与集成测试同一套测试替身 model runtime（apps/finance-api 已移除运行时 MockModel，此处不得再 import 已删除的 mock-model）。
import { createTestDoubleModelRuntime } from "../apps/finance-api/dist/adapters/test-double-model.js";
import { createRunApplicationService } from "../apps/finance-api/dist/application/run-service.js";

const userId = "user_smoke_mcp";

async function main() {
  // 1. 连接真实 stdio MCP server 并发现工具（产出即可并入 agentLoop config.tools 的 AgentTool[]）。
  const client = await createMcpStdioClient({ clientName: "aiagent-mcp-smoke" });
  const discoveryEvents = [];
  const discovered = await discoverMcpAgentTools(client, { sink: (event) => { discoveryEvents.push(event); } });
  assert.equal(discovered.ok, true, `MCP discovery 失败: ${JSON.stringify(discovered.error)}`);
  assert.equal(discovered.tools.length, 3);
  console.log("discovered MCP tools:", discovered.toolNames.join(", "));

  try {
    // 2. 装配 run service：默认内置工具 + MCP 工具数组合并为一个 tools（白名单前移到装配期）。
    const runtime = createInMemoryApiTestRuntime();
    const tools = [...createDefaultToolRegistry().list(), ...discovered.tools];
    // 手动调度器：create 之后 run 停在 queued，先落 discovery 事件再放行执行。
    let pendingTask;
    // 测试替身 runtime（不发起外部请求），与集成测试同源；注意本项目已无运行时 MockModel。
    const mockRuntime = createTestDoubleModelRuntime();
    const service = createRunApplicationService({
      store: runtime.runStore,
      messageStore: runtime.messageStore,
      eventBus: createInMemoryRunEventBus(),
      executionRegistry: createInMemoryExecutionRegistry(),
      scheduler: { schedule(task) { pendingTask = task; } },
      resolveModel: () => mockRuntime,
      hasModel: () => true,
      defaultModelId: "test-double",
      tools,
      dataSourceRuntime: runtime.dataSourceRuntime,
      attachmentRepository: runtime.attachmentRepository,
      citationRepository: runtime.citationRepository
    });

    // 3. 创建会话与 run（检索意图且不含 ticker → MockModel 选择 MCP search_filings）。
    const conversation = await runtime.conversationRepository.create(userId, { title: "mcp smoke" });
    const accepted = await service.create({
      message: "检索年报中关于不良贷款率的表述",
      conversationId: conversation.id
    }, userId);
    console.log("run created:", accepted.runId);
    assert.ok(pendingTask, "手动调度器应持有待执行 run");

    // 4. run 仍在 queued：把 discovery 捕获的 mcp_tool_discovered 事件写入 run_events
    //    （与 run-service 的 publish 同一条 store.appendEvent 路径）。
    const discoveryEvent = discoveryEvents.find((event) => event.type === "mcp_tool_discovered");
    assert.ok(discoveryEvent, "discovery 应产生 mcp_tool_discovered 事件");
    const appended = await runtime.runStore.appendEvent(userId, accepted.runId, {
      type: "mcp_tool_discovered",
      runId: accepted.runId,
      requestId: accepted.requestId,
      conversationId: conversation.id,
      createdAt: new Date().toISOString(),
      payload: discoveryEvent.payload
    });
    assert.ok(appended, "mcp_tool_discovered 应能写入 run_events（run 非终态）");
    console.log("mcp_tool_discovered appended to run_events, sequence:", appended.sequence);

    // 5. 放行执行：MockModel 发起 search_filings 工具调用，真实 MCP server 应答。
    await pendingTask();
    let snapshot;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      snapshot = await service.get(userId, accepted.runId);
      if (["completed", "failed", "cancelled", "interrupted"].includes(snapshot.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(snapshot.status, "completed", `run 未完成: ${snapshot.status} ${JSON.stringify(snapshot.error ?? "")}`);
    console.log("run terminal status:", snapshot.status);

    // 6. run_events 断言：discovery 事件 + 完整工具执行事件。
    const events = await service.listEvents(userId, accepted.runId, 0);
    const discoveredStored = events.find((event) => event.type === "mcp_tool_discovered");
    assert.ok(discoveredStored, "run_events 应含 mcp_tool_discovered");
    assert.equal(discoveredStored.payload.ok, true);
    assert.ok(discoveredStored.payload.toolNames.includes("search_filings"));

    const toolStart = events.find((event) => event.type === "tool_execution_start" && JSON.stringify(event.payload).includes("search_filings"));
    assert.ok(toolStart, "run_events 应含 search_filings 的 tool_execution_start");
    const toolEnd = events.find((event) => event.type === "tool_execution_end" && JSON.stringify(event.payload).includes("search_filings"));
    assert.ok(toolEnd, "run_events 应含 search_filings 的 tool_execution_end");
    assert.notEqual(JSON.stringify(toolEnd.payload).includes('"isError":true'), true, "MCP 工具调用不应出错");
    console.log("tool execution events: start seq", toolStart.sequence, "→ end seq", toolEnd.sequence);

    // 7. 安全封装断言：最终 assistant 答复引用的工具输出带 <untrusted_context> 边界。
    const finalAssistant = [...events].reverse().find(
      (event) => event.type === "message_end" && event.payload?.message?.role === "assistant"
    );
    assert.ok(finalAssistant, "run_events 应含最终 assistant message_end");
    const finalText = finalAssistant.payload.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    assert.ok(finalText.includes("<untrusted_context"), "MCP 工具输出应经 security 二次封装");
    assert.ok(finalText.includes('source="tool_output"'));
    console.log("final answer contains <untrusted_context> wrapper");

    console.log("\n✅ MCP agent tools 冒烟通过");
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
