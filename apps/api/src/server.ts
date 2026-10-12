import { agentLoop, defaultConvertToLlm, type AgentMessage } from "@aiagent/agent";
import type { Model } from "@aiagent/ai";
import { createQqBotChannel } from "@aiagent/channels";
import { createDatabaseRuntime, createVectorStoreFromEnv, DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS } from "@aiagent/database";
import { createLocalArtifactStorage } from "@aiagent/report";
import { createIdentityService } from "@aiagent/identity";
import { discoverMcpAgentTools, createMcpStdioClient, type McpClient } from "@aiagent/mcp";
import {
  createDataSourceRuntime,
  createEmbeddingClientFromEnv,
  createRerankerFromEnv,
  createContextEnricherFromEnv,
  createQueryRewriterFromEnv,
  DEFAULT_MOCK_EMBEDDING_MODEL,
  BRIDGE_ENV
} from "@aiagent/rag";
import { createDefaultToolRegistry } from "@aiagent/tools";
import { stat } from "node:fs/promises";
import { createApiServer } from "./index.js";
import { createModelRuntimeRegistry, type ModelRuntime, type ModelRuntimeEntry } from "./application/model-registry.js";
import { BASE_SYSTEM_PROMPT } from "./application/run-service.js";
import { createMockModelRuntime } from "./adapters/mock-model.js";

/**
 * 唯一生产 composition root：所有事实源 adapter 在此注入，领域 package 不读取 DATABASE_URL。
 * 默认 runtime 全部为 PostgreSQL；内存 repository 只由测试显式创建。
 */
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";
const providerMode = process.env.AIAGENT_PROVIDER_MODE ?? "mock";
// run 执行统一走 agentLoop；工具集在此装配一次，API server 与 QQ channel 共享。
const agentTools = createDefaultToolRegistry().list();
// 阶段 5 MCP 回迁：AIAGENT_MCP_ENABLED=true 时启动期做 stdio discovery，
// 产出直接并入 agentLoop config.tools（白名单语义前移到装配期）。
const mcpEnabled = process.env.AIAGENT_MCP_ENABLED === "true";
let mcpClient: McpClient | undefined;
const deepseekRuntime = providerMode === "real" ? createOpenAiCompatibleRuntime("deepseek", "https://api.deepseek.com/v1") : undefined;
const openrouterRuntime = providerMode === "real" ? createOpenAiCompatibleRuntime("openrouter", "https://openrouter.ai/api/v1") : undefined;
// profile id 必须与 env 后缀一致：createOpenAiCompatibleRuntime 用 profile.toUpperCase() 拼 AIAGENT_LLM_*_<SUFFIX>，
// 因此这里用 bridge_ai（非 bridge-ai），对应 .env 的 AIAGENT_LLM_*_BRIDGE_AI。
// baseUrl 缺省回退为环境变量 AIAGENT_LLM_BASE_URL_BRIDGE_AI（见 BRIDGE_ENV），去掉硬编码 IP；
// 未配置时传空串，由 createOpenAiCompatibleRuntime 自身的 env 读取行为决定（不改动该函数）。
const bridgeAiRuntime = providerMode === "real" ? createOpenAiCompatibleRuntime("bridge_ai", process.env[BRIDGE_ENV.baseUrl] ?? "") : undefined;
// 只注册「apiKey 与 model 同时配置齐全」的 profile；未配置的 profile 不进入目录，也不阻断 readiness。
// 默认模型取第一个已配置 profile（配置 DeepSeek 时优先 DeepSeek）。
const realEntries = [
  {
    option: {
      id: "deepseek",
      label: "DeepSeek",
      provider: "deepseek",
      description: "快速、稳定的金融研究对话",
      isDefault: false,
      capabilities: { structuredOutput: true, toolCalling: true }
    },
    runtime: deepseekRuntime?.runtime
  },
  {
    option: {
      id: "openrouter",
      label: "OpenRouter",
      provider: "openrouter",
      description: "通过 OpenRouter 调用配置模型",
      isDefault: false,
      capabilities: { structuredOutput: true, toolCalling: true }
    },
    runtime: openrouterRuntime?.runtime
  },
  {
    option: {
      id: "bridge_ai",
      label: "Bridge-AI",
      provider: "bridge_ai",
      description: "自托管 OpenAI-compatible 兼容端点",
      isDefault: false,
      capabilities: { structuredOutput: true, toolCalling: true }
    },
    runtime: bridgeAiRuntime?.runtime
  }
].filter((entry): entry is { option: ModelRuntimeEntry["option"]; runtime: ModelRuntime } => Boolean(entry.runtime));
const defaultRealModelId = realEntries[0]?.option.id ?? "deepseek";
const defaultRealEntry = realEntries.find((entry) => entry.option.id === defaultRealModelId);
if (defaultRealEntry) defaultRealEntry.option.isDefault = true;
// real 模式至少要有一个 provider 配置齐全；否则退回 mock 目录（readiness 会显式报告未配置）。
const modelRegistry = providerMode === "real" && realEntries.length > 0
  ? createModelRuntimeRegistry(realEntries, defaultRealModelId)
  : createModelRuntimeRegistry([{
      option: {
        id: "mock",
        label: "Mock Agent",
        provider: "mock",
        description: "本地确定性学习运行时",
        isDefault: true,
        capabilities: { structuredOutput: true, toolCalling: true }
      },
      runtime: createMockModelRuntime()
    }], "mock");
