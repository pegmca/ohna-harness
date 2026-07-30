import { createIdentityService, createInMemoryIdentityRepository, type IdentityService } from "@aiagent/identity";
import { createDataSourceRuntime, type DataSourceRuntime } from "@aiagent/rag";
import type { ArtifactRepository, WorkflowRepository } from "@aiagent/report";
import type { ApprovalRepository } from "@aiagent/database";
import { createInMemoryTraceStore, type TraceStore } from "@aiagent/trace";
import type { RunStore } from "../application/run-ports.js";
import { createInMemoryApprovalRepository } from "./in-memory-approval-repository.js";
import { createInMemoryReportRepositories } from "./in-memory-report-persistence.js";
import { createInMemoryRunStore } from "./in-memory-run-runtime.js";

/** 测试用内存依赖集合；生产 composition 不得使用，只能由测试显式创建并注入。 */
export interface InMemoryApiTestRuntime {
  identityService: IdentityService;
  dataSourceRuntime: DataSourceRuntime;
  approvalRepository: ApprovalRepository;
  workflowRepository: WorkflowRepository;
  artifactRepository: ArtifactRepository;
  runStore: RunStore;
  traceStore: TraceStore;
}

/**
 * 创建一套共享同一份内存事实源的测试依赖。
 *
 * 内存 traceStore 与 runStore 的投影双写不是事务，仅模拟单进程测试语义；
 * 生产由 PostgreSQL adapter 在同一事务中完成（见 packages/database trace-repository）。
 *
 * @param options.runStore 需要跨 server 实例共享（模拟重启）时显式传入的内存 Run store。
 * @returns 可直接展开传入 createApiServer 的内存依赖。
 */
export function createInMemoryApiTestRuntime(options: { runStore?: RunStore } = {}): InMemoryApiTestRuntime {
  const runStore = options.runStore ?? createInMemoryRunStore();
  const report = createInMemoryReportRepositories();
  return {
    identityService: createIdentityService(createInMemoryIdentityRepository(), {
      fingerprintPepper: "test-only-identity-pepper"
    }),
    dataSourceRuntime: createDataSourceRuntime(),
    approvalRepository: createInMemoryApprovalRepository(),
    workflowRepository: report.workflowRepository,
    artifactRepository: report.artifactRepository,
    runStore,
    traceStore: createInMemoryTraceProjectionStore(runStore)
  };
}

/**
 * 创建内存 TraceStore 并向 runStore 追加 trace_event 投影，保持与生产 TraceStore 相同的返回契约。
 *
 * @param runStore 测试共享的内存 Run store。
 * @returns 包装后的 TraceStore。
 */
function createInMemoryTraceProjectionStore(runStore: RunStore): TraceStore {
  const base = createInMemoryTraceStore();
  return {
    ...base,
    /** @param context Trace 归属上下文。 @param event canonical event。 @returns Run 投影。 */
    async append(context, event) {
      await base.append(context, event);
      const projection = await runStore.append(context.userId, context.runId, {
        type: "trace_event",
        event,
        runId: context.runId,
        requestId: context.requestId,
        traceId: context.traceId,
        conversationId: context.conversationId,
        createdAt: event.createdAt
      });
      return projection?.type === "trace_event" ? projection : undefined;
    }
  };
}
