import assert from "node:assert/strict";
import { test } from "node:test";
import { createInMemoryTraceRecorder } from "@aiagent/trace";
import { runAgent } from "../dist/index.js";

test("chat questions use the lightweight answer path without tools", async () => {
  const trace = createInMemoryTraceRecorder("trace_chat_test");
  const response = await runAgent({ message: "解释一下 ROE 是什么？" }, { traceRecorder: trace });

  assert.equal(response.ok, true);
  assert.equal(response.intent, "chat");
  assert.match(response.answer, /ROE/);
  assert.deepEqual(
    response.steps.map((step) => step.type),
    ["route_intent", "model_answer", "final_response"]
  );
  assert.equal(response.traceId, "trace_chat_test");
  assert.equal(response.requestId.startsWith("req_"), true);
  assert.equal(response.trace.traceId, "trace_chat_test");
  assert.equal(response.trace.events.some((event) => event.type === "request_received" && event.userMessage.includes("ROE")), true);
  assert.equal(trace.getEvents().some((event) => event.type === "tool_call"), false);
  assert.equal(trace.getEvents().some((event) => event.type === "final_response" && event.ok), true);
});

test("financial metric questions select financial_metric_mock through the registry", async () => {
  const trace = createInMemoryTraceRecorder("trace_metric_test");
  const response = await runAgent(
    { message: "帮我查询 000001.SZ 最近一期净利润和 ROE。" },
    { traceRecorder: trace }
  );

  assert.equal(response.ok, true);
  assert.equal(response.intent, "tool");
  assert.match(response.answer, /financial_metric_mock/);
  assert.match(response.answer, /净利润/);
  assert.deepEqual(
    response.steps.map((step) => step.type),
    ["route_intent", "select_tool", "call_tool", "final_response"]
  );

  const toolEvent = trace.getEvents().find((event) => event.type === "tool_call");
  assert.equal(toolEvent.toolName, "financial_metric_mock");
  assert.equal(toolEvent.ok, true);
});

test("filing search questions select filing_search_mock through the registry", async () => {
  const trace = createInMemoryTraceRecorder("trace_filing_test");
  const response = await runAgent(
    { message: "检索一下 000001.SZ 最近年报中关于资产质量的描述。" },
    { traceRecorder: trace }
  );

  assert.equal(response.ok, true);
  assert.equal(response.intent, "tool");
  assert.match(response.answer, /filing_search_mock/);
  assert.match(response.answer, /资产质量/);

  const toolEvent = trace.getEvents().find((event) => event.type === "tool_call");
  assert.equal(toolEvent.toolName, "filing_search_mock");
  assert.equal(toolEvent.ok, true);
});

test("report PDF requests return the Week 3 workflow placeholder", async () => {
  const trace = createInMemoryTraceRecorder("trace_report_test");
  const response = await runAgent(
    { message: "帮我生成一份 000001.SZ 的公司研究报告 PDF。" },
    { traceRecorder: trace }
  );

  assert.equal(response.ok, true);
  assert.equal(response.intent, "report_skill");
  assert.match(response.answer, /Week 3/);
  assert.deepEqual(
    response.steps.map((step) => step.type),
    ["route_intent", "report_skill_placeholder", "final_response"]
  );
});

test("maxSteps returns a structured failure instead of continuing the loop", async () => {
  const trace = createInMemoryTraceRecorder("trace_max_steps_test");
  const response = await runAgent({ message: "解释一下 ROE 是什么？", maxSteps: 1 }, { traceRecorder: trace });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "max_steps_exceeded");
  assert.equal(response.steps.some((step) => step.type === "max_steps_exceeded"), true);
  assert.equal(response.steps.at(-1).type, "final_response");
  assert.equal(trace.getEvents().some((event) => event.type === "agent_step" && event.stepType === "max_steps_exceeded"), true);
});

test("tool validation errors are returned and traced", async () => {
  const trace = createInMemoryTraceRecorder("trace_tool_validation_test");
  const response = await runAgent(
    { message: "force validation" },
    {
      traceRecorder: trace,
      router: {
        async route() {
          return {
            intent: "tool",
            confidence: 1,
            reason: "test validation",
            matchedRules: ["test"],
            tool: {
              toolName: "financial_metric_mock",
              args: {},
              reason: "test validation"
            }
          };
        }
      }
    }
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "validation_error");
  assert.equal(response.error.details.toolError.code, "validation_error");

  const toolEvent = trace.getEvents().find((event) => event.type === "tool_call");
  assert.equal(toolEvent.ok, false);
  assert.equal(toolEvent.error.code, "validation_error");
});

test("missing tools return tool_not_found and write trace", async () => {
  const trace = createInMemoryTraceRecorder("trace_missing_tool_test");
  const response = await runAgent(
    { message: "force missing tool" },
    {
      traceRecorder: trace,
      router: {
        async route() {
          return {
            intent: "tool",
            confidence: 1,
            reason: "test missing tool",
            matchedRules: ["test"],
            tool: {
              toolName: "missing_tool",
              args: { ticker: "000001.SZ" },
              reason: "test missing tool"
            }
          };
        }
      }
    }
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "tool_not_found");
  assert.equal(response.error.details.toolError.code, "tool_not_found");

  const toolEvent = trace.getEvents().find((event) => event.type === "tool_call");
  assert.equal(toolEvent.toolName, "missing_tool");
  assert.equal(toolEvent.ok, false);
});

test("model router JSON parse failures are structured and traced", async () => {
  const trace = createInMemoryTraceRecorder("trace_model_json_test");
  const response = await runAgent(
    { message: "请判断一下这是什么任务" },
    {
      traceRecorder: trace,
      enableModelRouter: true,
      llmClient: createJsonFailingClient()
    }
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "json_parse_error");
  assert.equal(response.steps[0].type, "route_intent");
  assert.equal(response.steps[0].status, "failed");

  const modelEvent = trace.getEvents().find((event) => event.type === "model_call");
  assert.equal(modelEvent.purpose, "intent_router");
  assert.equal(modelEvent.ok, false);
  assert.equal(modelEvent.error.code, "json_parse_error");
});

function createJsonFailingClient() {
  return {
    async chat() {
      throw new Error("chat should not be called");
    },
    async streamChat() {
      throw new Error("streamChat should not be called");
    },
    async jsonChat() {
      return {
        ok: false,
        error: {
          code: "json_parse_error",
          message: "Invalid JSON for agent intent route.",
          details: {
            contentPreview: "not json"
          }
        }
      };
    },
    async toolChat() {
      throw new Error("toolChat should not be called");
    }
  };
}
