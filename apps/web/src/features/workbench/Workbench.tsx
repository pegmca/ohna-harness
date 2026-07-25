import * as Switch from "@radix-ui/react-switch";
import type {
  AgentRunResponseDto,
  AgentRunStreamEventDto,
  ApiError,
  ApiResult,
  ConversationDto,
  ConversationMessageDto,
  DataSourceChunksResponseDto,
  DataSourceDocumentDto,
  DataSourceDocumentsResponseDto,
  DataSourceIngestResponseDto,
  ProductArchitectureDto,
  ProductEvalReportDto,
  RagAnswerResponseDto,
  RagChunkDto,
  RagSearchResponseDto,
  ReportArtifactDto,
  ReportWorkflowResponseDto,
  ReportTriggerSourceDto,
  RetrievalResultDto,
  ToolApprovalDecisionDto,
  ToolApprovalRequestDto
} from "@aiagent/types";
import {
  Activity,
  Archive,
  AlertTriangle,
  Bot,
  Braces,
  ChevronDown,
  Clock3,
  Database,
  FilePlus2,
  FileText,
  Loader2,
  Menu,
  Plus,
  Quote,
  Search,
  Send,
  ShieldCheck,
  Network,
  BarChart3,
  User,
  Wrench,
  Settings,
  X
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { SettingsPage } from "../settings";
import { findMarketSeries, MarketCandlestickChart } from "../market-data";
import { createAndStreamRun } from "../../shared/api/run-stream-client";
import {
  createConversation,
  listConversationMessages,
  listConversations,
  updateConversation as updateConversationApi
} from "../../shared/api/conversation-client";

type MessageRole = "user" | "assistant";
type MessageStatus = "complete" | "pending" | "failed";
type WorkspaceView = "chat" | "data-sources" | "workflow" | "citations" | "eval" | "architecture" | "settings";

interface UiMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  status: MessageStatus;
  ok?: boolean;
  run?: AgentRunResponseDto;
  streamEvents?: AgentRunStreamEventDto[];
}

interface SelectedRunDetail {
  run?: AgentRunResponseDto;
  event?: AgentRunStreamEventDto;
}

type TraceEventDto = AgentRunResponseDto["trace"]["events"][number];

const demoPrompts = [
  "这家公司最近两年的营收变化如何？",
  "帮我查询 000001.SZ 最近一期净利润和 ROE。",
  "检索一下 000001.SZ 最近年报中关于资产质量的描述。",
  "执行 SQL：SELECT ticker, roe FROM metrics",
  "帮我生成一份 000001.SZ 的公司研究报告 PDF。"
];
const demoDataSourceContent = `# 资产质量
公司不良率保持稳定，拨备覆盖率维持在安全水平。

# 盈利能力
公司净利润同比增长，ROE 保持在较高水平。

# 现金流
经营性现金流改善，但资本开支增加带来短期压力。`;

/**
 * 渲染 Immersive Agent Chat；持久化历史只来自 Conversation API，live Run 仅作为瞬时派生状态。
 *
 * @returns Week 1 Agent Chat 产品页面。
 */
