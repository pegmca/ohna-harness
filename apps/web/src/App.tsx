import type { Trace, TraceEvent } from "@aiagent/trace";

const demoTrace: Trace = {
  traceId: "trace_week1_demo",
  requestId: "req_week1_demo",
  startedAt: "2026-06-24T00:00:00.000Z",
  events: [
    {
      type: "request_received",
      id: "trace_week1_demo_request",
      traceId: "trace_week1_demo",
      requestId: "req_week1_demo",
      createdAt: "2026-06-24T00:00:00.000Z",
      userMessage: "帮我查询 000001.SZ 最近一期净利润和 ROE。",
      inputPreview: "帮我查询 000001.SZ 最近一期净利润和 ROE。"
    },
    {
      type: "intent_routed",
      id: "trace_week1_demo_intent",
      traceId: "trace_week1_demo",
      requestId: "req_week1_demo",
      createdAt: "2026-06-24T00:00:00.012Z",
      intent: "tool",
      confidence: 0.9,
      reason: "命中财务指标查询诉求。",
      toolName: "financial_metric_mock"
    },
    {
      type: "agent_step",
      id: "trace_week1_demo_step_0",
      traceId: "trace_week1_demo",
      requestId: "req_week1_demo",
      createdAt: "2026-06-24T00:00:00.014Z",
      stepIndex: 0,
      stepType: "route_intent",
      status: "succeeded",
      durationMs: 1.7
    },
    {
      type: "tool_call",
      id: "trace_week1_demo_tool",
      traceId: "trace_week1_demo",
      requestId: "req_week1_demo",
      createdAt: "2026-06-24T00:00:00.024Z",
      toolName: "financial_metric_mock",
      args: {
        ticker: "000001.SZ",
        metrics: ["net_profit", "roe"]
      },
      result: {
        ticker: "000001.SZ",
        period: "2024Q3",
        metrics: {
          net_profit: {
            value: 14932000000,
            unit: "CNY"
          },
          roe: {
            value: 3.42,
            unit: "%"
          }
        }
      },
      durationMs: 3.34,
      ok: true
    },
    {
      type: "final_response",
      id: "trace_week1_demo_final",
      traceId: "trace_week1_demo",
      requestId: "req_week1_demo",
      createdAt: "2026-06-24T00:00:00.031Z",
      answerPreview: "已调用 financial_metric_mock。000001.SZ 2024Q3 净利润为 14932000000 CNY，ROE 为 3.42%。数据来源：mock。",
      ok: true
    }
  ]
};

/**
 * 渲染 Week 1 trace 时间线，验证前端能消费 packages/trace 暴露的稳定结构。
 *
 * @returns Immersive trace playground 主界面。
 */
export function App() {
  return (
    <main className="app-shell">
      <section className="overview">
        <p className="eyebrow">Week 1 Trace</p>
        <h1>Trace Timeline</h1>
        <p className="summary">
          一次金融研究请求的关键链路：request、intent、agent step、tool call、latency、error 和 final response。
        </p>
      </section>

      <section className="trace-meta" aria-label="Trace metadata">
        <div>
          <span>Request ID</span>
          <strong>{demoTrace.requestId}</strong>
        </div>
        <div>
          <span>Trace ID</span>
          <strong>{demoTrace.traceId}</strong>
        </div>
        <div>
          <span>Events</span>
          <strong>{demoTrace.events.length}</strong>
        </div>
      </section>

      <section className="timeline" aria-label="Trace timeline">
        {demoTrace.events.map((event, index) => (
          <article className="timeline-event" key={event.id}>
            <div className="event-index">{index + 1}</div>
            <div className="event-body">
              <div className="event-heading">
                <strong>{formatEventTitle(event)}</strong>
                <span>{formatLatency(event)}</span>
              </div>
              <p>{formatEventSummary(event)}</p>
              <pre>{JSON.stringify(event, null, 2)}</pre>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

/**
 * 将 trace event 类型转换成适合 timeline 展示的标题。
 *
 * @param event trace event。
 * @returns 用户可读标题。
 */
function formatEventTitle(event: TraceEvent): string {
  switch (event.type) {
    case "request_received":
      return "Request Received";
    case "intent_routed":
      return `Intent Routed: ${event.intent}`;
    case "agent_step":
      return `Agent Step: ${event.stepType}`;
    case "model_call":
      return `Model Call: ${event.purpose}`;
    case "tool_call":
      return `Tool Call: ${event.toolName}`;
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
function formatLatency(event: TraceEvent): string {
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
function formatEventSummary(event: TraceEvent): string {
  switch (event.type) {
    case "request_received":
      return event.inputPreview;
    case "intent_routed":
      return event.reason;
    case "agent_step":
      return `${event.status} with ${event.error?.code ?? "no_error"}`;
    case "model_call":
      return event.ok ? `${event.model} responded` : event.error?.message ?? "model failed";
    case "tool_call":
      return event.ok ? "工具成功返回结构化结果。" : event.error?.message ?? "工具调用失败。";
    case "final_response":
      return event.answerPreview;
  }
}
