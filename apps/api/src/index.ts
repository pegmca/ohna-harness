import type { IdentityService, IdentitySnapshot } from "@aiagent/identity";
import type { ConversationRepository, MessageStore } from "@aiagent/conversation";
import type { AttachmentStore, DataSourceRuntime, EmbeddingClient } from "@aiagent/rag";
import { createLocalArtifactStorage, createReportTool } from "@aiagent/report";
import type { ArtifactRepository, ArtifactStorage, WorkflowRepository } from "@aiagent/report";
import type { AgentTool } from "@aiagent/agent";
import { randomUUID } from "node:crypto";
import { createDefaultToolRegistry } from "@aiagent/tools";
import type { IdentityMeDto } from "@aiagent/types";
import type { AttachmentRepository } from "@aiagent/database";
import type { CitationRepository } from "@aiagent/rag";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createInMemoryExecutionRegistry,
  createInMemoryRunEventBus
} from "./adapters/in-memory-run-runtime.js";
import type { ToolResultStore } from "@aiagent/database";
import type { BudgetConfig, BudgetTracker } from "./application/budget-tracker.js";
import type { CircuitBreaker } from "./application/circuit-breaker.js";
import type { RunCancelStore, RunExecutionRegistry } from "./application/run-ports.js";
import { createRunWorker } from "./application/run-worker.js";
import {
  createRunApplicationService,
  type RunCompactionOptions
} from "./application/run-service.js";
import type { RunEventBus, RunStore } from "./application/run-ports.js";
import { createConversationApplicationService } from "./application/conversation-service.js";
import { registerAuthHook } from "./http/hooks/auth.js";
import { registerErrorHandler } from "./http/hooks/error-handler.js";
import { registerHealthRoutes } from "./http/routes/health.js";
import { registerIdentityRoutes } from "./http/routes/identity.js";
import { registerConversationRoutes } from "./http/routes/conversations.js";
import { registerRunRoutes } from "./http/routes/runs.js";
import { registerDataSourceRoutes } from "./http/routes/data-sources.js";
import { registerRagRoutes } from "./http/routes/rag.js";
import { registerReportRoutes } from "./http/routes/reports.js";
import { registerProductRoutes } from "./http/routes/product.js";
import { registerModelRoutes } from "./http/routes/models.js";
import { registerAttachmentRoutes } from "./http/routes/attachments.js";
import {
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
  /** 会话级临时附件存储（生产 Redis，测试内存）；与 embeddingClient 同时存在时附件路由与 grounding 才启用。 */
  attachmentStore?: AttachmentStore;
  /** embedding provider；未注入时附件上传返回 503，grounding 不注入附件上下文。 */
  embeddingClient?: EmbeddingClient;
  /**
   * 附件内联阈值（字符数）：解析文本 ≤ 该值走原文内联，否则切块 + embed。
   * 缺省由 @aiagent/rag 常量 DEFAULT_ATTACHMENT_INLINE_MAX_CHARS (200_000) 决定。
   */
  inlineMaxChars?: number;
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
  /**
   * Run event 实时总线（fan-out 边界）。缺省用进程内内存总线（单实例 demo / 测试）。
   * 多实例部署时由组合根注入 Redis 支撑的总线（见 createRedisRunEventBus），
   * 让落到任意实例的 SSE 连接都能收到其他实例 worker 执行的 run 事件。
   */
  eventBus?: RunEventBus;
  /** compaction 注入点（测试用小 contextWindow 触发压缩）。 */
  compaction?: RunCompactionOptions;
  staleRunThresholdMs?: number;
  /**
   * 执行注册表（取消信号跨实例边界）：缺省用进程内内存注册表（单实例 demo / 测试）。
   * 多实例部署由组合根（server.ts）注入共享取消信号 + DB 标记的跨实例实现。
   */
  executionRegistry?: RunExecutionRegistry;
  /** 跨实例取消标记存储；多实例部署由组合根注入 DB 实现，缺省退化为进程内。 */
  cancelStore?: RunCancelStore;
  /** 写类工具结果去重存储；多实例/持久化由组合根注入 DB 实现，缺省退化为进程内。 */
  toolResultStore?: ToolResultStore;
  /** 写类（有副作用）工具名集合：续跑恢复时若已有结果则直接复用，避免重复副作用。 */
  writeToolNames?: string[];
  /** 运行预算上限配置（成本 guardrail，env 驱动）。 */
  budget?: BudgetConfig;
  /** 运行预算追踪器（成本 guardrail）；缺省按 budget 创建进程内实现。 */
  budgetTracker?: BudgetTracker;
  /** LLM provider 熔断器（运行时 SLO 熔断）；缺省从 env 创建实例级熔断器。 */
  circuitBreaker?: CircuitBreaker;
}

