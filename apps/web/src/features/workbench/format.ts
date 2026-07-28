import type {
  AgentRunResponseDto,
  AgentRunStreamEventDto,
  ApiError,
  ApiResult,
  ConversationDto,
  ConversationMessageDto,
  ToolApprovalRequestDto
} from "@aiagent/types";
import type { TraceEventDto, UiMessage, WorkspaceView } from "./types";

/**
 * 把实时事件转换为 assistant 消息中的简短进度文案。
 *
 * @param event 当前 run event。
 * @returns 用户可读进度。
 */
export function formatRunProgress(event: AgentRunStreamEventDto): string {
  if (event.type === "run_status") return event.message;
  if (event.type === "run_error") return event.error.message;
  if (event.type === "run_result") return event.result.answer;
  const labels: Partial<Record<TraceEventDto["type"], string>> = {
    request_received: "已接收研究问题，正在分析意图。",
    intent_routed: "已完成意图识别，正在选择研究路径。",
    retrieval: "正在检索公告与研究证据。",
    tool_call: "已调用本地研究工具。",
    mcp_tool_call: "已通过 MCP 获取结构化数据。",
    workflow_node: "正在执行研报工作流节点。",
    citation_verifier: "正在校验结论与引用覆盖。",
    final_response: "研究过程已完成，正在整理回答。"
  };
  return labels[event.event.type] ?? `正在处理 ${event.event.type.replaceAll("_", " ")}。`;
}

/**
 * 解析 API 响应，兼容 dev proxy 断连、空响应和 HTML 错误页。
 *
 * @param response fetch 返回的响应对象。
 * @returns 结构化 API result。
 */
export async function parseApiResult<TData>(response: Response): Promise<ApiResult<TData>> {
  const text = await response.text();
  const requestId = response.headers.get("x-request-id") ?? "unknown";

  if (!text.trim()) {
    return {
      ok: false,
      requestId,
      error: {
        code: "internal_error",
        message: response.ok
          ? "API 返回了空响应。"
          : `API 服务未启动或 Vite proxy 无法连接后端：HTTP ${response.status}。请用 pnpm dev 同时启动 apps/api 和 apps/web。`,
        requestId,
        details: {
          status: response.status,
          statusText: response.statusText
        }
      }
    };
  }

  try {
    return JSON.parse(text) as ApiResult<TData>;
  } catch {
    return {
      ok: false,
      requestId,
      error: {
        code: "internal_error",
        message: `API 返回了非 JSON 响应：HTTP ${response.status}。请检查 apps/api 是否正在运行。`,
        requestId,
        details: {
          status: response.status,
          statusText: response.statusText,
          contentType: response.headers.get("content-type"),
          preview: text.slice(0, 240)
        }
      }
    };
  }
}

/**
 * 格式化 API 错误，保留关键诊断字段但不暴露堆栈。
 *
 * @param error API 结构化错误。
 * @returns 面向用户和开发调试的错误文案。
 */
export function formatApiError(error: ApiError): string {
  const diagnostics = [
    typeof error.details?.status === "number" ? `status=${error.details.status}` : undefined,
    typeof error.details?.cause === "string" ? `cause=${error.details.cause}` : undefined
  ].filter(Boolean);

  return diagnostics.length > 0
    ? `${error.code}: ${error.message} (${diagnostics.join(", ")})`
    : `${error.code}: ${error.message}`;
}

/**
 * 从 trace 中提取 approval request，前端只消费 trace DTO，不推断权限策略。
 *
 * @param run Agent run DTO。
 * @returns 去重后的审批请求。
 */
export function getApprovalRequests(run: AgentRunResponseDto): ToolApprovalRequestDto[] {
  const requests = new Map<string, ToolApprovalRequestDto>();

  for (const event of run.trace.events) {
    if (event.type !== "approval" || event.status !== "requested") {
      continue;
    }

    requests.set(event.approvalId, {
      approvalId: event.approvalId,
      traceId: event.traceId,
      toolName: event.toolName,
      reason: event.reason,
      inputPreview: event.inputPreview,
      permissionLevel: "needs_approval",
      requestId: event.requestId,
      inputDigest: event.inputDigest,
      reasonCode: event.reasonCode
    });
  }

  const workflowApproval = run.reportWorkflow?.run.approvalRequest;
  if (workflowApproval) requests.set(workflowApproval.approvalId, workflowApproval);

  return [...requests.values()];
}

/**
 * 将 trace event 类型转换成适合 timeline 展示的标题。
 *
 * @param event trace event。
 * @returns 用户可读标题。
 */
export function formatEventTitle(event: TraceEventDto): string {
  switch (event.type) {
    case "request_received":
      return "Request Received";
    case "intent_routed":
      return `Intent Routed: ${event.intent}`;
    case "agent_step":
      return `Agent Step: ${event.stepType}`;
    case "approval":
      return `Approval: ${event.status}`;
    case "security":
      return `Security: ${event.decision}`;
    case "retrieval":
      return `Retrieval: ${event.mode}`;
    case "report_skill_activation":
      return `Report Activation: ${event.triggerSource}`;
    case "report_plan":
      return "Report Plan";
    case "workflow_node":
      return `Workflow Node: ${event.nodeId}`;
    case "citation_verifier":
      return `Citation Verifier: ${event.decision}`;
    case "pdf_export":
      return `PDF Export: ${event.status}`;
    case "model_call":
      return `Model Call: ${event.purpose}`;
    case "tool_call":
      return `Tool Call: ${event.toolName}`;
    case "mcp_tool_discovered":
      return `MCP Discovery: ${event.serverName}`;
    case "mcp_tool_call":
      return `MCP Tool Call: ${event.toolName}`;
    case "final_response":
      return "Final Response";
  }
}

