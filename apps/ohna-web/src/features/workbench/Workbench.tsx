import type {
  ApiResult,
  WorkspaceConversationDto,
  RunStreamEventDtoV2
} from "@aiagent/types";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { TraceToggle, WorkbenchNav } from "../../app/workbench-nav";
import { SettingsDialog } from "../settings/SettingsDialog";
import { TraceDrawer } from "../trace/TraceDrawer";
import { cancelRun, createAndStreamRun, replayRunEvents, type RunTerminalDto } from "../../shared/api/run-stream-client";
import { fetchLocalMode, type LocalModeInfo } from "../../shared/mode";
import {
  deriveConfirmationCards,
  submitConfirmation,
  type ConfirmationCard,
  type ConfirmationDecision
} from "./confirmations";
import { ConfirmationCards, type ConfirmationCardUiState } from "./confirmation-cards";
import {
  createConversation,
  generateConversationTitle,
  listConversationMessages,
  listConversations,
  updateConversation as updateConversationApi
} from "../../shared/api/conversation-client";
import { ChatComposer, ChatHeader, ChatTimeline } from "./chat";
import { ChatMain } from "./chat-main";
import {
  applyFailure,
  createConversationTitle,
  createUiId,
  formatApiError,
  mergeConversations,
  mergeMessages,
  textOfBlocks,
  toUiMessages
} from "./format";
import { projectLiveRun } from "./live-run-projection";
import { RunDetailPanel } from "./run-details";
import { ConversationSidebar } from "./sidebar";
import type { RetryRunContext, SelectedRunDetail, UiMessage } from "./types";
import { useComposerState } from "./use-composer-state";

/** composer 表单 id：主区左下角设置按钮与发送键同处底行（FR-001）。 */
const COMPOSER_FORM_ID = "chat-composer-form";

/**
 * 渲染 ohna 本地工作台：左会话列表 + 文件树 + 中央时间线 + composer + 待确认卡片。
 * 持久化历史只来自 Conversation 线性消息 API，live Run 仅作为瞬时派生状态；
 * 未决确认卡片从 run 事件流推导（含刷新后 SSE replay 恢复，W-9）。
 *
 * @returns 本地编码 Agent 主页面。
 */
