import { agentLoop, defaultConvertToLlm, type AgentMessage } from "@aiagent/agent";
import type { Model } from "@aiagent/ai";
import { createQqBotChannel } from "@aiagent/channels";
import { createDatabaseRuntime, createPostgresVectorStore } from "@aiagent/database";
import { createLocalArtifactStorage } from "@aiagent/report";
import { createIdentityService } from "@aiagent/identity";
import { createDataSourceRuntime, createDeterministicMockEmbeddingClient } from "@aiagent/rag";
import { createDefaultToolRegistry } from "@aiagent/tools";
import { stat } from "node:fs/promises";
import { createApiServer } from "./index.js";
import { createModelRuntimeRegistry, type ModelRuntime } from "./application/model-registry.js";
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
const deepseekRuntime = providerMode === "real" ? createOpenAiCompatibleRuntime("deepseek", "https://api.deepseek.com/v1") : undefined;
const openrouterRuntime = providerMode === "real" ? createOpenAiCompatibleRuntime("openrouter", "https://openrouter.ai/api/v1") : undefined;
const modelRegistry = providerMode === "real"
  ? createModelRuntimeRegistry([
      {
        option: {
          id: "deepseek",
          label: "DeepSeek",
          provider: "deepseek",
          description: "快速、稳定的金融研究对话",
          isDefault: true,
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
      }
    ], "deepseek")
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
    embeddingClient: createDeterministicMockEmbeddingClient(),
    vectorStoreFactory: (ownerUserId) => createPostgresVectorStore(database.pool, { ownerUserId })
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
  traceStore: database.traceStore,
  readiness: async () => {
    if (providerMode !== "mock" && providerMode !== "real") {
      return { ok: false, dependency: "provider-config", message: "AIAGENT_PROVIDER_MODE must be mock or real." };
    }
    if (providerMode === "real" && (!deepseekRuntime?.runtime || !openrouterRuntime?.runtime)) {
      return {
        ok: false,
        dependency: "llm-provider-config",
        message: llmConfigurationError(deepseekRuntime, openrouterRuntime)
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
  const apiKey = process.env[`AIAGENT_LLM_API_KEY_${suffix}`];
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
 * 从两个模型装配结果中提取稳定的就绪错误，避免可选链破坏联合类型收窄。
 *
 * @param deepseek DeepSeek 装配结果。
 * @param openrouter OpenRouter 装配结果。
 * @returns 首个配置错误消息。
 */
function llmConfigurationError(
  deepseek: typeof deepseekRuntime,
  openrouter: typeof openrouterRuntime
): string {
  if (deepseek?.error) return deepseek.error;
  if (openrouter?.error) return openrouter.error;
  return "LLM provider is not configured.";
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
  await database.close();
});

void start();