/**
 * 提取事件耗时，没有耗时字段时展示稳定占位。
 *
 * @param event trace event。
 * @returns 耗时文案。
 */
export function formatLatency(event: TraceEventDto): string {
  if ("durationMs" in event) {
    return `${event.durationMs} ms`;
  }

  return "recorded";
}

/**
 * 生成每类 trace event 的摘要，避免前端只展示原始 JSON。
 *
 * @param event trace event。
 * @returns 时间线摘要。
 */
export function formatEventSummary(event: TraceEventDto): string {
  switch (event.type) {
    case "request_received":
      return event.inputPreview;
    case "intent_routed":
      return event.reason;
    case "agent_step":
      return `${event.status} with ${event.error?.code ?? "no_error"}`;
    case "approval":
      return `${event.toolName}: ${event.reason}`;
    case "security":
      return `${event.category}: ${event.reasonCode}`;
    case "retrieval":
      return event.ok
        ? `${event.chunkIds.length} chunks retrieved, topK=${event.topK}`
        : event.error?.message ?? "检索失败。";
    case "report_skill_activation":
      return `${event.triggerSource} activation; ${event.routeReason}`;
    case "report_plan":
      return event.ok ? `${event.plan.status} plan created` : event.error?.message ?? "planner failed";
    case "workflow_node":
      return `${event.status} ${event.nodeType} in ${event.durationMs} ms`;
    case "citation_verifier":
      return `${event.missingClaimCount} missing claims, ${event.missingMetricCount} missing metrics`;
    case "pdf_export":
      return event.fileName ?? "PDF export state updated";
    case "model_call":
      return event.ok ? `${event.model} responded` : event.error?.message ?? "model failed";
    case "tool_call":
      return event.ok ? "工具成功返回结构化结果。" : event.error?.message ?? "工具调用失败。";
    case "mcp_tool_discovered":
      return event.ok
        ? `发现 ${event.toolNames.length} 个 MCP 工具：${event.toolNames.join("、")}`
        : event.error?.message ?? "MCP 工具发现失败。";
    case "mcp_tool_call":
      return event.ok ? "MCP 工具成功返回结构化结果。" : event.error?.message ?? "MCP 工具调用失败。";
    case "final_response":
      return event.answerPreview;
  }
}

/**
 * 格式化 ISO 时间；非法时间保持原值，避免 UI 抛错。
 *
 * @param value ISO 时间字符串。
 * @returns 本地时间文案。
 */
export function formatTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString();
}

/**
 * 格式化较短的会话更新时间。
 *
 * @param value ISO 时间字符串。
 * @returns 简短时间文案。
 */
export function formatRelativeTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * 把最近一次 run 转成会话列表和 header 的状态文案。
 *
 * @param run 最近一次 run。
 * @returns 状态文案。
 */
export function formatRunStatus(run: AgentRunResponseDto | undefined): string {
  if (!run) {
    return "idle";
  }

  return run.ok ? run.intent : "failed";
}

/**
 * 从第一条用户输入生成会话标题。
 *
 * @param message 用户输入。
 * @returns 会话标题。
 */
export function createConversationTitle(message: string): string {
  return message.length > 24 ? `${message.slice(0, 24)}...` : message;
}

/** @param message 服务端消息 DTO。 @returns 时间线 UI 消息。 */
export function toUiMessage(message: ConversationMessageDto): UiMessage {
  return {
    id: message.messageId,
    role: message.role === "user" ? "user" : "assistant",
    content: message.content,
    createdAt: message.createdAt,
    status: message.status === "failed" ? "failed" : "complete",
    ok: message.status === "completed",
    attachments: message.attachments ?? []
  };
}

/** @param current 已加载会话。 @param incoming 新页。 @returns 按 ID 去重的列表。 */
export function mergeConversations(current: ConversationDto[], incoming: ConversationDto[]): ConversationDto[] {
  const seen = new Set(current.map((item) => item.conversationId));
  return [...current, ...incoming.filter((item) => !seen.has(item.conversationId))];
}

/** @param current 已加载消息。 @param incoming 新页。 @returns 按 ID 去重并按时间线顺序排列的消息。 */
export function mergeMessages(current: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !seen.has(item.id))];
}

/**
 * 生成浏览器本地 id，避免依赖服务端持久化能力。
 *
 * @param prefix id 前缀。
 * @returns UI id。
 */
export function createUiId(prefix: string): string {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 将浏览器路径解析为稳定工作区，未知路径安全回退到聊天首页。
 *
 * @param pathname 当前 URL pathname。
 * @returns 对应工作区。
 */
export function getWorkspaceView(pathname: string): WorkspaceView {
  const routes: Record<string, WorkspaceView> = {
    "/": "chat",
    "/scheduled-tasks": "scheduled-tasks",
    "/data-sources": "data-sources",
    "/workflow": "workflow",
    "/citations": "citations",
    "/eval": "eval",
    "/architecture": "architecture",
    "/settings": "settings"
  };
  return routes[pathname] ?? "chat";
}

/**
 * 将工作区转换为可分享的产品路由。
 *
 * @param view 工作区。
 * @returns URL pathname。
 */
export function getWorkspacePath(view: WorkspaceView): string {
  return view === "chat" ? "/" : `/${view}`;
}
