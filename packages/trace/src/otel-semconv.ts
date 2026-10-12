/**
 * OTel `gen_ai` semconv 映射层（docs/v1.1/04-eval-observability.md P1）。
 *
 * 把 trace 包的 `RunEvent` 投影为 OpenTelemetry GenAI 语义约定兼容的 span，便于一次性导出到
 * Phoenix / OTel Collector，与 Python 侧 RAGAS 链路对齐（"三位一体"观测）。
 *
 * 设计要点：
 * - span 命名对齐 `gen_ai.agent.run` / `gen_ai.agent.generation` / `gen_ai.tool.call` / `gen_ai.retrieval`；
 * - 属性对齐 `gen_ai.operation.name` / `gen_ai.request.model` / `gen_ai.response.model` /
 *   `gen_ai.token.count.{prompt,completion,total}` / `cost.total` 等 GenAI 语义字段；
 * - token / cost 读取全部防御式：字段可能缺失或类型不对，缺失时填 0 或省略，绝不抛异常；
 * - 中间事件（message_start / message_update / tool_execution_update / turn_* / run_*）映射为
 *   `null`，由调用方在 `runEventsToOtelSpans` 中过滤，保证 span 集合只含可观测边界。
 */
import type { RunEvent } from "./index.js";

/** OTel span 兼容结构（OTel GenAI 语义约定子集）。 */
export interface OtelSpan {
  /** 关联 trace 标识。 */
  traceId: string;
  /** span 标识；同类事件（如 agent_start/agent_end）共享同一 spanId 以便后端合并。 */
  spanId: string;
  /** 父 span 标识（可选）。 */
  parentSpanId?: string;
  /** span 名称（对齐 `gen_ai.*` 语义）。 */
  name: string;
  /** span 种类：agent / tool / retrieval / internal。 */
  kind: "agent" | "tool" | "retrieval" | "internal";
  /** span 开始时间（ISO 8601）。 */
  startTime: string;
  /** span 结束时间（可选；RunEvent 未携带时省略）。 */
  endTime?: string;
  /** span 属性（字符串 / 数字 / 布尔）。 */
  attributes: Record<string, string | number | boolean>;
}

/** token 用量视图（防御式读取，字段均可缺）。 */
interface TokenUsageView {
  input?: unknown;
  output?: unknown;
  totalTokens?: unknown;
  total?: unknown;
  cost?: { total?: unknown };
}

/** 成本视图（防御式读取）。 */
interface CostView {
  total?: unknown;
}

/**
 * 把单条 RunEvent 映射为一个 OTel 兼容 span；中间事件返回 null（不映射）。
 *
 * @param event 单条运行事件。
 * @returns OTel span；若事件不产生可观测 span 则返回 null。
 */
