import type { IdentityService, IdentitySnapshot } from "@aiagent/identity";
import type { ConversationRepository, MessageStore } from "@aiagent/conversation";
import type { DataSourceRuntime } from "@aiagent/rag";
import { createLocalArtifactStorage } from "@aiagent/report";
import type { ArtifactRepository, ArtifactStorage, WorkflowRepository } from "@aiagent/report";
import type { TraceStore } from "@aiagent/trace";
import type { AgentTool } from "@aiagent/agent";
import { createDefaultToolRegistry } from "@aiagent/tools";
import type { ApprovalRepository } from "@aiagent/database";
import type { IdentityMeDto } from "@aiagent/types";
import type { AttachmentRepository } from "@aiagent/database";
import type { CitationRepository } from "@aiagent/rag";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createInMemoryExecutionRegistry,
  createInMemoryRunEventBus,
  createMicrotaskRunScheduler
} from "./adapters/in-memory-run-runtime.js";
import { createMockModelRuntime } from "./adapters/mock-model.js";
import {
  createRunApplicationService,
  type RunCompactionOptions
} from "./application/run-service.js";
import type { RunStore } from "./application/run-ports.js";
import { createConversationApplicationService } from "./application/conversation-service.js";
import { registerAuthHook } from "./http/hooks/auth.js";
import { registerErrorHandler } from "./http/hooks/error-handler.js";
import { registerHealthRoutes } from "./http/routes/health.js";
import { registerIdentityRoutes } from "./http/routes/identity.js";
import { registerConversationRoutes } from "./http/routes/conversations.js";
import { registerTraceRoutes } from "./http/routes/traces.js";
import { registerRunRoutes } from "./http/routes/runs.js";
import { registerDataSourceRoutes } from "./http/routes/data-sources.js";
import { registerRagRoutes } from "./http/routes/rag.js";
import { registerReportRoutes } from "./http/routes/reports.js";
import { registerProductRoutes } from "./http/routes/product.js";
import { registerModelRoutes } from "./http/routes/models.js";
import { registerAttachmentRoutes } from "./http/routes/attachments.js";
import {
  createModelRuntimeRegistry,
  type ModelRuntimeRegistry
} from "./application/model-registry.js";

export interface ApiServerOptions {
  modelRegistry?: ModelRuntimeRegistry;
  /** 注入 agent loop 的工具集；缺省用 @aiagent/tools 默认 registry。 */
  tools?: AgentTool[];
  readiness?: () => Promise<{ ok: boolean; dependency: string; message?: string }>;
  identityService: IdentityService;
  dataSourceRuntime: DataSourceRuntime;
  attachmentRepository: AttachmentRepository;
  citationRepository: CitationRepository;
  requireIdentity?: boolean;
  qqBotQrUrl?: string;
  qqBotEnabled?: boolean;
  qqBotStatus?: () => IdentityMeDto["qqBot"]["status"];
  cookieSecure?: boolean;
  workflowRepository: WorkflowRepository;
  artifactRepository: ArtifactRepository;
  artifactStorage?: ArtifactStorage;
  conversationRepository?: ConversationRepository;
  messageStore?: MessageStore;
  runStore: RunStore;
  /** compaction 注入点（测试用小 contextWindow 触发压缩）。 */
  compaction?: RunCompactionOptions;
  /** 旧 trace 查询路由的可选事实源；run 主路径不再写 trace 表（阶段 6 收敛）。 */
  traceStore?: TraceStore;
  staleRunThresholdMs?: number;
  /** report 路由仍依赖旧 approval 表查询 PDF 导出决定（阶段 5/6 收敛）。 */
  approvalRepository: ApprovalRepository;
}

declare module "fastify" {
  interface FastifyInstance {
    /** composition 内部共享的 Run 用例服务；server.ts 用它执行 graceful shutdown。 */
    aiagentRunService: ReturnType<typeof createRunApplicationService>;
  }
}

