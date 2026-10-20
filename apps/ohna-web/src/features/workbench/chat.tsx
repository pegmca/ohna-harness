import type { ModelOptionDto, RunStatusDtoV2 } from "@aiagent/types";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  Copy,
  Loader2,
  Menu,
  RotateCcw,
  User,
  Wrench
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { formatRunStatus, formatTime } from "./format";
import { projectLiveRun } from "./live-run-projection";
import { JsonDetails, RunDetails, StatusBadge } from "./run-details";
import { ComposerControls } from "./composer-controls";
import type { LocalModeInfo } from "../../shared/mode";
import type { SelectedRunDetail, UiContentBlock, UiMessage, UiToolCallBlock } from "./types";

export const demoPrompts = [
  "列出 src 目录结构并说明各模块职责。",
  "读取 README.md 并总结项目目标。",
  "运行 pnpm typecheck，若有错误请修复。",
  "在 utils.ts 中新增一个 formatDate 函数并写注释。"
];

interface ChatHeaderProps {
  conversationTitle: string;
  isSubmitting: boolean;
  latestRunStatus: RunStatusDtoV2 | undefined;
  /** 本地模式信息（W-7：头部展示「本地运行 · 工作目录」）；null 表示健康检查未通过。 */
  localMode: LocalModeInfo | null;
  onMenuClick: () => void;
  /** 主导航插槽（对话 / Trace 切换）；由页面注入，header 只负责排版。 */
  nav?: ReactNode;
}

/**
 * 渲染紧凑顶部栏，展示本地运行标识、当前会话与最近一次 run 状态。
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
          <p className="md-label">ohna · 本地编码 Agent</p>
          <h2 className="chat-title">{props.conversationTitle}</h2>
          {props.localMode ? (
            <p className="local-mode-line" title={props.localMode.workspaceRoot}>
              本地运行 · 工作目录：<code>{props.localMode.workspaceRoot}</code>
            </p>
          ) : null}
        </div>
      </div>

      <div className="header-actions">
        {props.nav}
        <StatusBadge tone={props.isSubmitting ? "info" : props.latestRunStatus === "failed" ? "danger" : "success"}>
          {props.isSubmitting ? "running" : formatRunStatus(props.latestRunStatus)}
        </StatusBadge>
      </div>
    </header>
  );
}

interface ChatTimelineProps {
  conversationId: string | undefined;
  error: string | undefined;
  hasMore: boolean;
  isLoading: boolean;
  isSubmitting: boolean;
  messages: UiMessage[];
  onLoadMore: () => void;
  onOpenRunDetail: (detail: SelectedRunDetail) => void;
  onRetryMessage: (message: UiMessage) => void;
  onUsePrompt: (prompt: string) => void;
  /** 当前会话是 CLI 镜像会话（标题以 `CLI ·` 开头）时，空态提示改用 Trace 观测台（N5）。 */
  showCliHint?: boolean;
}

/**
 * 渲染中央对话时间线；空状态只显示紧凑 starter prompts。
 *
 * @param props 组件属性。
 * @returns 对话消息列表。
 */
export function ChatTimeline(props: ChatTimelineProps) {
  const scrollRef = useRef<HTMLElement>(null);
  // 用户是否贴近底部：滚动条离底小于阈值时视为「钉住底部」，可继续自动跟随。
  const pinnedRef = useRef(true);
  const prevConversationRef = useRef<string | undefined>(undefined);
  // 末条消息签名：仅当末条新增或内容增长时才跟随滚动，避免「加载更多」顶部插入时跳到底部。
  const prevTailSigRef = useRef<string>("");

  /**
   * 用户手动滚动时重算「是否钉住底部」，决定后续是否自动跟随流式输出。
   *
   * @returns void。
   */
  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // 容差 80px：流式增量较小时也能保持跟随，又不会把轻微上滑误判为「在底部」。
    pinnedRef.current = distanceFromBottom < 80;
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 切换会话：直接跳到底部定位最新位置，并恢复强制跟随。
    if (props.conversationId !== prevConversationRef.current) {
      prevConversationRef.current = props.conversationId;
      prevTailSigRef.current = "";
      pinnedRef.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    const lastMessage = props.messages[props.messages.length - 1];
    // 流式期输出来自 liveEvents 而非 content，二者长度任一增长都视为末条推进，需跟随滚动。
    const tailSig = lastMessage
      ? `${lastMessage.id}#${lastMessage.liveEvents?.length ?? 0}#${lastMessage.content.length}`
      : "";
    // 仅顶部「加载更多」导致消息变化时末条签名不变，此时不滚动，保留用户当前位置。
    if (tailSig === prevTailSigRef.current) return;
    prevTailSigRef.current = tailSig;
    // 用户在底部才跟随流式输出，避免回看历史时被强行拽到底部。
    if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [props.messages, props.conversationId]);

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
          <h2>从一个编码任务开始</h2>
          <p>Agent 直接读写当前工作目录；写与执行操作会先弹出待确认卡片。</p>
          {props.showCliHint ? (
            <p className="muted-row">CLI 会话（默认 `ohna`）只镜像 run 事件、不写入对话消息，请到 Trace 观测台查看。</p>
          ) : null}
          <StarterPrompts disabled={props.isSubmitting} onUsePrompt={props.onUsePrompt} />
        </div>
      </section>
    );
  }

  return (
    <section className="chat-timeline" aria-label="消息列表" onScroll={handleScroll} ref={scrollRef}>
      <div className="timeline-inner">
        {props.hasMore ? <button className="secondary-button timeline-load-more" onClick={props.onLoadMore} type="button">加载更多消息</button> : null}
        {props.messages.map((message, index) => (
          message.kind === "compaction"
            ? <CompactionDivider key={message.id} />
            : (
              <ChatMessage
                canRetry={message.role === "assistant" && message.status !== "pending"
                  && props.messages.slice(0, index).some((candidate) => candidate.role === "user")}
                isSubmitting={props.isSubmitting}
                key={message.id}
                message={message}
                onOpenRunDetail={props.onOpenRunDetail}
                onRetryMessage={props.onRetryMessage}
              />
            )
        ))}
      </div>
    </section>
  );
}