export function Workbench() {
  const location = useLocation();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<WorkspaceConversationDto[]>([]);
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
  // Trace 抽屉（D3）：初始收起、不读 URL——刷新即回到对话视图。
  const [isTraceOpen, setIsTraceOpen] = useState(false);
  // 设置弹窗（FR-001）：就地弹窗、不读 URL；关闭即卸载内容，健康探针随之中止。
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [localMode, setLocalMode] = useState<LocalModeInfo | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] = useState<SelectedRunDetail>();
  const [_activeRunId, setActiveRunId] = useState<string>();
  // 确认卡片：事件流（实时 + replay）→ 推导卡片；交互状态按 toolCallId 记录。
  const [confirmationEvents, setConfirmationEvents] = useState<RunStreamEventDtoV2[]>([]);
  const [confirmationUi, setConfirmationUi] = useState<Record<string, ConfirmationCardUiState>>({});
  const composer = useComposerState();
  const retrySubmission = useRef<{ message: string; clientMessageId: string } | undefined>(undefined);
  const activeRunController = useRef<AbortController | undefined>(undefined);
  const activeRunIdRef = useRef<string | undefined>(undefined);
  const cancelRequested = useRef(false);
  const activeConversationIdRef = useRef(activeConversationId);
  const messageRequestController = useRef<AbortController | undefined>(undefined);
  const messageRequestGeneration = useRef(0);
  const skipInitialHistoryConversationId = useRef<string | undefined>(undefined);
  // 刷新恢复（W-9）的 SSE replay 控制器：切换会话 / 组件卸载时中断。
  const replayController = useRef<AbortController | undefined>(undefined);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.conversationId === activeConversationId),
    [activeConversationId, conversations]
  );
  const latestRunStatus = [...messages].reverse().find((message) => message.runStatus)?.runStatus;
  const confirmationCards = deriveConfirmationCards(confirmationEvents);

  /**
   * 关闭设置弹窗。必须是稳定引用（`useCallback`）：`useDialogFocus` 依赖 onClose，
   * 每次渲染换新函数会让监听重绑，并在弹窗仍打开时重跑「焦点归还」清理。
   */
  const closeSettings = useCallback(() => setIsSettingsOpen(false), []);

  /**
   * 切换 Trace 抽屉。右侧位互斥（L2-3 / TC-L2-04）：Trace 抽屉与 RunDetailPanel 都是
   * 「右侧排查位」，打开其一即收起另一个，避免两套面板抢同一列。
   *
   * @returns void。
   */
  function toggleTrace(): void {
    setIsTraceOpen((current) => {
      if (!current) setSelectedRunDetail(undefined);
      return !current;
    });
  }

  /**
   * 打开某条 assistant 消息的运行详情；同时收起 Trace 抽屉（互斥的另一半）。
   *
   * @param detail 选中的消息与分区。
   * @returns void。
   */
  function openRunDetail(detail: SelectedRunDetail): void {
    setIsTraceOpen(false);
    setSelectedRunDetail(detail);
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadConversationPage(undefined, false, controller.signal);
    void fetchLocalMode(controller.signal).then((mode) => setLocalMode(mode));
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

  // 卸载时中断 replay 流，避免离开页面后仍在消费 SSE。
  useEffect(() => () => replayController.current?.abort(), []);

  /**
   * 处理单条 run 事件：live 投影、确认卡片累积（W-4/W-9）、文件树联动（W-8）共用此入口。
   *
   * @param event canonical run event envelope。
   * @returns 无返回值。
   */
  function handleRunEvent(event: RunStreamEventDtoV2): void {
    setConfirmationEvents((current) => {
      // replay 与 live 可能重叠投递，按 sequence 去重。
      if (current.some((item) => item.sequence === event.sequence)) return current;
      return [...current, event];
    });
    if (event.type === "tool_execution_end") {
      const payload = (event.payload ?? {}) as { toolCallId?: string; toolName?: string };
      // 写类工具落地后解除该卡片的提交中状态。
      if (payload.toolCallId) {
        setConfirmationUi((current) => {
          if (!(payload.toolCallId! in current)) return current;
          const next = { ...current };
          delete next[payload.toolCallId!];
          return next;
        });
      }
    }
  }

  /**
   * 用 SSE replay 恢复某个 run 的事件（W-9）：页面刷新后历史里最后一条 user 消息
   * 携带 runId，重放事件流即可用同一推导函数恢复未决确认卡片并联动文件树。
   *
   * @param runId Run 标识。
   * @returns 无返回值。
   */
  function startReplay(runId: string): void {
    replayController.current?.abort();
    const controller = new AbortController();
    replayController.current = controller;
    setConfirmationEvents([]);
    void replayRunEvents(runId, { signal: controller.signal, onEvent: handleRunEvent });
  }

  /**
   * 提交确认决定（W-4）：提交期间禁用按钮并显示「提交中」；
   * 失败把结构化错误挂在对应卡片上；成功后等待 tool_execution_end 收敛已决态。
   *
   * @param card 目标卡片。
   * @param decision allow / deny。
   * @returns 提交完成 Promise。
   */
  async function handleDecide(card: ConfirmationCard, decision: ConfirmationDecision): Promise<void> {
    setConfirmationUi((current) => ({ ...current, [card.toolCallId]: { ...current[card.toolCallId], submitting: decision, error: undefined } }));
    const result = await submitConfirmation(card.runId, card.toolCallId, decision);
    if (!result.ok) {
      setConfirmationUi((current) => ({
        ...current,
        [card.toolCallId]: { ...current[card.toolCallId], submitting: undefined, error: formatApiError(result.error) }
      }));
    }
  }

  /**
   * 加载会话分页；服务端列表是历史唯一事实源，追加时按 ID 去重。
   *
   * 侧栏展示全部工作区的会话（03 D1 分组），因此这里的列表是**全量**；它同时也是 composer
   * 的目标会话查找源——服务端已按会话 workspaceRoot 装配 agent 上下文，前端不再按工作区过滤。
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
   * 初始历史加载完成后，若末条是带 runId 的 user 消息（run 可能仍在途 / 待确认），
   * 则启动 SSE replay 恢复未决确认卡片（W-9）。
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
    if (!append) setMessageState("loading");
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
      // 初始历史（非追加分页）末条是 user 消息且带 runId → 可能存在未决确认 / 在途 run。
      if (!append && !cursor) {
        const last = result.data.items[result.data.items.length - 1];
        if (last && last.role === "user" && last.runId) {
          startReplay(last.runId);
        }
      }
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
      setComposerError("正在等待服务端确认任务，确认后将立即停止；输入会保留。");
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
   * 重置当前视图到「待创建」的新会话草稿态（BUG-001 web）。
   *
   * 不落盘任何会话：activeConversationId 置空串表示「尚无活跃会话」，首条真实消息发送时
   * 才由 submitAgentMessage 的懒创建分支调用 createConversation。此处的状态重置需与
   * selectConversation 保持一致（清空消息 / 游标 / 确认卡片 / replay，并重置 skip 占位），
   * 保证从一个已选会话切到新会话时不会残留上一会话的历史与派生状态。
   *
   * @returns void。
   */
  function resetToDraft(): void {
    messageRequestController.current?.abort();
    messageRequestGeneration.current += 1;
    replayController.current?.abort();
    setConfirmationEvents([]);
    setConfirmationUi({});
    activeConversationIdRef.current = "";
    skipInitialHistoryConversationId.current = undefined;
    setMessages([]);
    setMessageCursor(undefined);
    setMessageState("ready");
    setActiveConversationId("");
    navigate("/", { replace: true });
  }

  /**
   * 打开一个「空的新会话」编辑态，不立即调用 createConversation 落盘（BUG-001 web）。
   *
   * 点击侧栏「New Chat」仅清空当前会话上下文并回到可输入的草稿态（header 显示「新会话」、
   * composer 可用）；真正落盘推迟到首条真实消息发送时（submitAgentMessage 懒创建）。
   *
   * @returns void。
   */
  function handleNewConversation(): void {
    resetToDraft();
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
    replayController.current?.abort();
    setConfirmationEvents([]);
    setConfirmationUi({});
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
   * 发送用户输入。
   *
   * @param message 用户输入。
   * @returns 请求完成 Promise。
   */
  async function submitMessage(message: string): Promise<void> {
    await submitAgentMessage(message);
  }

  /**
   * 首条消息懒创建会话后，异步把标题升级为语义标题（BUG-002 的第二步）。
   *
   * 截断标题在 `createConversation({ title: createConversationTitle(...) })` 创建时已落盘并
   * 同步进侧栏，因此这里只负责「语义升级」：异步请求服务端语义标题并改写侧栏。全程
   * fire-and-forget，绝不阻塞消息发送；失败静默保留创建时的截断标题（服务端返回现有标题
   * 或前端 catch 后不动）。
   *
   * 该函数只在「首条消息懒创建会话」的当次提交被调用一次（见 submitAgentMessage 的
   * isNewConversation 守卫）；既有会话 / 多轮消息 / 重试都不会再触发，避免把已生成的
   * 语义标题覆盖为最新一条消息的截断值，并产生多余的 LLM 调用。
   *
   * @param conversationId 会话 id。
   * @param firstMessage 首条用户消息。
   * @returns 无返回值。
   */
  function ensureConversationTitle(conversationId: string, firstMessage: string): void {
    const truncated = createConversationTitle(firstMessage);
    void generateConversationTitle(conversationId, firstMessage).then((result) => {
      // 服务端语义标题成功且与截断值不同才改写侧栏；失败时返回现有截断标题，这里保持不变。
      if (result.ok && result.data.title !== truncated) {
        setConversations((current) =>
          current.map((item) => item.conversationId === conversationId ? result.data : item));
      }
    }).catch(() => {
      // 语义标题生成失败静默降级，保留创建时的截断标题。
    });
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
    const retryContext = message.retryContext ?? (sourceMessage ? {
      message: sourceMessage.content,
      modelId: message.modelId ?? composer.selectedModelId
    } : undefined);
    if (!retryContext?.modelId) return;
    retrySubmission.current = undefined;
    await submitAgentMessage(retryContext.message, retryContext);
  }

  /**
   * 发送用户输入并把 run 结果挂到对应 assistant 消息，live 事件实时投影为内容块；
   * 同时驱动确认卡片与文件树联动。终态后从消息列表 API 拉终态正文替换本地投影。
   *
   * @param message 用户输入。
   * @param retryContext 失败重试的输入快照。
   * @returns 请求完成 Promise。
   */
  async function submitAgentMessage(
    message: string,
    retryContext?: RetryRunContext
  ): Promise<void> {
    const trimmed = message.trim();
    const submittedModelId = retryContext?.modelId ?? composer.selectedModelId;
    if (!trimmed || isSubmitting || !submittedModelId) {
      return;
    }
    // 目标会话唯一查找（BUG-002）：服务端已按会话 workspaceRoot 装配 agent 上下文，
    // 前端不再区分工作区，active 会话必然在侧栏 conversations 里（侧栏选中或新建后 prepend）。
    const currentId = activeConversationIdRef.current;
    let conversation: WorkspaceConversationDto | undefined = conversations.find(
      (item) => item.conversationId === currentId
    );
    // 本次提交是否懒创建了新会话：只有这种情况才算「首条消息」，需要触发一次语义标题升级。
    let isNewConversation = false;
    if (!conversation) {
      const created = await createConversation({ title: createConversationTitle(trimmed) });
      if (!created.ok) {
        setComposerError(formatApiError(created.error));
        return;
      }
      conversation = created.data;
      setConversations((current) => [created.data, ...current]);
      selectConversation(created.data.conversationId, false, true);
      isNewConversation = true;
    }

    const submittedConversationId = conversation.conversationId;
    // BUG-002：仅在「首条消息懒创建会话」时触发一次语义标题升级。既有会话的标题在创建时
    // 已建立，多轮消息 / 重试会再次命中此分支（conversation 已在侧栏）——若在此触发，会把
    // 已生成的语义标题覆盖为最新消息的截断值，并产生多余的 LLM 调用，因此必须跳过。
    if (isNewConversation) {
      ensureConversationTitle(submittedConversationId, trimmed);
    }

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
      status: "complete"
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
        modelId: submittedModelId
      }
    };

    setMessages((current) => [
      ...current,
      ...(current.some((item) => item.id === clientMessageId) ? [] : [userMessage]),
      pendingMessage
    ]);
    setComposerError(undefined);
    setIsSubmitting(true);
    // 新 run 开始：重置确认卡片流，旧 run 的已决卡片不再展示。
    setConfirmationEvents([]);
    setConfirmationUi({});
    const runController = new AbortController();
    cancelRequested.current = false;
    activeRunController.current = runController;
    // live 事件累积在闭包内，终态时一次性投影为消息块，避免渲染期反复重算。
    const liveEvents: RunStreamEventDtoV2[] = [];

    try {
      const result = await runAgent(
        trimmed,
        submittedConversationId,
        clientMessageId,
        submittedModelId,
        (event) => {
          liveEvents.push(event);
          setMessages((current) => current.map((item) => item.id === pendingMessageId
            ? { ...item, liveEvents: [...liveEvents] }
            : item));
          handleRunEvent(event);
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
              setComposerError("已停止服务端任务，输入已保留。");
              runController.abort();
              return;
            }
          }
          // 只清理由本次 accepted Run 消费的草稿，避免迟到回调删除用户随后输入的内容。
          setInput((current) => current === trimmed ? "" : current);
        },
        runController.signal
      );

      const projection = projectLiveRun(liveEvents);
      const finalBlocks = projection.blocks;
      const finalText = textOfBlocks(finalBlocks);

      if (!result.ok) {
        const cancelledRun = result.error.code === "request_cancelled";
        // BUG-001 错误落点唯一化：失败态的字段组合（正文 / error / status / runStatus）由
        // format.ts 的 applyFailure 单点构造并单测，避免后续调用点各自拼出正文与 error-block
        // 重复展示同一错误。replaceMessage 只合并传入字段，因此 retryContext 会保留。
        replaceMessage(submittedConversationId, pendingMessageId, applyFailure(result.error, finalBlocks, cancelledRun));
        // 取消是用户主动行为：status 已表达 cancelled，不再额外弹 composer 提示。
        if (!cancelledRun) {
          setComposerError("请求失败，错误详情见下方消息。");
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
      // 终态正文以服务端消息列表为准：拉取后移除本地 pending 占位，避免与持久化消息重复。
      void refreshTerminalMessages(submittedConversationId, pendingMessageId, activeRunIdRef.current);
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
      const messageText = caught instanceof Error ? caught.message : "请求失败，请检查本地服务是否已启动。";
      replaceMessage(submittedConversationId, pendingMessageId, {
        content: messageText,
        status: "failed",
        ok: false,
        runStatus: "failed"
      });
      setComposerError("请求失败，请确认 ohna 服务已启动（ohna --web 或 pnpm --filter @aiagent/ohna-cli start）且代理端口一致。");
    } finally {
      setIsSubmitting(false);
      setActiveRunId(undefined);
      activeRunIdRef.current = undefined;
      activeRunController.current = undefined;
      cancelRequested.current = false;
    }
  }

  /**
   * run 终态后重新拉取会话消息（终态正文以服务端为准）。
   * 只有服务端已可见该 run 的 assistant 消息时才移除本地 pending 占位，
   * 避免落盘竞态导致终端内容闪空。
   *
   * @param conversationId 会话 id。
   * @param pendingMessageId 本地 pending 占位 id。
   * @param runId 刚结束的 Run id。
   * @returns 刷新完成 Promise。
   */
  async function refreshTerminalMessages(
    conversationId: string,
    pendingMessageId: string,
    runId: string | undefined
  ): Promise<void> {
    const result = await listConversationMessages(conversationId);
    if (!result.ok || activeConversationIdRef.current !== conversationId) return;
    const serverItems = toUiMessages(result.data.items);
    const hasRunAssistant = runId !== undefined
      && serverItems.some((item) => item.role === "assistant" && item.runId === runId);
    if (!hasRunAssistant) return;
    setMessages((current) => {
      const withoutPending = current.filter((item) => item.id !== pendingMessageId);
      return mergeMessages(withoutPending, serverItems);
    });
    setMessageState("ready");
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
    <main className={[
      "agent-app-shell",
      selectedRunDetail ? "has-detail-panel" : "",
      isTraceOpen ? "has-trace-panel" : ""
    ].filter(Boolean).join(" ")}>
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
        onNewConversation={handleNewConversation}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onRetry={() => void loadConversationPage()}
        onSelectConversation={handleSelectConversation}
      />

      <ChatMain
        header={(
          <ChatHeader
            conversationTitle={activeConversation?.title ?? "新会话"}
            isSubmitting={isSubmitting}
            latestRunStatus={latestRunStatus}
            localMode={localMode}
            onMenuClick={() => setIsSidebarOpen(true)}
            nav={(
              <nav className="app-nav" aria-label="工作台导航">
                <WorkbenchNav />
                <TraceToggle isOpen={isTraceOpen} onToggle={toggleTrace} />
              </nav>
            )}
          />
        )}
        confirmations={(
          <ConfirmationCards cards={confirmationCards} uiState={confirmationUi} onDecide={(card, decision) => void handleDecide(card, decision)} />
        )}
        timeline={(
          <ChatTimeline
            conversationId={activeConversationId}
            isSubmitting={isSubmitting}
            error={messageError}
            hasMore={Boolean(messageCursor)}
            isLoading={messageState === "loading"}
            messages={messages}
            onLoadMore={() => {
              if (!activeConversationId) return;
              void loadMessagePage(activeConversationId, messageCursor, true);
            }}
            onOpenRunDetail={openRunDetail}
            onRetryMessage={(message) => void retryFailedMessage(message)}
            onUsePrompt={setInput}
            showCliHint={activeConversation?.title.startsWith("CLI ·") ?? false}
          />
        )}
        composer={(
          <ChatComposer
            error={composerError}
            formId={COMPOSER_FORM_ID}
            input={input}
            isSubmitting={isSubmitting}
            models={composer.models}
            modelCatalogStatus={composer.modelCatalogStatus}
            modelCatalogError={composer.modelCatalogError}
            onInputChange={setInput}
            onRetryModels={composer.retryModels}
            onSelectModel={composer.selectModel}
            onStop={() => void handleStop()}
            onSubmit={handleSubmit}
            onUsePrompt={setInput}
            selectedModelId={composer.selectedModelId}
          />
        )}
        composerFormId={COMPOSER_FORM_ID}
      />
      {/* 右侧排查位互斥（L2-3）：Trace 抽屉与运行详情共用同一列，打开一个即收起另一个。 */}
      <RunDetailPanel
        detail={selectedRunDetail}
        onClose={() => setSelectedRunDetail(undefined)}
      />
      <TraceDrawer
        conversationId={activeConversation?.conversationId}
        conversationTitle={activeConversation?.title ?? "未选择会话"}
        isOpen={isTraceOpen}
        onClose={() => setIsTraceOpen(false)}
      />
      {/* 设置弹窗：`App` 的 ThemeProvider 在外层，主题/字号偏好上下文可直接复用。 */}
      <SettingsDialog isOpen={isSettingsOpen} onClose={closeSettings} />
    </main>
  );
}

/**
 * 创建异步 Agent run 并消费 SSE，过程事件实时回写 assistant 消息。
 *
 * @param message 当前用户输入。
 * @param conversationId 当前会话 ID。
 * @param clientMessageId 用户消息幂等键。
 * @param modelId 模型目录 ID。
 * @param onEvent 实时事件回调。
 * @param onAccepted accepted 回调（拿到 runId 后才能停止）。
 * @param signal 取消信号。
 * @returns terminal API 运行结果。
 */
async function runAgent(
  message: string,
  conversationId: string,
  clientMessageId: string,
  modelId: string,
  onEvent?: (event: RunStreamEventDtoV2) => void,
  onAccepted?: (runId: string) => void | Promise<void>,
  signal?: AbortSignal
): Promise<ApiResult<RunTerminalDto>> {
  return createAndStreamRun({
    message,
    conversationId,
    clientMessageId,
    modelId,
    mode: "auto",
    source: "composer"
  }, { onEvent, onAccepted: (accepted) => onAccepted?.(accepted.runId), signal });
}