export function Workbench() {
  const location = useLocation();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [activeConversationId, setActiveConversationId] = useState(
    () => new URLSearchParams(location.search).get("conversation") ?? ""
  );
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [conversationCursor, setConversationCursor] = useState<string>();
  const [messageCursor, setMessageCursor] = useState<string>();
  const [conversationState, setConversationState] = useState<"loading" | "ready" | "error">("loading");
  const [messageState, setMessageState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [conversationError, setConversationError] = useState<string>();
  const [messageError, setMessageError] = useState<string>();
  const [input, setInput] = useState(demoPrompts[1]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [composerError, setComposerError] = useState<string | undefined>();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const workspaceView = getWorkspaceView(location.pathname);
  const [approvalStatusById, setApprovalStatusById] = useState<Record<string, string>>({});
  const [selectedRunDetail, setSelectedRunDetail] = useState<SelectedRunDetail>();
  const [reportMode, setReportMode] = useState(false);
  const retrySubmission = useRef<{ message: string; clientMessageId: string } | undefined>(undefined);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.conversationId === activeConversationId),
    [activeConversationId, conversations]
  );
  const latestRun = [...messages].reverse().find((message) => message.run)?.run;
  const isEmpty = messages.length === 0;

  useEffect(() => {
    const controller = new AbortController();
    void loadConversationPage(undefined, false, controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!activeConversationId) {
      setMessages([]);
      setMessageState("idle");
      return;
    }
    const controller = new AbortController();
    setMessages([]);
    setMessageState("loading");
    setMessageError(undefined);
    void listConversationMessages(activeConversationId, undefined, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setMessageState("error");
        setMessageError(formatApiError(result.error));
        return;
      }
      setMessages(result.data.items.map(toUiMessage));
      setMessageCursor(result.data.nextCursor);
      setMessageState("ready");
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setMessageState("error");
      setMessageError(error instanceof Error ? error.message : "会话消息加载失败。");
    });
    return () => controller.abort();
  }, [activeConversationId]);

  /**
   * 加载会话分页；服务端列表是历史唯一事实源，追加时按 ID 去重。
   *
   * @param cursor 可选游标。
   * @param append 是否追加。
   * @param signal 取消信号。
   * @returns 请求完成 Promise。
   */
  async function loadConversationPage(cursor?: string, append = false, signal?: AbortSignal): Promise<void> {
    setConversationState("loading");
    setConversationError(undefined);
    try {
      const result = await listConversations(cursor, signal);
      if (!result.ok) {
        setConversationState("error");
        setConversationError(formatApiError(result.error));
        return;
      }
      setConversations((current) => append ? mergeConversations(current, result.data.items) : result.data.items);
      setConversationCursor(result.data.nextCursor);
      setConversationState("ready");
      if (!append) {
        const requested = new URLSearchParams(location.search).get("conversation");
        const selected = result.data.items.find((item) => item.conversationId === requested)
          ?? result.data.items[0];
        if (selected) selectConversation(selected.conversationId, true);
        else setActiveConversationId("");
      }
    } catch (error) {
      if (signal?.aborted) return;
      setConversationState("error");
      setConversationError(error instanceof Error ? error.message : "会话列表加载失败。");
    }
  }

  /**
   * 处理表单提交，保持提交入口只在顶层触发 API。
   *
   * @param event 表单提交事件。
   * @returns 请求完成 Promise。
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await submitMessage(input);
  }

  /**
   * 创建新的浏览器本地会话，并切换到该会话。
   *
   * @returns void。
   */
  async function handleNewConversation(): Promise<void> {
    const result = await createConversation({ title: "新会话" });
    if (!result.ok) {
      setConversationError(formatApiError(result.error));
      setConversationState("error");
      return;
    }
    setConversations((current) => [result.data, ...current]);
    selectConversation(result.data.conversationId);
    setInput("");
    setComposerError(undefined);
    setIsSidebarOpen(false);
  }

  /**
   * 切换当前浏览器本地会话，同时关闭移动端 drawer。
   *
   * @param conversationId 会话 id。
   * @returns void。
   */
  function handleSelectConversation(conversationId: string): void {
    selectConversation(conversationId);
    setComposerError(undefined);
    setIsSidebarOpen(false);
  }

  /** @param conversationId 会话 ID。 @param replace 是否替换历史记录。 @returns void。 */
  function selectConversation(conversationId: string, replace = false): void {
    setActiveConversationId(conversationId);
    const target = `/?conversation=${encodeURIComponent(conversationId)}`;
    navigate(target, { replace });
  }

  /** @param conversationId 会话 ID。 @returns 归档请求完成 Promise。 */
  async function handleArchiveConversation(conversationId: string): Promise<void> {
    const result = await updateConversationApi(conversationId, { archive: true });
    if (!result.ok) {
      setConversationError(formatApiError(result.error));
      return;
    }
    const remaining = conversations.filter((item) => item.conversationId !== conversationId);
    setConversations(remaining);
    if (activeConversationId === conversationId) {
      const next = remaining[0];
      setMessages([]);
      if (next) selectConversation(next.conversationId, true);
      else {
        setActiveConversationId("");
        navigate("/", { replace: true });
      }
    }
  }

  /**
   * 更新当前会话的 Report Mode；该状态会随下一次请求提交给 API。
   *
   * @param checked Report Mode 是否启用。
   * @returns void。
   */
  function handleReportModeChange(checked: boolean): void {
    setReportMode(checked);
  }

  /**
   * 发送用户输入并把 run 结果挂到对应 assistant 消息，避免使用全局右侧调试状态。
   *
   * @param message 用户输入。
   * @returns 请求完成 Promise。
   */
  async function submitMessage(message: string): Promise<void> {
    await submitAgentMessage(message);
  }

  /**
   * 从按钮显式触发 Report Skill，和自然语言、Report Mode 开关复用同一个 API activation 边界。
   *
   * @returns 请求完成 Promise。
   */
  async function handleGenerateReport(): Promise<void> {
    const message = input.trim() || "帮我生成一份公司研究报告 PDF。";
    await submitAgentMessage(message, "button");
  }

  /**
   * 发送用户输入并把 run 结果挂到对应 assistant 消息，避免使用全局右侧调试状态。
   *
   * @param message 用户输入。
   * @param triggerSource 可选 Report Skill 显式触发来源。
   * @returns 请求完成 Promise。
   */
  async function submitAgentMessage(message: string, triggerSource?: ReportTriggerSourceDto): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed || isSubmitting) {
      return;
    }
    let conversation = activeConversation;
    if (!conversation) {
      const created = await createConversation({ title: createConversationTitle(trimmed) });
      if (!created.ok) {
        setComposerError(formatApiError(created.error));
        return;
      }
      conversation = created.data;
      setConversations((current) => [created.data, ...current]);
      selectConversation(created.data.conversationId);
    }

    const submittedConversationId = conversation.conversationId;
    const submittedReportMode = reportMode;
    const pendingMessageId = createUiId("assistant");
    const clientMessageId = retrySubmission.current?.message === trimmed
      ? retrySubmission.current.clientMessageId
      : crypto.randomUUID();
    retrySubmission.current = { message: trimmed, clientMessageId };
    const now = new Date().toISOString();
    const userMessage: UiMessage = {
      id: clientMessageId,
      role: "user",
      content: trimmed,
      createdAt: now,
      status: "complete"
    };
    const pendingMessage: UiMessage = {
      id: pendingMessageId,
      role: "assistant",
      content: "Agent 正在分析问题、路由意图并准备回答。",
      createdAt: now,
      status: "pending",
      streamEvents: []
    };

    setMessages((current) => [...current, userMessage, pendingMessage]);
    if (conversation.title === "新会话") {
      const title = createConversationTitle(trimmed);
      void updateConversationApi(submittedConversationId, { title }).then((result) => {
        if (result.ok) setConversations((current) =>
          current.map((item) => item.conversationId === submittedConversationId ? result.data : item));
      });
    }
    setInput("");
    setComposerError(undefined);
    setIsSubmitting(true);

    try {
      const result = await runAgent(
        trimmed,
        submittedReportMode || triggerSource === "button",
        submittedConversationId,
        clientMessageId,
        triggerSource,
        (event) => {
          replaceMessage(submittedConversationId, pendingMessageId, {
            content: formatRunProgress(event)
          });
          setMessages((current) => current.map((item) => item.id === pendingMessageId
            ? { ...item, streamEvents: [...(item.streamEvents ?? []), event] }
            : item));
        }
      );

      if (!result.ok) {
        const messageText = formatApiError(result.error);
        replaceMessage(submittedConversationId, pendingMessageId, {
          content: messageText,
          status: "failed",
          ok: false
        });
        setComposerError("请求失败，已把结构化错误写入当前 assistant 消息。");
        return;
      }

      const run = result.data;
      retrySubmission.current = undefined;
      replaceMessage(submittedConversationId, pendingMessageId, {
        content: run.answer,
        status: run.ok ? "complete" : "failed",
        ok: run.ok,
        run,
        streamEvents: undefined
      });

      if (!run.ok && run.error) {
        setComposerError(formatApiError(run.error));
      }
    } catch (caught) {
      const messageText = caught instanceof Error ? caught.message : "请求失败，请检查 API 服务是否已启动。";
      replaceMessage(submittedConversationId, pendingMessageId, {
        content: messageText,
        status: "failed",
        ok: false
      });
      setComposerError("请求失败，请确认 apps/api 和 apps/web 已通过 pnpm dev 启动。");
    } finally {
      setIsSubmitting(false);
    }
  }

  /**
   * 替换 pending assistant 消息，保证每次 run 的派生数据保留在消息内。
   *
   * @param conversationId 会话 id。
   * @param messageId 消息 id。
   * @param patch 消息补丁。
   * @returns void。
   */
  function replaceMessage(conversationId: string, messageId: string, patch: Partial<UiMessage>): void {
    if (conversationId !== activeConversationId) return;
    setMessages((current) => current.map((messageItem) =>
      messageItem.id === messageId ? { ...messageItem, ...patch } : messageItem
    ));
  }

  /**
   * 提交人工审批决定；UI 只转交 decision，不在浏览器内重复实现权限判断。
   *
   * @param approvalId 审批请求 id。
   * @param decision approve/reject 决策。
   * @returns 请求完成 Promise。
   */
  async function handleApprovalDecision(
    approvalRequest: ToolApprovalRequestDto,
    decision: ToolApprovalDecisionDto["decision"]
  ): Promise<void> {
    const approvalId = approvalRequest.approvalId;
    const runId = latestRun?.runId;
    if (!runId) {
      setComposerError("当前审批没有关联可操作的 Run。");
      return;
    }
    setApprovalStatusById((current) => ({
      ...current,
      [approvalId]: "submitting"
    }));

    const result = await submitApprovalDecision(runId, {
      approvalId,
      decision,
      requestId: approvalRequest.requestId,
      inputDigest: approvalRequest.inputDigest,
      reviewerNote: decision === "approved" ? "Approved from Immersive UI." : "Rejected from Immersive UI."
    });

    setApprovalStatusById((current) => ({
      ...current,
      [approvalId]: result.ok ? result.data.decision : "failed"
    }));

    if (!result.ok) {
      setComposerError(formatApiError(result.error));
    }
  }

  return (
    <main className={`agent-app-shell ${selectedRunDetail ? "has-detail-panel" : ""}`}>
      <ConversationSidebar
        activeConversationId={activeConversation?.conversationId}
        error={conversationError}
        hasMore={Boolean(conversationCursor)}
        isLoading={conversationState === "loading"}
        conversations={conversations}
        isOpen={isSidebarOpen}
        onArchiveConversation={(conversationId) => void handleArchiveConversation(conversationId)}
        onClose={() => setIsSidebarOpen(false)}
        onLoadMore={() => void loadConversationPage(conversationCursor, true)}
        onNewConversation={() => void handleNewConversation()}
        onRetry={() => void loadConversationPage()}
        onSelectConversation={handleSelectConversation}
        onSelectView={(view) => {
          navigate(getWorkspacePath(view));
          setIsSidebarOpen(false);
        }}
        workspaceView={workspaceView}
      />

      {workspaceView === "chat" ? (
        <section className="chat-main" aria-label="Agent Chat 主区域">
          <ChatHeader
            conversationTitle={activeConversation?.title ?? "新会话"}
            isSubmitting={isSubmitting}
            latestRun={latestRun}
            onGenerateReport={handleGenerateReport}
            onMenuClick={() => setIsSidebarOpen(true)}
            onReportModeChange={handleReportModeChange}
            reportMode={reportMode}
          />

          <ChatTimeline
            approvalStatusById={approvalStatusById}
            isSubmitting={isSubmitting}
            error={messageError}
            hasMore={Boolean(messageCursor)}
            isLoading={messageState === "loading"}
            messages={messages}
            onLoadMore={() => {
              if (!activeConversationId) return;
              void listConversationMessages(activeConversationId, messageCursor).then((result) => {
                if (!result.ok) {
                  setMessageError(formatApiError(result.error));
                  return;
                }
                setMessages((current) => mergeMessages(current, result.data.items.map(toUiMessage)));
                setMessageCursor(result.data.nextCursor);
              });
            }}
            onApprovalDecision={handleApprovalDecision}
            onOpenRunDetail={setSelectedRunDetail}
            onUsePrompt={setInput}
          />

          <ChatComposer
            error={composerError}
            input={input}
            isEmpty={isEmpty}
            isSubmitting={isSubmitting}
            onInputChange={setInput}
            onSubmit={handleSubmit}
            onUsePrompt={setInput}
            reportMode={reportMode}
          />
        </section>
      ) : workspaceView === "data-sources" ? (
        <DataSourcesWorkspace onMenuClick={() => setIsSidebarOpen(true)} />
      ) : workspaceView === "settings" ? (
        <SettingsPage onMenuClick={() => setIsSidebarOpen(true)} />
      ) : (
        <ProductWorkspace latestRun={latestRun} onMenuClick={() => setIsSidebarOpen(true)} view={workspaceView} />
      )}
      <RunDetailPanel
        approvalStatusById={approvalStatusById}
        detail={selectedRunDetail}
        onApprovalDecision={handleApprovalDecision}
        onClose={() => setSelectedRunDetail(undefined)}
      />
    </main>
  );
}