export function toOtelSpan(event: RunEvent): OtelSpan | null {
  const base = { traceId: event.traceId, startTime: event.createdAt };
  const payload = event.payload as Record<string, unknown>;

  switch (event.type) {
    case "agent_start": {
      // agent 运行的全局 span：请求侧语义（模型、系统、agent 名）。
      const attributes: Record<string, string | number | boolean> = { "gen_ai.operation.name": "agent.run" };
      if (typeof payload.model === "string" && payload.model.length > 0) attributes["gen_ai.request.model"] = payload.model;
      if (typeof payload.api === "string" && payload.api.length > 0) attributes["gen_ai.system"] = payload.api;
      if (typeof payload.agentName === "string" && payload.agentName.length > 0) attributes["gen_ai.agent.name"] = payload.agentName;
      return { ...base, spanId: `agent-${event.traceId}`, name: "gen_ai.agent.run", kind: "agent", attributes };
    }

    case "agent_end": {
      // agent 运行结束：把请求侧 span 补齐为响应侧语义（token、成本、错误标记）。
      const tokens = readTokenCounts(payload);
      const attributes: Record<string, string | number | boolean> = { "gen_ai.operation.name": "agent.run" };
      if (typeof payload.model === "string" && payload.model.length > 0) attributes["gen_ai.response.model"] = payload.model;
      attributes["gen_ai.token.count.prompt"] = tokens.prompt;
      attributes["gen_ai.token.count.completion"] = tokens.completion;
      attributes["gen_ai.token.count.total"] = tokens.total;
      const cost = readCostTotal(payload);
      if (cost !== undefined) attributes["cost.total"] = cost;
      if (payload.error !== undefined && payload.error !== null) attributes["gen_ai.agent.run.error"] = true;
      return { ...base, spanId: `agent-${event.traceId}`, name: "gen_ai.agent.run", kind: "agent", attributes };
    }

    case "message_end": {
      // 单次 generation：父子关系挂在 agent span 下，写入请求/响应模型与 token 用量。
      const tokens = readTokenCounts(payload);
      const attributes: Record<string, string | number | boolean> = { "gen_ai.operation.name": "agent.generation" };
      if (typeof payload.model === "string" && payload.model.length > 0) {
        attributes["gen_ai.request.model"] = payload.model;
        attributes["gen_ai.response.model"] = payload.model;
      }
      attributes["gen_ai.token.count.prompt"] = tokens.prompt;
      attributes["gen_ai.token.count.completion"] = tokens.completion;
      attributes["gen_ai.token.count.total"] = tokens.total;
      const cost = readCostTotal(payload);
      if (cost !== undefined) attributes["cost.total"] = cost;
      return {
        ...base,
        spanId: `gen-${event.traceId}`,
        parentSpanId: `agent-${event.traceId}`,
        name: "gen_ai.agent.generation",
        kind: "agent",
        attributes,
      };
    }

    case "tool_execution_start": {
      // 工具调用开始：写入工具名与调用 id，便于与 tool_execution_end 配对。
      const attributes: Record<string, string | number | boolean> = {
        "gen_ai.operation.name": "tool.call",
        "gen_ai.tool.name": typeof payload.toolName === "string" ? payload.toolName : "",
        "gen_ai.tool.call.id": typeof payload.toolCallId === "string" ? payload.toolCallId : "",
      };
      return {
        ...base,
        spanId: `tool-${String(payload.toolCallId ?? event.id)}`,
        parentSpanId: `agent-${event.traceId}`,
        name: "gen_ai.tool.call",
        kind: "tool",
        attributes,
      };
    }

    case "tool_execution_end": {
      // 工具调用结束：复用同一 spanId，补齐状态、token 与成本。
      const tokens = readTokenCounts(payload);
      const attributes: Record<string, string | number | boolean> = {
        "gen_ai.operation.name": "tool.call",
        "gen_ai.tool.name": typeof payload.toolName === "string" ? payload.toolName : "",
        "gen_ai.tool.call.id": typeof payload.toolCallId === "string" ? payload.toolCallId : "",
        "gen_ai.tool.call.status": payload.isError ? "error" : "ok",
      };
      attributes["gen_ai.token.count.prompt"] = tokens.prompt;
      attributes["gen_ai.token.count.completion"] = tokens.completion;
      attributes["gen_ai.token.count.total"] = tokens.total;
      const cost = readCostTotal(payload);
      if (cost !== undefined) attributes["cost.total"] = cost;
      return {
        ...base,
        spanId: `tool-${String(payload.toolCallId ?? event.id)}`,
        parentSpanId: `agent-${event.traceId}`,
        name: "gen_ai.tool.call",
        kind: "tool",
        attributes,
      };
    }

    case "retrieval": {
      // 检索能力事件：对齐 `gen_ai.retrieval.*` 语义字段（查询预览、top_k、模式、命中数等）。
      const chunkIds = Array.isArray(payload.chunkIds) ? (payload.chunkIds as unknown[]) : [];
      const attributes: Record<string, string | number | boolean> = {
        "gen_ai.retrieval.query_preview": String(payload.queryPreview ?? payload.query ?? ""),
        "gen_ai.retrieval.top_k": toNumber(payload.topK, 0),
        "gen_ai.retrieval.mode": String(payload.mode ?? ""),
        "gen_ai.retrieval.candidate_limit": toNumber(payload.candidateLimit, 0),
        "gen_ai.retrieval.duration_ms": toNumber(payload.durationMs, 0),
        "gen_ai.retrieval.ok": Boolean(payload.ok),
        "gen_ai.retrieval.result_count": chunkIds.length,
      };
      return {
        ...base,
        spanId: `retrieval-${event.traceId}`,
        parentSpanId: `agent-${event.traceId}`,
        name: "gen_ai.retrieval",
        kind: "retrieval",
        attributes,
      };
    }

    case "workflow_node": {
      // workflow 节点：作为 internal span 透传关键 payload（节点、状态、耗时）。
      const attributes: Record<string, string | number | boolean> = {
        node: String(payload.node ?? payload.nodeType ?? payload.nodeId ?? ""),
        status: String(payload.status ?? ""),
        durationMs: toNumber(payload.durationMs, 0),
      };
      return {
        ...base,
        spanId: `wf-${event.traceId}-${String(payload.node ?? payload.nodeId ?? "n")}`,
        parentSpanId: `agent-${event.traceId}`,
        name: "workflow.node",
        kind: "internal",
        attributes,
      };
    }

    case "pdf_export": {
      // PDF 导出：internal span 透传状态与耗时（可选项 fileName）。
      const attributes: Record<string, string | number | boolean> = {
        status: String(payload.status ?? ""),
        durationMs: toNumber(payload.durationMs, 0),
      };
      if (typeof payload.fileName === "string" && payload.fileName.length > 0) attributes["fileName"] = payload.fileName;
      return {
        ...base,
        spanId: `pdf-${event.traceId}`,
        parentSpanId: `agent-${event.traceId}`,
        name: "pdf.export",
        kind: "internal",
        attributes,
      };
    }

    case "mcp_tool_discovered": {
      // MCP 工具发现：internal span 透传服务名、是否成功、耗时与工具数量。
      const toolNames = Array.isArray(payload.toolNames) ? (payload.toolNames as unknown[]) : [];
      const attributes: Record<string, string | number | boolean> = {
        serverName: String(payload.serverName ?? ""),
        ok: Boolean(payload.ok),
        durationMs: toNumber(payload.durationMs, 0),
        toolCount: toolNames.length,
      };
      return {
        ...base,
        spanId: `mcp-${event.traceId}`,
        parentSpanId: `agent-${event.traceId}`,
        name: "mcp.tool_discovered",
        kind: "internal",
        attributes,
      };
    }

    // 中间事件（message_start / message_update / tool_execution_update / turn_* / run_*）不映射。
    default:
      return null;
  }
}

