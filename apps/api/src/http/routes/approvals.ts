import type { IdentitySnapshot } from "@aiagent/identity";
import { redactSensitiveValue, type TraceRunEventProjection } from "@aiagent/trace";
import type {
  ApprovalDecideResult,
  ApprovalDecisionInput,
  ApprovalRecord,
  ApprovalRepository
} from "@aiagent/database";
import type {
  AgentRunEventInputDto,
  AgentRunStreamEventDto,
  ApiResult,
  ToolApprovalDecisionDto
} from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import type { createInMemoryRunEventBus } from "../../adapters/in-memory-run-runtime.js";
import type { RunStore } from "../../application/run-ports.js";
import type { createRunApplicationService } from "../../application/run-service.js";
import { createRequestId, fail, toApiError } from "../errors.js";
import { requestUserId } from "../hooks/auth.js";
import { approvalDecisionRequestSchema } from "../schemas.js";

export interface ApprovalRoutesDeps {
  approvalRepository: ApprovalRepository;
  /**
   * 生产注入的审批决定组合服务：决定与 approval decided trace event 在同一数据库事务提交。
   * 不注入时退回 endpoint 旁路 append，仅用于纯内存测试 composition。
   */
  approvalDecisionService?: (input: ApprovalDecisionInput) => Promise<{
    result: ApprovalDecideResult;
    event?: TraceRunEventProjection;
  }>;
  runEventBus: ReturnType<typeof createInMemoryRunEventBus>;
  runService: ReturnType<typeof createRunApplicationService>;
  runStore: RunStore;
  identityByRequest: WeakMap<object, IdentitySnapshot>;
}

/**
 * 注册 Approval decision 路由。
 *
 * @param app Fastify 实例。
 * @param deps 审批 repository、可选事务性决定服务、run 事件总线与共享 identity 映射。
 */
export function registerApprovalRoutes(app: FastifyInstance, deps: ApprovalRoutesDeps): void {
  const { approvalRepository, runEventBus, runService, runStore, identityByRequest } = deps;

  /**
   * Approval decision 接口把人工 approve/reject 决策持久化到 Approval repository。
   * reviewer 身份只来自服务端 session，归属、run、digest 绑定与过期由 repository CAS 统一校验。
   *
   * @param request Fastify 请求对象，body 必须符合 RunApprovalDecisionRequestDto。
   * @param reply Fastify 响应对象，用于在请求无效时设置 HTTP 状态码。
   * @returns 成功时返回已持久化的 approval decision。
   */
  app.post<{ Params: { runId: string; approvalId: string } }>(
    "/api/runs/:runId/approvals/:approvalId/decision",
    async (request, reply): Promise<ApiResult<ToolApprovalDecisionDto>> => {
    const requestId = createRequestId();
    const parsed = approvalDecisionRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      const error = toApiError("validation_failed", "Approval decision 请求格式不正确。", requestId, {
        issues: parsed.error.issues
      });
      reply.code(400);
      return fail(error, requestId);
    }

    let result: ApprovalDecideResult;
    try {
      if (deps.approvalDecisionService) {
        // 生产路径：决定与 approval decided trace event 在同一数据库事务提交，
        // 提交后才把事件投影 fan-out 给 live SSE 订阅者。
        const outcome = await deps.approvalDecisionService({
          approvalId: request.params.approvalId,
          runId: request.params.runId,
          reviewerUserId: requestUserId(identityByRequest, request),
          decision: parsed.data.decision,
          expectedInputDigest: parsed.data.inputDigest,
          reviewerNote: parsed.data.reviewerNote?.trim(),
          decidedAt: new Date().toISOString()
        });
        result = outcome.result;
        if (outcome.event) runEventBus.publish(outcome.event as AgentRunStreamEventDto);
      } else {
        // 纯内存测试 composition：单进程内旁路 append 等价于生产的事务语义。
        result = await approvalRepository.decide({
          approvalId: request.params.approvalId,
          runId: request.params.runId,
          reviewerUserId: requestUserId(identityByRequest, request),
          decision: parsed.data.decision,
          expectedInputDigest: parsed.data.inputDigest,
          reviewerNote: parsed.data.reviewerNote?.trim(),
          decidedAt: new Date().toISOString()
        });
        if (result.ok && !result.idempotent) {
          await appendApprovalDecisionTraceEvent(result.record);
        }
      }
    } catch (error) {
      // repository 已映射为结构化错误；这里只返回稳定话术，不向客户端泄漏内部异常。
      app.log.warn({ err: error, approvalId: request.params.approvalId }, "approval decision failed");
      reply.code(503);
      return fail(toApiError("internal_error", "Approval 服务暂时不可用，请稍后重试。", requestId), requestId);
    }

    if (!result.ok) {
      if (result.code === "conflict" && result.conflictReason === "decision") {
        reply.code(409);
        return fail(toApiError("conflict", "Approval 已存在不同决定，不能覆盖。", requestId, { reasonCode: "SEC_APPROVAL_CONFLICT" }), requestId);
      }
      if (result.code === "expired") {
        reply.code(409);
        return fail(toApiError("conflict", "Approval 已过期，请重新发起研究任务。", requestId, { reasonCode: "SEC_APPROVAL_EXPIRED" }), requestId);
      }
      // 不存在、归属不符与 digest 绑定不符统一 403 话术，不泄漏资源是否存在。
      reply.code(403);
      return fail(toApiError("forbidden", "Approval request 不存在、已处理或与原请求不匹配。", requestId, { reasonCode: "SEC_APPROVAL_BINDING_MISMATCH" }), requestId);
    }

    const record = result.record;

    return {
      ok: true,
      data: {
        approvalId: record.approvalId,
        decision: record.decision ?? parsed.data.decision,
        reviewerNote: record.reviewerNote,
        requestId: record.requestId,
        inputDigest: record.inputDigest
      },
      requestId
    };
  });

  /**
   * 纯内存测试 composition 的旁路事件追加；生产由 approvalDecisionService 在同一事务完成。
   * Run 已终态或事件写入失败不影响已持久化的决定，只记录日志。
   *
   * @param record 已决定的审批记录。
   * @returns 完成 Promise。
   */
  const appendApprovalDecisionTraceEvent = async (record: ApprovalRecord): Promise<void> => {
    try {
      const snapshot = await runService.get(record.userId, record.runId);
      if (!snapshot) return;
      const createdAt = new Date().toISOString();
      const eventInput = redactSensitiveValue({
        type: "trace_event",
        runId: record.runId,
        requestId: snapshot.requestId,
        traceId: `trace_${record.runId}`,
        conversationId: snapshot.conversationId,
        createdAt,
        event: {
          type: "approval",
          id: `${record.traceId}_${record.approvalId}_${record.status}_${Date.now().toString(36)}`,
          traceId: record.traceId,
          requestId: record.requestId,
          approvalId: record.approvalId,
          toolName: record.toolName ?? "unknown",
          status: record.status,
          reason: record.reason ?? "",
          inputPreview: record.inputPreview ?? null,
          reviewerNote: record.reviewerNote,
          inputDigest: record.inputDigest,
          reasonCode: record.reasonCode,
          createdAt
        }
      }) as AgentRunEventInputDto;
      const appended = await runStore.append(record.userId, record.runId, eventInput);
      if (!appended) {
        app.log.info({ runId: record.runId, approvalId: record.approvalId }, "approval decided trace event skipped because the run is terminal or missing");
      }
    } catch (error) {
      app.log.warn({ err: error, approvalId: record.approvalId }, "approval decided trace event append failed");
    }
  };
}
