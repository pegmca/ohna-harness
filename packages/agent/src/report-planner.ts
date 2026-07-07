import type {
  ReportPlanDto,
  ReportPlannerInputDto,
  ReportPlanStatusDto,
  ReportPlanStepDto,
  ReportTriggerSourceDto,
  ReportTypeDto
} from "@aiagent/types";

const TICKER_PATTERN = /\b\d{6}\.(?:SZ|SH|BJ)\b/i;
const REPORT_DELIVERY_KEYWORDS = ["报告", "研报", "研究报告", "研究简报", "PDF", "pdf", "导出", "生成", "撰写"];
const DATA_NEED_KEYWORDS = [
  "公司",
  "公告",
  "财报",
  "财务数据",
  "财务指标",
  "年报",
  "季报",
  "营收",
  "净利润",
  "ROE",
  "风险",
  "最近"
];

export interface ReportActivationInput {
  message: string;
  reportMode?: boolean;
  explicitTriggerSource?: ReportTriggerSourceDto;
  routeReason: string;
  matchedRules: string[];
}

export interface ReportActivation {
  triggerSource: ReportTriggerSourceDto;
  plannerInput: ReportPlannerInputDto;
}

/**
 * 判断自然语言是否真的表达“交付报告”的技能激活诉求，降低只因单个关键词导致的误触发。
 *
 * @param message 用户输入。
 * @returns 是否应进入 report skill。
 */
export function isNaturalLanguageReportRequest(message: string): boolean {
  const normalized = message.trim();
  const hasDeliveryIntent = REPORT_DELIVERY_KEYWORDS.some((keyword) => normalized.includes(keyword));
  const hasDataNeed = DATA_NEED_KEYWORDS.some((keyword) => normalized.includes(keyword)) || TICKER_PATTERN.test(normalized);

  return hasDeliveryIntent && hasDataNeed;
}

/**
 * 生成 Report Skill activation 输入，保证 toggle、button 和自然语言共用同一个 planner 边界。
 *
 * @param input activation 原始上下文。
 * @returns 可写入 trace 并传给 planner 的 activation。
 */
export function createReportActivation(input: ReportActivationInput): ReportActivation {
  const triggerSource = resolveTriggerSource(input);

  return {
    triggerSource,
    plannerInput: {
      message: input.message,
      triggerSource,
      reportMode: input.reportMode ?? false,
      matchedRules: input.matchedRules,
      routeReason: input.routeReason
    }
  };
}

/**
 * 根据用户输入生成第一版确定性研报计划，只规划后续 workflow，不执行检索、写作或导出。
 *
 * @param input planner 输入 DTO。
 * @returns 前后端共享的 Report plan DTO。
 */
export function createReportPlan(input: ReportPlannerInputDto): ReportPlanDto {
  const message = input.message.trim();
  const subject = extractSubject(message);
  const reportType = extractReportType(message);
  const timeRange = extractTimeRange(message);
  const requiredData = extractRequiredData(message, reportType);
  const assumptions: string[] = [];
  const clarificationQuestions: string[] = [];

  if (!timeRange) {
    assumptions.push("未指定时间范围，默认使用最近两年可获得公告和财务数据。");
  }

  if (!message.includes("PDF") && !message.includes("pdf")) {
    assumptions.push("本阶段只生成结构化计划，PDF 导出会在后续 Workflow 阶段接入。");
  }

  if (!subject) {
    clarificationQuestions.push("请提供要研究的公司、股票代码或行业对象。");
  }

  const status = resolvePlanStatus({
    subject,
    triggerSource: input.triggerSource,
    message,
    clarificationQuestions
  });
  const effectiveTimeRange = timeRange ?? (status === "needs_clarification" ? undefined : "最近两年");

  return {
    planId: createPlanId(input.triggerSource),
    status,
    triggerSource: input.triggerSource,
    reportType,
    subject,
    timeRange: effectiveTimeRange,
    requiredData,
    assumptions,
    clarificationQuestions,
    steps: buildPlanSteps(status, requiredData)
  };
}

/**
 * 根据显式来源、开关状态和路由规则确定 activation 来源。
 *
 * @param input activation 输入。
 * @returns 触发来源。
 */
function resolveTriggerSource(input: ReportActivationInput): ReportTriggerSourceDto {
  if (input.explicitTriggerSource) {
    return input.explicitTriggerSource;
  }

  return input.reportMode ? "toggle" : "natural_language";
}

/**
 * 提取报告研究对象，优先使用 A 股 ticker，缺失时尝试识别“为 X 生成”等自然语言对象。
 *
 * @param message 用户输入。
 * @returns 研究对象或 undefined。
 */
function extractSubject(message: string): string | undefined {
  const ticker = message.match(TICKER_PATTERN)?.[0].toUpperCase();

  if (ticker) {
    return ticker;
  }

  const subjectMatch = message.match(/(?:为|给|针对|关于)\s*([^，。,.]{2,24}?)(?:生成|写|撰写|做|的)/);
  const subject = subjectMatch?.[1]?.trim();

  return subject && !["公司", "这家公司", "研究报告", "研报"].includes(subject) ? subject : undefined;
}

/**
 * 识别报告类型，保持枚举稳定，便于后续 Workflow 分支。
 *
 * @param message 用户输入。
 * @returns 报告类型。
 */
