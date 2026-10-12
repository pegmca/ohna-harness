import assert from "node:assert/strict";
import test from "node:test";
import {
  isSensitiveKey,
  redactSensitiveText,
  redactTokenTrace,
  runEventsToOtelSpans,
  toOtelSpan
} from "../dist/index.js";

const requestId = "req-1";
const base = (traceId, id, type, payload) => ({ type, id, traceId, requestId, createdAt: "2026-01-01T00:00:00.000Z", payload });

test("agent_start 映射为 gen_ai.agent.run span 并写入请求模型", () => {
  const span = toOtelSpan(base("t1", "e1", "agent_start", { model: "gpt-4o", api: "openai-completions" }));
  assert.ok(span);
  assert.equal(span.name, "gen_ai.agent.run");
  assert.equal(span.kind, "agent");
  assert.equal(span.spanId, "agent-t1");
  assert.equal(span.attributes["gen_ai.operation.name"], "agent.run");
  assert.equal(span.attributes["gen_ai.request.model"], "gpt-4o");
  assert.equal(span.attributes["gen_ai.system"], "openai-completions");
});

test("agent_end 映射为同一 spanId 并写入 token 与成本", () => {
  const withUsage = toOtelSpan(base("t1", "e2", "agent_end", {
    model: "gpt-4o",
    usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.002 } },
    cost: { total: 0.002 }
  }));
  assert.equal(withUsage.spanId, "agent-t1");
  assert.equal(withUsage.attributes["gen_ai.token.count.prompt"], 100);
  assert.equal(withUsage.attributes["gen_ai.token.count.completion"], 50);
  assert.equal(withUsage.attributes["gen_ai.token.count.total"], 150);
  assert.equal(withUsage.attributes["gen_ai.response.model"], "gpt-4o");
  assert.equal(withUsage.attributes["cost.total"], 0.002);

  // 缺失 usage/cost 时不抛错且填 0。
  const noUsage = toOtelSpan(base("t2", "e3", "agent_end", {}));
  assert.equal(noUsage.attributes["gen_ai.token.count.prompt"], 0);
  assert.equal(noUsage.attributes["gen_ai.token.count.total"], 0);
  assert.ok(!("cost.total" in noUsage.attributes));

  // error 标记。
  const errored = toOtelSpan(base("t3", "e4", "agent_end", { error: { code: "run_failed" } }));
  assert.equal(errored.attributes["gen_ai.agent.run.error"], true);
});

test("message_end 映射为 gen_ai.agent.generation 子 span", () => {
  const span = toOtelSpan(base("t1", "e5", "message_end", {
    model: "gpt-4o",
    usage: { input: 80, output: 20, totalTokens: 100 }
  }));
  assert.equal(span.name, "gen_ai.agent.generation");
  assert.equal(span.kind, "agent");
  assert.equal(span.parentSpanId, "agent-t1");
  assert.equal(span.attributes["gen_ai.operation.name"], "agent.generation");
  assert.equal(span.attributes["gen_ai.request.model"], "gpt-4o");
  assert.equal(span.attributes["gen_ai.response.model"], "gpt-4o");
  assert.equal(span.attributes["gen_ai.token.count.total"], 100);
});

test("tool_execution 映射为 gen_ai.tool.call 并带状态", () => {
  const start = toOtelSpan(base("t1", "e6", "tool_execution_start", { toolName: "search_filings", toolCallId: "call-1" }));
  assert.equal(start.name, "gen_ai.tool.call");
  assert.equal(start.kind, "tool");
  assert.equal(start.spanId, "tool-call-1");
  assert.equal(start.attributes["gen_ai.tool.name"], "search_filings");
  assert.equal(start.attributes["gen_ai.tool.call.id"], "call-1");

  const end = toOtelSpan(base("t1", "e7", "tool_execution_end", {
    toolName: "search_filings", toolCallId: "call-1", isError: false,
    usage: { input: 10, output: 5, totalTokens: 15 }
  }));
  assert.equal(end.spanId, "tool-call-1");
  assert.equal(end.attributes["gen_ai.tool.call.status"], "ok");
  assert.equal(end.attributes["gen_ai.token.count.total"], 15);

  const failed = toOtelSpan(base("t1", "e8", "tool_execution_end", {
    toolName: "search_filings", toolCallId: "call-2", isError: true
  }));
  assert.equal(failed.attributes["gen_ai.tool.call.status"], "error");
});

