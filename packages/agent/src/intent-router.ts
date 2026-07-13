import type { TraceRecorder } from "@aiagent/trace";
import type { LlmClient } from "@aiagent/types";
import { isNaturalLanguageReportRequest } from "./report-planner.js";
import type { AgentRoute, AgentRouter, AgentToolSelection } from "./types.js";

interface ModelRouteJson {
  intent?: string;
  reason?: string;
}

const REPORT_KEYWORDS = ["报告", "研报", "研究报告", "研究简报", "PDF", "pdf", "导出", "生成一份"];
const FILING_KEYWORDS = ["年报", "公告", "财报原文", "披露", "检索", "资产质量描述", "资产质量"];
const METRIC_KEYWORDS = ["营收", "净利润", "ROE", "roe", "毛利率", "现金流", "财务指标", "最近一期", "同比"];
const SQL_KEYWORDS = ["SQL", "sql", "SELECT", "select", "WITH", "with", "DROP", "drop", "查询 SQL", "执行 SQL"];
const CONCEPT_KEYWORDS = ["解释", "是什么", "什么意思", "概念", "定义"];
const DATA_NEED_KEYWORDS = ["最近", "查询", "变化", "多少", "同比", "公司", "这家公司"];
const TICKER_PATTERN = /\b\d{6}\.(?:SZ|SH|BJ)\b/i;

export interface IntentRouterOptions {
  llmClient?: LlmClient;
  enableModelRouter?: boolean;
  traceRecorder?: TraceRecorder;
}

/**
 * 创建第一版可审查 Intent Router，规则优先，模型结构化判断只作为兜底。
 *
 * @param options 可选模型 client 和模型兜底开关。
 * @returns 可注入 Agent Loop 的 router。
 */
export function createIntentRouter(options: IntentRouterOptions = {}): AgentRouter {
  return {
    route(message) {
      return routeIntent(message, options);
    }
  };
}

/**
 * 根据用户输入识别意图和工具参数，优先使用明确关键词保证 Week 1 行为可解释。
 *
 * @param message 用户输入。
 * @param options 可选模型兜底配置。
 * @returns 结构化路由结果。
 */
export async function routeIntent(message: string, options: IntentRouterOptions = {}): Promise<AgentRoute> {
  const normalized = message.trim();
  const reportMatches = findMatches(normalized, REPORT_KEYWORDS);
  const filingMatches = findMatches(normalized, FILING_KEYWORDS);
  const metricMatches = findMatches(normalized, METRIC_KEYWORDS);
  const sqlMatches = findMatches(normalized, SQL_KEYWORDS);

  if (isNaturalLanguageReportRequest(normalized)) {
    return {
      intent: "report_skill",
      confidence: 0.95,
      reason: "同时命中报告交付诉求和数据需求，进入 report skill planner。",
      matchedRules: [...new Set([...reportMatches, ...filingMatches, ...metricMatches, "report_delivery_with_data_need"])]
    };
  }

  if (sqlMatches.length > 0) {
    return toolRoute("sql_query_mock", buildSqlArgs(normalized), "命中 SQL 查询工具诉求，需要经过工具权限边界。", sqlMatches);
  }

  if (filingMatches.length > 0) {
    return toolRoute("filing_search_mock", buildFilingArgs(normalized), "命中公告/披露文本检索诉求。", filingMatches);
  }

  if (metricMatches.length > 0 && !isMetricConceptQuestion(normalized)) {
    return toolRoute("financial_metric_mock", buildMetricArgs(normalized), "命中财务指标查询诉求。", metricMatches);
  }

  if (options.enableModelRouter && options.llmClient) {
    const modelRoute = await routeWithModel(normalized, options.llmClient, options.traceRecorder);

    if (modelRoute.intent === "report_skill") {
      return {
        intent: "report_skill",
        confidence: 0.6,
        reason: modelRoute.reason ?? "模型结构化判断为 report skill。",
        matchedRules: ["model_router"]
      };
    }

    if (modelRoute.intent === "tool") {
      return toolRoute(
        "financial_metric_mock",
        buildMetricArgs(normalized),
        modelRoute.reason ?? "模型结构化判断为工具查询。",
        ["model_router"]
      );
    }
  }

  return {
    intent: "chat",
    confidence: 0.8,
    reason: "未命中外部数据或报告交付规则，使用轻量问答路径。",
    matchedRules: ["default_chat"]
  };
}

/**
 * 调用模型输出结构化路由 JSON，解析失败由 LLM client 转成结构化错误并向上返回。
 *
 * @param message 用户输入。
 * @param llmClient 模型 client。
 * @returns 模型路由 JSON。
 */
