import assert from "node:assert/strict";
import { createInMemoryTraceRecorder } from "../packages/trace/src/index.ts";
import { createDefaultToolRegistry } from "../packages/tools/src/index.ts";
import { runAgent } from "../packages/agent/src/index.ts";

/**
 * 验证 Week 1-004 的 Intent Router 与最小 Agent Loop 手动检查入口。
 *
 * @returns Promise<void>
 */
async function main() {
  const cases = [
    await verifyChatPath(),
    // await verifyFinancialMetricToolPath(),
    // await verifyFilingSearchToolPath(),
    // await verifyReportSkillPlaceholder(),
    // await verifyMaxStepsGuard()
  ];

  const summary = {
    ok: cases.every((item) => item.ok),
    checkedAt: new Date().toISOString(),
    cases
  };

  console.log(JSON.stringify(summary, null, 2));
}

/**
 * 验证普通概念问题走 chat 路径，不产生工具调用。
 *
 * @returns 单个验证用例摘要。
 */
async function verifyChatPath() {
  const trace = createInMemoryTraceRecorder("manual_week1_004_chat");
  const response = await runSourceAgent({ message: "解释一下 ROE 是什么？" }, trace);
  const events = trace.getEvents();

  assert.equal(response.ok, true);
  assert.equal(response.intent, "chat");
  assert.deepEqual(getStepTypes(response), ["route_intent", "model_answer", "final_response"]);
  assert.equal(events.some((event) => event.type === "tool_call"), false);
  assert.equal(events.some((event) => event.type === "request_received"), true);
  assert.equal(events.some((event) => event.type === "intent_routed" && event.intent === "chat"), true);
  assert.equal(events.some((event) => event.type === "final_response" && event.ok), true);

  return createCaseSummary("chat_path", response, events);
}

/**
 * 验证财务指标问题经 registry 调用 financial_metric_mock。
 *
 * @returns 单个验证用例摘要。
 */
async function verifyFinancialMetricToolPath() {
  const trace = createInMemoryTraceRecorder("manual_week1_004_metric");
  const response = await runSourceAgent({ message: "帮我查询 000001.SZ 最近一期净利润和 ROE。" }, trace);
  const events = trace.getEvents();
  const toolEvent = events.find((event) => event.type === "tool_call");

  assert.equal(response.ok, true);
  assert.equal(response.intent, "tool");
  assert.match(response.answer, /financial_metric_mock/);
  assert.deepEqual(getStepTypes(response), ["route_intent", "select_tool", "call_tool", "final_response"]);
  assert.equal(toolEvent?.toolName, "financial_metric_mock");
  assert.equal(toolEvent?.ok, true);

  return createCaseSummary("financial_metric_tool_path", response, events);
}

/**
 * 验证公告检索问题经 registry 调用 filing_search_mock。
 *
 * @returns 单个验证用例摘要。
 */
async function verifyFilingSearchToolPath() {
  const trace = createInMemoryTraceRecorder("manual_week1_004_filing");
  const response = await runSourceAgent({ message: "检索一下 000001.SZ 最近年报中关于资产质量的描述。" }, trace);
  const events = trace.getEvents();
  const toolEvent = events.find((event) => event.type === "tool_call");

  assert.equal(response.ok, true);
  assert.equal(response.intent, "tool");
  assert.match(response.answer, /filing_search_mock/);
  assert.deepEqual(getStepTypes(response), ["route_intent", "select_tool", "call_tool", "final_response"]);
  assert.equal(toolEvent?.toolName, "filing_search_mock");
  assert.equal(toolEvent?.ok, true);

  return createCaseSummary("filing_search_tool_path", response, events);
}

/**
 * 验证报告/PDF 诉求只返回 Week 1 占位结果，不执行完整 workflow。
 *
 * @returns 单个验证用例摘要。
 */
async function verifyReportSkillPlaceholder() {
  const trace = createInMemoryTraceRecorder("manual_week1_004_report");
  const response = await runSourceAgent({ message: "帮我生成一份 000001.SZ 的公司研究报告 PDF。" }, trace);
  const events = trace.getEvents();

  assert.equal(response.ok, true);
  assert.equal(response.intent, "report_skill");
  assert.match(response.answer, /Week 3/);
  assert.deepEqual(getStepTypes(response), ["route_intent", "report_skill_placeholder", "final_response"]);
  assert.equal(events.some((event) => event.type === "tool_call"), false);

  return createCaseSummary("report_skill_placeholder", response, events);
}

/**
 * 验证 maxSteps 生效，达到上限时返回结构化失败和 trace step。
 *
 * @returns 单个验证用例摘要。
 */
async function verifyMaxStepsGuard() {
  const trace = createInMemoryTraceRecorder("manual_week1_004_max_steps");
  const response = await runSourceAgent({ message: "解释一下 ROE 是什么？", maxSteps: 1 }, trace);
  const events = trace.getEvents();

  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "max_steps_exceeded");
  assert.equal(response.steps.some((step) => step.type === "max_steps_exceeded"), true);
  assert.equal(events.some((event) => event.type === "agent_step" && event.stepType === "max_steps_exceeded"), true);
  assert.equal(events.some((event) => event.type === "final_response" && !event.ok), true);

  return createCaseSummary("max_steps_guard", response, events);
}

/**
 * 用源码版 trace recorder 和 tools registry 执行 Agent，便于 VS Code debugger 进入 src 流程。
 *
 * @param request Agent 请求。
 * @param trace 本次验证使用的源码版 trace recorder。
 * @returns Agent 执行响应。
 */
function runSourceAgent(request, trace) {
  return runAgent(request, {
    traceRecorder: trace,
    toolRegistry: createDefaultToolRegistry()
  });
}

/**
 * 提取响应步骤类型，便于断言 Agent Loop 是否走到预期路径。
 *
 * @param response Agent 执行响应。
 * @returns 步骤类型数组。
 */
function getStepTypes(response) {
  return response.steps.map((step) => step.type);
}

/**
 * 汇总单个用例的核心可观测结果，方便人工查看 launch 日志。
 *
 * @param name 用例名称。
 * @param response Agent 执行响应。
 * @param events trace 事件列表。
 * @returns 用例摘要。
 */
function createCaseSummary(name, response, events) {
  return {
    name,
    ok: true,
    intent: response.intent,
    traceId: response.traceId,
    steps: getStepTypes(response),
    errorCode: response.error?.code,
    traceEvents: events.map((event) => event.type)
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
