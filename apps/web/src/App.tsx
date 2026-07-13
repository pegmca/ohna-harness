import * as Switch from "@radix-ui/react-switch";
import type {
  AgentRunResponseDto,
  ApiError,
  ApiResult,
  DataSourceChunksResponseDto,
  DataSourceDocumentsResponseDto,
  DataSourceIngestResponseDto,
  IngestedFilingDocumentDto,
  RagAnswerResponseDto,
  RagChunkDto,
  RagSearchResponseDto,
  ReportTriggerSourceDto,
  RetrievalResultDto,
  ToolApprovalDecisionDto,
  ToolApprovalRequestDto
} from "@aiagent/types";
import {
  Activity,
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
  Sparkles,
  User,
  Wrench,
  X
} from "lucide-react";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";

type MessageRole = "user" | "assistant";
type MessageStatus = "complete" | "pending" | "failed";
type WorkspaceView = "chat" | "data-sources";

interface UiMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  status: MessageStatus;
  ok?: boolean;
  run?: AgentRunResponseDto;
}

interface LocalConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: UiMessage[];
  latestRun?: AgentRunResponseDto;
  reportMode: boolean;
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
 * 渲染 Immersive Agent Chat，负责本地会话编排和真实 Agent API 调用。
 *
 * @returns Week 1 Agent Chat 产品页面。
 */
