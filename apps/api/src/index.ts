import { runAgent } from "@aiagent/agent";
import type { AgentResponse, AgentStep } from "@aiagent/agent";
import type {
  AgentRunRequestDto,
  AgentRunResponseDto,
  AgentStepDto,
  ApiError,
  ApiResult
} from "@aiagent/types";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

const agentRunRequestSchema = z.object({
  message: z.string(),
  reportMode: z.boolean().optional(),
  conversationId: z.string().min(1).optional()
});

const DEFAULT_CONVERSATION_ID = "week1-local-session";

/**
 * 创建 Week 1 最小 HTTP API，只承载请求校验和 Agent DTO 映射。
 *
 * @returns 已注册路由的 Fastify 实例。
 */
export function createApiServer(): FastifyInstance {
  const app = Fastify({
    logger: true
  });

  app.get("/health", async () => ({
    ok: true,
    service: "@aiagent/api"
  }));

  app.post("/api/agent/run", async (request, reply): Promise<ApiResult<AgentRunResponseDto>> => {
    const requestId = createRequestId();
    const parsed = agentRunRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      const error = toApiError("validation_failed", "请求格式不正确，请输入有效的研究问题。", requestId, {
        issues: parsed.error.issues
      });
      reply.code(400);
      return fail(error, requestId);
    }

    const message = parsed.data.message.trim();

    if (!message) {
      const error = toApiError("validation_failed", "请输入需要研究或解释的问题。", requestId);
      reply.code(400);
      return fail(error, requestId);
    }

    try {
      const agentResponse = await runAgent({
        message
      });
      const responseDto = toAgentRunResponseDto(agentResponse, parsed.data, requestId);

      return {
        ok: true,
        data: responseDto,
        requestId
      };
    } catch (error) {
      const apiError = toApiError("internal_error", "Agent 服务暂时不可用，请稍后重试。", requestId, {
        cause: error instanceof Error ? error.message : "unknown"
      });
      reply.code(500);
      return fail(apiError, requestId);
    }
  });

  return app;
}

/**
 * 将 AgentResponse 投影为前端稳定 DTO，避免 UI 依赖内部实现细节。
 *
 * @param response Agent 运行结果。
 * @param requestDto API 请求 DTO。
 * @param requestId API 层请求标识。
 * @returns 前端消费的 Agent run 响应 DTO。
 */
function toAgentRunResponseDto(
  response: AgentResponse,
  requestDto: AgentRunRequestDto,
  requestId: string
): AgentRunResponseDto {
  return {
    conversationId: requestDto.conversationId ?? DEFAULT_CONVERSATION_ID,
    requestId: response.requestId || requestId,
    traceId: response.traceId,
    ok: response.ok,
    intent: response.intent,
    answer: response.answer,
    steps: response.steps.map(toAgentStepDto),
    trace: response.trace,
    error: response.error
      ? {
          code: "agent_failed",
          message: response.error.message,
          requestId,
          details: {
            agentCode: response.error.code,
            reportMode: requestDto.reportMode ?? false,
            ...response.error.details
          }
        }
      : undefined
  };
}

/**
 * 收窄 Agent step 字段，保持工具调用面板只消费稳定展示信息。
 *
 * @param step Agent 内部步骤。
 * @returns 前端步骤 DTO。
 */
function toAgentStepDto(step: AgentStep): AgentStepDto {
  return {
    index: step.index,
    type: step.type,
    status: step.status,
    durationMs: step.durationMs,
    data: step.data,
    error: step.error
      ? {
          code: "agent_failed",
          message: step.error.message,
          details: {
            agentCode: step.error.code,
            ...step.error.details
          }
        }
      : undefined
  };
}

/**
 * 构造 API 失败结构，避免把原始异常对象直接返回给浏览器。
 *
 * @param error 结构化 API 错误。
 * @param requestId API 请求标识。
 * @returns ApiResult 失败分支。
 */
function fail<TData>(error: ApiError, requestId: string): ApiResult<TData> {
  return {
    ok: false,
    error,
    requestId
  };
}

/**
 * 构造稳定 API 错误对象。
 *
 * @param code API 错误码。
 * @param message 用户可读错误。
 * @param requestId API 请求标识。
 * @param details 可选诊断信息。
 * @returns ApiError。
 */
function toApiError(
  code: ApiError["code"],
  message: string,
  requestId: string,
  details?: Record<string, unknown>
): ApiError {
  return {
    code,
    message,
    requestId,
    details
  };
}

/**
 * 生成 API adapter 自己的请求标识，和 Agent trace request id 分层展示。
 *
 * @returns 带 api_req_ 前缀的请求标识。
 */
function createRequestId(): string {
  return `api_req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