declare module "fastify" {
  interface FastifyInstance {
    /** composition 内部共享的 Run 用例服务；server.ts 用它执行 graceful shutdown。 */
    aiagentRunService: ReturnType<typeof createRunApplicationService>;
  }
}

/**
 * 创建 HTTP API：run 主路径为 agentLoop → run_events 落库 + SSE fan-out 的新协议。
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
  // 总线可注入：多实例部署传 Redis 总线，缺省退化为进程内内存总线（与附件 store 同一兜底策略）。
  const runEventBus = options.eventBus ?? createInMemoryRunEventBus();
  // 本项目已移除内置 mock 模型：模型目录必须由调用方显式注入真实 provider，
  // 禁止回退到假 LLM。未注入时直接失败，避免生产实例在「无可用模型」状态下静默接流量。
  const modelRegistry = options.modelRegistry;
  if (!modelRegistry) {
    throw new Error("createApiServer 必须显式注入 modelRegistry；本项目已移除内置 mock 模型，禁止回退到假 LLM，调用方需提供真实 provider 目录。");
  }
  if (!options.messageStore) throw new Error("messageStore is required.");
  const messageStore = options.messageStore;
  const runService = createRunApplicationService({
    store: runStore,
    messageStore,
    eventBus: runEventBus,
    executionRegistry: options.executionRegistry ?? createInMemoryExecutionRegistry(),
    cancelStore: options.cancelStore,
    tools: options.tools ?? createDefaultToolRegistry().list(),
    resolveModel: (modelId) => modelRegistry.resolve(modelId),
    hasModel: (modelId) => modelRegistry.has(modelId),
    defaultModelId: modelRegistry.defaultModelId,
    attachmentRepository: options.attachmentRepository,
    attachmentStore: options.attachmentStore,
    embeddingClient: options.embeddingClient,
    // dataSourceRuntime 的实现类（DataSourceRuntimeService）已公开 retriever 方法，
    // 但接口类型尚未声明；这里用结构化类型断言让 run-service 编译期可用。
    dataSourceRuntime: options.dataSourceRuntime as Parameters<typeof createRunApplicationService>[0]["dataSourceRuntime"],
    citationRepository: options.citationRepository,
    compaction: options.compaction,
    // 透传调用方注入的 LLM provider 熔断器（运行时 SLO 熔断）；缺省由 run-service 自行创建。
    // 透传后同一实例可被观测 / 测试端点共享，是故障演练可观测性的必要前提。
    circuitBreaker: options.circuitBreaker,
    // report 工具按 run 装配（阶段 5 方案 A）：模型自主调用 generate_report，
    // 事件经 recordEvent 落 run_events + SSE，PDF 在工具内直接发布（无 approval 门）。
    reportToolFactory: ({ recordEvent, userId, conversationId, runId }) => createReportTool({
      dataSourceRuntime,
      workflowRepository,
      artifactRepository,
      artifactStorage,
      ownerUserId: userId,
      conversationId,
      agentRunId: runId,
      sink: async (event) => recordEvent(event.type, event.payload)
    })
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
  registerRunRoutes(app, { runService, identityByRequest });

  // Run worker：把 queued run 从队列消费并执行，与 HTTP 进程解耦（见 run-worker.ts）。
  // workerId 用进程级 UUID 标记 lease 归属；claimNext 的 SKIP LOCKED 保证多实例无竞争。
  const runWorker = createRunWorker({
    store: runStore,
    execute: (runId, request, userId) => runService.execute(runId, request, userId),
    workerId: randomUUID(),
    pollIntervalMs: 500,
    leaseDurationMs: 30_000,
    renewIntervalMs: 10_000
  });

  const staleThresholdMs = options.staleRunThresholdMs ?? 5 * 60_000;
  app.addHook("onReady", async () => {
    await runService.recoverStale(new Date(Date.now() - staleThresholdMs).toISOString());
    // recoverStale 把过期 lease 的 run 重置为 queued；随后启动 worker 开始消费队列。
    runWorker.start();
  });
  app.addHook("onClose", async () => {
    await runWorker.stop();
  });

  registerDataSourceRoutes(app, { dataSourceRuntime, identityByRequest });
  if (options.attachmentRepository && options.attachmentStore) {
    registerAttachmentRoutes(app, {
      attachmentStore: options.attachmentStore,
      embeddingClient: options.embeddingClient,
      attachmentRepository: options.attachmentRepository,
      identityByRequest,
      inlineMaxChars: options.inlineMaxChars
    });
  }
  registerRagRoutes(app, { dataSourceRuntime, identityByRequest });
  registerReportRoutes(app, {
    workflowRepository,
    artifactRepository,
    artifactStorage,
    identityByRequest
  });
  registerProductRoutes(app);

  return app;
}
