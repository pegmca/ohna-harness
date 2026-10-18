import { agentLoop, defaultConvertToLlm, type AgentMessage } from "@aiagent/agent";
import { createOpenAiCompatibleRuntime, type Model } from "@aiagent/ai";
import { createQqBotChannel } from "@aiagent/channels";
import { createDatabaseRuntime, createAttachmentStoreFromEnv, createPostgresKeywordCandidateStore, createRunEventBusTransportFromEnv, createVectorStoreFromEnv } from "@aiagent/database";
import { createLocalArtifactStorage } from "@aiagent/report";
import { createIdentityService } from "@aiagent/identity";
import { discoverMcpAgentTools, createMcpStdioClient, type McpClient } from "@aiagent/mcp";
import {
  createDataSourceRuntime,
  createEmbeddingClientFromEnv,
  createRerankerFromEnv,
  createContextEnricherFromEnv,
  createQueryRewriterFromEnv,
  readLlmProviderConfig,
  readEmbeddingProviderConfig,
  readRerankProviderConfig,
  readJudgeProviderConfig
} from "@aiagent/rag";
import { createDefaultToolRegistry, createFinancialDataSourceFromEnv } from "@aiagent/tools";
import { stat } from "node:fs/promises";
import { createApiServer } from "./index.js";
import { createRedisRunEventBus } from "./adapters/redis-run-event-bus.js";
import { createSharedExecutionRegistry } from "./adapters/execution-registry-shared.js";
import { createRedisRunCancelSignal } from "./adapters/redis-run-cancel-signal.js";
import { createInMemoryRunCancelSignal } from "./adapters/in-memory-run-runtime.js";
import { createCircuitBreaker } from "./application/circuit-breaker.js";
import { createModelRuntimeRegistry, type ModelRuntimeEntry } from "./application/model-registry.js";
import { BASE_SYSTEM_PROMPT } from "./application/run-service.js";

/**
 * 唯一生产 composition root：所有事实源 adapter 在此注入，领域 package 不读取 DATABASE_URL。
 * 默认 runtime 全部为 PostgreSQL；内存 repository 只由测试显式创建。
 */
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";
// run 执行统一走 agentLoop；工具集在此装配一次，API server 与 QQ channel 共享。
// 数据源走真实 FinancialDataSource 端口；未配置真实凭据时工具在调用时返回结构化错误，而非中断 run。
const agentTools = createDefaultToolRegistry(createFinancialDataSourceFromEnv()).list();
// 阶段 5 MCP 回迁：AIAGENT_MCP_ENABLED=true 时启动期做 stdio discovery，
// 产出直接并入 agentLoop config.tools（白名单语义前移到装配期）。
const mcpEnabled = process.env.AIAGENT_MCP_ENABLED === "true";
let mcpClient: McpClient | undefined;
const deepseekRuntime = createOpenAiCompatibleRuntime("deepseek", "https://api.deepseek.com/v1");
const openrouterRuntime = createOpenAiCompatibleRuntime("openrouter", "https://openrouter.ai/api/v1");
// 自托管 LLM provider 的配置来源已切到 provider-config 的统一 AIAGENT_LLM_*（无 suffix）。
// profile id 仍为 "bridge_ai"：它是 /api/models 下发并持久化到 localStorage
// `aiagent.selected-model` 的稳定标识，改名会作废用户已保存的选中模型。
// 统一 provider 只有 enabled=true 才形成 overrides；否则不传 overrides，让旧的
// AIAGENT_LLM_*_BRIDGE_AI 后缀变量继续作为兼容兜底。model 为空时也必须传 undefined，
// 避免空值或历史默认模型覆盖旧后缀配置。
const llmProvider = readLlmProviderConfig();
const llmProviderOverrides = llmProvider?.enabled
  ? {
      apiKey: llmProvider.apiKey || undefined,
      baseUrl: llmProvider.baseUrl || undefined,
      model: llmProvider.model || undefined
    }
  : undefined;