const database = createDatabaseRuntime(process.env.DATABASE_URL ?? "");
const artifactStorageRoot = process.env.ARTIFACT_STORAGE_ROOT ?? "./var/artifacts";
const attachmentOrphanTtlHours = Math.max(
  1,
  Number(process.env.AIAGENT_ATTACHMENT_ORPHAN_TTL_HOURS ?? 24)
);
let attachmentCleanupTimer: NodeJS.Timeout | undefined;
const identityService = createIdentityService(database.identityRepository, {
  fingerprintPepper: process.env.IDENTITY_FINGERPRINT_PEPPER ?? "",
  sessionTtlDays: Number(process.env.IDENTITY_SESSION_TTL_DAYS ?? 30)
});
const qqBotEnabled = process.env.QQBOT_ENABLED === "true";
const qqChannel = createQqBotChannel({
  enabled: qqBotEnabled,
  appId: process.env.QQBOT_APP_ID,
  appSecret: process.env.QQBOT_APP_SECRET,
  identityService,
  async answerAgent(_userId, message) {
    // QQ channel 复用同一条 agentLoop 路径，默认模型目录项解析 runtime。
    const runtime = modelRegistry.resolve(modelRegistry.defaultModelId);
    if (!runtime) return "模型未配置，暂时无法回答。";
    const prompt: AgentMessage = { role: "user", content: message, timestamp: Date.now() };
    const stream = agentLoop(
      [prompt],
      { systemPrompt: BASE_SYSTEM_PROMPT, messages: [], tools: agentTools },
      { model: runtime.model, apiKey: runtime.apiKey, convertToLlm: defaultConvertToLlm },
      undefined,
      runtime.streamFn
    );
    const messages = await stream.result();
    const lastAssistant = [...messages].reverse().find((item) => item.role === "assistant");
    if (!lastAssistant || lastAssistant.role !== "assistant") return "Agent 未能生成回答。";
    return lastAssistant.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n") || "Agent 未能生成回答。";
  },
  logger: {
    info(message, meta) { console.info(message, meta ?? {}); },
    warn(message, meta) { console.warn(message, meta ?? {}); },
    error(message, meta) { console.error(message, meta ?? {}); }
  }
});
const app = createApiServer({
  modelRegistry,
  tools: agentTools,
  identityService,
  dataSourceRuntime: createDataSourceRuntime({
    repository: database.ragDocumentRepository,
    // 生产组合开关：bridge 环境变量就绪时自动切真实 provider，否则回退确定性 mock / 启发式 / 恒等，
    // 保证本地 demo 与 CI 零外部依赖可复现；真实环境无需改码即热插拔（依赖倒置）。
    embeddingClient: createEmbeddingClientFromEnv(),
    reranker: createRerankerFromEnv(),
    contextEnricher: createContextEnricherFromEnv(),
    queryRewriter: createQueryRewriterFromEnv(),
    // env 驱动：有 DATABASE_URL 走 pgvector（生产默认），无则退化为内存 fixture 保持本地 demo 可用。
    vectorStoreFactory: createVectorStoreFromEnv(database.pool, {
      embeddingModel: DEFAULT_MOCK_EMBEDDING_MODEL,
      dimensions: DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS
    })
  }),
  attachmentRepository: database.attachmentRepository,
  citationRepository: database.citationRepository,
  requireIdentity: true,
  qqBotEnabled,
  qqBotQrUrl: process.env.QQBOT_PUBLIC_QR_URL,
  qqBotStatus: () => qqChannel.getStatus(),
  cookieSecure: process.env.IDENTITY_COOKIE_SECURE === "true",
  workflowRepository: database.workflowRepository,
  artifactRepository: database.artifactRepository,
  conversationRepository: database.conversationRepository,
  messageStore: database.messageStore,
  artifactStorage: createLocalArtifactStorage(artifactStorageRoot),
  runStore: database.runRepository,
  readiness: async () => {
    if (providerMode !== "mock" && providerMode !== "real") {
      return { ok: false, dependency: "provider-config", message: "AIAGENT_PROVIDER_MODE must be mock or real." };
    }
    if (providerMode === "real" && realEntries.length === 0) {
      return {
        ok: false,
        dependency: "llm-provider-config",
        message: "real 模式未配置任何可用 provider：请在 .env 至少设置一组 AIAGENT_LLM_API_KEY_<PROFILE> 与 AIAGENT_LLM_MODEL_<PROFILE>（deepseek / openrouter / bridge-ai）。"
      };
    }
    if (!await database.ping()) {
      return { ok: false, dependency: "postgresql", message: "PostgreSQL is not reachable." };
    }
    if (!await isStorageReady(artifactStorageRoot)) {
      return { ok: false, dependency: "artifact-storage", message: "Artifact storage root is not accessible." };
    }
    return { ok: true, dependency: providerMode === "real" ? "postgresql,artifact-storage,llm-provider-config" : "postgresql,artifact-storage,mock-runtime" };
  }
});

