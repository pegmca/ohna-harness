import * as Switch from "@radix-ui/react-switch";
import type {
  AgentRunResponseDto,
  ToolApprovalDecisionDto,
  ToolApprovalRequestDto
} from "@aiagent/types";
import {
  AlertTriangle,
  FilePlus2,
  Loader2,
  Menu,
  Send,
  User
} from "lucide-react";
import { type FormEvent } from "react";
import {
  formatEventSummary,
  formatEventTitle,
  formatRunStatus,
  formatTime
} from "./format";
import { RunDetails, StatusBadge } from "./run-details";
import type { SelectedRunDetail, UiMessage } from "./types";

export const demoPrompts = [
  "这家公司最近两年的营收变化如何？",
  "帮我查询 000001.SZ 最近一期净利润和 ROE。",
  "检索一下 000001.SZ 最近年报中关于资产质量的描述。",
  "执行 SQL：SELECT ticker, roe FROM metrics",
  "帮我生成一份 000001.SZ 的公司研究报告 PDF。"
];

interface ChatHeaderProps {
  conversationTitle: string;
  isSubmitting: boolean;
  latestRun: AgentRunResponseDto | undefined;
  onGenerateReport: () => void;
  onMenuClick: () => void;
  onReportModeChange: (checked: boolean) => void;
  reportMode: boolean;
}

/**
 * 渲染紧凑顶部栏，展示当前会话、Report Mode 和最近一次 run 状态。
 *
 * @param props 组件属性。
 * @returns 聊天顶部栏。
 */
export function ChatHeader(props: ChatHeaderProps) {
  return (
    <header className="chat-header">
      <div className="header-title-group">
        <button className="icon-button mobile-only" onClick={props.onMenuClick} type="button" aria-label="打开会话列表">
          <Menu className="icon-size" />
        </button>
        <div className="min-w-0">
          <p className="md-label">Financial Research Agent</p>
          <h2 className="chat-title">{props.conversationTitle}</h2>
        </div>
      </div>

      <div className="header-actions">
        <button aria-label="生成研报" className="secondary-button" disabled={props.isSubmitting} onClick={props.onGenerateReport} type="button">
          <FilePlus2 className="icon-size" />
          <span>生成研报</span>
        </button>
        <div className="report-switch">
          <span>Report Mode</span>
          <Switch.Root
            aria-label="Report Mode"
            checked={props.reportMode}
            className="switch-root"
            onCheckedChange={props.onReportModeChange}
          >
            <Switch.Thumb className="switch-thumb" />
          </Switch.Root>
        </div>
        <StatusBadge tone={props.isSubmitting ? "info" : props.latestRun?.ok === false ? "danger" : "success"}>
          {props.isSubmitting ? "running" : formatRunStatus(props.latestRun)}
        </StatusBadge>
      </div>
    </header>
  );
}

interface ChatTimelineProps {
  approvalStatusById: Record<string, string>;
  error: string | undefined;
  hasMore: boolean;
  isLoading: boolean;
  isSubmitting: boolean;
  messages: UiMessage[];
  onLoadMore: () => void;
  onApprovalDecision: (request: ToolApprovalRequestDto, decision: ToolApprovalDecisionDto["decision"]) => Promise<void>;
  onOpenRunDetail: (detail: SelectedRunDetail) => void;
  onUsePrompt: (prompt: string) => void;
}

/**
 * 渲染中央对话时间线；空状态只显示紧凑 starter prompts。
 *
 * @param props 组件属性。
 * @returns 对话消息列表。
 */
