/**
 * `llm_call` 的一等公民展示（W4）：摘要行 + 三个 tab（请求参数 / 响应 / 原始 JSON）。
 *
 * v2.0 渲染预算：整块可「进入视口才挂载」（`LlmCallBlock.virtual.tsx` 的包装器），
 * 本文件同时提供轻量的摘要行视图（`LlmCallSummaryRow`），让视口外只渲染一行摘要——
 * 500+ 事件的 live run 不会一次挂载全部 raw JSON。
 *
 * 设计取舍：
 * - 摘要行严格按「#callIndex · model · 耗时 · tokens · cost」排列，便于纵向对比多次调用；
 * - 请求与响应拆 tab，是因为排查时的提问不同（「我发了什么」vs「模型回了什么」）；
 * - 每个 tab 自带复制 JSON，直接粘到 issue / 本地脚本复现，不引入导出机制（计划 §8 开放项）；
 * - **序列化只在展开态发生并 memo**：live 期间 message_update 会逐帧重渲染整棵树，
 *   已展开的 MB 级记录不能每帧重新 stringify（S1）；
 * - 展示侧走统一的 `JsonViewer`（节点级折叠 + 高亮 + 惰性渲染），整段字符串只剩「复制 / 体量」两个用途；
 *   因此不再需要「超过 1MB 就不渲染」的兜底，安全上限交给了 JsonViewer 的节点预算。
 */
import type { LlmCallRecordDto } from "@aiagent/types";
import { AlertTriangle, ChevronDown, Copy, RotateCw } from "lucide-react";
import { type KeyboardEvent, useMemo, useState } from "react";
import { JsonViewer } from "../json-viewer/index.js";

type TabKey = "request" | "response" | "raw";
type RequestTabKey = "payload" | "unified";

const MAIN_TABS = [
  ["request", "请求参数"],
  ["response", "响应"],
  ["raw", "原始 JSON"]
] as const;
const REQUEST_TABS = [
  ["payload", "Provider Payload"],
  ["unified", "统一 messages + tools"]
] as const;

/**
 * 把任意值格式化为可复制的 JSON 文本。
 *
 * @param value 任意 JSON 值。
 * @returns 2 空格缩进的 JSON；不可序列化时回退 String。
 */
export function toJsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * 成本展示：极小值用 `<0.000001` 表达，避免四舍五入成 `$0.000000` 误导为免费（N7）。
 *
 * @param cost 成本（USD）。
 * @returns 展示字符串。
 */
export function formatCost(cost: number): string {
  if (cost > 0 && cost < 0.000001) return "<$0.000001";
  return `$${cost.toFixed(6)}`;
}

/**
 * 摘要行的固定格式（可单测，不依赖 DOM）。
 *
 * @param record 采集记录。
 * @returns 形如 `#1 · model · 120ms · in 10 · out 20 · $0.003000`。
 */
export function formatLlmSummary(record: LlmCallRecordDto): string {
  const usage = record.response?.usage;
  return `#${record.callIndex} · ${record.request.modelId} · ${record.durationMs ?? 0}ms · in ${
    usage?.input ?? 0
  } · out ${usage?.output ?? 0} · ${formatCost(usage?.cost.total ?? 0)}`;
}

/**
 * 复制文本到剪贴板；无 clipboard API（非安全上下文）时静默跳过。
 *
 * @param text 待复制文本。
 */
function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/**
 * 摘要行（不含展开体）——供视口外占位使用。
 *
 * @param props.record 采集记录。
 * @param props.open 是否已展开（只决定箭头朝向）。
 * @param props.onToggle 点击回调；不传时渲染为静态行（占位态，不可交互）。
 * @param props.summaryRef 已废弃、不再挂到 DOM 上（保留形参只为旧调用方零改动）。
 * @returns 摘要行元素。
 */
export function LlmCallSummaryRow(props: {
  record: LlmCallRecordDto;
  open?: boolean;
  onToggle?: () => void;
  summaryRef?: (node: HTMLElement | null) => void;
}) {
  const { record } = props;
  const usage = record.response?.usage;
  const summary = formatLlmSummary(record);
  const inner = (
    <>
      <ChevronDown className={`icon-size details-chevron ${props.open ? "is-open" : ""}`} />
      <span className="trace-llm-index">#{record.callIndex}</span>
      <span className="trace-llm-model">{record.request.modelId}</span>
      <span className="trace-llm-metric">{record.durationMs ?? 0}ms</span>
      <span className="trace-llm-metric">in {usage?.input ?? 0}</span>
      <span className="trace-llm-metric">out {usage?.output ?? 0}</span>
      <span className="trace-llm-metric">{formatCost(usage?.cost.total ?? 0)}</span>
      {record.attemptCount > 1 ? (
        <span className="md-badge md-badge-warning" title="adapter 构造/重放 payload 的次数">
          <RotateCw className="icon-size" />×{record.attemptCount}
        </span>
      ) : null}
      {record.error ? (
        <span className="md-badge md-badge-danger" title={record.error.message}>
          <AlertTriangle className="icon-size" />
          {record.error.stopReason ?? "error"}
        </span>
      ) : null}
    </>
  );
  if (!props.onToggle) {
    return (
      <div aria-label={summary} className="trace-llm-summary" role="group">
        {inner}
      </div>
    );
  }
  return (
    <button
      aria-expanded={props.open === true}
      aria-label={summary}
      className="trace-llm-summary"
      onClick={props.onToggle}
      type="button"
    >
      {inner}
    </button>
  );
}

