import type {
  ApiResult,
  ConversationDto,
  ReportTriggerSourceDto,
  RunStreamEventDtoV2
} from "@aiagent/types";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { SettingsDialog } from "../settings";
import { cancelRun, createAndStreamRun, type RunTerminalDto } from "../../shared/api/run-stream-client";
import {
  createConversation,
  listConversationMessages,
  listConversations,
  updateConversation as updateConversationApi
} from "../../shared/api/conversation-client";
import { ChatComposer, ChatHeader, ChatTimeline } from "./chat";
import {
  createConversationTitle,
  createUiId,
  formatApiError,
  getWorkspacePath,
  getWorkspaceView,
  mergeConversations,
  mergeMessages,
  textOfBlocks,
  toUiMessages
} from "./format";
import { projectLiveRun } from "./live-run-projection";
import { RunDetailPanel } from "./run-details";
import { ConversationSidebar } from "./sidebar";
import type { DraftAttachment, RetryRunContext, SelectedRunDetail, UiMessage } from "./types";
import { useComposerState } from "./use-composer-state";
import { DataSourcesWorkspace, ProductWorkspace, ScheduledTasksWorkspace } from "./workspace-views";

/**
 * 渲染 Immersive Agent Chat；持久化历史只来自 Conversation 线性消息 API，live Run 仅作为瞬时派生状态。
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
  const [input, setInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [composerError, setComposerError] = useState<string | undefined>();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const workspaceView = getWorkspaceView(location.pathname);
  const [selectedRunDetail, setSelectedRunDetail] = useState<SelectedRunDetail>();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [reportMode, setReportMode] = useState(false);
  const [, setActiveRunId] = useState<string>();
  const composer = useComposerState(setComposerError, ensureConversationId);
  const retrySubmission = useRef<{ message: string; clientMessageId: string } | undefined>(undefined);
  const activeRunController = useRef<AbortController | undefined>(undefined);
  const activeRunIdRef = useRef<string | undefined>(undefined);
  const cancelRequested = useRef(false);
  const activeConversationIdRef = useRef(activeConversationId);
  const messageRequestController = useRef<AbortController | undefined>(undefined);
  const messageRequestGeneration = useRef(0);
  const skipInitialHistoryConversationId = useRef<string | undefined>(undefined);
  // 记录因附件上传而自动创建的占位"新会话"，发送首条消息时据此决定是否改写标题。
  const autoCreatedConversationIdRef = useRef<string | null>(null);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.conversationId === activeConversationId),
    [activeConversationId, conversations]
  );
  const latestRunStatus = [...messages].reverse().find((message) => message.runStatus)?.runStatus;

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
   * 新协议下历史渲染只依赖线性消息列表，不再按 runId 逐个恢复快照。
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
      const incoming = toUiMessages(result.data.items);
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
   * 解析当前会话 ID：已有会话直接返回，否则先创建占位"新会话"再返回。
   * 附件上传接口要求 conversationId，因此 Composer 选择附件时会先调用它。
   *
   * @returns 当前会话 ID；创建失败时返回 null。
   */
  async function ensureConversationId(): Promise<string | null> {
    if (activeConversationIdRef.current) return activeConversationIdRef.current;
    const created = await createConversation({ title: "新会话" });
    if (!created.ok) {
      setComposerError(formatApiError(created.error));
      return null;
    }
    setConversations((current) => [created.data, ...current]);
    selectConversation(created.data.conversationId, false, true);
    autoCreatedConversationIdRef.current = created.data.conversationId;
    return created.data.conversationId;
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
   * 发送用户输入并把 run 终态挂到对应 assistant 消息，避免使用全局右侧调试状态。
   *
   * @param message 用户输入。
   * @returns 请求完成 Promise。
   */
  async function submitMessage(message: string): Promise<void> {
    await submitAgentMessage(message);
  }

  /**
   * 使用失败消息保存的输入快照创建新 Run，避免幂等键命中原失败终态。
   *
   * @param message 带重试上下文的失败 assistant 消息。
   * @returns 请求完成 Promise。
   */
  async function retryFailedMessage(message: UiMessage): Promise<void> {
    if (isSubmitting) return;
    const messageIndex = messages.findIndex((candidate) => candidate.id === message.id);
    const sourceMessage = messageIndex < 0
      ? undefined
      : messages.slice(0, messageIndex).reverse().find((candidate) => candidate.role === "user");
    const restoredAttachments = (sourceMessage?.attachments ?? []).map((attachment, ordinal) => ({
      ...attachment,
      ordinal
    }));
    const retryContext = message.retryContext ?? (sourceMessage ? {
      message: sourceMessage.content,
      modelId: message.modelId ?? composer.selectedModelId,
      reportMode: false,
      attachments: restoredAttachments
    } : undefined);
    if (!retryContext?.modelId) return;
    retrySubmission.current = undefined;
    await submitAgentMessage(retryContext.message, undefined, retryContext);
  }

  /**
   * 发送用户输入并把 run 结果挂到对应 assistant 消息，live 事件实时投影为内容块。
   *
   * @param message 用户输入。
   * @param triggerSource 可选 Report Skill 显式触发来源。
   * @returns 请求完成 Promise。
   */
  async function submitAgentMessage(
    message: string,
    triggerSource?: ReportTriggerSourceDto,
    retryContext?: RetryRunContext
  ): Promise<void> {
    const trimmed = message.trim();
    const indexedAttachments = composer.attachments.filter(
      (attachment): attachment is DraftAttachment & { documentId: string } =>
        attachment.status === "indexed" && Boolean(attachment.documentId)
    );
    const submittedModelId = retryContext?.modelId ?? composer.selectedModelId;
    const submittedAttachments = retryContext?.attachments ?? indexedAttachments.map((attachment, ordinal) => ({
      attachmentId: attachment.clientAttachmentId,
      documentId: attachment.documentId,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      ordinal
    }));
    if (!trimmed || isSubmitting || !submittedModelId
      || (!retryContext && indexedAttachments.length !== composer.attachments.length)) {
      return;
    }
    // 附件上传可能已自动创建会话；优先复用当前 ref 指向的会话，再回退到已选中会话。
    let conversation = conversations.find(
      (item) => item.conversationId === activeConversationIdRef.current
    ) ?? activeConversation;
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
    // 自动创建的占位"新会话"在首条消息发送时改写成问题摘要；改名是尽力而为，失败不阻塞发送。
    if (submittedConversationId === autoCreatedConversationIdRef.current && conversation.title === "新会话") {
      const title = createConversationTitle(trimmed);
      autoCreatedConversationIdRef.current = null;
      // 同步本地快照标题，避免下方通用改名分支重复请求。
      conversation = { ...conversation, title };
      void updateConversationApi(submittedConversationId, { title })
        .then((result) => {
          if (result.ok) setConversations((current) =>
            current.map((item) => item.conversationId === submittedConversationId ? result.data : item));
        })
        .catch(() => {
          // 改名失败不影响消息发送。
        });
    }

    const submittedReportMode = retryContext?.reportMode ?? reportMode;
    const pendingMessageId = createUiId("assistant");
    const clientMessageId = !retryContext && retrySubmission.current?.message === trimmed
      ? retrySubmission.current.clientMessageId
      : crypto.randomUUID();
    retrySubmission.current = { message: trimmed, clientMessageId };
    const now = new Date().toISOString();
    const userMessage: UiMessage = {
      id: clientMessageId,
      role: "user",
      content: trimmed,
      blocks: [],
      createdAt: now,
      status: "complete",
      attachments: submittedAttachments
    };
    const pendingMessage: UiMessage = {
      id: pendingMessageId,
      role: "assistant",
      content: "",
      blocks: [],
      createdAt: now,
      status: "pending",
      liveEvents: [],
      modelId: submittedModelId,
      retryContext: {
        message: trimmed,
        modelId: submittedModelId,
        reportMode: submittedReportMode,
        attachments: submittedAttachments
      }
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
    // live 事件累积在闭包内，终态时一次性投影为消息块，避免渲染期反复重算。
    const liveEvents: RunStreamEventDtoV2[] = [];

    try {
      const result = await runAgent(
        trimmed,
        submittedReportMode || triggerSource === "button",
        submittedConversationId,
        clientMessageId,
        submittedModelId,
        submittedAttachments.map((attachment) => attachment.documentId),
        triggerSource,
        (event) => {
          liveEvents.push(event);
          setMessages((current) => current.map((item) => item.id === pendingMessageId
            ? { ...item, liveEvents: [...liveEvents] }
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
          if (!retryContext) {
            composer.clearAttachments(indexedAttachments.map((attachment) => attachment.clientAttachmentId));
          }
        },
        runController.signal
      );

      const projection = projectLiveRun(liveEvents);
      const finalBlocks = projection.blocks;
      const finalText = textOfBlocks(finalBlocks);

      if (!result.ok) {
        const cancelledRun = result.error.code === "request_cancelled";
        replaceMessage(submittedConversationId, pendingMessageId, {
          content: finalText || formatApiError(result.error),
          blocks: finalBlocks,
          status: cancelledRun ? "cancelled" : "failed",
          ok: false,
          runStatus: cancelledRun ? "cancelled" : "failed",
          error: result.error,
          liveEvents: undefined
        });
        if (!cancelledRun) {
          setComposerError("请求失败，已把结构化错误写入当前 assistant 消息。");
        }
        return;
      }

      retrySubmission.current = undefined;
      replaceMessage(submittedConversationId, pendingMessageId, {
        content: finalText,
        blocks: finalBlocks,
        status: "complete",
        ok: true,
        runStatus: result.data.status,
        liveEvents: undefined
      });
    } catch (caught) {
      if (runController.signal.aborted) {
        const projection = projectLiveRun(liveEvents);
        replaceMessage(submittedConversationId, pendingMessageId, {
          content: textOfBlocks(projection.blocks) || "已停止本次生成。",
          blocks: projection.blocks,
          status: "cancelled",
          ok: false,
          runStatus: "cancelled",
          liveEvents: undefined
        });
        return;
      }
      const messageText = caught instanceof Error ? caught.message : "请求失败，请检查 API 服务是否已启动。";
      replaceMessage(submittedConversationId, pendingMessageId, {
        content: messageText,
        status: "failed",
        ok: false,
        runStatus: "failed"
      });
      setComposerError("请求失败，请确认 apps/finance-api 和 apps/finance-web 已通过 pnpm dev 启动。");
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
        onOpenSettings={() => setIsSettingsOpen(true)}
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
            latestRunStatus={latestRunStatus}
            onMenuClick={() => setIsSidebarOpen(true)}
          />

          <ChatTimeline
            conversationId={activeConversationId}
            compactEmpty
            isSubmitting={isSubmitting}
            error={messageError}
            hasMore={Boolean(messageCursor)}
            isLoading={messageState === "loading"}
            messages={messages}
            onLoadMore={() => {
              if (!activeConversationId) return;
              void loadMessagePage(activeConversationId, messageCursor, true);
            }}
            onOpenRunDetail={setSelectedRunDetail}
            onRetryMessage={(message) => void retryFailedMessage(message)}
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
        <section className="chat-main" aria-label="Agent Chat 主区域">
          <ChatHeader
            conversationTitle={activeConversation?.title ?? "新会话"}
            isSubmitting={isSubmitting}
            latestRunStatus={latestRunStatus}
            onMenuClick={() => setIsSidebarOpen(true)}
          />
        </section>
      ) : (
        <ProductWorkspace onMenuClick={() => setIsSidebarOpen(true)} view={workspaceView} />
      )}
      <RunDetailPanel
        detail={selectedRunDetail}
        onClose={() => setSelectedRunDetail(undefined)}
      />
      <SettingsDialog isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
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
  onEvent?: (event: RunStreamEventDtoV2) => void,
  onAccepted?: (runId: string) => void | Promise<void>,
  signal?: AbortSignal
): Promise<ApiResult<RunTerminalDto>> {
  return createAndStreamRun({
    message,
    conversationId: conversationId ?? createUiId("conversation"),
    clientMessageId,
    modelId,
    attachmentDocumentIds,
    mode: reportMode ? "report" : "auto",
    source: reportTriggerSource === "button" ? "report_button" : "composer",
    // 阶段 5：report 开关不再产生 API 层编排分支，而是以 hint 约束模型调用 generate_report 工具。
    metadata: reportMode ? { hint: "report" } : undefined
  }, { onEvent, onAccepted: (accepted) => onAccepted?.(accepted.runId), signal });
}
