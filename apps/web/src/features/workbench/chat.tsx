import type {
  AgentRunResponseDto,
  ModelOptionDto,
  ToolApprovalDecisionDto,
  ToolApprovalRequestDto
} from "@aiagent/types";
import {
  AlertTriangle,
  FileText,
  Loader2,
  Menu,
  User
} from "lucide-react";
import { type FormEvent } from "react";
import {
  formatEventSummary,
  formatRunStatus,
  formatTime
} from "./format";
import { RunDetails, StatusBadge } from "./run-details";
import { ComposerControls } from "./composer-controls";
import type { DraftAttachment, SelectedRunDetail, UiMessage } from "./types";
import { projectLiveRun } from "./live-run-projection";

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
  onMenuClick: () => void;
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
      <div className={`message-avatar ${message.status === "pending" ? "is-thinking" : ""}`} aria-hidden="true">
        {isUser ? <User className="icon-size" /> : <span className="brand-mark message-brand-mark" />}
      </div>
      <div className="message-content">
        <div className="message-meta">
          <span>{isUser ? "User" : "Assistant"}</span>
          <span>{formatTime(message.createdAt)}</span>
          {message.status === "pending" ? <StatusBadge tone="info">running</StatusBadge> : null}
          {message.status === "failed" ? <StatusBadge tone="danger">failed</StatusBadge> : null}
          {message.status === "cancelled" ? <StatusBadge tone="neutral">cancelled</StatusBadge> : null}
        </div>
        {message.attachments && message.attachments.length > 0 ? (
          <div className="message-attachments">
            {message.attachments.map((attachment) => (
              <span key={"attachmentId" in attachment ? attachment.attachmentId : attachment.clientAttachmentId}>
                <FileText className="icon-size" />{attachment.fileName}
              </span>
            ))}
          </div>
        ) : null}
        {message.run ? (
          <RunDetails
            onOpen={(section) => props.onOpenRunDetail({ run: message.run, section })}
            reportMode={message.run.intent === "report_skill"}
            run={message.run}
          />
        ) : null}
        {message.status === "pending" ? (
          <div className="message-progress run-progress-list">
            <Loader2 className="icon-size spin" />
            <div>
              {projectLiveRun(message.streamEvents ?? []).map((activity) => (
                <button key={activity.category} onClick={() => props.onOpenRunDetail({ event: activity.event })} type="button">
                  <span>{activity.label}</span>
                  <small>{formatEventSummary(activity.event.event)} · {activity.count} · {activity.status}</small>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <p className="message-text">{message.content}</p>
      </div>
    </article>
  );
}

interface ChatComposerProps {
  attachments: DraftAttachment[];
  error: string | undefined;
  input: string;
  isSubmitting: boolean;
  models: ModelOptionDto[];
  modelCatalogStatus: "loading" | "ready" | "failed";
  modelCatalogError?: string;
  onFilesSelected: (files: FileList) => void;
  onInputChange: (value: string) => void;
  onRemoveAttachment: (clientAttachmentId: string) => void;
  onReportModeChange: (checked: boolean) => void;
  onRetryAttachment: (clientAttachmentId: string) => void;
  onRetryModels: () => void;
  onSelectModel: (modelId: string) => void;
  onStop: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUsePrompt: (prompt: string) => void;
  reportMode: boolean;
  selectedModelId: string;
}

/**
 * 渲染底部 composer，集中承载输入、状态、错误和快捷 prompt。
 *
 * @param props 组件属性。
 * @returns 输入区表单。
 */
export function ChatComposer(props: ChatComposerProps) {
  return <ComposerControls {...props} prompts={demoPrompts} />;
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
