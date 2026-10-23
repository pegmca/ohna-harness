/**
 * Trace 时间线：把投影后的行渲染成「文本 / 工具 / LLM 调用 / 终态」四类块。
 *
 * 为什么不复用 chat 时间线：chat 的时间线以对话消息为主体、运行细节折叠进 assistant 消息；
 * 观测台要的是**按事件顺序平铺**的完整执行轨迹（含每次 LLM 请求），语义不同。
 */
import { AlertTriangle, ChevronDown, Wrench } from "lucide-react";
import { JsonViewer } from "../json-viewer/index.js";
import { LlmCallBlock } from "./LlmCallBlock";
import type { TraceRow } from "./trace-projection";

/**
 * 渲染 Trace 行列表。
 *
 * @param props.rows 投影后的行。
 * @param props.isLoading 是否正在加载（replay 尚未返回首帧）。
 * @returns 时间线。
 */
export function TraceStream(props: { rows: TraceRow[]; isLoading: boolean }) {
  if (props.isLoading && props.rows.length === 0) {
    return <p className="muted-row trace-empty">正在回放事件…</p>;
  }
  if (props.rows.length === 0) {
    return (
      <p className="muted-row trace-empty">
        该 run 暂无事件。CLI 镜像 run 只记录 LLM 请求/响应与 loop 事件，不会写入会话消息。
      </p>
    );
  }
  return (
    <div className="trace-rows">
      {props.rows.map((row) => {
        switch (row.kind) {
          case "llm":
            return <LlmCallBlock key={row.key} record={row.record} idSuffix={row.key} />;
          case "message":
            return (
              <article className={`trace-message is-${row.role}`} key={row.key}>
                <header>
                  <span className="md-label">{row.role === "user" ? "user" : row.role}</span>
                  {row.live ? <span className="trace-live-dot" aria-label="流式接收中" /> : null}
                </header>
                <p>{row.text || "（空消息）"}</p>
              </article>
            );
          case "tool":
            return (
              <details className="trace-tool" key={row.key}>
                <summary>
                  <ChevronDown className="icon-size details-chevron" />
                  <Wrench className="icon-size" />
                  <span className="trace-tool-name">{row.toolName}</span>
                  {row.isError ? <span className="md-badge md-badge-danger">error</span> : null}
                  {row.done ? null : <span className="md-badge md-badge-info">running</span>}
                </summary>
                <div className="trace-tool-body">
                  <div>
                    <p className="md-label">参数</p>
                    <JsonViewer className="trace-json-viewer" value={row.args ?? null} />
                  </div>
                  {row.done ? (
                    <div>
                      <p className="md-label">结果</p>
                      <JsonViewer className="trace-json-viewer" value={row.result ?? null} />
                    </div>
                  ) : null}
                </div>
              </details>
            );
          case "terminal":
            return (
              <div className={`trace-terminal is-${row.status ?? "unknown"}`} key={row.key}>
                {row.status === "failed" ? <AlertTriangle className="icon-size" /> : null}
                <span>run {row.status ?? "unknown"}</span>
                {row.message ? <code>{row.message}</code> : null}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
