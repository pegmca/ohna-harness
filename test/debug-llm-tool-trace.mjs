import { createLlmClientFromEnv } from "../packages/agent/dist/index.js";
import { createInMemoryTraceRecorder } from "../packages/trace/dist/index.js";
import { createDefaultToolRegistry } from "../packages/tools/dist/index.js";

const requestedQuestion = "帮我查询 000001.SZ 最近一期净利润和 ROE。";
const DEFAULT_DEBUG_PROVIDER = "openrouter";

/**
 * 手动调试真实 LLM tool calling -> registry.execute -> final chat -> trace events 的闭环链路。
 *
 * 使用方式：
 * 1. 先配置 .env 或环境变量，例如 AIAGENT_LLM_API_KEY_OPENROUTER、AIAGENT_LLM_BASE_URL_OPENROUTER、AIAGENT_LLM_MODEL_OPENROUTER。
 * 2. 运行 `pnpm build`。
 * 3. 先运行 `node test/debug-llm-tool-trace.mjs --dry-run` 检查配置是否能创建 client。
 * 4. 再运行 `node test/debug-llm-tool-trace.mjs` 发起真实 LLM tool call。
 * 5. 默认使用 openrouter；可选 `node test/debug-llm-tool-trace.mjs --provider kimi` 切换 profile。
 *
 * @returns Promise<void>
 */
async function main() {
  const options = parseOptions(process.argv);
  const registry = createDefaultToolRegistry();
  const trace = createInMemoryTraceRecorder("debug_llm_tool_trace_001");
  const clientResult = createLlmClientFromEnv(createDebugEnv(options.provider));

  console.log("\n== 1. provider context ==");
  console.dir(
    {
      provider: options.provider,
      dryRun: options.dryRun
    },
    { depth: null }
  );

  if (!clientResult.ok) {
    console.log("\n== createLlmClientFromEnv error ==");
    console.dir(clientResult, { depth: null });
    process.exitCode = 1;
    return;
  }

  if (options.dryRun) {
    console.log("\n== createLlmClientFromEnv ok ==");
    console.log("Client created. Remove --dry-run to call the real LLM provider.");
    return;
  }

  const messages = [
    {
      role: "user",
      content: requestedQuestion
    }
  ];
  const llmResult = await clientResult.data.toolChat({
    messages,
    tools: createToolDefinitions(),
    toolChoice: "required"
  });

  console.log("\n== 2. normalized llm tool decision ==");
  console.dir(llmResult, { depth: null });

  const toolResult = await executeSelectedTool(registry, trace, llmResult);

  console.log("\n== 3. tool execution result ==");
  console.dir(toolResult, { depth: null });

  const finalResponse = await createFinalResponse(clientResult.data, messages, llmResult, toolResult);

  console.log("\n== 4. final llm answer ==");
  console.dir(finalResponse, { depth: null });

  console.log("\n== 5. trace events recorded by packages/trace ==");
  console.dir(trace.getEvents(), { depth: null });
}

/**
 * 把工具结果交还给 LLM，让模型生成最终用户可读回答。
 *
 * @param client 已创建的 LLM client。
 * @param originalMessages 第一轮用户消息。
 * @param llmResult 第一轮 toolChat 返回的工具选择。
 * @param toolResult 本地 registry 执行工具后的结果。
 * @returns 第二轮 chat 返回的最终回答。
 */
async function createFinalResponse(client, originalMessages, llmResult, toolResult) {
  if (!llmResult.ok || !toolResult.ok) {
    return {
      ok: false,
      stage: "prepare_final_response",
      reason: "Skip final response because tool selection or tool execution failed.",
      llmResult,
      toolResult
    };
  }

  const selectedToolCall = llmResult.data.toolCall;

  return client.chat({
    messages: [
      ...originalMessages,
      {
        role: "system",
        content:
          "你正在调试一个金融研究 Agent。下面会给出本地工具执行结果，请只基于工具结果回答，不要编造额外数据。"
      },
      {
        role: "user",
        content: [
          `模型选择的工具：${selectedToolCall.name}`,
          `工具调用 ID：${selectedToolCall.id ?? "(none)"}`,
          `工具参数：${JSON.stringify(selectedToolCall.arguments)}`,
          `工具结果：${JSON.stringify(toolResult.result)}`,
          "请基于工具结果，用中文给出简洁结论，并明确说明数据来源是 mock。"
        ].join("\n")
      }
    ],
    temperature: 0.2
  });
}

/**
 * 解析调试脚本参数，避免为了切换 provider 修改代码。
 *
 * @param argv 当前 Node 进程参数。
 * @returns 调试选项。
 */
function parseOptions(argv) {
  const providerIndex = argv.indexOf("--provider");
  const provider = providerIndex >= 0 ? argv[providerIndex + 1] : DEFAULT_DEBUG_PROVIDER;

  return {
    provider,
    dryRun: argv.includes("--dry-run")
  };
}

/**
 * 创建传给 createLlmClientFromEnv 的环境变量集合，只覆盖本次调试需要的 profile。
 *
 * @param provider 可选模型 profile。
 * @returns 环境变量集合。
 */
function createDebugEnv(provider) {
  return {
    ...process.env,
    ...(provider ? { AIAGENT_LLM_PROVIDER: provider } : {})
  };
}

/**
 * 执行模型选中的工具。这里就是后续 Agent loop 会做的核心交接动作：
 * 把 LLM 返回的 tool name 和 arguments 交给 tools registry。
 *
 * @param registry 默认工具注册表。
 * @param trace 当前 run 的 trace recorder。
 * @param llmResult LLM toolChat 的结构化结果。
 * @returns 工具执行结果；如果 LLM 调用失败，则返回 LLM 错误包装。
 */
async function executeSelectedTool(registry, trace, llmResult) {
  if (!llmResult.ok) {
    return {
      ok: false,
      stage: "llm_tool_chat",
      error: llmResult.error
    };
  }

  const { name, arguments: args } = llmResult.data.toolCall;
  return registry.execute(name, args, { trace });
}

/**
 * 定义暴露给模型的工具 schema。003 阶段还没有把 zod schema 自动转 JSON schema，
 * 所以调试脚本直接手写 OpenAI-compatible function 参数结构。
 *
 * @returns LLM tool definitions。
 */
function createToolDefinitions() {
  return [
    {
      name: "financial_metric_mock",
      description: "查询稳定 mock 财务指标，包括最近一期净利润和 ROE。",
      parameters: {
        type: "object",
        properties: {
          ticker: {
            type: "string",
            description: "A 股 ticker，例如 000001.SZ。"
          },
          metrics: {
            type: "array",
            items: {
              type: "string",
              enum: ["net_profit", "roe"]
            }
          }
        },
        required: ["ticker"]
      }
    }
  ];
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
