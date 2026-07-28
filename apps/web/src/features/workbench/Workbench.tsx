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
import { cancelRun, createAndStreamRun } from "../../shared/api/run-stream-client";
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
import type { DraftAttachment, SelectedRunDetail, UiMessage } from "./types";
import { useComposerState } from "./use-composer-state";
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
  const [activeRunId, setActiveRunId] = useState<string>();
  const composer = useComposerState(setComposerError);
  const retrySubmission = useRef<{ message: string; clientMessageId: string } | undefined>(undefined);
  const activeRunController = useRef<AbortController | undefined>(undefined);
  const activeRunIdRef = useRef<string | undefined>(undefined);
  const cancelRequested = useRef(false);
  const activeConversationIdRef = useRef(activeConversationId);
  const messageRequestController = useRef<AbortController | undefined>(undefined);
  const messageRequestGeneration = useRef(0);
  const skipInitialHistoryConversationId = useRef<string | undefined>(undefined);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.conversationId === activeConversationId),
    [activeConversationId, conversations]
  );
  const latestRun = [...messages].reverse().find((message) => message.run)?.run;

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

  /** @returns 取消当前服务端 Run 的 Promise。 */
  async function handleStop(): Promise<void> {
    const runId = activeRunIdRef.current;
    if (!runId) {
      // 不能 abort 创建请求：服务端可能已经提交 Run，只是 202 尚未到达浏览器。
      cancelRequested.current = true;
      setComposerError("正在等待服务端确认任务，确认后将立即停止；草稿会保留。");
      return;
    }
    const result = await cancelRun(runId);
    if (!result.ok) {
      setComposerError(formatApiError(result.error));
      return;
    }
    // 已取消 Run 的 clientMessageId 不能用于原文重试，否则服务端会返回相同取消终态。
    retrySubmission.current = undefined;
    activeRunController.current?.abort();
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
   * 发送用户输入并把 run 结果挂到对应 assistant 消息，避免使用全局右侧调试状态。
   *
   * @param message 用户输入。
   * @param triggerSource 可选 Report Skill 显式触发来源。
   * @returns 请求完成 Promise。
   */
  async function submitAgentMessage(message: string, triggerSource?: ReportTriggerSourceDto): Promise<void> {
    const trimmed = message.trim();
    const indexedAttachments = composer.attachments.filter(
      (attachment): attachment is DraftAttachment & { documentId: string } =>
        attachment.status === "indexed" && Boolean(attachment.documentId)
    );
    if (!trimmed || isSubmitting || !composer.selectedModelId
      || indexedAttachments.length !== composer.attachments.length) {
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
      ,
      attachments: indexedAttachments.map((attachment, ordinal) => ({
        attachmentId: attachment.clientAttachmentId,
        documentId: attachment.documentId,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        ordinal
      }))
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
    setComposerError(undefined);
    setIsSubmitting(true);
    const runController = new AbortController();
    cancelRequested.current = false;
    activeRunController.current = runController;

    try {
      const result = await runAgent(
        trimmed,
        submittedReportMode || triggerSource === "button",
        submittedConversationId,
        clientMessageId,
        composer.selectedModelId,
        indexedAttachments.map((attachment) => attachment.documentId),
        triggerSource,
        (event) => {
          replaceMessage(submittedConversationId, pendingMessageId, {
            content: formatRunProgress(event)
          });
          setMessages((current) => current.map((item) => item.id === pendingMessageId
            ? { ...item, streamEvents: [...(item.streamEvents ?? []), event] }
            : item));
        },
        async (runId) => {
          // ref 必须先于 React state 更新，Stop 不依赖下一次 render 才能看到 accepted Run。
          activeRunIdRef.current = runId;
          setActiveRunId(runId);
          if (cancelRequested.current) {
            const cancelled = await cancelRun(runId);
            if (!cancelled.ok) {
              cancelRequested.current = false;
              setComposerError(formatApiError(cancelled.error));
              // 取消失败后继续消费既有 Run，因此恢复正常 accepted 语义并清理本次已提交草稿。
            }
            if (cancelled.ok) {
              // 此次 accepted Run 已被取消；下次重试必须使用新 clientMessageId，不能命中取消终态。
              retrySubmission.current = undefined;
              setComposerError("已停止服务端任务，输入和附件草稿已保留。");
              runController.abort();
              return;
            }
          }
          // 只清理由本次 accepted Run 消费的草稿，避免迟到回调删除用户随后输入或新增的附件。
          setInput((current) => current === trimmed ? "" : current);
          composer.clearAttachments(indexedAttachments.map((attachment) => attachment.clientAttachmentId));
        },
        runController.signal
      );

      if (!result.ok) {
        const messageText = formatApiError(result.error);
        replaceMessage(submittedConversationId, pendingMessageId, {
          content: messageText,
          status: result.error.code === "request_cancelled" ? "cancelled" : "failed",
          ok: false
        });
        if (result.error.code !== "request_cancelled") {
          setComposerError("请求失败，已把结构化错误写入当前 assistant 消息。");
        }
        return;
      }

      const run = result.data;
      retrySubmission.current = undefined;
      replaceMessage(submittedConversationId, pendingMessageId, {
        content: run.answer,
        status: run.ok ? "complete" : run.error?.code === "request_cancelled" ? "cancelled" : "failed",
        ok: run.ok,
        run,
        streamEvents: undefined
      });

      if (!run.ok && run.error) {
        setComposerError(formatApiError(run.error));
      }
    } catch (caught) {
      if (runController.signal.aborted) {
        replaceMessage(submittedConversationId, pendingMessageId, {
          content: "已停止本次生成。",
          status: "cancelled",
          ok: false,
          streamEvents: undefined
        });
        return;
      }
      const messageText = caught instanceof Error ? caught.message : "请求失败，请检查 API 服务是否已启动。";
      replaceMessage(submittedConversationId, pendingMessageId, {
        content: messageText,
        status: "failed",
        ok: false
      });
      setComposerError("请求失败，请确认 apps/api 和 apps/web 已通过 pnpm dev 启动。");
    } finally {
      setIsSubmitting(false);
      setActiveRunId(undefined);
      activeRunIdRef.current = undefined;
      activeRunController.current = undefined;
      cancelRequested.current = false;
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
    if (conversationId !== activeConversationIdRef.current) return;
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
            onMenuClick={() => setIsSidebarOpen(true)}
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
            attachments={composer.attachments}
            error={composerError}
            input={input}
            isSubmitting={isSubmitting}
            models={composer.models}
            modelCatalogStatus={composer.modelCatalogStatus}
            modelCatalogError={composer.modelCatalogError}
            onFilesSelected={composer.onFilesSelected}
            onInputChange={setInput}
            onRemoveAttachment={composer.removeAttachment}
            onReportModeChange={handleReportModeChange}
            onRetryAttachment={composer.retryAttachment}
            onRetryModels={composer.retryModels}
            onSelectModel={composer.selectModel}
            onStop={() => void handleStop()}
            onSubmit={handleSubmit}
            onUsePrompt={setInput}
            reportMode={reportMode}
            selectedModelId={composer.selectedModelId}
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
 * @param modelId 模型目录 ID。
 * @param attachmentDocumentIds 当前消息允许检索的附件文档 ID。
 * @param reportTriggerSource 显式研报触发来源。
 * @param onEvent 实时事件回调。
 * @returns terminal API 运行结果。
 */
async function runAgent(
  message: string,
  reportMode: boolean,
  conversationId: string | undefined,
  clientMessageId: string,
  modelId: string,
  attachmentDocumentIds: string[],
  reportTriggerSource?: ReportTriggerSourceDto,
  onEvent?: (event: AgentRunStreamEventDto) => void,
  onAccepted?: (runId: string) => void | Promise<void>,
  signal?: AbortSignal
): Promise<ApiResult<AgentRunResponseDto>> {
  return createAndStreamRun({
    message,
    conversationId: conversationId ?? createUiId("conversation"),
    clientMessageId,
    modelId,
    attachmentDocumentIds,
    mode: reportMode ? "report" : "auto",
    source: reportTriggerSource === "button" ? "report_button" : "composer"
  }, { onEvent, onAccepted: (accepted) => onAccepted?.(accepted.runId), signal });
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