function extractReportType(message: string): ReportTypeDto {
  if (message.includes("风险")) {
    return "risk_review";
  }

  if (["业绩", "财报", "年报", "季报", "盈利"].some((keyword) => message.includes(keyword))) {
    return "earnings_review";
  }

  if (["研究简报", "公司研究", "研究报告", "研报"].some((keyword) => message.includes(keyword))) {
    return "company_brief";
  }

  return "custom";
}

/**
 * 提取时间范围，当前使用可解释规则覆盖验收样例和常见中文表达。
 *
 * @param message 用户输入。
 * @returns 时间范围或 undefined。
 */
function extractTimeRange(message: string): string | undefined {
  if (message.includes("最近两年") || message.includes("近两年")) {
    return "最近两年";
  }

  if (message.includes("最近一年") || message.includes("近一年")) {
    return "最近一年";
  }

  if (message.includes("最近一期")) {
    return "最近一期";
  }

  const explicitYear = message.match(/20\d{2}(?:\s*[-至到]\s*20\d{2})?/u)?.[0];
  return explicitYear;
}

/**
 * 识别计划需要的数据域；缺省选择研报最小可执行数据集，而不是要求用户填满所有字段。
 *
 * @param message 用户输入。
 * @param reportType 报告类型。
 * @returns 数据需求列表。
 */
function extractRequiredData(message: string, reportType: ReportTypeDto): string[] {
  const data = new Set<string>();

  if (["公告", "年报", "季报", "披露"].some((keyword) => message.includes(keyword))) {
    data.add("filings");
  }

  if (["财务数据", "财务指标", "营收", "净利润", "ROE", "roe", "盈利"].some((keyword) => message.includes(keyword))) {
    data.add("financial_metrics");
  }

  if (["风险", "资产质量", "不良率"].some((keyword) => message.includes(keyword)) || reportType === "risk_review") {
    data.add("risk_factors");
  }

  if (["股价", "估值", "市场"].some((keyword) => message.includes(keyword))) {
    data.add("market_data");
  }

  if (data.size === 0) {
    data.add("filings");
    data.add("financial_metrics");
  }

  return [...data];
}

/**
 * 根据信息完整度选择 ready、needs_clarification 或 partial，避免对所有字段机械必填。
 *
 * @param input 状态判断上下文。
 * @returns 计划状态。
 */
function resolvePlanStatus(input: {
  subject: string | undefined;
  triggerSource: ReportTriggerSourceDto;
  message: string;
  clarificationQuestions: string[];
}): ReportPlanStatusDto {
  if (input.clarificationQuestions.length > 0 && input.triggerSource === "toggle") {
    return "needs_clarification";
  }

  if (input.clarificationQuestions.length > 0) {
    return "partial";
  }

  return "ready";
}

/**
 * 按计划状态生成可执行步骤；澄清步骤只在需要时出现。
 *
 * @param status 计划状态。
 * @param requiredData 数据需求。
 * @returns 计划步骤。
 */
function buildPlanSteps(status: ReportPlanStatusDto, requiredData: string[]): ReportPlanStepDto[] {
  const steps: ReportPlanStepDto[] = [];

  if (status !== "ready") {
    steps.push({
      id: "clarify_requirements",
      kind: "clarify_requirements",
      title: "澄清研究对象",
      description: "确认公司、股票代码或行业对象后再执行完整研报流程。",
      requiredData: [],
      optional: false
    });
  }

  if (requiredData.includes("filings")) {
    steps.push({
      id: "collect_filings",
      kind: "collect_filings",
      title: "收集公告和财报",
      description: "检索研究对象在时间范围内的公告、年报和季报文本。",
      requiredData: ["filings"],
      optional: false
    });
  }

  if (requiredData.includes("financial_metrics")) {
    steps.push({
      id: "collect_financial_metrics",
      kind: "collect_financial_metrics",
      title: "收集财务指标",
      description: "拉取营收、净利润、ROE、现金流等核心财务指标。",
      requiredData: ["financial_metrics"],
      optional: false
    });
  }

  steps.push(
    {
      id: "retrieve_evidence",
      kind: "retrieve_evidence",
      title: "检索证据",
      description: "基于 RAG 检索公告段落和可引用证据。",
      requiredData,
      optional: false
    },
    {
      id: "analyze_findings",
      kind: "analyze_findings",
      title: "分析发现",
      description: "归纳业务、财务和风险变化，形成可审查结论。",
      requiredData,
      optional: false
    },
    {
      id: "draft_report",
      kind: "draft_report",
      title: "起草报告",
      description: "生成结构化研报正文草稿，不输出评级或目标价。",
      requiredData,
      optional: false
    },
    {
      id: "review_citations",
      kind: "review_citations",
      title: "检查引用",
      description: "核对关键结论是否有公告或财务数据支撑。",
      requiredData: ["filings"],
      optional: true
    },
    {
      id: "prepare_export",
      kind: "prepare_export",
      title: "准备导出",
      description: "保留 PDF 导出所需结构，实际导出在后续阶段完成。",
      requiredData: [],
      optional: true
    }
  );

  return steps;
}

/**
 * 生成轻量 plan id，避免为学习阶段引入额外 UUID 依赖。
 *
 * @param triggerSource 触发来源。
 * @returns plan id。
 */
function createPlanId(triggerSource: ReportTriggerSourceDto): string {
  return `report_plan_${triggerSource}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