/**
 * 渲染单条 user 或 assistant 消息；assistant 消息按 content 块分类型渲染。
 *
 * @param props 组件属性。
 * @returns 消息块。
 */
export function ChatMessage(props: {
  canRetry: boolean;
  isSubmitting: boolean;
  message: UiMessage;
  onOpenRunDetail: (detail: SelectedRunDetail) => void;
  onRetryMessage: (message: UiMessage) => void;
}) {
  const { message } = props;
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const isPending = message.status === "pending";
  const liveProjection = isPending ? projectLiveRun(message.liveEvents ?? []) : undefined;
  const blocks = isPending ? liveProjection?.blocks ?? [] : message.blocks;

  /**
   * 复制当前回答正文，并用短暂状态反馈替代额外 toast。
   *
   * @returns 复制完成 Promise。
   */
  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopyFailed(true);
      window.setTimeout(() => setCopyFailed(false), 1_500);
    }
  }

  return (
    <article className={`chat-message ${isUser ? "is-user" : "is-assistant"}`}>
      <div className={`message-avatar ${isPending ? "is-thinking" : ""}`} aria-hidden="true">
        {isUser ? <User className="icon-size" /> : <span className="brand-mark message-brand-mark" />}
      </div>
      <div className="message-content">
        <div className="message-meta">
          <span>{isUser ? "User" : "Assistant"}</span>
          <span>{formatTime(message.createdAt)}</span>
          {isPending ? <StatusBadge tone="info">running</StatusBadge> : null}
          {message.status === "failed" ? <StatusBadge tone="danger">failed</StatusBadge> : null}
          {message.status === "cancelled" ? <StatusBadge tone="neutral">cancelled</StatusBadge> : null}
        </div>
        {isPending && liveProjection ? <LiveRunProcess label={liveProjection.progressLabel} /> : null}
        {!isUser && !isPending && (blocks.some((block) => block.type !== "text") || message.runId) ? (
          <RunDetails message={message} onOpen={(section) => props.onOpenRunDetail({ message, section })} />
        ) : null}
        <MessageBlocks blocks={blocks} live={isPending} />
        {isUser || (blocks.length === 0 && message.content) ? <p className="message-text">{message.content}</p> : null}
        {message.error ? (
          <div className="error-block"><AlertTriangle className="icon-size" /><span>{message.error.code}: {message.error.message}</span></div>
        ) : null}
        {!isUser && !isPending ? (
          <div className="message-actions" aria-label="回答操作">
            <button
              aria-label={copied ? "已复制" : "复制回答"}
              className="message-action-button"
              onClick={() => void handleCopy()}
              title={copied ? "已复制" : "复制"}
              type="button"
            >
              {copied ? <Check className="icon-size" /> : <Copy className="icon-size" />}
            </button>
            <button
              aria-label="重新生成回答"
              className="message-action-button"
              disabled={props.isSubmitting || !props.canRetry}
              onClick={() => props.onRetryMessage(message)}
              title="重新生成"
              type="button"
            >
              <RotateCcw className="icon-size" />
            </button>
            <span aria-live="polite" className="visually-hidden">
              {copied ? "回答已复制" : copyFailed ? "复制失败，请手动选择回答正文" : ""}
            </span>
          </div>
        ) : null}
      </div>
    </article>
  );
}