export function ChatTimeline(props: ChatTimelineProps) {
  if (props.isLoading && props.messages.length === 0) {
    return <section className="chat-timeline empty-timeline" aria-label="消息列表"><p className="muted-row">正在加载会话历史…</p></section>;
  }
  if (props.error && props.messages.length === 0) {
    return <section className="chat-timeline empty-timeline" aria-label="消息列表"><div className="error-block"><AlertTriangle className="icon-size" /><span>{props.error}</span></div></section>;
  }
  if (props.messages.length === 0) {
    return (
      <section className="chat-timeline empty-timeline" aria-label="消息列表">
        <div className="empty-state">
          <span className="empty-brand-logo" aria-hidden="true"><span className="brand-mark empty-brand-mark" /></span>
          <h2>从一个金融研究问题开始</h2>
          <p>回答会保留真实 Agent run、工具调用和 trace，可在 assistant 消息内展开查看。</p>
          <StarterPrompts disabled={props.isSubmitting} onUsePrompt={props.onUsePrompt} />
        </div>
      </section>
    );
  }

  return (
    <section className="chat-timeline" aria-label="消息列表">
      <div className="timeline-inner">
        {props.hasMore ? <button className="secondary-button timeline-load-more" onClick={props.onLoadMore} type="button">加载更多消息</button> : null}
        {props.messages.map((message) => (
          <ChatMessage
            approvalStatusById={props.approvalStatusById}
            key={message.id}
            message={message}
            onApprovalDecision={props.onApprovalDecision}
            onOpenRunDetail={props.onOpenRunDetail}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * 渲染单条 user 或 assistant 消息；assistant 消息承载 run details。
 *
 * @param props 组件属性。
 * @returns 消息块。
 */
export function ChatMessage(props: {
  approvalStatusById: Record<string, string>;
  message: UiMessage;
  onApprovalDecision: (request: ToolApprovalRequestDto, decision: ToolApprovalDecisionDto["decision"]) => Promise<void>;
  onOpenRunDetail: (detail: SelectedRunDetail) => void;
}) {
  const { message } = props;
  const isUser = message.role === "user";

  return (
    <article className={`chat-message ${isUser ? "is-user" : "is-assistant"}`}>
      <div className="message-avatar" aria-hidden="true">
        {isUser ? <User className="icon-size" /> : <span className="brand-mark message-brand-mark" />}
      </div>
      <div className="message-content">
        <div className="message-meta">
          <span>{isUser ? "User" : "Assistant"}</span>
          <span>{formatTime(message.createdAt)}</span>
          {message.status === "pending" ? <StatusBadge tone="info">running</StatusBadge> : null}
          {message.status === "failed" ? <StatusBadge tone="danger">failed</StatusBadge> : null}
        </div>
        <p className="message-text">{message.content}</p>
        {message.status === "pending" ? (
          <div className="message-progress run-progress-list">
            <Loader2 className="icon-size spin" />
            <div>
              {(message.streamEvents ?? []).filter((event) => event.type === "trace_event").slice(-4).map((event) => (
                <button key={event.eventId} onClick={() => props.onOpenRunDetail({ event })} type="button">
                  <span>{event.type === "trace_event" ? formatEventTitle(event.event) : event.type}</span>
                  <small>{event.type === "trace_event" ? formatEventSummary(event.event) : ""}</small>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {message.run ? (
          <RunDetails
            onOpen={() => props.onOpenRunDetail({ run: message.run })}
            reportMode={message.run.intent === "report_skill"}
            run={message.run}
          />
        ) : null}
      </div>
    </article>
  );
}

interface ChatComposerProps {
  error: string | undefined;
  input: string;
  isEmpty: boolean;
  isSubmitting: boolean;
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUsePrompt: (prompt: string) => void;
  reportMode: boolean;
}

/**
 * 渲染底部 composer，集中承载输入、状态、错误和快捷 prompt。
 *
 * @param props 组件属性。
 * @returns 输入区表单。
 */
export function ChatComposer(props: ChatComposerProps) {
  return (
    <form className="chat-composer" onSubmit={props.onSubmit}>
      {!props.isEmpty ? <StarterPrompts disabled={props.isSubmitting} onUsePrompt={props.onUsePrompt} compact /> : null}
      {props.error ? (
        <div className="composer-error" role="status">
          <AlertTriangle className="icon-size" />
          <span>{props.error}</span>
        </div>
      ) : null}
      <div className="composer-box">
        <textarea
          className="composer-textarea"
          disabled={props.isSubmitting}
          onChange={(event) => props.onInputChange(event.target.value)}
          placeholder="输入金融研究问题..."
          value={props.input}
        />
        <div className="composer-actions">
          <StatusBadge tone={props.reportMode ? "info" : "neutral"}>
            {props.reportMode ? "report" : "chat"}
          </StatusBadge>
          <button
            className="send-button"
            disabled={props.isSubmitting || !props.input.trim()}
            type="submit"
            aria-label="发送"
          >
            {props.isSubmitting ? <Loader2 className="icon-size spin" /> : <Send className="icon-size" />}
          </button>
        </div>
      </div>
      {props.isSubmitting ? <p className="composer-progress">Agent 正在分析 / routing / calling tool / finalizing</p> : null}
    </form>
  );
}

/**
 * 展示示例问题，空状态和 composer 复用同一组真实请求入口。
 *
 * @param props 组件属性。
 * @returns 示例问题按钮组。
 */
export function StarterPrompts(props: {
  compact?: boolean;
  disabled: boolean;
  onUsePrompt: (prompt: string) => void;
}) {
  return (
    <div className={`starter-prompts ${props.compact ? "is-compact" : ""}`}>
      {demoPrompts.map((prompt) => (
        <button disabled={props.disabled} key={prompt} onClick={() => props.onUsePrompt(prompt)} type="button">
          {prompt}
        </button>
      ))}
    </div>
  );
}