test("retrieval 映射为 gen_ai.retrieval 并写入 top_k 等语义字段", () => {
  const span = toOtelSpan(base("t1", "e9", "retrieval", {
    queryPreview: "净利润",
    mode: "hybrid",
    topK: 8,
    candidateLimit: 20,
    durationMs: 32,
    chunkIds: ["c1", "c2", "c3"],
    ok: true
  }));
  assert.equal(span.name, "gen_ai.retrieval");
  assert.equal(span.kind, "retrieval");
  assert.equal(span.attributes["gen_ai.retrieval.query_preview"], "净利润");
  assert.equal(span.attributes["gen_ai.retrieval.top_k"], 8);
  assert.equal(span.attributes["gen_ai.retrieval.mode"], "hybrid");
  assert.equal(span.attributes["gen_ai.retrieval.candidate_limit"], 20);
  assert.equal(span.attributes["gen_ai.retrieval.duration_ms"], 32);
  assert.equal(span.attributes["gen_ai.retrieval.ok"], true);
  assert.equal(span.attributes["gen_ai.retrieval.result_count"], 3);
});

test("internal 能力事件映射为 internal span", () => {
  const wf = toOtelSpan(base("t1", "e10", "workflow_node", { node: "plan", status: "completed", durationMs: 5 }));
  assert.equal(wf.kind, "internal");
  assert.equal(wf.name, "workflow.node");
  assert.equal(wf.attributes.node, "plan");

  const pdf = toOtelSpan(base("t1", "e11", "pdf_export", { status: "succeeded", durationMs: 9 }));
  assert.equal(pdf.name, "pdf.export");
  assert.equal(pdf.attributes.status, "succeeded");

  const mcp = toOtelSpan(base("t1", "e12", "mcp_tool_discovered", { serverName: "s1", ok: true, durationMs: 3, toolNames: ["a", "b"] }));
  assert.equal(mcp.name, "mcp.tool_discovered");
  assert.equal(mcp.attributes.toolCount, 2);
});

test("runEventsToOtelSpans 过滤中间事件并正确计数", () => {
  const events = [
    base("t1", "1", "agent_start", { model: "gpt-4o" }),
    base("t1", "2", "message_start", {}),
    base("t1", "3", "message_update", {}),
    base("t1", "4", "message_end", { model: "gpt-4o" }),
    base("t1", "5", "tool_execution_start", { toolName: "t", toolCallId: "c" }),
    base("t1", "6", "tool_execution_update", {}),
    base("t1", "7", "tool_execution_end", { toolName: "t", toolCallId: "c" }),
    base("t1", "8", "retrieval", { queryPreview: "q", mode: "vector", topK: 3, candidateLimit: 5, durationMs: 1, chunkIds: ["x"], ok: true }),
    base("t1", "9", "turn_start", {}),
    base("t1", "10", "turn_end", {}),
    base("t1", "11", "agent_end", {}),
    base("t1", "12", "run_status", { status: "completed" })
  ];
  const spans = runEventsToOtelSpans(events);
  // agent_start + message_end + tool_start + tool_end + retrieval + agent_end = 6
  assert.equal(spans.length, 6);
  assert.ok(spans.every((s) => s.traceId === "t1"));
  // 中间事件映射为 null。
  assert.equal(toOtelSpan(base("t1", "x", "message_start", {})), null);
  assert.equal(toOtelSpan(base("t1", "x", "turn_start", {})), null);
  assert.equal(toOtelSpan(base("t1", "x", "run_status", { status: "x" })), null);
});

test("redactTokenTrace 脱敏含 PII 的字符串", () => {
  const value = { note: "联系 user@example.com，手机 13812345678" };
  const redacted = redactTokenTrace(value);
  assert.equal(JSON.stringify(redacted).includes("user@example.com"), false);
  assert.equal(JSON.stringify(redacted).includes("13812345678"), false);
  // 原对象不被修改。
  assert.equal(value.note.includes("user@example.com"), true);
});

test("isSensitiveKey 对模型 I/O 键返回 true", () => {
  assert.equal(isSensitiveKey("prompt"), true);
  assert.equal(isSensitiveKey("content"), true);
  assert.equal(isSensitiveKey("messages"), true);
  assert.equal(isSensitiveKey("answer"), true);
  assert.equal(isSensitiveKey("completion"), true);
  // 复合键（如 inputValidation）不应误伤。
  assert.equal(isSensitiveKey("inputValidation"), false);
  assert.equal(isSensitiveKey("authorization"), true);
});

test("redactSensitiveValue 既有行为未被破坏（截断 + secret 模式）", () => {
  const redacted = redactTokenTrace({ authorization: "Bearer abc", note: `x${"y".repeat(600)}` });
  assert.equal(redacted.authorization, "[redacted]");
  assert.ok(JSON.stringify(redacted).includes("[truncated]"));
  // redactSensitiveText 仍可从文本层面脱敏 PII。
  assert.ok(redactSensitiveText("a@b.com").includes("[redacted:email]"));
});
