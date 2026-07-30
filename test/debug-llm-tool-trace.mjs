import { agentLoop, defaultConvertToLlm } from "../packages/agent/dist/index.js";
import { createDefaultToolRegistry } from "../packages/tools/dist/index.js";

const requestedQuestion = "帮我查询 000001.SZ 最近一期净利润和 ROE。";
const DEFAULT_DEBUG_PROVIDER = "openrouter";

/**
 * 手动调试真实 LLM → agentLoop function calling → 工具执行 → 多轮回喂 的闭环链路。
 * pi 化阶段 2 后不再有独立 LlmClient；真实模型经 packages/ai streamSimple 走 agentLoop。
 *
 * 使用方式：
 * 1. 配置 .env 或环境变量：AIAGENT_LLM_API_KEY_<PROFILE>、AIAGENT_LLM_BASE_URL_<PROFILE>、AIAGENT_LLM_MODEL_<PROFILE>。
 * 2. 运行 `pnpm build`。
 * 3. 先 `node test/debug-llm-tool-trace.mjs --dry-run` 检查模型配置。
 * 4. 再 `node test/debug-llm-tool-trace.mjs` 发起真实 LLM tool call。
 * 5. 默认 openrouter；可选 `--provider deepseek` 切换 profile。
 *
 * @returns Promise<void>
 */
async function main() {
  const options = parseOptions(process.argv);
  const runtime = createRuntimeFromEnv(options.provider);

  console.log("\n== 1. provider context ==");
  console.dir({ provider: options.provider, dryRun: options.dryRun, hasApiKey: Boolean(runtime.apiKey), model: runtime.model.id, baseUrl: runtime.model.baseUrl }, { depth: null });

  if (options.dryRun) {
    console.log(runtime.apiKey ? "\n== 配置可用；去掉 --dry-run 发起真实调用 ==" : "\n== 缺 API key，无法真实调用 ==");
    if (!runtime.apiKey) process.exitCode = 1;
    return;
  }
  if (!runtime.apiKey) {
    console.error("Missing API key. Set AIAGENT_LLM_API_KEY_" + options.provider.toUpperCase());
    process.exitCode = 1;
    return;
  }

  const events = [];
  const stream = agentLoop(
    [{ role: "user", content: requestedQuestion, timestamp: Date.now() }],
    {
      systemPrompt: "你是金融研究 Agent，可以调用工具查询财务指标后回答。",
      messages: [],
      tools: createDefaultToolRegistry().list()
    },
    { model: runtime.model, apiKey: runtime.apiKey, convertToLlm: defaultConvertToLlm },
    undefined
  );
  for await (const event of stream) {
    events.push(event);
    if (event.type === "tool_execution_start") console.log(`\n[tool] ${event.toolName} ${JSON.stringify(event.args)}`);
    if (event.type === "tool_execution_end") console.log(`[tool] ${event.toolName} isError=${event.isError}`);
  }

  const messages = await stream.result();
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  console.log("\n== 2. event sequence ==");
  console.log(events.map((event) => event.type).join(" -> "));
  console.log("\n== 3. final assistant message ==");
  console.dir(lastAssistant, { depth: null });
  if (lastAssistant?.stopReason === "error") process.exitCode = 1;
}

/**
 * 从环境变量装配 OpenAI 兼容模型 runtime（与 apps/api server.ts 同款约定）。
 *
 * @param profile 模型 profile 标识。
 * @returns pi 形态 Model 与 apiKey。
 */
function createRuntimeFromEnv(profile) {
  const suffix = profile.toUpperCase();
  const modelName = process.env[`AIAGENT_LLM_MODEL_${suffix}`] ?? "unknown-model";
  return {
    apiKey: process.env[`AIAGENT_LLM_API_KEY_${suffix}`],
    model: {
      id: modelName,
      name: modelName,
      api: "openai-completions",
      provider: profile,
      baseUrl: process.env[`AIAGENT_LLM_BASE_URL_${suffix}`] ?? "https://openrouter.ai/api/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192
    }
  };
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
  return { provider, dryRun: argv.includes("--dry-run") };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
