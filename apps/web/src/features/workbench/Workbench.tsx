import type {
  AgentRunResponseDto,
  AgentRunStreamEventDto,
  ApiResult,
  ConversationDto,
  ReportTriggerSourceDto,
  ToolApprovalDecisionDto,
  ToolApprovalRequestDto
} from "@aiagent/types";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { SettingsPage } from "../settings";
import { createAndStreamRun } from "../../shared/api/run-stream-client";
import {
  createConversation,
  getRunSnapshot,
  listConversationMessages,
  listConversations,
  updateConversation as updateConversationApi
} from "../../shared/api/conversation-client";
import { ChatComposer, ChatHeader, ChatTimeline, demoPrompts } from "./chat";
import {
  createConversationTitle,
  createUiId,
  formatApiError,
  formatRunProgress,
  getWorkspacePath,
  getWorkspaceView,
  mergeConversations,
  mergeMessages,
  parseApiResult,
  toUiMessage
} from "./format";
import { RunDetailPanel } from "./run-details";
import { ConversationSidebar } from "./sidebar";
import type { SelectedRunDetail, UiMessage } from "./types";
import { DataSourcesWorkspace, ProductWorkspace, ScheduledTasksWorkspace } from "./workspace-views";

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
  const activeConversationIdRef = useRef(activeConversationId);
  const messageRequestController = useRef<AbortController | undefined>(undefined);
  const messageRequestGeneration = useRef(0);
  const skipInitialHistoryConversationId = useRef<string | undefined>(undefined);

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
      return;
    }
    if (skipInitialHistoryConversationId.current === activeConversationId) {
      return;
    }
    void loadMessagePage(activeConversationId);
    return () => messageRequestController.current?.abort();
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
      let result = await listConversations(cursor, signal);
      if (!result.ok) {
        setConversationState("error");
        setConversationError(formatApiError(result.error));
        return;
      }
      let loadedItems = result.data.items;
      let nextCursor = result.data.nextCursor;
      const requested = !append ? new URLSearchParams(location.search).get("conversation") : undefined;
      // 稳定 URL 恢复必须继续读取游标页，不能因目标不在首屏而静默改选。
      while (requested && !loadedItems.some((item) => item.conversationId === requested) && nextCursor) {
        result = await listConversations(nextCursor, signal);
        if (!result.ok) {
          setConversationState("error");
          setConversationError(formatApiError(result.error));
          return;
        }
        loadedItems = mergeConversations(loadedItems, result.data.items);
        nextCursor = result.data.nextCursor;
      }
      setConversations((current) => append ? mergeConversations(current, loadedItems) : loadedItems);
      setConversationCursor(nextCursor);
      setConversationState("ready");
      if (!append) {
        const selected = loadedItems.find((item) => item.conversationId === requested)
          ?? loadedItems[0];
        if (selected && selected.conversationId === activeConversationIdRef.current) {
          navigate(`/?conversation=${encodeURIComponent(selected.conversationId)}`, { replace: true });
        } else if (selected) {
          selectConversation(selected.conversationId, true);
        }
        else {
          activeConversationIdRef.current = "";
          setActiveConversationId("");
        }
      }
    } catch (error) {
      if (signal?.aborted) return;
      setConversationState("error");
      setConversationError(error instanceof Error ? error.message : "会话列表加载失败。");
    }
  }

  /**
   * 统一加载初始历史与后续消息页；请求代次和当前选择共同阻止迟到响应串写。
   *
   * @param conversationId 请求所属会话。
   * @param cursor 可选消息游标。
   * @param append 是否追加分页。
   * @returns 请求完成 Promise。
   */
  async function loadMessagePage(
    conversationId: string,
    cursor?: string,
    append = false
  ): Promise<void> {
    messageRequestController.current?.abort();
    const controller = new AbortController();
    const generation = messageRequestGeneration.current + 1;
    messageRequestGeneration.current = generation;
    messageRequestController.current = controller;
    setMessageState("loading");
    setMessageError(undefined);
    try {
      const result = await listConversationMessages(conversationId, cursor, controller.signal);
      if (
        controller.signal.aborted
        || generation !== messageRequestGeneration.current
        || activeConversationIdRef.current !== conversationId
      ) return;
      if (!result.ok) {
        setMessageState("error");
        setMessageError(formatApiError(result.error));
        return;
      }
      const incoming = await Promise.all(result.data.items.map(async (message) => {
        const uiMessage = toUiMessage(message);
        if (message.role !== "assistant" || !message.runId) return uiMessage;
        // Run 是持久化事实源；历史消息只携带关联 ID，因此在进入时间线时恢复终态运行详情。
        const snapshot = await getRunSnapshot(message.runId, controller.signal).catch(() => undefined);
        return snapshot?.ok && snapshot.data.result
          ? { ...uiMessage, run: snapshot.data.result }
          : uiMessage;
      }));
      if (
        controller.signal.aborted
        || generation !== messageRequestGeneration.current
        || activeConversationIdRef.current !== conversationId
      ) return;
      setMessages((current) => append
        ? mergeMessages(current, incoming)
        : mergeMessages(incoming, current));
      setMessageCursor(result.data.nextCursor);
      setMessageState("ready");
    } catch (error) {
      if (
        controller.signal.aborted
        || generation !== messageRequestGeneration.current
        || activeConversationIdRef.current !== conversationId
      ) return;
      setMessageState("error");
      setMessageError(error instanceof Error ? error.message : "会话消息加载失败。");
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
    selectConversation(result.data.conversationId, false, true);
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

  /**
   * 切换当前会话；当前页面刚创建的空会话可跳过首次历史请求，避免与首个 Run 写消息竞态。
   *
   * @param conversationId 会话 ID。
   * @param replace 是否替换历史记录。
   * @param skipInitialHistory 是否跳过已知为空的首次历史请求。
   * @returns void。
   */
  function selectConversation(
    conversationId: string,
    replace = false,
    skipInitialHistory = false
  ): void {
    // 重复点击当前会话时 React 不会触发 ID effect；若仍重置 loading，会导致历史页永久卡住。
    if (conversationId === activeConversationIdRef.current) {
      const target = `/?conversation=${encodeURIComponent(conversationId)}`;
      navigate(target, { replace });
      return;
    }
    messageRequestController.current?.abort();
    messageRequestGeneration.current += 1;
    activeConversationIdRef.current = conversationId;
    skipInitialHistoryConversationId.current = skipInitialHistory ? conversationId : undefined;
    setMessages([]);
    setMessageCursor(undefined);
    setMessageState(skipInitialHistory ? "ready" : "loading");
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
        activeConversationIdRef.current = "";
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
      selectConversation(created.data.conversationId, false, true);
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

    setMessages((current) => [
      ...current,
      ...(current.some((item) => item.id === clientMessageId) ? [] : [userMessage]),
      pendingMessage
    ]);
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
              void loadMessagePage(activeConversationId, messageCursor, true);
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
      ) : workspaceView === "scheduled-tasks" ? (
        <ScheduledTasksWorkspace onMenuClick={() => setIsSidebarOpen(true)} />
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