interface ConversationSidebarProps {
  activeConversationId: string | undefined;
  conversations: ConversationDto[];
  error: string | undefined;
  hasMore: boolean;
  isLoading: boolean;
  isOpen: boolean;
  onArchiveConversation: (conversationId: string) => void;
  onClose: () => void;
  onLoadMore: () => void;
  onNewConversation: () => void;
  onRetry: () => void;
  onSelectConversation: (conversationId: string) => void;
  onSelectView: (view: WorkspaceView) => void;
  workspaceView: WorkspaceView;
}

/**
 * 展示服务端会话列表；移动端作为 drawer，桌面端作为固定左栏。
 *
 * @param props 组件属性。
 * @returns 会话侧栏。
 */
function ConversationSidebar(props: ConversationSidebarProps) {
  return (
    <>
      <button
        aria-label="关闭会话列表"
        className={`sidebar-backdrop ${props.isOpen ? "is-visible" : ""}`}
        onClick={props.onClose}
        type="button"
      />
      <aside className={`conversation-sidebar ${props.isOpen ? "is-open" : ""}`} aria-label="会话列表">
        <div className="sidebar-header">
          <h1 className="sidebar-title"><span className="brand-mark sidebar-brand-mark" aria-hidden="true" /><span>Immersive</span></h1>
          <button className="icon-button mobile-only" onClick={props.onClose} type="button" aria-label="关闭">
            <X className="icon-size" />
          </button>
        </div>

        <button className="new-chat-button" onClick={props.onNewConversation} type="button">
          <Plus className="icon-size" />
          <span>New Chat</span>
        </button>

        <nav className="workspace-nav" aria-label="工作区导航">
          <button
            className={props.workspaceView === "chat" ? "is-active" : ""}
            onClick={() => props.onSelectView("chat")}
            type="button"
          >
            <Bot className="icon-size" />
            <span>Immersive</span>
          </button>
          <button
            className={props.workspaceView === "data-sources" ? "is-active" : ""}
            onClick={() => props.onSelectView("data-sources")}
            type="button"
          >
            <Database className="icon-size" />
            <span>Data Sources</span>
          </button>
          <button className={props.workspaceView === "workflow" ? "is-active" : ""} onClick={() => props.onSelectView("workflow")} type="button">
            <Activity className="icon-size" /><span>Report Workflow</span>
          </button>
          <button className={props.workspaceView === "citations" ? "is-active" : ""} onClick={() => props.onSelectView("citations")} type="button">
            <ShieldCheck className="icon-size" /><span>Citation Checker</span>
          </button>
          <button className={props.workspaceView === "eval" ? "is-active" : ""} onClick={() => props.onSelectView("eval")} type="button">
            <BarChart3 className="icon-size" /><span>Eval Report</span>
          </button>
          <button className={props.workspaceView === "architecture" ? "is-active" : ""} onClick={() => props.onSelectView("architecture")} type="button">
            <Network className="icon-size" /><span>Architecture</span>
          </button>
        </nav>

        <div className="conversation-list">
          {props.isLoading && props.conversations.length === 0 ? <p className="muted-row">正在加载会话…</p> : null}
          {props.error ? (
            <div className="conversation-list-error">
              <span>{props.error}</span>
              <button className="secondary-button" onClick={props.onRetry} type="button">重试</button>
            </div>
          ) : null}
          {!props.isLoading && !props.error && props.conversations.length === 0
            ? <p className="muted-row">暂无历史会话，创建一个开始研究。</p>
            : null}
          {props.conversations.map((conversation) => (
            <div
              className={`conversation-item ${
                conversation.conversationId === props.activeConversationId ? "is-active" : ""
              }`}
              key={conversation.conversationId}
            >
              <button className="conversation-select" onClick={() => props.onSelectConversation(conversation.conversationId)} type="button">
                <span className="conversation-title">{conversation.title}</span>
                <span className="conversation-preview">最近更新 {formatRelativeTime(conversation.lastMessageAt)}</span>
              </button>
              <button
                aria-label={`归档 ${conversation.title}`}
                className="conversation-archive"
                onClick={() => props.onArchiveConversation(conversation.conversationId)}
                type="button"
              ><Archive className="icon-size" /></button>
            </div>
          ))}
          {props.hasMore ? (
            <button className="secondary-button conversation-load-more" disabled={props.isLoading} onClick={props.onLoadMore} type="button">
              {props.isLoading ? "加载中…" : "加载更多"}
            </button>
          ) : null}
        </div>

        <footer className="sidebar-footer">
          <button className={props.workspaceView === "settings" ? "is-active" : ""} onClick={() => props.onSelectView("settings")} type="button">
            <Settings className="icon-size" /><span>Settings</span>
          </button>
          <span>{props.conversations.length} chats</span>
        </footer>
      </aside>
    </>
  );
}

/** 展示 Workflow、Citation、Eval 与 Architecture 产品视图；所有内容均来自 API DTO 或当前 Agent run。 */
function ProductWorkspace(props: { latestRun?: AgentRunResponseDto; onMenuClick: () => void; view: Exclude<WorkspaceView, "chat" | "data-sources" | "settings"> }) {
  const [evalReport, setEvalReport] = useState<ProductEvalReportDto>();
  const [architecture, setArchitecture] = useState<ProductArchitectureDto>();
  const [error, setError] = useState<string>();
  const workflow = props.latestRun?.reportWorkflow;
  const artifact = workflow?.artifact;

  useEffect(() => {
    let active = true;
    if (props.view === "eval") void fetchProductEval().then((result) => active && (result.ok ? setEvalReport(result.data) : setError(formatApiError(result.error))));
    if (props.view === "architecture") void fetchProductArchitecture().then((result) => active && (result.ok ? setArchitecture(result.data) : setError(formatApiError(result.error))));
    return () => { active = false; };
  }, [props.view]);

  const title = props.view === "workflow" ? "Report Workflow" : props.view === "citations" ? "Citation Checker" : props.view === "eval" ? "Eval Report" : "Architecture";
  return (
    <section className="data-sources-main product-main" aria-label={title}>
      <header className="data-header"><div className="header-title-group">
        <button className="icon-button mobile-only" onClick={props.onMenuClick} type="button" aria-label="打开导航"><Menu className="icon-size" /></button>
        <div><p className="md-label">Immersive Product</p><h2 className="chat-title">{title}</h2></div>
      </div>{props.view === "eval" && evalReport ? <StatusBadge tone="info">DEMO DATA · {evalReport.datasetVersion}</StatusBadge> : null}</header>
      <div className="product-content">
        {error ? <ErrorBlock error={{ code: "internal_error", message: error }} /> : null}
        {props.view === "workflow" ? workflow ? <ReportWorkflowPanel workflow={workflow} /> : <ProductEmpty text="先在 Immersive 中开启 Report Mode 或用自然语言生成报告；这里将展示同一次真实 run 的节点输入、输出、耗时和错误。" /> : null}
        {props.view === "citations" ? artifact ? <CitationChecker artifact={artifact} /> : <ProductEmpty text="当前没有报告引用。完成一次 Report Workflow 后，可从关键结论回溯 document、chunk 和 source。" /> : null}
        {props.view === "eval" ? evalReport ? <EvalReportView report={evalReport} /> : <LoadingBlock /> : null}
        {props.view === "architecture" ? architecture ? <ArchitectureView value={architecture} /> : <LoadingBlock /> : null}
      </div>
    </section>
  );
}