export function App() {
  const [conversations, setConversations] = useState<LocalConversation[]>(() => [createConversation()]);
  const [activeConversationId, setActiveConversationId] = useState(() => conversations[0]?.id ?? "");
  const [input, setInput] = useState(demoPrompts[1]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [composerError, setComposerError] = useState<string | undefined>();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("chat");
  const [approvalStatusById, setApprovalStatusById] = useState<Record<string, string>>({});

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0],
    [activeConversationId, conversations]
  );
  const latestRun = activeConversation?.latestRun;
  const isEmpty = (activeConversation?.messages.length ?? 0) === 0;

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
  function handleNewConversation(): void {
    const conversation = createConversation();
    setConversations((current) => [conversation, ...current]);
    setActiveConversationId(conversation.id);
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
    setActiveConversationId(conversationId);
    setComposerError(undefined);
    setIsSidebarOpen(false);
  }

  /**
   * 更新当前会话的 Report Mode；该状态会随下一次请求提交给 API。
   *
   * @param checked Report Mode 是否启用。
   * @returns void。
   */
  function handleReportModeChange(checked: boolean): void {
    updateConversation(activeConversationId, (conversation) => ({
      ...conversation,
      reportMode: checked,
      updatedAt: new Date().toISOString()
    }));
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
    const conversation = activeConversation;

    if (!trimmed || isSubmitting || !conversation) {
      return;
    }

    const submittedConversationId = conversation.id;
    const submittedReportMode = conversation.reportMode;
    const pendingMessageId = createUiId("assistant");
    const now = new Date().toISOString();
    const userMessage: UiMessage = {
      id: createUiId("user"),
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
      status: "pending"
    };

    updateConversation(submittedConversationId, (current) => ({
      ...current,
      title: current.messages.length === 0 ? createConversationTitle(trimmed) : current.title,
      updatedAt: now,
      messages: [...current.messages, userMessage, pendingMessage]
    }));
    setInput("");
    setComposerError(undefined);
    setIsSubmitting(true);

    try {
      const result = await runAgent(
        trimmed,
        submittedReportMode || triggerSource === "button",
        submittedConversationId,
        triggerSource
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
      replaceMessage(submittedConversationId, pendingMessageId, {
        content: run.answer,
        status: run.ok ? "complete" : "failed",
        ok: run.ok,
        run
      });
      updateConversation(submittedConversationId, (current) => ({
        ...current,
        latestRun: run,
        updatedAt: new Date().toISOString()
      }));

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
   * 更新指定会话，集中处理本地会话数组不可变写入。
   *
   * @param conversationId 会话 id。
   * @param updater 会话更新函数。
   * @returns void。
   */
  function updateConversation(
    conversationId: string,
    updater: (conversation: LocalConversation) => LocalConversation
  ): void {
    setConversations((current) =>
      current.map((conversation) => (conversation.id === conversationId ? updater(conversation) : conversation))
    );
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
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      updatedAt: new Date().toISOString(),
      messages: conversation.messages.map((messageItem) =>
        messageItem.id === messageId ? { ...messageItem, ...patch } : messageItem
      )
    }));
  }

  /**
   * 提交人工审批决定；UI 只转交 decision，不在浏览器内重复实现权限判断。
   *
   * @param approvalId 审批请求 id。
   * @param decision approve/reject 决策。
   * @returns 请求完成 Promise。
   */
  async function handleApprovalDecision(
    approvalId: string,
    decision: ToolApprovalDecisionDto["decision"]
  ): Promise<void> {
    setApprovalStatusById((current) => ({
      ...current,
      [approvalId]: "submitting"
    }));

    const result = await submitApprovalDecision({
      approvalId,
      decision,
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
    <main className="agent-app-shell">
      <ConversationSidebar
        activeConversationId={activeConversation?.id}
        conversations={conversations}
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        onNewConversation={handleNewConversation}
        onSelectConversation={handleSelectConversation}
        onSelectView={(view) => {
          setWorkspaceView(view);
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
            reportMode={activeConversation?.reportMode ?? false}
          />

          <ChatTimeline
            approvalStatusById={approvalStatusById}
            isSubmitting={isSubmitting}
            messages={activeConversation?.messages ?? []}
            onApprovalDecision={handleApprovalDecision}
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
            reportMode={activeConversation?.reportMode ?? false}
          />
        </section>
      ) : (
        <DataSourcesWorkspace onMenuClick={() => setIsSidebarOpen(true)} />
      )}
    </main>
  );
}

interface ConversationSidebarProps {
  activeConversationId: string | undefined;
  conversations: LocalConversation[];
  isOpen: boolean;
  onClose: () => void;
  onNewConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
  onSelectView: (view: WorkspaceView) => void;
  workspaceView: WorkspaceView;
}

/**
 * 展示浏览器本地会话列表；移动端作为 drawer，桌面端作为固定左栏。
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
          <div>
            <p className="md-label">Immersive</p>
            <h1 className="sidebar-title">Agent Chat</h1>
          </div>
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
            <span>Agent Chat</span>
          </button>
          <button
            className={props.workspaceView === "data-sources" ? "is-active" : ""}
            onClick={() => props.onSelectView("data-sources")}
            type="button"
          >
            <Database className="icon-size" />
            <span>Data Sources</span>
          </button>
        </nav>

        <div className="conversation-list" role="list">
          {props.conversations.map((conversation) => (
            <button
              className={`conversation-item ${
                conversation.id === props.activeConversationId ? "is-active" : ""
              }`}
              key={conversation.id}
              onClick={() => props.onSelectConversation(conversation.id)}
              type="button"
            >
              <span className="conversation-title">{conversation.title}</span>
              <span className="conversation-preview">{getConversationPreview(conversation)}</span>
              <span className="conversation-meta">
                <span>{formatRelativeTime(conversation.updatedAt)}</span>
                <span>{formatRunStatus(conversation.latestRun)}</span>
              </span>
            </button>
          ))}
        </div>

        <footer className="sidebar-footer">
          <span>Local session</span>
          <span>{props.conversations.length} chats</span>
        </footer>
      </aside>
    </>
  );
}

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
  const [documents, setDocuments] = useState<IngestedFilingDocumentDto[]>([]);
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

    setDocuments((current) => upsertBy(current, result.data.document, (item) => item.documentId));
    setChunks((current) => mergeChunks(current, result.data.chunks));
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
                <span>{document.fileName}</span>
                <small>{document.source}</small>
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
        <button className="secondary-button" disabled={props.isSubmitting} onClick={props.onGenerateReport} type="button">
          <FilePlus2 className="icon-size" />
          <span>生成研报</span>
        </button>
        <label className="report-switch">
          <span>Report Mode</span>
          <Switch.Root
            checked={props.reportMode}
            className="switch-root"
            onCheckedChange={props.onReportModeChange}
          >
            <Switch.Thumb className="switch-thumb" />
          </Switch.Root>
        </label>
        <StatusBadge tone={props.isSubmitting ? "info" : props.latestRun?.ok === false ? "danger" : "success"}>
          {props.isSubmitting ? "running" : formatRunStatus(props.latestRun)}
        </StatusBadge>
      </div>
    </header>
  );
}

interface ChatTimelineProps {
  approvalStatusById: Record<string, string>;
  isSubmitting: boolean;
  messages: UiMessage[];
  onApprovalDecision: (approvalId: string, decision: ToolApprovalDecisionDto["decision"]) => Promise<void>;
  onUsePrompt: (prompt: string) => void;
}

/**
 * 渲染中央对话时间线；空状态只显示紧凑 starter prompts。
 *
 * @param props 组件属性。
 * @returns 对话消息列表。
 */
function ChatTimeline(props: ChatTimelineProps) {
  if (props.messages.length === 0) {
    return (
      <section className="chat-timeline empty-timeline" aria-label="消息列表">
        <div className="empty-state">
          <Sparkles className="empty-icon" />
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
        {props.messages.map((message) => (
          <ChatMessage
            approvalStatusById={props.approvalStatusById}
            key={message.id}
            message={message}
            onApprovalDecision={props.onApprovalDecision}
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
  onApprovalDecision: (approvalId: string, decision: ToolApprovalDecisionDto["decision"]) => Promise<void>;
}) {
  const { message } = props;
  const isUser = message.role === "user";

  return (
    <article className={`chat-message ${isUser ? "is-user" : "is-assistant"}`}>
      <div className="message-avatar" aria-hidden="true">
        {isUser ? <User className="icon-size" /> : <Bot className="icon-size" />}
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
          <div className="message-progress">
            <Loader2 className="icon-size spin" />
            <span>routing / tool selection / finalizing</span>
          </div>
        ) : null}
        {message.run ? (
          <RunDetails
            approvalStatusById={props.approvalStatusById}
            onApprovalDecision={props.onApprovalDecision}
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
  approvalStatusById: Record<string, string>;
  onApprovalDecision: (approvalId: string, decision: ToolApprovalDecisionDto["decision"]) => Promise<void>;
  reportMode: boolean;
  run: AgentRunResponseDto;
}) {
  const { run } = props;
  const toolEvents = run.trace.events.filter((event) => event.type === "tool_call");
  const approvalRequests = getApprovalRequests(run);

  return (
    <details className="run-details">
      <summary>
        <span className="summary-title">
          <Activity className="icon-size" />
          Run details
        </span>
        <span className="summary-badges">
          <StatusBadge tone="neutral">{run.intent}</StatusBadge>
          <StatusBadge tone={run.ok ? "success" : "danger"}>{run.ok ? "ok" : "failed"}</StatusBadge>
          <StatusBadge tone={props.reportMode ? "info" : "neutral"}>{props.reportMode ? "report" : "chat"}</StatusBadge>
          <StatusBadge tone="neutral">{run.steps.length} steps</StatusBadge>
          <StatusBadge tone="neutral">{toolEvents.length} tools</StatusBadge>
          <StatusBadge tone={approvalRequests.length > 0 ? "info" : "neutral"}>{approvalRequests.length} approvals</StatusBadge>
          <StatusBadge tone="neutral">{run.trace.events.length} trace</StatusBadge>
        </span>
        <ChevronDown className="details-chevron" />
      </summary>
      <div className="run-details-body">
        <div className="run-identifiers">
          <span>requestId: {run.requestId}</span>
          <span>traceId: {run.traceId}</span>
        </div>
        {run.error ? <ErrorBlock error={run.error} /> : null}
        {run.reportPlan ? <ReportPlanPanel plan={run.reportPlan} /> : null}
        <ApprovalRequestsPanel
          approvalStatusById={props.approvalStatusById}
          onApprovalDecision={props.onApprovalDecision}
          requests={approvalRequests}
        />
        <RunStepsList steps={run.steps} />
        <ToolCallsList events={toolEvents} />
        <TraceTimeline events={run.trace.events} />
        <JsonDetails title="run json" value={run} />
      </div>
    </details>
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

/**
 * 展示需要人工确认的敏感动作；按钮只提交 decision，不执行敏感逻辑。
 *
 * @param props 组件属性。
 * @returns approval request 面板。
 */
function ApprovalRequestsPanel(props: {
  approvalStatusById: Record<string, string>;
  onApprovalDecision: (approvalId: string, decision: ToolApprovalDecisionDto["decision"]) => Promise<void>;
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
                  onClick={() => void props.onApprovalDecision(request.approvalId, "approved")}
                  type="button"
                >
                  <ShieldCheck className="icon-size" />
                  <span>Approve</span>
                </button>
                <button
                  className="secondary-button danger-action"
                  disabled={disabled}
                  onClick={() => void props.onApprovalDecision(request.approvalId, "rejected")}
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
  return (
    <section className="details-section">
      <h3>
        <Clock3 className="icon-size" />
        Trace timeline
      </h3>
      <div className="trace-list">
        {props.events.map((event, index) => (
          <article className="trace-row" key={event.id}>
            <span className="trace-index">{index + 1}</span>
            <div>
              <strong>{formatEventTitle(event)}</strong>
              <span>{formatEventSummary(event)}</span>
              <small>{formatTime(event.createdAt)}</small>
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
  conversationId: string | undefined,
  reportTriggerSource?: ReportTriggerSourceDto
): Promise<ApiResult<AgentRunResponseDto>> {
  const response = await fetch("/api/agent/run", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      message,
      reportMode,
      reportTriggerSource,
      conversationId
    })
  });
  const result = await parseApiResult<AgentRunResponseDto>(response);

  if (!response.ok && result.ok) {
    throw new Error("API 返回了不一致的成功状态。");
  }

  return result;
}

/**
 * 调用 Approval decision API，供 Run details 中的人工确认控件使用。
 *
 * @param decision 审批决定。
 * @returns API result。
 */
async function submitApprovalDecision(decision: ToolApprovalDecisionDto): Promise<ApiResult<ToolApprovalDecisionDto>> {
  const response = await fetch("/api/approvals/decision", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(decision)
  });

  return parseApiResult(response);
}

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
      permissionLevel: "needs_approval"
    });
  }

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
    case "retrieval":
      return `Retrieval: ${event.mode}`;
    case "report_skill_activation":
      return `Report Activation: ${event.triggerSource}`;
    case "report_plan":
      return "Report Plan";
    case "workflow_node":
      return `Workflow Node: ${event.nodeId}`;
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
    case "approval":
      return `${event.toolName}: ${event.reason}`;
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
 * 生成会话列表摘要，优先展示最后一条消息内容。
 *
 * @param conversation 本地会话。
 * @returns 摘要文案。
 */
function getConversationPreview(conversation: LocalConversation): string {
  const lastMessage = conversation.messages.at(-1);

  if (!lastMessage) {
    return "尚未提问";
  }

  return lastMessage.content.length > 54 ? `${lastMessage.content.slice(0, 54)}...` : lastMessage.content;
}

/**
 * 从第一条用户输入生成本地会话标题。
 *
 * @param message 用户输入。
 * @returns 会话标题。
 */
function createConversationTitle(message: string): string {
  return message.length > 24 ? `${message.slice(0, 24)}...` : message;
}

/**
 * 创建浏览器本地会话；刷新后丢失符合 Week 1 约束。
 *
 * @returns 本地会话对象。
 */
function createConversation(): LocalConversation {
  const now = new Date().toISOString();

  return {
    id: createUiId("conversation"),
    title: "新会话",
    createdAt: now,
    updatedAt: now,
    messages: [],
    reportMode: false
  };
}

/**
 * 按稳定 key 更新或插入数组项，避免 ingest 后出现重复文档。
 *
 * @template TItem 数组元素类型。
 * @param current 当前数组。
 * @param next 新元素。
 * @param getKey key 提取函数。
 * @returns 合并后的新数组。
 */
function upsertBy<TItem>(
  current: readonly TItem[],
  next: TItem,
  getKey: (item: TItem) => string
): TItem[] {
  const nextKey = getKey(next);
  const exists = current.some((item) => getKey(item) === nextKey);

  return exists ? current.map((item) => (getKey(item) === nextKey ? next : item)) : [next, ...current];
}

/**
 * 合并 chunk 列表，相同 chunkId 使用最新 ingestion 输出替换。
 *
 * @param current 当前 chunk 列表。
 * @param next 本次 ingest 生成的 chunks。
 * @returns 合并后的 chunk 列表。
 */
function mergeChunks(current: readonly RagChunkDto[], next: readonly RagChunkDto[]): RagChunkDto[] {
  const chunksById = new Map(current.map((chunk) => [chunk.chunkId, chunk]));

  next.forEach((chunk) => chunksById.set(chunk.chunkId, chunk));

  return [...chunksById.values()].sort((left, right) =>
    left.documentId === right.documentId
      ? left.chunkIndex - right.chunkIndex
      : left.documentId.localeCompare(right.documentId)
  );
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
