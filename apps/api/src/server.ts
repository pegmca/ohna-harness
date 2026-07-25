import { createLlmClientFromEnv } from "@aiagent/agent";
import { runAgent } from "@aiagent/agent";
import { createQqBotChannel } from "@aiagent/channels";
import { createDatabaseRuntime, createPostgresVectorStore } from "@aiagent/database";
import { createLocalArtifactStorage } from "@aiagent/report";
import { createIdentityService } from "@aiagent/identity";
import { createDataSourceRuntime, createDeterministicMockEmbeddingClient } from "@aiagent/rag";
import { stat } from "node:fs/promises";
import { createApiServer } from "./index.js";

/**
 * 唯一生产 composition root：所有事实源 adapter 在此注入，领域 package 不读取 DATABASE_URL。
 * 默认 runtime 全部为 PostgreSQL；内存 repository 只由测试显式创建。
 */
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";
const providerMode = process.env.AIAGENT_PROVIDER_MODE ?? "mock";
const llmResult = providerMode === "real" ? createLlmClientFromEnv() : undefined;
const database = createDatabaseRuntime(process.env.DATABASE_URL ?? "");
const artifactStorageRoot = process.env.ARTIFACT_STORAGE_ROOT ?? "./var/artifacts";
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
    const response = await runAgent({ message }, { llmClient: llmResult?.ok ? llmResult.data : undefined });
    return response.answer;
  },
  logger: {
    info(message, meta) { console.info(message, meta ?? {}); },
    warn(message, meta) { console.warn(message, meta ?? {}); },
    error(message, meta) { console.error(message, meta ?? {}); }
  }
});
const app = createApiServer({
  llmClient: llmResult?.ok ? llmResult.data : undefined,
  identityService,
  dataSourceRuntime: createDataSourceRuntime({
    repository: database.ragDocumentRepository,
    embeddingClient: createDeterministicMockEmbeddingClient(),
    vectorStoreFactory: (ownerUserId) => createPostgresVectorStore(database.pool, { ownerUserId })
  }),
  requireIdentity: true,
  qqBotEnabled,
  qqBotQrUrl: process.env.QQBOT_PUBLIC_QR_URL,
  qqBotStatus: () => qqChannel.getStatus(),
  cookieSecure: process.env.IDENTITY_COOKIE_SECURE === "true",
  workflowRepository: database.workflowRepository,
  artifactRepository: database.artifactRepository,
  conversationRepository: database.conversationRepository,
  messageRepository: database.messageRepository,
  artifactStorage: createLocalArtifactStorage(artifactStorageRoot),
  runStore: database.runRepository,
  approvalRepository: database.approvalRepository,
  approvalDecisionService: database.approvalDecisionService,
  traceStore: database.traceStore,
  readiness: async () => {
    if (providerMode !== "mock" && providerMode !== "real") {
      return { ok: false, dependency: "provider-config", message: "AIAGENT_PROVIDER_MODE must be mock or real." };
    }
    if (providerMode === "real" && !llmResult?.ok) {
      return { ok: false, dependency: "llm-provider-config", message: llmResult?.error.message ?? "LLM provider is not configured." };
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
    if (qqBotEnabled) void qqChannel.start().catch((error) => app.log.error(error));
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
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
  qqChannel.stop();
  await database.close();
});

void start();
