import { createLlmClientFromEnv } from "@aiagent/agent";
import { runAgent } from "@aiagent/agent";
import { createQqBotChannel } from "@aiagent/channels";
import { createDatabaseRuntime, createPostgresVectorStore } from "@aiagent/database";
import { createLocalArtifactStorage } from "@aiagent/report";
import { createIdentityService } from "@aiagent/identity";
import { createDataSourceRuntime, createDeterministicMockEmbeddingClient } from "@aiagent/rag";
import { createApiServer } from "./index.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";
const providerMode = process.env.AIAGENT_PROVIDER_MODE ?? "mock";
const llmResult = providerMode === "real" ? createLlmClientFromEnv() : undefined;
const database = createDatabaseRuntime(process.env.DATABASE_URL ?? "");
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
  artifactStorage: createLocalArtifactStorage(process.env.ARTIFACT_STORAGE_ROOT ?? "./var/artifacts"),
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
    return { ok: true, dependency: providerMode === "real" ? "postgresql,llm-provider-config" : "postgresql,mock-runtime" };
  }
});

/**
 * 启动本地 Fastify 服务，保持入口文件只负责进程生命周期。
 *
 * @returns 服务启动 Promise。
 */
async function start(): Promise<void> {
  try {
    await app.listen({ port, host });
    if (qqBotEnabled) void qqChannel.start().catch((error) => app.log.error(error));
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

app.addHook("onClose", async () => {
  qqChannel.stop();
  await database.close();
});

void start();