/**
 * 把一组 RunEvent 投影为 OTel span 列表（自动过滤 null）。
 *
 * @param events 按时间排序的运行事件序列。
 * @returns 非空 span 集合，供一次性导出到 Phoenix / OTel。
 */
export function runEventsToOtelSpans(events: readonly RunEvent[]): OtelSpan[] {
  const spans: OtelSpan[] = [];
  for (const event of events) {
    const span = toOtelSpan(event);
    if (span) spans.push(span);
  }
  return spans;
}

/**
 * 防御式读取 token 用量：字段可能缺失或类型不对，缺失时填 0，绝不抛异常。
 *
 * @param payload 事件载荷（视图）。
 * @returns prompt / completion / total 三个计数（缺省 0）。
 */
function readTokenCounts(payload: Record<string, unknown>): { prompt: number; completion: number; total: number } {
  const usage = (payload.usage ?? payload.tokenUsage) as TokenUsageView | undefined;
  if (!usage) return { prompt: 0, completion: 0, total: 0 };
  const prompt = toNumber(usage.input, 0);
  const completion = toNumber(usage.output, 0);
  const total = toNumber(usage.totalTokens, toNumber(usage.total, 0));
  return { prompt, completion, total };
}

/**
 * 防御式读取总成本：优先 payload.cost.total，其次 usage.cost.total；均无则 undefined（省略）。
 *
 * @param payload 事件载荷（视图）。
 * @returns 总成本数字；无则返回 undefined。
 */
function readCostTotal(payload: Record<string, unknown>): number | undefined {
  const direct = payload.cost as CostView | undefined;
  if (direct && typeof direct.total === "number" && Number.isFinite(direct.total)) return direct.total;
  const usage = payload.usage as TokenUsageView | undefined;
  if (usage?.cost && typeof usage.cost.total === "number" && Number.isFinite(usage.cost.total)) return usage.cost.total;
  return undefined;
}

/**
 * 把未知值安全转为数字；非有限数字时回退到默认值。
 *
 * @param value 原始值。
 * @param fallback 回退值。
 * @returns 有限数字或回退值。
 */
function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