/** @param props 空状态说明。 @returns 可解释空状态。 */
function ProductEmpty(props: { text: string }) { return <div className="product-empty"><FileText /><h3>暂无当前运行数据</h3><p>{props.text}</p></div>; }
/** @returns 产品视图加载状态。 */
function LoadingBlock() { return <div className="product-empty"><Loader2 className="spin" /><p>正在读取 API DTO…</p></div>; }

/** 关键结论—来源映射；missing claims 独立使用警示状态。 */
function CitationChecker(props: { artifact: ReportArtifactDto }) {
  return <div className="product-stack"><section className="data-panel"><div className="panel-heading"><h3><ShieldCheck className="icon-size" />Coverage</h3><StatusBadge tone={props.artifact.citationVerification.verified ? "success" : "danger"}>{props.artifact.citationVerification.decision}</StatusBadge></div>
    <p className="muted-row">{props.artifact.citations.length} 条已映射引用 · {props.artifact.citationVerification.missingClaims.length} 条未覆盖结论</p></section>
    {props.artifact.citations.map((citation, index) => <article className="data-panel citation-map" key={citation.id}><strong>[{index + 1}] {citation.supportsFinding}</strong><span>{citation.quote}</span><small>source {citation.source}</small><small>document {citation.documentId ?? "unknown"} · chunk {citation.chunkId ?? citation.chunkIndex ?? "unknown"}</small></article>)}
    {props.artifact.citationVerification.missingClaims.map((claim) => <article className="data-panel uncovered" key={claim}><AlertTriangle className="icon-size" /><strong>未覆盖结论</strong><span>{claim}</span></article>)}</div>;
}

/** 展示版本化 eval 当前值、baseline 和至少三个失败案例。 */
function EvalReportView(props: { report: ProductEvalReportDto }) {
  const primary = ["citationCoverage", "financialAccuracy", "sourceGroundedness", "successRate"];
  return <div className="product-stack"><div className="metric-grid">{primary.map((key) => <article className="metric-card" key={key}><span>{key}</span><strong>{formatMetric(props.report.metrics[key])}</strong><small>baseline {formatMetric(props.report.baseline[key])}</small></article>)}</div>
    <section className="data-panel"><div className="panel-heading"><h3>Failure cases</h3><StatusBadge tone="danger">{props.report.failures.length}</StatusBadge></div><div className="data-list">{props.report.failures.map((failure) => <article className="data-row" key={failure.caseId}><strong>{failure.caseId} · {failure.query}</strong><span>{failure.rootCause}</span><small>{failure.improvement}</small><small>{failure.requestId} / {failure.traceId}</small></article>)}</div></section></div>;
}

/** 使用节点与边列表展示真实包责任和依赖方向，移动端无需横向图布。 */
function ArchitectureView(props: { value: ProductArchitectureDto }) {
  return <div className="architecture-grid"><section className="data-panel"><div className="panel-heading"><h3>Package boundaries</h3></div>{props.value.nodes.map((node) => <article className="architecture-node" key={node.id}><strong>{node.label}</strong><span>{node.responsibility}</span></article>)}</section>
    <section className="data-panel"><div className="panel-heading"><h3>Dependency flow</h3></div>{props.value.edges.map((edge, index) => <article className="architecture-edge" key={`${edge.from}-${edge.to}-${index}`}><code>{edge.from}</code><span>→ {edge.label} →</span><code>{edge.to}</code></article>)}</section></div>;
}

/** @param value 指标值。 @returns 评分显示；延迟保留毫秒。 */
function formatMetric(value: number | undefined): string { return value === undefined ? "—" : value <= 1 ? `${(value * 100).toFixed(1)}%` : `${value.toFixed(1)} ms`; }

/**
 * Data Sources 页面通过 HTTP API 演示 ingestion、chunk、retrieval 和 citation answer 数据流。
 *
 * @param props 组件属性。
 * @returns Data Sources 产品功能页。
 */
function DataSourcesWorkspace(props: { onMenuClick: () => void }) {
  const [source, setSource] = useState("demo");
  const [fileName, setFileName] = useState("annual-report.md");
  const [content, setContent] = useState(demoDataSourceContent);
  const [query, setQuery] = useState("资产质量");
  const [question, setQuestion] = useState("公司资产质量如何？");
  const [documents, setDocuments] = useState<DataSourceDocumentDto[]>([]);
  const [chunks, setChunks] = useState<RagChunkDto[]>([]);
  const [searchResults, setSearchResults] = useState<RetrievalResultDto[]>([]);
  const [answer, setAnswer] = useState<RagAnswerResponseDto | undefined>();
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState<string | undefined>();

  /**
   * 刷新 documents 和 chunks，保证页面展示服务端内存 runtime 当前状态。
   *
   * @returns 请求完成 Promise。
   */
  async function refreshDataSources(): Promise<void> {
    const [documentsResult, chunksResult] = await Promise.all([fetchDataSourceDocuments(), fetchDataSourceChunks()]);

    if (!documentsResult.ok) {
      setError(formatApiError(documentsResult.error));
      return;
    }

    if (!chunksResult.ok) {
      setError(formatApiError(chunksResult.error));
      return;
    }

    setDocuments(documentsResult.data.documents);
    setChunks(chunksResult.data.chunks);
  }

  /**
   * 提交 Markdown/TXT 文档到 ingestion API，并刷新列表。
   *
   * @returns 请求完成 Promise。
   */
  async function handleIngest(): Promise<void> {
    setStatus("ingesting");
    setError(undefined);

    const result = await ingestDataSource({
      source,
      fileName,
      contentType: fileName.endsWith(".txt") ? "text/plain" : "text/markdown",
      content
    });

    if (!result.ok) {
      setError(formatApiError(result.error));
      setStatus("failed");
      return;
    }

    // ingest 成功后重新拉取分页列表，文档行展示服务端持久化的版本与状态。
    await refreshDataSources();
    setStatus(`indexed ${result.data.indexedChunkCount} chunks`);
  }

  /**
   * 调用 RAG search API 并展示检索结果。
   *
   * @returns 请求完成 Promise。
   */
  async function handleSearch(): Promise<void> {
    setStatus("searching");
    setError(undefined);

    const result = await searchRag(query);

    if (!result.ok) {
      setError(formatApiError(result.error));
      setStatus("failed");
      return;
    }

    setSearchResults(result.data.results);
    setStatus(`${result.data.results.length} results`);
  }

  /**
   * 调用 RAG answer API，展示 answer 和 citations。
   *
   * @returns 请求完成 Promise。
   */
  async function handleAnswer(): Promise<void> {
    setStatus("answering");
    setError(undefined);

    const result = await answerRag(question);

    if (!result.ok) {
      setError(formatApiError(result.error));
      setStatus("failed");
      return;
    }

    setAnswer(result.data);
    setStatus(`${result.data.answer.citations.length} citations`);
  }

  return (
    <section className="data-sources-main" aria-label="Data Sources">
      <header className="data-header">
        <div className="header-title-group">
          <button className="icon-button mobile-only" onClick={props.onMenuClick} type="button" aria-label="打开会话列表">
            <Menu className="icon-size" />
          </button>
          <div className="min-w-0">
            <p className="md-label">RAG Knowledge Base</p>
            <h2 className="chat-title">Data Sources</h2>
          </div>
        </div>
        <div className="header-actions">
          <button className="secondary-button" onClick={refreshDataSources} type="button">
            <Database className="icon-size" />
            <span>Refresh</span>
          </button>
          <StatusBadge tone={status === "failed" ? "danger" : status === "idle" ? "neutral" : "info"}>{status}</StatusBadge>
        </div>
      </header>

      <div className="data-sources-grid">
        <section className="data-panel ingest-panel">
          <div className="panel-heading">
            <h3>
              <FileText className="icon-size" />
              Ingest
            </h3>
            <button className="secondary-button" onClick={handleIngest} type="button">
              <Plus className="icon-size" />
              <span>Index</span>
            </button>
          </div>
          <div className="field-grid">
            <label>
              <span>Source</span>
              <input value={source} onChange={(event) => setSource(event.target.value)} />
            </label>
            <label>
              <span>File</span>
              <input value={fileName} onChange={(event) => setFileName(event.target.value)} />
            </label>
          </div>
          <textarea className="data-textarea" value={content} onChange={(event) => setContent(event.target.value)} />
          {error ? <ErrorBlock error={{ code: "internal_error", message: error }} /> : null}
        </section>

        <section className="data-panel retrieval-panel">
          <div className="panel-heading">
            <h3>
              <Database className="icon-size" />
              Documents
            </h3>
            <StatusBadge tone="neutral">{documents.length}</StatusBadge>
          </div>
          <div className="data-list">
            {documents.length === 0 ? <p className="muted-row">暂无文档。先 ingest Markdown/TXT。</p> : null}
            {documents.map((document) => (
              <article className="data-row" key={document.documentId}>
                <strong>{document.title}</strong>
                <span>v{document.latestVersion} · {document.latestStatus} · {document.scope}</span>
                <small>{document.sourceUri}</small>
              </article>
            ))}
          </div>
        </section>

        <section className="data-panel chunks-panel">
          <div className="panel-heading">
            <h3>
              <Braces className="icon-size" />
              Chunks
            </h3>
            <StatusBadge tone="neutral">{chunks.length}</StatusBadge>
          </div>
          <div className="data-list">
            {chunks.length === 0 ? <p className="muted-row">暂无 chunks。</p> : null}
            {chunks.map((chunk) => (
              <article className="data-row" key={chunk.chunkId}>
                <strong>{chunk.heading ?? "未命名章节"}</strong>
                <span>{chunk.text}</span>
                <small>
                  {chunk.documentId} / chunk {chunk.chunkIndex}
                </small>
              </article>
            ))}
          </div>
        </section>

        <section className="data-panel">
          <div className="panel-heading">
            <h3>
              <Search className="icon-size" />
              Retrieval
            </h3>
            <button className="secondary-button" onClick={handleSearch} type="button">
              <Search className="icon-size" />
              <span>Search</span>
            </button>
          </div>
          <input className="data-input" value={query} onChange={(event) => setQuery(event.target.value)} />
          <RetrievalResults results={searchResults} />
        </section>

        <section className="data-panel answer-panel">
          <div className="panel-heading">
            <h3>
              <Quote className="icon-size" />
              Citation Answer
            </h3>
            <button className="secondary-button" onClick={handleAnswer} type="button">
              <Send className="icon-size" />
              <span>Answer</span>
            </button>
          </div>
          <input className="data-input" value={question} onChange={(event) => setQuestion(event.target.value)} />
          {answer ? (
            <div className="answer-output">
              <p>{answer.answer.answer}</p>
              <CitationList citations={answer.answer.citations} />
              <RetrievalResults results={answer.answer.retrievalResults} compact />
            </div>
          ) : (
            <p className="muted-row">暂无 answer。可以先提问一个资料中不存在的问题验证 unknown policy。</p>
          )}
        </section>
      </div>
    </section>
  );
}

