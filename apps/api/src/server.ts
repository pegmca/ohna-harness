import { createLlmClientFromEnv } from "@aiagent/agent";
import { createApiServer } from "./index.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";
const providerMode = process.env.AIAGENT_PROVIDER_MODE ?? "mock";
const llmResult = providerMode === "real" ? createLlmClientFromEnv() : undefined;
const app = createApiServer({
  llmClient: llmResult?.ok ? llmResult.data : undefined,
  readiness: async () => {
    if (providerMode !== "mock" && providerMode !== "real") {
      return { ok: false, dependency: "provider-config", message: "AIAGENT_PROVIDER_MODE must be mock or real." };
    }
    if (providerMode === "real" && !llmResult?.ok) {
      return { ok: false, dependency: "llm-provider-config", message: llmResult?.error.message ?? "LLM provider is not configured." };
    }
    return { ok: true, dependency: providerMode === "real" ? "llm-provider-config" : "mock-runtime" };
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
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

void start();