const providerLlmRuntime = createOpenAiCompatibleRuntime("bridge_ai", llmProviderOverrides?.baseUrl ?? "", llmProviderOverrides);
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
      label: "自托管 LLM",
      provider: "bridge_ai",
      description: "自托管 OpenAI-compatible 兼容端点",
      isDefault: false,
      capabilities: { structuredOutput: true, toolCalling: true }
    },
    runtime: providerLlmRuntime?.runtime
  }
].filter((entry): entry is { option: ModelRuntimeEntry["option"]; runtime: { model: Model<"openai-completions">; apiKey: string } } => Boolean(entry.runtime));
const defaultRealModelId = realEntries[0]?.option.id ?? "deepseek";
const defaultRealEntry = realEntries.find((entry) => entry.option.id === defaultRealModelId);
if (defaultRealEntry) defaultRealEntry.option.isDefault = true;
// 本项目已移除 mock 模式：未在 .env 配置任何真实 provider 时，组合根直接失败，
// 禁止回退到假 LLM。至少配置一个真实 provider 才能启动（否则下方抛错）。
if (realEntries.length === 0) {
  throw new Error(
    "本项目已移除 mock 模式，必须在 .env 配置至少一个真实 LLM provider："
    + "DeepSeek / OpenRouter 需 AIAGENT_LLM_API_KEY_<PROFILE> 与 AIAGENT_LLM_MODEL_<PROFILE>"
    + "（<PROFILE> 为 DEEPSEEK / OPENROUTER）；自托管端点需 AIAGENT_LLM_API_KEY 与 AIAGENT_LLM_MODEL。"
  );
}
const modelRegistry = createModelRuntimeRegistry(realEntries, defaultRealModelId);
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
const embeddingProvider = readEmbeddingProviderConfig();
// 组合根只创建一次 embedding client，同时注入持久化 RAG runtime 与会话级附件路由/grounding，
// 避免两路使用不同 provider 导致向量不可比。禁用（未配置）时工厂返回 null。
const embeddingClient = createEmbeddingClientFromEnv() ?? undefined;
// 会话级临时附件存储：REDIS_URL 存在走 Redis，否则回退内存（单进程 demo）；onClose 负责 quit。
const attachmentStoreRuntime = createAttachmentStoreFromEnv();
// Run event 总线：REDIS_URL 存在走 Redis pub/sub 实现跨实例 fan-out，否则退化为进程内内存总线。
// 两条 redis 连接（pub/sub 分离）由传输层在首次命令时懒连接，onClose 统一 quit。
const runEventBusRuntime = createRunEventBusTransportFromEnv();
const runEventBus = runEventBusRuntime.transport
  ? createRedisRunEventBus(runEventBusRuntime.transport)
  : undefined;
// 执行注册表外置（P0）：取消信号跨实例。REDIS_URL 存在走 Redis pub/sub 取消信号，
// 否则退化为进程内内存信号（单实例 demo）；取消标记持久化始终用 DB（组合根已要求 DATABASE_URL）。
// 与 SSE 事件总线同一传输层与兜底策略，保证"取消请求落在实例 B、run 执行在实例 A"时仍能真正中断。
const runCancelSignal = runEventBusRuntime.transport
  ? createRedisRunCancelSignal(runEventBusRuntime.transport)
  : createInMemoryRunCancelSignal();