/**
 * 创建 HTTP API：run 主路径为 agentLoop → run_events_v2 落库 + SSE fan-out 的新协议。
 *
 * @returns 已注册路由的 Fastify 实例。
 */
export function createApiServer(options: ApiServerOptions): FastifyInstance {
  const app = Fastify({
    logger: true
  });
  // 事实源 repository 一律由 composition root 注入；内存 adapter 只能由测试显式创建，
  // 这里不再提供任何默认 fallback，避免生产意外退回进程内 Map。
  const dataSourceRuntime = options.dataSourceRuntime;
  const workflowRepository = options.workflowRepository;
  const artifactRepository = options.artifactRepository;
  const artifactStorage = options.artifactStorage ?? createLocalArtifactStorage(
    process.env.ARTIFACT_STORAGE_ROOT ?? `${process.cwd()}/.artifacts-test`
  );
  const runStore = options.runStore;
  const runEventBus = createInMemoryRunEventBus();
  const modelRegistry = options.modelRegistry ?? createModelRuntimeRegistry([{
    option: {
      id: "mock",
      label: "Mock Agent",
      provider: "mock",
      description: "Deterministic local runtime",
      isDefault: true,
      capabilities: { structuredOutput: true, toolCalling: true }
    },
    runtime: createMockModelRuntime()
  }], "mock");
  if (!options.messageStore) throw new Error("messageStore is required.");
  const messageStore = options.messageStore;
  const runService = createRunApplicationService({
    store: runStore,
    messageStore,
    eventBus: runEventBus,
    executionRegistry: createInMemoryExecutionRegistry(),
    scheduler: createMicrotaskRunScheduler(),
    tools: options.tools ?? createDefaultToolRegistry().list(),
    resolveModel: (modelId) => modelRegistry.resolve(modelId),
    hasModel: (modelId) => modelRegistry.has(modelId),
    defaultModelId: modelRegistry.defaultModelId,
    dataSourceRuntime,
    attachmentRepository: options.attachmentRepository,
    citationRepository: options.citationRepository,
    compaction: options.compaction
  });
  const identityService = options.identityService;
  app.decorate("aiagentRunService", runService);
  const identityByRequest = new WeakMap<object, IdentitySnapshot>();
  const conversationService = options.conversationRepository
    ? createConversationApplicationService({
        conversationRepository: options.conversationRepository,
        messageStore
      })
    : undefined;

  // hook 必须先于 routes 注册：session 解析与错误兜底对所有路由生效。
  registerAuthHook(app, {
    identityService,
    requireIdentity: options.requireIdentity,
    identityByRequest
  });
  registerErrorHandler(app);

  registerHealthRoutes(app, { readiness: options.readiness });
  registerModelRoutes(app, modelRegistry);
  registerIdentityRoutes(app, {
    identityService,
    identityByRequest,
    cookieSecure: options.cookieSecure,
    qqBotQrUrl: options.qqBotQrUrl,
    qqBotEnabled: options.qqBotEnabled,
    qqBotStatus: options.qqBotStatus
  });
  registerConversationRoutes(app, { identityByRequest, conversationService });
  if (options.traceStore) {
    registerTraceRoutes(app, { traceStore: options.traceStore, identityByRequest });
  }
  registerRunRoutes(app, { runService, identityByRequest });

  const staleThresholdMs = options.staleRunThresholdMs ?? 5 * 60_000;
  app.addHook("onReady", async () => {
    await runService.recoverStale(new Date(Date.now() - staleThresholdMs).toISOString());
  });

  registerDataSourceRoutes(app, { dataSourceRuntime, identityByRequest });
  if (options.attachmentRepository) {
    registerAttachmentRoutes(app, {
      dataSourceRuntime,
      attachmentRepository: options.attachmentRepository,
      identityByRequest
    });
  }
  registerRagRoutes(app, { dataSourceRuntime, identityByRequest });
  registerReportRoutes(app, {
    workflowRepository,
    artifactRepository,
    artifactStorage,
    approvalRepository: options.approvalRepository,
    identityByRequest
  });
  registerProductRoutes(app);

  return app;
}
