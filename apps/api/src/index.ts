import type { IdentityService, IdentitySnapshot } from "@aiagent/identity";
import type { LlmClient } from "@aiagent/types";
import type { ConversationRepository, MessageRepository } from "@aiagent/conversation";
import type { DataSourceRuntime } from "@aiagent/rag";
import { createLocalArtifactStorage } from "@aiagent/report";
import type { ArtifactRepository, ArtifactStorage, WorkflowRepository } from "@aiagent/report";
import type { TraceStore } from "@aiagent/trace";
import type { ApprovalDecideResult, ApprovalDecisionInput, ApprovalRepository } from "@aiagent/tools";
import { APPROVAL_REQUEST_TTL_MS } from "@aiagent/tools";
import type { TraceRunEventProjection } from "@aiagent/trace";
import type { IdentityMeDto } from "@aiagent/types";
import type { AttachmentRepository } from "@aiagent/database";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createInMemoryExecutionRegistry,
  createInMemoryRunEventBus,
  createMicrotaskRunScheduler
} from "./adapters/in-memory-run-runtime.js";
import { createRunApplicationService } from "./application/run-service.js";
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
import { registerApprovalRoutes } from "./http/routes/approvals.js";
import { registerReportRoutes } from "./http/routes/reports.js";
import { registerProductRoutes } from "./http/routes/product.js";
import { registerModelRoutes } from "./http/routes/models.js";
import { registerAttachmentRoutes } from "./http/routes/attachments.js";
import {
  createModelRuntimeRegistry,
  type ModelRuntimeRegistry
} from "./application/model-registry.js";

export interface ApiServerOptions {
  llmClient?: LlmClient;
  modelRegistry?: ModelRuntimeRegistry;
  mockStepDelayMs?: number;
  readiness?: () => Promise<{ ok: boolean; dependency: string; message?: string }>;
  identityService: IdentityService;
  dataSourceRuntime: DataSourceRuntime;
  attachmentRepository?: AttachmentRepository;
  requireIdentity?: boolean;
  qqBotQrUrl?: string;
  qqBotEnabled?: boolean;
  qqBotStatus?: () => IdentityMeDto["qqBot"]["status"];
  cookieSecure?: boolean;
  workflowRepository: WorkflowRepository;
  artifactRepository: ArtifactRepository;
  artifactStorage?: ArtifactStorage;
  conversationRepository?: ConversationRepository;
  messageRepository?: MessageRepository;
  runStore: RunStore;
  traceStore: TraceStore;
  staleRunThresholdMs?: number;
  approvalRepository: ApprovalRepository;
  /**
   * 生产注入的审批决定组合服务：决定与 approval decided trace event 在同一数据库事务提交。
   * 不注入时退回 endpoint 旁路 append，仅用于纯内存测试 composition。
   */
  approvalDecisionService?: (input: ApprovalDecisionInput) => Promise<{
    result: ApprovalDecideResult;
    event?: TraceRunEventProjection;
  }>;
}

declare module "fastify" {
  interface FastifyInstance {
    /** composition 内部共享的 Run 用例服务；server.ts 用它执行 graceful shutdown。 */
    aiagentRunService: ReturnType<typeof createRunApplicationService>;
  }
}

/**
 * 创建 Week 1 最小 HTTP API，只承载请求校验和 Agent DTO 映射。
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
  const approvalRepository = options.approvalRepository;
  const workflowRepository = options.workflowRepository;
  const artifactRepository = options.artifactRepository;
  const artifactStorage = options.artifactStorage ?? createLocalArtifactStorage(
    process.env.ARTIFACT_STORAGE_ROOT ?? `${process.cwd()}/.artifacts-test`
  );
  const runStore = options.runStore;
  const traceStore = options.traceStore;
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
    client: options.llmClient,
    clientlessRuntime: !options.llmClient
  }], "mock");
  const runService = createRunApplicationService({
    store: runStore,
    eventBus: runEventBus,
    executionRegistry: createInMemoryExecutionRegistry(),
    scheduler: createMicrotaskRunScheduler(),
    llmClient: options.llmClient,
    resolveLlmClient: (modelId) => modelRegistry.resolve(modelId),
    hasModel: (modelId) => modelRegistry.has(modelId),
    defaultModelId: modelRegistry.defaultModelId,
    dataSourceRuntime,
    mockStepDelayMs: options.mockStepDelayMs,
    traceStore,
    recordInternalWarning: (warning) => {
      app.log.warn(warning, "Trace persistence degraded");
    },
    sink: {
      saveWorkflow: async (workflow, context) => {
        await workflowRepository.save({ context, run: workflow.run });
      },
      saveArtifact: async (artifact, context) => {
        await artifactRepository.save({
          artifact, ...context, kind: "research_report", mediaType: "text/html",
          metadata: {}, updatedAt: artifact.createdAt
        });
      },
      saveApproval: async (approval, context) => {
        try {
          const now = Date.now();
          await approvalRepository.requestApproval({
            approvalId: approval.approvalId,
            runId: context.runId,
            requestId: approval.requestId ?? approval.approvalId,
            traceId: approval.traceId,
            userId: context.userId,
            toolName: approval.toolName,
            permissionLevel: approval.permissionLevel,
            reason: approval.reason,
            reasonCode: approval.reasonCode,
            // 原请求未绑定摘要时落库为空串；此类审批无法通过 decision endpoint 决定，只能过期。
            inputDigest: approval.inputDigest ?? "",
            inputPreview: approval.inputPreview ?? null,
            requestedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + APPROVAL_REQUEST_TTL_MS).toISOString()
          });
        } catch (error) {
          // 审批登记失败（含相同 id 不同 digest/run/user 的重放冲突）不影响 Run 主流程，
          // 但必须留下日志线索，便于审计与排障。
          app.log.warn(
            { err: error, approvalId: approval.approvalId, runId: context.runId },
            "approval registration failed"
          );
        }
      }
    }
  });
  const identityService = options.identityService;
  app.decorate("aiagentRunService", runService);
  const identityByRequest = new WeakMap<object, IdentitySnapshot>();
  const conversationService = options.conversationRepository && options.messageRepository
    ? createConversationApplicationService({
        conversationRepository: options.conversationRepository,
        messageRepository: options.messageRepository
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
  registerTraceRoutes(app, { traceStore, identityByRequest });
  registerRunRoutes(app, { runService, conversationService, identityByRequest });

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
  registerApprovalRoutes(app, {
    approvalRepository,
    approvalDecisionService: options.approvalDecisionService,
    runEventBus,
    runService,
    runStore,
    identityByRequest
  });
  registerReportRoutes(app, {
    workflowRepository,
    artifactRepository,
    artifactStorage,
    approvalRepository,
    identityByRequest
  });
  registerProductRoutes(app);

  return app;
}