async function routeWithModel(
  message: string,
  llmClient: LlmClient,
  traceRecorder: TraceRecorder | undefined
): Promise<ModelRouteJson> {
  const startedAt = performance.now();
  const result = await llmClient.jsonChat<ModelRouteJson>({
    schemaName: "agent intent route",
    messages: [
      {
        role: "system",
        content:
          '判断用户意图，只返回 JSON：{"intent":"chat|tool|report_skill","reason":"简短原因"}。不要输出投资建议。'
      },
      {
        role: "user",
        content: message
      }
    ],
    temperature: 0
  });
  const durationMs = elapsedMs(startedAt);

  if (traceRecorder) {
    recordTrace(traceRecorder, {
      type: "model_call",
      id: createTraceEventId(traceRecorder.traceId, "router_model"),
      traceId: traceRecorder.traceId,
      requestId: traceRecorder.requestId,
      model: result.ok ? result.data.model : "unknown",
      purpose: "intent_router",
      durationMs,
      ok: result.ok,
      usage: result.ok ? result.data.usage : undefined,
      error: result.ok ? undefined : result.error,
      createdAt: new Date().toISOString()
    });
  }

  if (!result.ok) {
    throw {
      code: result.error.code === "json_parse_error" ? "json_parse_error" : "model_error",
      message: result.error.message,
      details: {
        llmCode: result.error.code,
        ...result.error.details
      }
    };
  }

  return result.data.json;
}

/**
 * 构造工具路由结果，保证工具选择也有 reason 和规则来源。
 *
 * @param toolName registry 中的工具名称。
 * @param args 工具参数。
 * @param reason 选择原因。
 * @param matchedRules 命中的关键词。
 * @returns tool 意图路由结果。
 */
function toolRoute(
  toolName: string,
  args: Record<string, unknown>,
  reason: string,
  matchedRules: string[]
): AgentRoute {
  const tool: AgentToolSelection = {
    toolName,
    args,
    reason
  };

  return {
    intent: "tool",
    confidence: 0.9,
    reason,
    matchedRules,
    tool
  };
}

/**
 * 从文本中提取 mock 工具需要的公告检索参数。
 *
 * @param message 用户输入。
 * @returns filing_search_mock 参数。
 */
function buildFilingArgs(message: string): Record<string, unknown> {
  return {
    ticker: extractTicker(message),
    query: message
  };
}

/**
 * 从文本中提取 mock 财务指标参数，Week 1 固定查净利润和 ROE。
 *
 * @param message 用户输入。
 * @returns financial_metric_mock 参数。
 */
function buildMetricArgs(message: string): Record<string, unknown> {
  return {
    ticker: extractTicker(message),
    metrics: ["net_profit", "roe"]
  };
}

/**
 * 从自然语言中提取 SQL 片段；demo 阶段保留原始 SQL 字符串交给 tools 权限边界校验。
 *
 * @param message 用户输入。
 * @returns sql_query_mock 参数。
 */
function buildSqlArgs(message: string): Record<string, unknown> {
  const sqlStart = message.search(/\b(select|with|drop|insert|update|delete|alter|truncate|create)\b/i);

  return {
    query: sqlStart >= 0 ? message.slice(sqlStart).trim() : message
  };
}

/**
 * 识别 A 股 ticker，缺省使用验收样例的 000001.SZ。
 *
 * @param message 用户输入。
 * @returns 标准化 ticker。
 */
function extractTicker(message: string): string {
  return message.match(TICKER_PATTERN)?.[0].toUpperCase() ?? "000001.SZ";
}

/**
 * 查找命中的关键词，保留命中列表便于 trace 和测试解释路由来源。
 *
 * @param message 用户输入。
 * @param keywords 候选关键词。
 * @returns 命中的关键词列表。
 */
function findMatches(message: string, keywords: string[]): string[] {
  return keywords.filter((keyword) => message.includes(keyword));
}

/**
 * 区分“解释 ROE 概念”和“查询某公司 ROE 数据”，避免概念题误调用工具。
 *
 * @param message 用户输入。
 * @returns 是否应保留在 chat 路径。
 */
function isMetricConceptQuestion(message: string): boolean {
  const hasConceptSignal = findMatches(message, CONCEPT_KEYWORDS).length > 0;
  const hasTicker = TICKER_PATTERN.test(message);
  const hasDataNeed = findMatches(message, DATA_NEED_KEYWORDS).length > 0;

  return hasConceptSignal && !hasTicker && !hasDataNeed;
}

/**
 * 安全写入 router 模型调用 trace，避免观测异常影响路由。
 *
 * @param trace trace recorder。
 * @param event trace event。
 */
function recordTrace(trace: TraceRecorder, event: Parameters<TraceRecorder["record"]>[0]): void {
  try {
    trace.record(event);
  } catch {
    // trace 失败不应改变路由结果。
  }
}

/**
 * 生成 router trace event id，保持无需额外依赖。
 *
 * @param traceId 当前 trace id。
 * @param label 事件标签。
 * @returns trace event id。
 */
function createTraceEventId(traceId: string, label: string): string {
  return `${traceId}_${label}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 计算模型路由耗时。
 *
 * @param startedAt performance.now 起点。
 * @returns 毫秒耗时。
 */
function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}
