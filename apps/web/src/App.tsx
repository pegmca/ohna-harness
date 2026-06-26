import * as Switch from "@radix-ui/react-switch";
import type { AgentRunResponseDto, ApiError, ApiResult } from "@aiagent/types";
import { Activity, Bot, Braces, Clock3, Loader2, Send, Sparkles, Wrench } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { Button } from "./components/ui/button";

type MessageRole = "user" | "assistant";

interface UiMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  ok?: boolean;
}

type TraceEventDto = AgentRunResponseDto["trace"]["events"][number];

const demoPrompts = [
  "这家公司最近两年的营收变化如何？",
  "帮我查询 000001.SZ 最近一期净利润和 ROE。",
  "检索一下 000001.SZ 最近年报中关于资产质量的描述。",
  "帮我生成一份 000001.SZ 的公司研究报告 PDF。"
];

/**
 * 渲染 Immersive Playground，负责本地消息状态和 API run 结果展示。
 *
 * @returns Week 1 可演示的金融研究工作台页面。
 */
export function App() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState(demoPrompts[1]);
  const [reportMode, setReportMode] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeRun, setActiveRun] = useState<AgentRunResponseDto | undefined>();
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const toolEvents = useMemo(
    () => activeRun?.trace.events.filter((event) => event.type === "tool_call") ?? [],
    [activeRun]
  );

  /**
   * 提交当前输入到 Fastify API，Week 1 不发送历史消息。
   *
   * @param event 表单提交事件。
   * @returns 请求完成 Promise。
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await submitMessage(input);
  }

  /**
   * 发送单条消息并把真实 Agent response 派生为 UI 状态。
   *
   * @param message 用户输入。
   * @returns 请求完成 Promise。
   */
  async function submitMessage(message: string): Promise<void> {
    const trimmed = message.trim();

    if (!trimmed || isSubmitting) {
      return;
    }

    const userMessage: UiMessage = {
      id: createUiId("user"),
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString()
    };

    setMessages((current) => [...current, userMessage]);
    setInput("");
    setError(undefined);
    setIsSubmitting(true);

    try {
      const result = await runAgent(trimmed, reportMode, conversationId);

      if (!result.ok) {
        setError(formatApiError(result.error));
        return;
      }

      const run = result.data;
      setActiveRun(run);
      setConversationId(run.conversationId);
      setMessages((current) => [
        ...current,
        {
          id: createUiId("assistant"),
          role: "assistant",
          content: run.answer,
          createdAt: new Date().toISOString(),
          ok: run.ok
        }
      ]);

      if (!run.ok && run.error) {
        setError(formatApiError(run.error));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "请求失败，请检查 API 服务是否已启动。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto grid min-h-screen w-full max-w-[1440px] grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1fr)_420px]">
        <section className="flex min-h-screen flex-col border-slate-800 lg:border-r">
          <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 px-5 py-4 md:px-8">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">Week 1 Immersive</p>
              <h1 className="mt-2 text-2xl font-semibold text-white md:text-3xl">Financial Research Playground</h1>
            </div>

            <label className="flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
              <span className="text-sm text-slate-300">Report Mode</span>
              <Switch.Root
                checked={reportMode}
                className="relative h-6 w-11 rounded-full bg-slate-700 outline-none data-[state=checked]:bg-cyan-500"
                onCheckedChange={setReportMode}
              >
                <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-[22px]" />
              </Switch.Root>
            </label>
          </header>

          <section className="grid gap-3 border-b border-slate-800 px-5 py-4 md:grid-cols-2 md:px-8 xl:grid-cols-4">
            {demoPrompts.map((prompt) => (
              <Button className="demo-chip" key={prompt} onClick={() => setInput(prompt)} type="button" variant="ghost">
                {prompt}
              </Button>
            ))}
          </section>

          <section className="flex-1 overflow-y-auto px-5 py-6 md:px-8" aria-label="消息列表">
            {messages.length === 0 ? (
              <div className="grid h-full min-h-[360px] place-items-center rounded-lg border border-dashed border-slate-700 bg-slate-900/50 p-6 text-center">
                <div className="max-w-lg">
                  <Sparkles className="mx-auto mb-4 size-10 text-cyan-300" />
                  <h2 className="text-xl font-semibold text-white">输入一个金融研究问题开始演示</h2>
                  <p className="mt-3 text-sm leading-6 text-slate-400">
                    页面会调用本地 Fastify API，再由 Agent 返回回答、步骤和 trace。历史仅保存在当前浏览器会话中。
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((message) => (
                  <article className={`message ${message.role === "user" ? "message-user" : "message-assistant"}`} key={message.id}>
                    <div className="message-icon">{message.role === "user" ? "你" : <Bot className="size-4" />}</div>
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span>{message.role === "user" ? "User" : "Assistant"}</span>
                        <span>{formatTime(message.createdAt)}</span>
                        {message.ok === false ? <span className="rounded bg-red-950 px-2 py-0.5 text-red-200">failed</span> : null}
                      </div>
                      <p className="whitespace-pre-wrap break-words leading-7">{message.content}</p>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <form className="border-t border-slate-800 bg-slate-950/95 px-5 py-4 md:px-8" onSubmit={handleSubmit}>
            {error ? (
              <div className="mb-3 rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-100">{error}</div>
            ) : null}
            <div className="flex gap-3">
              <textarea
                className="min-h-24 flex-1 resize-none rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-500 focus:border-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isSubmitting}
                onChange={(event) => setInput(event.target.value)}
                placeholder="输入金融研究问题..."
                value={input}
              />
              <Button
                className="grid h-24 w-14 place-items-center rounded-lg bg-cyan-400 text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                disabled={isSubmitting || !input.trim()}
                type="submit"
              >
                {isSubmitting ? <Loader2 className="size-5 animate-spin" /> : <Send className="size-5" />}
              </Button>
            </div>
          </form>
        </section>

        <aside className="grid min-h-screen grid-rows-[auto_auto_minmax(0,1fr)] bg-slate-900/80">
          <RunSummary activeRun={activeRun} reportMode={reportMode} />
          <ToolPanel steps={activeRun?.steps ?? []} toolEvents={toolEvents} />
          <TracePanel activeRun={activeRun} />
        </aside>
      </div>
    </main>
  );
}

/**
 * 调用最小 Agent API 并返回共享 ApiResult。
 *
 * @param message 当前用户输入。
 * @param reportMode Report Mode 占位开关状态。
 * @param conversationId 可选会话标识。
 * @returns API 运行结果。
 */
async function runAgent(
  message: string,
  reportMode: boolean,
  conversationId: string | undefined
): Promise<ApiResult<AgentRunResponseDto>> {
  const response = await fetch("/api/agent/run", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      message,
      reportMode,
      conversationId
    })
  });
  const result = await parseApiResult(response);

  if (!response.ok && result.ok) {
    throw new Error("API 返回了不一致的成功状态。");
  }

  return result;
}

/**
 * 解析 API 响应，兼容 dev proxy 断连、空响应和 HTML 错误页，避免浏览器抛出原始 JSON 解析异常。
 *
 * @param response fetch 返回的响应对象。
 * @returns 结构化 API result。
 */
async function parseApiResult(response: Response): Promise<ApiResult<AgentRunResponseDto>> {
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
    return JSON.parse(text) as ApiResult<AgentRunResponseDto>;
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
function formatApiError(error: ApiError): string {
  const diagnostics = [
    typeof error.details?.status === "number" ? `status=${error.details.status}` : undefined,
    typeof error.details?.cause === "string" ? `cause=${error.details.cause}` : undefined
  ].filter(Boolean);

  return diagnostics.length > 0
    ? `${error.code}: ${error.message} (${diagnostics.join(", ")})`
    : `${error.code}: ${error.message}`;
}

/**
 * 展示最近一次 run 的关键元信息。
 *
 * @param props 组件属性。
 * @returns run summary 面板。
 */
function RunSummary(props: { activeRun: AgentRunResponseDto | undefined; reportMode: boolean }) {
  const { activeRun, reportMode } = props;

  return (
    <section className="border-b border-slate-800 p-5">
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
        <Activity className="size-4 text-cyan-300" />
        Run State
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <MetaItem label="Intent" value={activeRun?.intent ?? "idle"} />
        <MetaItem label="Status" value={activeRun ? (activeRun.ok ? "ok" : "failed") : "waiting"} />
        <MetaItem label="Report Mode" value={reportMode ? "on" : "off"} />
        <MetaItem label="Trace Events" value={String(activeRun?.trace.events.length ?? 0)} />
      </dl>
      {activeRun ? (
        <p className="mt-4 break-all rounded-lg bg-slate-950 p-3 text-xs leading-5 text-slate-400">
          requestId: {activeRun.requestId}
          <br />
          traceId: {activeRun.traceId}
        </p>
      ) : null}
    </section>
  );
}

/**
 * 展示一个 run summary 字段。
 *
 * @param props 组件属性。
 * @returns 元信息条目。
 */
function MetaItem(props: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950 p-3">
      <dt className="text-xs text-slate-500">{props.label}</dt>
      <dd className="mt-1 break-words font-medium text-slate-100">{props.value}</dd>
    </div>
  );
}

/**
 * 展示 Agent step 和 tool_call trace 的工具执行细节。
 *
 * @param props 组件属性。
 * @returns 工具调用面板。
 */
function ToolPanel(props: { steps: AgentRunResponseDto["steps"]; toolEvents: TraceEventDto[] }) {
  const toolSteps = props.steps.filter((step) => step.type === "select_tool" || step.type === "call_tool");

  return (
    <section className="border-b border-slate-800 p-5">
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
        <Wrench className="size-4 text-cyan-300" />
        Tools
      </div>
      {toolSteps.length === 0 && props.toolEvents.length === 0 ? (
        <p className="rounded-lg border border-slate-800 bg-slate-950 p-4 text-sm text-slate-400">暂无工具调用。</p>
      ) : (
        <div className="space-y-3">
          {toolSteps.map((step) => (
            <JsonBlock key={`${step.index}-${step.type}`} title={`${step.index}. ${step.type}`} value={step} />
          ))}
          {props.toolEvents.map((event) => (
            <JsonBlock key={event.id} title={`trace tool_call: ${"toolName" in event ? event.toolName : "unknown"}`} value={event} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * 展示 request trace 时间线和原始事件快照。
 *
 * @param props 组件属性。
 * @returns trace 面板。
 */
function TracePanel(props: { activeRun: AgentRunResponseDto | undefined }) {
  const events = props.activeRun?.trace.events ?? [];

  return (
    <section className="min-h-0 overflow-y-auto p-5">
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
        <Clock3 className="size-4 text-cyan-300" />
        Trace Timeline
      </div>
      {events.length === 0 ? (
        <p className="rounded-lg border border-slate-800 bg-slate-950 p-4 text-sm text-slate-400">提交请求后显示 trace。</p>
      ) : (
        <div className="space-y-3">
          {events.map((event, index) => (
            <article className="rounded-lg border border-slate-800 bg-slate-950 p-4" key={event.id}>
              <div className="mb-2 flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-white">
                    {index + 1}. {formatEventTitle(event)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">{formatTime(event.createdAt)}</p>
                </div>
                <span className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-300">{formatLatency(event)}</span>
              </div>
              <p className="mb-3 text-sm leading-6 text-slate-300">{formatEventSummary(event)}</p>
              <JsonBlock title="event json" value={event} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * 以可读深色块展示 JSON，供调试工具参数、结果和 trace。
 *
 * @param props 组件属性。
 * @returns JSON 展示块。
 */
function JsonBlock(props: { title: string; value: unknown }) {
  return (
    <details className="rounded-lg border border-slate-800 bg-slate-950/80" open>
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-slate-300">
        <Braces className="size-3.5 text-cyan-300" />
        {props.title}
      </summary>
      <pre className="max-h-72 overflow-auto border-t border-slate-800 p-3 text-xs leading-5 text-slate-300">
        {JSON.stringify(props.value, null, 2)}
      </pre>
    </details>
  );
}

/**
 * 将 trace event 类型转换成适合 timeline 展示的标题。
 *
 * @param event trace event。
 * @returns 用户可读标题。
 */
function formatEventTitle(event: TraceEventDto): string {
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
function formatLatency(event: TraceEventDto): string {
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
function formatEventSummary(event: TraceEventDto): string {
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

/**
 * 格式化 ISO 时间；非法时间保持原值，避免 UI 抛错。
 *
 * @param value ISO 时间字符串。
 * @returns 本地时间文案。
 */
function formatTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString();
}

/**
 * 生成浏览器本地消息 id，避免依赖服务端会话。
 *
 * @param prefix id 前缀。
 * @returns UI id。
 */
function createUiId(prefix: string): string {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