/**
 * 展示 retrieval result 列表，默认包含 score 和 citation 元数据。
 *
 * @param props 组件属性。
 * @returns retrieval results。
 */
function RetrievalResults(props: { compact?: boolean; results: RetrievalResultDto[] }) {
  return (
    <div className={`retrieval-results ${props.compact ? "is-compact" : ""}`}>
      {props.results.length === 0 ? <p className="muted-row">暂无检索结果。</p> : null}
      {props.results.map((result) => (
        <article className="data-row" key={`${result.chunkId}-${result.rank ?? 0}`}>
          <strong>
            #{result.rank ?? "-"} score {result.score.toFixed(3)}
          </strong>
          <span>{result.text}</span>
          <small>
            {result.citation.source} / {result.citation.heading ?? "no heading"} / chunk{" "}
            {result.citation.chunkIndex}
          </small>
        </article>
      ))}
    </div>
  );
}

/**
 * 展示 answer citations，强调每条引用可以追溯到 source、heading 和 chunkIndex。
 *
 * @param props 组件属性。
 * @returns citation 列表。
 */
function CitationList(props: { citations: RagAnswerResponseDto["answer"]["citations"] }) {
  return (
    <div className="citation-list">
      {props.citations.length === 0 ? <p className="muted-row">当前 answer 没有可用 citation。</p> : null}
      {props.citations.map((citation, index) => (
        <article className="citation-row" key={`${citation.chunkId}-${index}`}>
          <strong>[{index + 1}]</strong>
          <div>
            <span>{citation.quote}</span>
            <small>
              {citation.source} / {citation.heading ?? "no heading"} / chunk {citation.chunkIndex}
            </small>
          </div>
        </article>
      ))}
    </div>
  );
}


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
function ChatHeader(props: ChatHeaderProps) {
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
function ChatTimeline(props: ChatTimelineProps) {
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
function ChatMessage(props: {
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
function ChatComposer(props: ChatComposerProps) {
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
function StarterPrompts(props: {
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

/**
 * 渲染 assistant 消息内的 run 派生详情，默认折叠减少调试信息干扰。
 *
 * @param props 组件属性。
 * @returns run 详情折叠区。
 */
function RunDetails(props: {
  onOpen: () => void;
  reportMode: boolean;
  run: AgentRunResponseDto;
}) {
  const { run } = props;
  // MCP 调用与本地 registry 调用共享消息内工具列表，但保留各自 trace 类型便于辨识边界。
  const toolEvents = run.trace.events.filter(
    (event) => event.type === "tool_call" || event.type === "mcp_tool_call"
  );

  return (
    <button className="run-details run-details-trigger" onClick={props.onOpen} type="button">
      <span className="run-details-summary">
        <span className="summary-title">
          <Activity className="icon-size" />
          查看运行过程
        </span>
        <span className="summary-badges">
          <StatusBadge tone="neutral">{run.intent}</StatusBadge>
          <StatusBadge tone={run.ok ? "success" : "danger"}>{run.ok ? "ok" : "failed"}</StatusBadge>
          <StatusBadge tone={props.reportMode ? "info" : "neutral"}>{props.reportMode ? "report" : "chat"}</StatusBadge>
          <StatusBadge tone="neutral">{run.steps.length} steps</StatusBadge>
          <StatusBadge tone="neutral">{toolEvents.length} tools</StatusBadge>
          <StatusBadge tone="neutral">{run.trace.events.length} trace</StatusBadge>
        </span>
        <ChevronDown className="details-chevron" />
      </span>
    </button>
  );
}

/**
 * 在右侧按需展示当前 assistant run 或实时事件，不形成永久调试侧栏。
 *
 * @param props 详情状态和审批操作。
 * @returns 可关闭的运行详情面板。
 */
function RunDetailPanel(props: {
  approvalStatusById: Record<string, string>;
  detail?: SelectedRunDetail;
  onApprovalDecision: (request: ToolApprovalRequestDto, decision: ToolApprovalDecisionDto["decision"]) => Promise<void>;
  onClose: () => void;
}) {
  if (!props.detail) return null;
  const run = props.detail?.run;
  const event = props.detail?.event;
  const toolEvents = run?.trace.events.filter((item) => item.type === "tool_call" || item.type === "mcp_tool_call") ?? [];
  const approvalRequests = run ? getApprovalRequests(run) : [];
  const marketSeries = findMarketSeries(event ?? run);
  return (
    <aside aria-label="运行详情" className="run-detail-panel is-open">
      <header className="run-detail-header">
        <div><p className="md-label">Agent activity</p><h2>{event?.type === "trace_event" ? formatEventTitle(event.event) : "运行过程"}</h2></div>
        <button className="icon-button" onClick={props.onClose} type="button" aria-label="关闭运行详情"><X className="icon-size" /></button>
      </header>
      <div className="run-detail-scroll">
        {marketSeries ? <MarketCandlestickChart series={marketSeries} /> : null}
        {event ? <><p className="detail-lead">{formatRunProgress(event)}</p><JsonDetails title="event json" value={event} /></> : null}
        {run ? (
          <>
            <div className="run-identifiers"><span>requestId: {run.requestId}</span><span>traceId: {run.traceId}</span></div>
            <TraceSummaryPanel summary={run.trace.summary} />
            {run.error ? <ErrorBlock error={run.error} /> : null}
            {run.reportPlan ? <ReportPlanPanel plan={run.reportPlan} /> : null}
            {run.reportWorkflow ? <ReportWorkflowPanel workflow={run.reportWorkflow} /> : null}
            <ApprovalRequestsPanel approvalStatusById={props.approvalStatusById} onApprovalDecision={props.onApprovalDecision} requests={approvalRequests} />
            <RunStepsList steps={run.steps} />
            <ToolCallsList events={toolEvents} />
            <TraceTimeline events={run.trace.events} />
            <JsonDetails title="run json" value={run} />
          </>
        ) : null}
      </div>
    </aside>
  );
}

/**
 * 展示后端聚合的请求级指标，Web 不重复计算事件明细。
 *
 * @param props trace 汇总 DTO。
 * @returns 指标摘要面板。
 */
function TraceSummaryPanel(props: { summary: AgentRunResponseDto["trace"]["summary"] }) {
  const { summary } = props;
  return (
    <section className="details-section">
      <h3><Activity className="icon-size" />Trace summary</h3>
      <div className="trace-summary-grid">
        <span><strong>{summary.durationMs} ms</strong><small>latency</small></span>
        <span><strong>{summary.modelCallCount}</strong><small>model calls</small></span>
        <span><strong>{summary.toolCallCount}</strong><small>tool calls</small></span>
        <span><strong>{summary.knownTokenTotal}</strong><small>known tokens</small></span>
        <span><strong>{summary.unknownTokenCallCount}</strong><small>unknown usage</small></span>
        <span><strong>{summary.errorCount}</strong><small>errors</small></span>
      </div>
    </section>
  );
}

/**
 * 展示 Report planner 结构化输出摘要，完整 DTO 仍可在 run JSON 中查看。
 *
 * @param props 组件属性。
 * @returns report plan 摘要面板。
 */
function ReportPlanPanel(props: { plan: NonNullable<AgentRunResponseDto["reportPlan"]> }) {
  const { plan } = props;

  return (
    <section className="details-section">
      <h3>
        <FileText className="icon-size" />
        Report plan
      </h3>
      <div className="report-plan-panel">
        <div className="report-plan-grid">
          <span>status</span>
          <strong>{plan.status}</strong>
          <span>trigger</span>
          <strong>{plan.triggerSource}</strong>
          <span>type</span>
          <strong>{plan.reportType}</strong>
          <span>subject</span>
          <strong>{plan.subject ?? "待确认"}</strong>
          <span>timeRange</span>
          <strong>{plan.timeRange ?? "待确认"}</strong>
          <span>data</span>
          <strong>{plan.requiredData.join(" / ")}</strong>
        </div>
        {plan.clarificationQuestions.length > 0 ? (
          <div className="report-plan-note">
            <strong>Clarification</strong>
            <span>{plan.clarificationQuestions.join("；")}</span>
          </div>
        ) : null}
        {plan.assumptions.length > 0 ? (
          <div className="report-plan-note">
            <strong>Assumptions</strong>
            <span>{plan.assumptions.join("；")}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** 展示完整研报节点链路、artifact 预览和可追溯引用；运行逻辑始终留在 API/package。 */
function ReportWorkflowPanel(props: { workflow: ReportWorkflowResponseDto }) {
  const { artifact, run } = props.workflow;
  const displayNodes = [
    { nodeId: "activation", title: "Activation", status: "succeeded", durationMs: 0 },
    { nodeId: "planner", title: "Planner", status: "succeeded", durationMs: 0 },
    ...run.nodes
  ];

  return (
    <section className="details-section report-workflow-section">
      <h3><Activity className="icon-size" />Report workflow</h3>
      <div className="workflow-header">
        <div className="run-identifiers"><span>workflowRunId: {run.runId}</span></div>
        <StatusBadge tone={run.status === "succeeded" ? "success" : run.status === "paused" ? "info" : "danger"}>{run.status}</StatusBadge>
      </div>
      {run.partial ? (
        <p className="workflow-recovery"><AlertTriangle className="icon-size" />部分数据源暂时不可用，已基于现有证据生成降级报告。请展开恢复详情核对数据缺口。</p>
      ) : null}
      {run.recovery && run.recovery.length > 0 ? <JsonDetails title="恢复与降级详情" value={run.recovery} /> : null}
      <div className="workflow-nodes">
        {displayNodes.map((node, index) => (
          <article className="workflow-node" key={node.nodeId}>
            <span className="workflow-index">{index + 1}</span>
            <div>
              <strong>{node.title}</strong>
              <small>{node.nodeId} · {node.durationMs} ms</small>
              {"inputSummary" in node && node.inputSummary ? <JsonDetails title="input summary" value={node.inputSummary} /> : null}
              {"outputSummary" in node && node.outputSummary ? <JsonDetails title="output summary" value={node.outputSummary} /> : null}
              {"error" in node && node.error ? <span className="workflow-error">{node.error.code}: {node.error.message}</span> : null}
            </div>
            <StatusBadge tone={node.status === "succeeded" ? "success" : node.status === "paused" ? "info" : node.status === "failed" ? "danger" : "neutral"}>{node.status}</StatusBadge>
          </article>
        ))}
      </div>
      {artifact ? <ReportArtifactPreview artifact={artifact} key={artifact.artifactId} /> : <p className="muted-row">Planner 尚未产出可预览报告。</p>}
    </section>
  );
}

/** 渲染报告 artifact，并通过 API 执行审批后的 PDF 生成与下载。 */
function ReportArtifactPreview(props: { artifact: ReportArtifactDto }) {
  const [artifact, setArtifact] = useState(props.artifact);
  const [exportError, setExportError] = useState<string>();
  async function handlePdfExport(): Promise<void> {
    setExportError(undefined);
    const result = await exportReportPdf(artifact.artifactId);
    if (result.ok) setArtifact(result.data); else setExportError(formatApiError(result.error));
  }
  return (
    <div className="report-artifact">
      <div className="artifact-heading">
        <div><span className="md-label">Report preview</span><strong>{artifact.title}</strong></div>
        <div className="summary-badges">
          <StatusBadge tone="info">{artifact.status}</StatusBadge>
          <StatusBadge tone={artifact.citationVerification.verified ? "success" : "danger"}>
            citations {artifact.citationVerification.decision}
          </StatusBadge>
          <StatusBadge tone="info">PDF {artifact.pdfExport.status}</StatusBadge>
        </div>
      </div>
      <iframe className="report-html-preview" sandbox="" srcDoc={artifact.html} title="HTML report preview" />
      <details className="markdown-preview"><summary>Markdown source</summary><pre>{artifact.markdown}</pre></details>
      <div className="artifact-actions"><p className="pdf-placeholder"><AlertTriangle className="icon-size" />{artifact.pdfExport.message}</p>
        {artifact.pdfExport.status === "ready" && artifact.pdfExport.downloadUrl ? <a className="secondary-button" href={artifact.pdfExport.downloadUrl}><FileText className="icon-size" />Download PDF</a> : <button className="secondary-button" onClick={() => void handlePdfExport()} type="button"><FilePlus2 className="icon-size" />Generate PDF</button>}
      </div>
      {exportError ? <ErrorBlock error={{ code: "forbidden", message: exportError }} /> : null}
      <div className="citation-list">
        {artifact.citations.map((citation, index) => (
          <article className="citation-row" key={citation.id}>
            <strong>[{index + 1}]</strong>
            <div><span>{citation.quote}</span><small>{citation.source} / document {citation.documentId ?? "unknown"} / chunk {citation.chunkId ?? citation.chunkIndex ?? "unknown"}</small><small>supports: {citation.supportsFinding}</small></div>
          </article>
        ))}
      </div>
    </div>
  );
}

/**
 * 展示需要人工确认的敏感动作；按钮只提交 decision，不执行敏感逻辑。
 *
 * @param props 组件属性。
 * @returns approval request 面板。
 */
function ApprovalRequestsPanel(props: {
  approvalStatusById: Record<string, string>;
  onApprovalDecision: (request: ToolApprovalRequestDto, decision: ToolApprovalDecisionDto["decision"]) => Promise<void>;
  requests: ToolApprovalRequestDto[];
}) {
  return (
    <section className="details-section">
      <h3>
        <ShieldCheck className="icon-size" />
        Approvals
      </h3>
      <div className="detail-list">
        {props.requests.length === 0 ? <p className="muted-row">暂无人工确认请求。</p> : null}
        {props.requests.map((request) => {
          const status = props.approvalStatusById[request.approvalId] ?? "pending";
          const disabled = status === "submitting" || status === "approved" || status === "rejected";

          return (
            <article className="approval-row" key={request.approvalId}>
              <div>
                <strong>{request.toolName}</strong>
                <span>{request.reason}</span>
                <small>{request.approvalId}</small>
                <JsonDetails title="approval preview" value={request.inputPreview} />
              </div>
              <div className="approval-actions">
                <StatusBadge tone={status === "approved" ? "success" : status === "rejected" ? "danger" : "info"}>
                  {status}
                </StatusBadge>
                <button
                  className="secondary-button"
                  disabled={disabled}
                  onClick={() => void props.onApprovalDecision(request, "approved")}
                  type="button"
                >
                  <ShieldCheck className="icon-size" />
                  <span>Approve</span>
                </button>
                <button
                  className="secondary-button danger-action"
                  disabled={disabled}
                  onClick={() => void props.onApprovalDecision(request, "rejected")}
                  type="button"
                >
                  <X className="icon-size" />
                  <span>Reject</span>
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * 展示 Agent steps 的摘要列表，避免默认展示完整 JSON。
 *
 * @param props 组件属性。
 * @returns step 列表。
 */
function RunStepsList(props: { steps: AgentRunResponseDto["steps"] }) {
  return (
    <section className="details-section">
      <h3>
        <Activity className="icon-size" />
        Steps
      </h3>
      <div className="detail-list">
        {props.steps.length === 0 ? <p className="muted-row">暂无 step。</p> : null}
        {props.steps.map((step) => (
          <article className="detail-row" key={`${step.index}-${step.type}`}>
            <div>
              <strong>
                {step.index}. {step.type}
              </strong>
              <span>{step.error?.message ?? `${step.durationMs} ms`}</span>
            </div>
            <StatusBadge tone={step.status === "succeeded" ? "success" : "danger"}>{step.status}</StatusBadge>
            <JsonDetails title="step json" value={step} />
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * 展示工具调用摘要，工具参数和结果放入二级 JSON 折叠。
 *
 * @param props 组件属性。
 * @returns 工具调用列表。
 */
function ToolCallsList(props: { events: TraceEventDto[] }) {
  return (
    <section className="details-section">
      <h3>
        <Wrench className="icon-size" />
        Tool calls
      </h3>
      <div className="detail-list">
        {props.events.length === 0 ? <p className="muted-row">暂无工具调用。</p> : null}
        {props.events.map((event) => (
          <article className="detail-row" key={event.id}>
            <div>
              <strong>{"toolName" in event ? event.toolName : "unknown tool"}</strong>
              <span>{formatEventSummary(event)}</span>
            </div>
            <StatusBadge tone={"ok" in event && event.ok ? "success" : "danger"}>{formatLatency(event)}</StatusBadge>
            <JsonDetails title="tool json" value={event} />
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * 展示 trace 事件时间线，用摘要承载默认可读信息。
 *
 * @param props 组件属性。
 * @returns trace timeline。
 */
function TraceTimeline(props: { events: TraceEventDto[] }) {
  const events = [...props.events].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return (
    <section className="details-section">
      <h3>
        <Clock3 className="icon-size" />
        Trace timeline
      </h3>
      <div className="trace-list">
        {events.map((event, index) => (
          <article className="trace-row" key={event.id}>
            <span className="trace-index">{index + 1}</span>
            <div>
              <strong>{formatEventTitle(event)}</strong>
              <span>{formatEventSummary(event)}</span>
              <small>{formatTime(event.createdAt)}</small>
              {event.spanId ? <small>span {event.spanId} · parent {event.parentSpanId ?? "root"}</small> : null}
              <JsonDetails title="event json" value={event} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * 以折叠方式展示 JSON，防止长 request payload 撑破对话区。
 *
 * @param props 组件属性。
 * @returns JSON 折叠块。
 */
function JsonDetails(props: { title: string; value: unknown }) {
  return (
    <details className="json-details">
      <summary>
        <Braces className="icon-size" />
        {props.title}
      </summary>
      <pre>{JSON.stringify(props.value, null, 2)}</pre>
    </details>
  );
}

/**
 * 展示结构化错误，不暴露浏览器或服务端原始堆栈。
 *
 * @param props 组件属性。
 * @returns 错误摘要。
 */
function ErrorBlock(props: { error: ApiError }) {
  return (
    <div className="error-block">
      <AlertTriangle className="icon-size" />
      <span>{formatApiError(props.error)}</span>
    </div>
  );
}

/**
 * 渲染小型状态标签，统一 run、会话和 composer 状态表达。
 *
 * @param props 组件属性。
 * @returns 状态标签。
 */
function StatusBadge(props: { children: ReactNode; tone: "danger" | "info" | "neutral" | "success" }) {
  return <span className={`status-badge tone-${props.tone}`}>{props.children}</span>;
}

/**
 * 创建异步 Agent run 并消费 SSE，过程事件实时回写 assistant 消息。
 *
 * @param message 当前用户输入。
 * @param reportMode Report Mode 占位开关状态。
 * @param conversationId 可选会话标识。
 * @param clientMessageId 用户消息幂等键。
 * @param reportTriggerSource 显式研报触发来源。
 * @param onEvent 实时事件回调。
 * @returns terminal API 运行结果。
 */
async function runAgent(
  message: string,
  reportMode: boolean,
  conversationId: string | undefined,
  clientMessageId: string,
  reportTriggerSource?: ReportTriggerSourceDto,
  onEvent?: (event: AgentRunStreamEventDto) => void
): Promise<ApiResult<AgentRunResponseDto>> {
  return createAndStreamRun({
    message,
    conversationId: conversationId ?? createUiId("conversation"),
    clientMessageId,
    mode: reportMode ? "report" : "auto",
    source: reportTriggerSource === "button" ? "report_button" : "composer"
  }, { onEvent });
}

/**
 * 把实时事件转换为 assistant 消息中的简短进度文案。
 *
 * @param event 当前 run event。
 * @returns 用户可读进度。
 */
function formatRunProgress(event: AgentRunStreamEventDto): string {
  if (event.type === "run_status") return event.message;
  if (event.type === "run_error") return event.error.message;
  if (event.type === "run_result") return event.result.answer;
  const labels: Partial<Record<TraceEventDto["type"], string>> = {
    request_received: "已接收研究问题，正在分析意图。",
    intent_routed: "已完成意图识别，正在选择研究路径。",
    retrieval: "正在检索公告与研究证据。",
    tool_call: "已调用本地研究工具。",
    mcp_tool_call: "已通过 MCP 获取结构化数据。",
    workflow_node: "正在执行研报工作流节点。",
    citation_verifier: "正在校验结论与引用覆盖。",
    final_response: "研究过程已完成，正在整理回答。"
  };
  return labels[event.event.type] ?? `正在处理 ${event.event.type.replaceAll("_", " ")}。`;
}

/**
 * 调用 Approval decision API，供 Run details 中的人工确认控件使用。
 *
 * @param decision 审批决定。
 * @returns API result。
 */
async function submitApprovalDecision(runId: string, decision: ToolApprovalDecisionDto): Promise<ApiResult<ToolApprovalDecisionDto>> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(decision.approvalId)}/decision`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      decision: decision.decision,
      reviewerNote: decision.reviewerNote,
      inputDigest: decision.inputDigest
    })
  });

  return parseApiResult(response);
}

/** @param artifactId 服务端稳定 artifact ID。 @returns 更新后的真实 PDF 状态。 */
async function exportReportPdf(artifactId: string): Promise<ApiResult<ReportArtifactDto>> {
  return parseApiResult(await fetch(`/api/report-artifacts/${encodeURIComponent(artifactId)}/pdf`, { method: "POST" }));
}

/** @returns 版本化 eval 展示 DTO。 */
async function fetchProductEval(): Promise<ApiResult<ProductEvalReportDto>> { return parseApiResult(await fetch("/api/product/eval-report")); }
/** @returns 当前 package 架构展示 DTO。 */
async function fetchProductArchitecture(): Promise<ApiResult<ProductArchitectureDto>> { return parseApiResult(await fetch("/api/product/architecture")); }

/**
 * 调用 Data Sources ingestion API。
 *
 * @param request ingestion 请求。
 * @returns 结构化 ingestion 结果。
 */
async function ingestDataSource(request: {
  source: string;
  fileName: string;
  contentType?: string;
  content: string;
}): Promise<ApiResult<DataSourceIngestResponseDto>> {
  const response = await fetch("/api/data-sources/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(request)
  });

  return parseApiResult(response);
}

/**
 * 获取当前 API 进程内的文档列表。
 *
 * @returns 文档列表 API result。
 */
async function fetchDataSourceDocuments(): Promise<ApiResult<DataSourceDocumentsResponseDto>> {
  return parseApiResult(await fetch("/api/data-sources/documents"));
}

/**
 * 获取当前 API 进程内的 chunk 列表。
 *
 * @returns chunk 列表 API result。
 */
async function fetchDataSourceChunks(): Promise<ApiResult<DataSourceChunksResponseDto>> {
  return parseApiResult(await fetch("/api/data-sources/chunks"));
}

/**
 * 调用 RAG search API。
 *
 * @param query 检索问题。
 * @returns search API result。
 */
async function searchRag(query: string): Promise<ApiResult<RagSearchResponseDto>> {
  const response = await fetch("/api/rag/search", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      query,
      topK: 5
    })
  });

  return parseApiResult(response);
}

/**
 * 调用 RAG answer API。
 *
 * @param question 用户问题。
 * @returns answer API result。
 */
async function answerRag(question: string): Promise<ApiResult<RagAnswerResponseDto>> {
  const response = await fetch("/api/rag/answer", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      question,
      topK: 5
    })
  });

  return parseApiResult(response);
}

/**
 * 解析 API 响应，兼容 dev proxy 断连、空响应和 HTML 错误页。
 *
 * @param response fetch 返回的响应对象。
 * @returns 结构化 API result。
 */
async function parseApiResult<TData>(response: Response): Promise<ApiResult<TData>> {
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
    return JSON.parse(text) as ApiResult<TData>;
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
 * 从 trace 中提取 approval request，前端只消费 trace DTO，不推断权限策略。
 *
 * @param run Agent run DTO。
 * @returns 去重后的审批请求。
 */
function getApprovalRequests(run: AgentRunResponseDto): ToolApprovalRequestDto[] {
  const requests = new Map<string, ToolApprovalRequestDto>();

  for (const event of run.trace.events) {
    if (event.type !== "approval" || event.status !== "requested") {
      continue;
    }

    requests.set(event.approvalId, {
      approvalId: event.approvalId,
      traceId: event.traceId,
      toolName: event.toolName,
      reason: event.reason,
      inputPreview: event.inputPreview,
      permissionLevel: "needs_approval",
      requestId: event.requestId,
      inputDigest: event.inputDigest,
      reasonCode: event.reasonCode
    });
  }

  const workflowApproval = run.reportWorkflow?.run.approvalRequest;
  if (workflowApproval) requests.set(workflowApproval.approvalId, workflowApproval);

  return [...requests.values()];
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
    case "approval":
      return `Approval: ${event.status}`;
    case "security":
      return `Security: ${event.decision}`;
    case "retrieval":
      return `Retrieval: ${event.mode}`;
    case "report_skill_activation":
      return `Report Activation: ${event.triggerSource}`;
    case "report_plan":
      return "Report Plan";
    case "workflow_node":
      return `Workflow Node: ${event.nodeId}`;
    case "citation_verifier":
      return `Citation Verifier: ${event.decision}`;
    case "pdf_export":
      return `PDF Export: ${event.status}`;
    case "model_call":
      return `Model Call: ${event.purpose}`;
    case "tool_call":
      return `Tool Call: ${event.toolName}`;
    case "mcp_tool_discovered":
      return `MCP Discovery: ${event.serverName}`;
    case "mcp_tool_call":
      return `MCP Tool Call: ${event.toolName}`;
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
    case "approval":
      return `${event.toolName}: ${event.reason}`;
    case "security":
      return `${event.category}: ${event.reasonCode}`;
    case "retrieval":
      return event.ok
        ? `${event.chunkIds.length} chunks retrieved, topK=${event.topK}`
        : event.error?.message ?? "检索失败。";
    case "report_skill_activation":
      return `${event.triggerSource} activation; ${event.routeReason}`;
    case "report_plan":
      return event.ok ? `${event.plan.status} plan created` : event.error?.message ?? "planner failed";
    case "workflow_node":
      return `${event.status} ${event.nodeType} in ${event.durationMs} ms`;
    case "citation_verifier":
      return `${event.missingClaimCount} missing claims, ${event.missingMetricCount} missing metrics`;
    case "pdf_export":
      return event.fileName ?? "PDF export state updated";
    case "model_call":
      return event.ok ? `${event.model} responded` : event.error?.message ?? "model failed";
    case "tool_call":
      return event.ok ? "工具成功返回结构化结果。" : event.error?.message ?? "工具调用失败。";
    case "mcp_tool_discovered":
      return event.ok
        ? `发现 ${event.toolNames.length} 个 MCP 工具：${event.toolNames.join("、")}`
        : event.error?.message ?? "MCP 工具发现失败。";
    case "mcp_tool_call":
      return event.ok ? "MCP 工具成功返回结构化结果。" : event.error?.message ?? "MCP 工具调用失败。";
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
 * 格式化较短的会话更新时间。
 *
 * @param value ISO 时间字符串。
 * @returns 简短时间文案。
 */
function formatRelativeTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * 把最近一次 run 转成会话列表和 header 的状态文案。
 *
 * @param run 最近一次 run。
 * @returns 状态文案。
 */
function formatRunStatus(run: AgentRunResponseDto | undefined): string {
  if (!run) {
    return "idle";
  }

  return run.ok ? run.intent : "failed";
}

/**
 * 从第一条用户输入生成会话标题。
 *
 * @param message 用户输入。
 * @returns 会话标题。
 */
function createConversationTitle(message: string): string {
  return message.length > 24 ? `${message.slice(0, 24)}...` : message;
}

/** @param message 服务端消息 DTO。 @returns 时间线 UI 消息。 */
function toUiMessage(message: ConversationMessageDto): UiMessage {
  return {
    id: message.messageId,
    role: message.role === "user" ? "user" : "assistant",
    content: message.content,
    createdAt: message.createdAt,
    status: message.status === "failed" ? "failed" : "complete",
    ok: message.status === "completed"
  };
}

/** @param current 已加载会话。 @param incoming 新页。 @returns 按 ID 去重的列表。 */
function mergeConversations(current: ConversationDto[], incoming: ConversationDto[]): ConversationDto[] {
  const seen = new Set(current.map((item) => item.conversationId));
  return [...current, ...incoming.filter((item) => !seen.has(item.conversationId))];
}

/** @param current 已加载消息。 @param incoming 新页。 @returns 按 ID 去重并按时间线顺序排列的消息。 */
function mergeMessages(current: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !seen.has(item.id))];
}

/**
 * 生成浏览器本地 id，避免依赖服务端持久化能力。
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

/**
 * 将浏览器路径解析为稳定工作区，未知路径安全回退到聊天首页。
 *
 * @param pathname 当前 URL pathname。
 * @returns 对应工作区。
 */
function getWorkspaceView(pathname: string): WorkspaceView {
  const routes: Record<string, WorkspaceView> = {
    "/": "chat",
    "/data-sources": "data-sources",
    "/workflow": "workflow",
    "/citations": "citations",
    "/eval": "eval",
    "/architecture": "architecture",
    "/settings": "settings"
  };
  return routes[pathname] ?? "chat";
}

/**
 * 将工作区转换为可分享的产品路由。
 *
 * @param view 工作区。
 * @returns URL pathname。
 */
function getWorkspacePath(view: WorkspaceView): string {
  return view === "chat" ? "/" : `/${view}`;
}