const executionRegistry = createSharedExecutionRegistry({
  cancelSignal: runCancelSignal,
  cancelStore: database.runCancelStore
});
const app = createApiServer({
  modelRegistry,
  tools: agentTools,
  identityService,
  dataSourceRuntime: createDataSourceRuntime({
    repository: database.ragDocumentRepository,
    // v1.1 四组 provider 各自独立：env 就绪时注入真实 client，禁用时工厂返回 null。
    // embedding 未注入时 ingest 返回结构化错误；rerank 缺省使用检索器内建启发式排序，
    // enricher/rewriter 缺省不增强。组合根在 readiness 显式暴露各 provider 状态。
    embeddingClient,
    reranker: createRerankerFromEnv() ?? undefined,
    contextEnricher: createContextEnricherFromEnv() ?? undefined,
    queryRewriter: createQueryRewriterFromEnv() ?? undefined,
    // env 驱动：有 DATABASE_URL 走 pgvector（生产默认），无则退化为内存 fixture 保持本地 demo 可用。
    vectorStoreFactory: createVectorStoreFromEnv(database.pool, {
      embeddingModel: embeddingProvider.embeddingModel,
      dimensions: embeddingProvider.dimensions
    }),
    // P3 关键词候选外置：有 DATABASE_URL 时按 owner 绑定 Postgres 共享存储实现，关键词召回跨实例一致；
    // 无 DATABASE_URL 时 keywordStoreFactory 为 undefined，retriever() 退回内存语料路径（本地 demo）。
    keywordStoreFactory: process.env.DATABASE_URL
      ? (ownerUserId) => createPostgresKeywordCandidateStore(database.pool, { ownerUserId })
      : undefined
  }),
  attachmentRepository: database.attachmentRepository,
  attachmentStore: attachmentStoreRuntime.store,
  embeddingClient,
  inlineMaxChars: Number(process.env.AIAGENT_ATTACHMENT_INLINE_MAX_CHARS) || undefined,
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
  eventBus: runEventBus,
  executionRegistry,
  cancelStore: database.runCancelStore,
  toolResultStore: database.toolResultStore,
  // 写类（有副作用）工具名集合：续跑恢复时若已有结果则直接复用，避免重复副作用。
  writeToolNames: ["generate_report"],
  // 成本 guardrail（P2）：env 驱动 run 级 / user 级 token + 成本上限；缺省不限制。
  budget: {
    runMaxTokens: envInt("AIAGENT_RUN_MAX_TOKENS"),
    runMaxCostUsd: envFloat("AIAGENT_RUN_MAX_COST_USD"),
    userMaxTokens: envInt("AIAGENT_USER_MAX_TOKENS"),
    userMaxCostUsd: envFloat("AIAGENT_USER_MAX_COST_USD")
  },
  // 运行时 SLO 熔断（P2）：env 驱动连续失败阈值与冷却窗口；缺省保守默认。
  circuitBreaker: createCircuitBreaker({
    failureThreshold: envInt("AIAGENT_LLM_CB_FAILURES"),
    cooldownMs: envInt("AIAGENT_LLM_CB_COOLDOWN_MS")
  }),
  readiness: async () => {
    // 读四组 RAG provider 配置，汇总启用状态（禁用非致命，但需在 readiness 显式暴露，避免静默降级）。
    const rerankProvider = readRerankProviderConfig();
    const judgeProvider = readJudgeProviderConfig();
    const disabledProviders = [
      !embeddingProvider.enabled && "embedding",
      !rerankProvider.enabled && "rerank",
      !judgeProvider.enabled && "judge"
    ].filter(Boolean) as string[];
    const providerNote = disabledProviders.length > 0
      ? ` 注意：以下 provider 未配置（已禁用）：${disabledProviders.join(", ")}。Embedding 关闭时 ingest 返回结构化错误；Rerank 关闭时使用启发式排序；Judge 关闭时不产出 judge 信号。`
      : "";
    if (!await database.ping()) {
      return { ok: false, dependency: "postgresql", message: "PostgreSQL is not reachable." };
    }
    if (!await isStorageReady(artifactStorageRoot)) {
      return { ok: false, dependency: "artifact-storage", message: "Artifact storage root is not accessible." };
    }
    return {
      ok: true,
      dependency: "postgresql,artifact-storage,llm-provider-config",
      message: `RAG providers — embedding:${embeddingProvider.enabled ? "on" : "off"} rerank:${rerankProvider.enabled ? "on" : "off"} judge:${judgeProvider.enabled ? "on" : "off"}.${providerNote}`
    };
  }
});

/**
 * 读取可选整数 env（用于预算上限 / 熔断阈值等）。缺失 / 非法 / ≤0 时返回 undefined（表示不限制 / 用缺省）。
 *
 * @param name 环境变量名。
 * @returns 正整数或 undefined。
 */
function envInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * 读取可选浮点 env（用于美元成本上限）。
 *
 * @param name 环境变量名。
 * @returns 正数或 undefined（表示不限制）。
 */
function envFloat(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
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
  // 附件 store 的 close 只在 Redis 已连接时 quit，内存实现为 no-op。
  await attachmentStoreRuntime.close().catch(() => { /* 关闭失败不阻断停机。 */ });
  // 事件总线传输层（Redis pub/sub）关闭两条连接；无 REDIS_URL 时为 no-op。
  await runEventBusRuntime.close().catch(() => { /* 关闭失败不阻断停机。 */ });
  await database.close();
});

void start();