/**
 * 按块类型渲染 assistant 内容：text 正文、thinking 折叠块、toolCall 折叠块。
 *
 * @param props 内容块与是否 live。
 * @returns 块列表。
 */
function MessageBlocks(props: { blocks: UiContentBlock[]; live: boolean }) {
  return (
    <>
      {props.blocks.map((block, index) => {
        if (block.type === "text") {
          return <p className="message-text" key={index}>{block.text}</p>;
        }
        if (block.type === "thinking") {
          return <ThinkingBlockView block={block} key={index} />;
        }
        return <ToolCallBlockView block={block} key={block.id || index} live={props.live} />;
      })}
    </>
  );
}

/**
 * thinking 块默认折叠，展开查看思考文本。
 *
 * @param props thinking 块。
 * @returns 折叠思考块。
 */
function ThinkingBlockView(props: { block: Extract<UiContentBlock, { type: "thinking" }> }) {
  return (
    <details className="run-process thinking-block">
      <summary className="run-process-trigger">
        <Brain className="icon-size" />
        <span>思考过程</span>
        <ChevronDown className="details-chevron" />
      </summary>
      <div className="run-process-body">
        <p className="thinking-text">{props.block.redacted ? "（该段思考内容已被安全过滤。）" : props.block.thinking}</p>
      </div>
    </details>
  );
}

/**
 * toolCall 块默认折叠为单行摘要（工具名 + 状态徽标），展开查看参数 JSON 与配对结果。
 *
 * @param props toolCall 块与是否 live。
 * @returns 折叠工具调用块。
 */
function ToolCallBlockView(props: { block: UiToolCallBlock; live: boolean }) {
  const { block } = props;
  const status = block.status ?? (props.live ? "running" : "completed");
  const isError = status === "failed" || block.result?.isError === true;
  return (
    <details className="run-process tool-call-block">
      <summary className="run-process-trigger">
        {status === "running" ? <Loader2 className="icon-size spin" /> : <Wrench className="icon-size" />}
        <span>{block.name}</span>
        <StatusBadge tone={isError ? "danger" : status === "running" ? "info" : "success"}>
          {isError ? "error" : status}
        </StatusBadge>
        <ChevronDown className="details-chevron" />
      </summary>
      <div className="run-process-body">
        <JsonDetails title="调用参数" value={block.arguments} />
        {block.result ? (
          <>
            <ToolResultContent content={block.result.content} />
            {block.result.details !== undefined ? <JsonDetails title="结果详情" value={block.result.details} /> : null}
          </>
        ) : null}
      </div>
    </details>
  );
}

/**
 * 渲染 toolResult 内容：text 块直接展示，其他形状退化为 JSON 折叠。
 *
 * @param props toolResult content。
 * @returns 结果内容。
 */
function ToolResultContent(props: { content: unknown }) {
  const texts = Array.isArray(props.content)
    ? props.content
        .filter((item): item is { type: "text"; text: string } =>
          Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text")
        .map((item) => item.text)
    : [];
  if (texts.length > 0) {
    return (
      <div className="tool-result-content">
        {texts.map((text, index) => <p className="message-text" key={index}>{text}</p>)}
      </div>
    );
  }
  return <JsonDetails title="工具结果" value={props.content} />;
}

/** @returns 「历史已压缩」分隔条。 */
function CompactionDivider() {
  return (
    <div className="compaction-divider" role="separator">
      <span>历史已压缩</span>
    </div>
  );
}

/**
 * 用单行摘要展示 live run 当前活动，不暴露原始事件结构。
 *
 * @param props 当前活动标签。
 * @returns 实时回答过程。
 */
function LiveRunProcess(props: { label: string }) {
  return (
    <div className="run-process live-run-process">
      <span className="run-process-trigger">
        <Loader2 className="icon-size spin" />
        <span>{props.label}</span>
      </span>
    </div>
  );
}

interface ChatComposerProps {
  error: string | undefined;
  input: string;
  isSubmitting: boolean;
  models: ModelOptionDto[];
  modelCatalogStatus: "loading" | "ready" | "failed";
  modelCatalogError?: string;
  onInputChange: (value: string) => void;
  onRetryModels: () => void;
  onSelectModel: (modelId: string) => void;
  onStop: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUsePrompt: (prompt: string) => void;
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
 * 展示示例任务，空状态和 composer 复用同一组真实请求入口。
 *
 * @param props 组件属性。
 * @returns 示例任务按钮组。
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