/**
 * 从环境变量装配 OpenAI 兼容模型 runtime（pi 形态 Model + apiKey）。
 * 缺 apiKey 或 model 时不产出 runtime，由 readiness 与 has() 在接流量前失败。
 *
 * @param profile 模型 profile 稳定标识（deepseek/openrouter）。
 * @param defaultBaseUrl 缺省 baseUrl。
 * @returns runtime 与配置错误消息（二者必居其一）。
 */
function createOpenAiCompatibleRuntime(
  profile: string,
  defaultBaseUrl: string
): { runtime?: ModelRuntime; error?: string } {
  const suffix = profile.toUpperCase();
  const rawApiKey = process.env[`AIAGENT_LLM_API_KEY_${suffix}`];
  // 文档占位符（replace-with-...）按未配置处理：避免把占位 key 当成真实凭据注册成默认模型，
  // 否则会静默用无效 key 请求导致 run 全部 401 失败（见用户切换 real 模式踩坑）。
  const apiKey = rawApiKey && !/^replace-with-/i.test(rawApiKey) ? rawApiKey : undefined;
  const baseUrl = process.env[`AIAGENT_LLM_BASE_URL_${suffix}`] || defaultBaseUrl;
  const modelName = process.env[`AIAGENT_LLM_MODEL_${suffix}`];
  if (!apiKey) return { error: `Missing LLM API key for ${profile} (AIAGENT_LLM_API_KEY_${suffix}).` };
  if (!modelName) return { error: `Missing LLM model for ${profile} (AIAGENT_LLM_MODEL_${suffix}).` };
  const model: Model<"openai-completions"> = {
    id: modelName,
    name: modelName,
    api: "openai-completions",
    provider: profile,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192
  };
  return { runtime: { model, apiKey } };
}

/**
 * 检查 artifact 存储根目录可写，readiness 与 PDF 下载共用同一事实源。
 *
 * @param root 存储根目录。
 * @returns 目录存在即可服务；文件由 local storage adapter 按需创建。
 */