/**
 * 渲染单条 LLM 调用记录。
 *
 * @param props.record 采集记录（payload 即 LlmCallRecordDto）。
 * @param props.idSuffix 可选的 DOM id 后缀（同 run 内 callId 重复时避免 aria id 冲突）。
 * @returns 可折叠的调用块。
 */
export function LlmCallBlock(props: { record: LlmCallRecordDto; idSuffix?: string }) {
  const { record } = props;
  const [open, setOpen] = useState(false);
  /** 主 tab：请求参数 / 响应 / 原始 JSON（原始 JSON 含 providerPayload 全量，最重）。 */
  const [tab, setTab] = useState<TabKey>("request");
  const [requestTab, setRequestTab] = useState<RequestTabKey>("payload");

  const idBase = `llm-${record.callId}${props.idSuffix ? `-${props.idSuffix}` : ""}`;
  const panelId = `${idBase}-panel`;
  const mainTabsId = `${idBase}-tabs`;
  const subPanelId = `${idBase}-request-panel`;
  const subTabsId = `${idBase}-request-tabs`;

  const unifiedRequest = useMemo(
    () => ({
      provider: record.request.provider,
      api: record.request.api,
      modelId: record.request.modelId,
      baseUrl: record.request.baseUrl,
      systemPrompt: record.request.systemPrompt,
      messages: record.request.messages,
      tools: record.request.tools,
      temperature: record.request.temperature,
      maxTokens: record.request.maxTokens,
      reasoning: record.request.reasoning,
      toolChoice: record.request.toolChoice,
      retries: record.request.retries
    }),
    [record]
  );

  const response = record.response;
  const activeValue = useMemo(() => {
    if (tab === "raw") return record;
    if (tab === "response") return response ?? { error: record.error };
    return requestTab === "payload" ? record.request.providerPayload : unifiedRequest;
  }, [tab, requestTab, record, response, unifiedRequest]);

  // 折叠态保持「零序列化」：只有展开时才付出 stringify 成本（S1）。
  const jsonText = useMemo(() => (open ? toJsonText(activeValue) : ""), [open, activeValue]);

  /**
   * 左右方向键切换主 tab（WAI-ARIA tab 交互，N6）。
   *
   * @param event 键盘事件。
   */
  const onMainTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = MAIN_TABS.findIndex(([key]) => key === tab);
    const next = (index + (event.key === "ArrowRight" ? 1 : -1) + MAIN_TABS.length) % MAIN_TABS.length;
    const nextKey = MAIN_TABS[next][0];
    setTab(nextKey);
    document.getElementById(`${idBase}-tab-${nextKey}`)?.focus();
  };

  /**
   * 左右方向键切换请求子 tab。
   *
   * @param event 键盘事件。
   */
  const onRequestTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = REQUEST_TABS.findIndex(([key]) => key === requestTab);
    const next = (index + (event.key === "ArrowRight" ? 1 : -1) + REQUEST_TABS.length) % REQUEST_TABS.length;
    setRequestTab(REQUEST_TABS[next][0]);
  };

  return (
    <section className={`trace-llm ${record.error ? "has-error" : ""}`} aria-label="LLM 调用">
      <LlmCallSummaryRow open={open} record={record} onToggle={() => setOpen((value) => !value)} />

      {open ? (
        <div className="trace-llm-body">
          <div
            aria-label="LLM 记录视图"
            className="trace-tabs"
            id={mainTabsId}
            onKeyDown={onMainTabsKeyDown}
            role="tablist"
          >
            {MAIN_TABS.map(([key, label]) => (
              <button
                aria-controls={key === "request" ? subPanelId : panelId}
                aria-selected={tab === key}
                className={`trace-tab ${tab === key ? "is-active" : ""}`}
                id={`${idBase}-tab-${key}`}
                key={key}
                onClick={() => setTab(key)}
                role="tab"
                tabIndex={tab === key ? 0 : -1}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "request" ? (
            <div
              aria-label="请求参数视图"
              className="trace-tabs trace-tabs-sub"
              id={subTabsId}
              onKeyDown={onRequestTabsKeyDown}
              role="tablist"
            >
              {REQUEST_TABS.map(([key, label]) => (
                <button
                  aria-controls={subPanelId}
                  aria-selected={requestTab === key}
                  className={`trace-tab ${requestTab === key ? "is-active" : ""}`}
                  id={`${idBase}-request-tab-${key}`}
                  key={key}
                  onClick={() => setRequestTab(key)}
                  role="tab"
                  tabIndex={requestTab === key ? 0 : -1}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}

          <div
            aria-labelledby={tab === "request" ? `${idBase}-request-tab-${requestTab}` : `${idBase}-tab-${tab}`}
            id={tab === "request" ? subPanelId : panelId}
            role="tabpanel"
            tabIndex={0}
          >
            {tab === "response" && response?.message ? (
              <div className="trace-response-meta">
                <span>finishReason: {response.finishReason ?? "—"}</span>
                <span>status: {response.status ?? "—"}</span>
                <span>responseId: {response.responseId ?? "—"}</span>
                <span>responseModel: {response.responseModel ?? "—"}</span>
              </div>
            ) : null}

            <JsonViewer className="trace-json-viewer" value={activeValue} />
          </div>

          <div className="trace-json-actions">
            <span className="trace-json-size">
              {jsonText.length > 0 ? `${(jsonText.length / 1024).toFixed(0)} KB · ${jsonText.length} 字符` : ""}
            </span>
            <button
              className="md-button md-button-secondary md-button-sm"
              onClick={() => copyText(jsonText)}
              type="button"
            >
              <Copy className="icon-size" />复制 JSON
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