async function isStorageReady(root: string): Promise<boolean> {
  try {
    return (await stat(root)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 启动前完成 migration 状态检查：存在 pending migration 说明 schema 落后于代码，
 * 必须拒绝启动而不是带着错误假设接流量。错误消息只含 migration 文件名。
 *
 * @returns schema 就绪时 resolve。
 */
async function assertSchemaCurrent(): Promise<void> {
  const pending = await database.listPendingMigrations();
  if (pending.length > 0) {
    throw new Error(`Database schema is not current; pending migrations: ${pending.join(", ")}. Run pnpm db:migrate first.`);
  }
}

/**
 * 启动本地 Fastify 服务，保持入口文件只负责进程生命周期。
 * 接流量顺序：migration 检查 → Fastify ready（含陈旧 Run 恢复）→ listen。
 *
 * @returns 服务启动 Promise。
 */
async function start(): Promise<void> {
  try {
    await assertSchemaCurrent();
    await assembleMcpTools();
    await app.listen({ port, host });
    void cleanupAttachmentOrphans();
    attachmentCleanupTimer = setInterval(() => void cleanupAttachmentOrphans(), 60 * 60_000);
    attachmentCleanupTimer.unref();
    if (qqBotEnabled) void qqChannel.start().catch((error) => app.log.error(error));
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

/**
 * 启动期 MCP discovery：连接真实 stdio MCP server，把产出 AgentTool 并入共享工具集。
 * 启动期没有 run 上下文，mcp_tool_discovered 事件落日志；run 内事件由 loop 的
 * tool_execution_* 承担（run_events）。server 不可用时仅记录日志并保留内置工具集。
 *
 * @returns 装配完成 Promise。
 */
async function assembleMcpTools(): Promise<void> {
  if (!mcpEnabled) return;
  try {
    mcpClient = await createMcpStdioClient({
      command: process.env.AIAGENT_MCP_COMMAND || undefined,
      args: process.env.AIAGENT_MCP_ARGS ? process.env.AIAGENT_MCP_ARGS.split(" ").filter(Boolean) : undefined
    });
    const discovered = await discoverMcpAgentTools(mcpClient, {
      sink: (event) => app.log.info({ mcpDiscovery: event.payload }, "mcp_tool_discovered")
    });
    if (discovered.ok) {
      agentTools.push(...discovered.tools);
      app.log.info({ mcpToolNames: discovered.toolNames }, "MCP tools assembled into agent loop");
    } else {
      app.log.warn({ error: discovered.error }, "MCP tool discovery failed; built-in tools only");
    }
  } catch (error) {
    app.log.warn({ err: error }, "MCP server unavailable; built-in tools only");
  }
}

/** @returns 完成一轮有界孤儿附件清理。 */
async function cleanupAttachmentOrphans(): Promise<void> {
  const before = new Date(Date.now() - attachmentOrphanTtlHours * 60 * 60_000).toISOString();
  let cleaned = 0;
  try {
    while (cleaned < 1_000) {
      const count = await database.attachmentRepository.cleanupOrphans(
        before,
        Math.min(100, 1_000 - cleaned),
        new Date().toISOString()
      );
      cleaned += count;
      if (count < 100) break;
    }
    if (cleaned > 0) app.log.info({ cleaned }, "orphan chat attachments cleaned");
  } catch (error) {
    app.log.warn({ err: error }, "orphan chat attachment cleanup failed");
  }
}

// graceful shutdown：先停止接收新 Run 并有限 drain，未完成任务落库为 interrupted，
// 再由 onClose 关闭 event subscribers（SSE 连接随 server close 结束）、QQ channel、storage 与连接池。
const shutdownDrainMs = Number(process.env.SHUTDOWN_DRAIN_MS ?? 10_000);
// app.close 的上限：异常 SSE 长连接不能无限阻塞关闭，超时后强制退出交给编排层重启。
const shutdownCloseTimeoutMs = Number(process.env.SHUTDOWN_CLOSE_TIMEOUT_MS ?? 15_000);
let shutdownStarted = false;

/**
 * @param signal 触发关闭的信号名，用于日志定位。
 * @returns 关闭完成 Promise。
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  app.log.info({ signal }, "shutdown started");
  // 失败或超时都必须以非零码退出，让编排层识别这不是一次干净停机。
  let exitCode = 0;
  const forceExitTimer = setTimeout(() => {
    app.log.error("shutdown timed out, forcing exit");
    process.exit(1);
  }, shutdownDrainMs + shutdownCloseTimeoutMs);
  try {
    const { interrupted } = await app.aiagentRunService.shutdown({ drainMs: shutdownDrainMs });
    app.log.info({ interrupted }, "run drain finished");
    await app.close();
  } catch (error) {
    exitCode = 1;
    app.log.error(error);
  } finally {
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  }
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

app.addHook("onClose", async () => {
  if (attachmentCleanupTimer) clearInterval(attachmentCleanupTimer);
  qqChannel.stop();
  if (mcpClient) await mcpClient.close().catch(() => { /* 关闭失败不阻断停机。 */ });
  await database.close();
});

void start();
