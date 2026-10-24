/**
 * 交互式 REPL（单一形态，docs/v1.4/06 D-A1）：终端是进程内 serve 的执行线订阅者。
 *
 * 由「CLI 本地执行 + serve 镜像观测」改为「serve 持有执行权，终端经
 * `server.createRun` + `server.subscribeConversation` 共享同一会话事件流」：
 * - 普通文本 → `server.createRun({ conversationId, message, source:"composer" })`；
 * - 会话事件（agent 帧 / user_message / run_status / confirmation_requested）经订阅回流，
 *   由 `renderFrame` 渲染；浏览器同会话的 run 也会实时出现在终端（共享事件流，C-M3-6）；
 * - 权限卡改经事件回流：订阅到 `confirmation_requested` 后终端决议并调用
 *   `server.resolveConfirmation`（不再本地 `beforeToolCall` 拦截 serve 侧工具执行）；
 * - `/resume` `/export` `/compact` 改经 `serve-session` 适配器读 serve 消息（A3 持久化收敛）。
 *
 * 并发治理（K2）与 EOF 语义沿用旧实现：readline 连续派发的多行用 `running` 标志 + 排队
 * 控制器串行处理，保证同一会话绝不并发写。
 */
import * as readline from "node:readline";
import type { ActiveModel } from "@aiagent/ai";
import type { AgentTool } from "@aiagent/tools";
import type { AgentMessage } from "@aiagent/agent";
import { createFollowUpController } from "./follow-up.js";
import { createPermissionSession } from "../permission/permission-session.js";
import { setOutputSink, write, type UsageTracker } from "../ui/render.js";
import { createResizeRedraw } from "../ui/tui/resize-redraw.js";
import { expandFileReferencesDetailed } from "../workspace/file-reference.js";
import { handleDirectInput } from "../commands/direct-command.js";
import { inputTopBar, paint, supportsAnsi } from "../ui/theme.js";
import { renderWelcome } from "../ui/welcome.js";
import { createReplTui } from "./repl-tui.js";
import { createReplActions, createReplToolGate } from "./repl-actions.js";
import { createReplCommands } from "./repl-commands.js";
import type { ReplContext } from "./repl-context.js";
import type { RunSetup } from "../runtime/turn.js";
import type { OhnaServer, ConfirmationRequestedPayload } from "@aiagent/serve";
import {
  getConversationMeta,
  isLegacySessionId,
  LegacySessionIdError,
  loadMessages,
  resolveDataDir,
} from "../session/serve-session.js";
import { renderFrame, TERMINAL_RUN_STATUSES } from "../cli/web-entry.js";

/**
 * 交互式 REPL：维护会话级可变绑定与订阅，Ctrl-C 中断当前 run 而不退出会话。
 *
 * @param active 已解析的真实模型与凭据。
 * @param tools 已装配的工具列表。
 * @param setup 会话级模式配置（跨轮复用同一份提示词与预算）。
 * @param tracker 会话级用量累计器（跨 run 累计）。
 * @param server 进程内 serve 句柄（执行权唯一归属）。
 * @param dataDir 数据目录（与 serve 实例一致，用于读取消息）。
 * @param context 可选的 MCP 来源信息。
 */
export async function runRepl(
  active: ActiveModel,
  tools: AgentTool<any>[],
  setup: RunSetup,
  tracker: UsageTracker,
  server: OhnaServer,
  dataDir: string,
  context?: ReplContext,
): Promise<void> {
  const history: AgentMessage[] = [];
  let sessionId = "";
  let sessionTitle: string | undefined;
  /** history 是否已完整（serve 载入恒为完整；新建会话天然完整）。 */
  let fullHistoryLoaded = true;
  /** /model 可在会话内切换 profile。 */
  let currentModel: ActiveModel = active;
  let controller: AbortController | null = null;
  /** 本会话第几轮 run（serve requestId 后缀）。 */
  let turnIndex = 0;
  /** 是否已收到 /exit 或 EOF。 */
  let closed = false;
  let inputClosed = false;
  let stopRequested = false;
  let running = false;
  /** 本终端发起的在途 run（用于等待终态与 Ctrl-C 取消）。 */
  let activeRun: { runId: string; finish: () => void } | null = null;
  /** 终态 runId 记录：createRun 与订阅回调之间命中终态窗口时立即收尾（幂等）。 */
  const terminalRunIds = new Set<string>();
  const followUps = createFollowUpController();
  let finish: (() => void) | undefined;

  const permissionSession = createPermissionSession({
    autoApprove: setup.autoApprove,
    tools,
  });

  // TTY 走整屏 TUI；否则保留 readline 路径。
  const useTui = supportsAnsi();
  let tuiHandle: ReturnType<typeof createReplTui> | undefined;
  let rl: readline.Interface | undefined;

  if (useTui) {
    tuiHandle = createReplTui({
      cwd: setup.cwd,
      getModel: () => currentModel,
      tracker,
      getPermissionPreset: () => permissionSession.preset(),
    });
  } else {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "│ > " });
  }
  const tui = tuiHandle?.tui;

  const actions = createReplActions({
    ...(tui ? { tui } : {}),
    permissionSession,
  });
  const { cyclePermissionMode, cycleVerbosity, toggleLastGroup, echoQueued, echoSubmitted } = actions;

  /** 打印输入区顶线（TTY 门控）后进入 readline prompt。 */
  const promptInput = (): void => {
    if (useTui) return;
    if (supportsAnsi()) {
      const cols = process.stdout.columns || 80;
      write(paint(inputTopBar(cols), "dim"));
      resizeRedraw?.noteWidth(cols);
    }
    rl!.prompt();
  };

  const resizeRedraw =
    supportsAnsi() && !useTui
      ? createResizeRedraw({
          shouldRedraw: () => !running && !closed && !inputClosed,
          currentLine: () => rl?.line ?? "",
          prompt: promptInput,
        })
      : undefined;
  resizeRedraw?.start();

  // 非 TTY：把宿主输出（欢迎头 / 命令回显 / 状态）接入普通直写，避免进对话模型。
  if (!useTui) setOutputSink((s) => process.stdout.write(s));

  renderWelcome(
    { id: currentModel.model.id, provider: currentModel.model.provider },
    tools.map((tool) => tool.name),
    {
      sessionId,
      cwd: setup.cwd,
      mcpServers: context?.mcpServerNames,
      ...(context?.traceUrl ? { traceUrl: context.traceUrl } : {}),
    },
  );

  if (tuiHandle) {
    tuiHandle.start({
      onSubmit: commitLine,
      onInterrupt: handleInterrupt,
      onEscape: handleEscape,
      onVerboseToggle: toggleLastGroup,
      onModeCycle: cyclePermissionMode,
    });
  } else {
    promptInput();
  }

  // 本地工具确认闸门仅用于 `!` 直通 bash（本地执行）；serve 侧工具执行由事件回流的权限卡处理。
  const beforeToolCall = createReplToolGate({
    autoApprove: setup.autoApprove,
    cwd: setup.cwd,
    permissionSession,
    ...(tui ? { tui } : { readline: rl! }),
  });
  context?.onGateReady?.(beforeToolCall);

  /** 关闭输入（readline 则关闭，TUI 仅置标志）；标记不再接收新输入。 */
  const closeInput = (): void => {
    closed = true;
    if (!inputClosed) {
      inputClosed = true;
      rl?.close();
    }
  };

  function handleInterrupt(): void {
    if (controller || activeRun) {
      // 有在途 run：走 serve 取消语义（abort → interrupted 终态）。
      if (activeRun) {
        const runId = activeRun.runId;
        write("\n正在中断当前 run…\n");
        void server.cancelRun(runId);
      } else {
        controller?.abort();
        controller = null;
      }
      return;
    }
    stopRequested = true;
    followUps.clear();
    closeInput();
    maybeFinish();
  }

  function handleEscape(): void {
    if (controller || activeRun) handleInterrupt();
  }

  const maybeFinish = (): void => {
    if (!running && !followUps.hasPending() && closed) finish?.();
  };

  /** 回放 serve 已落盘的历史消息（仅用于 `/resume` 切换后的可见展示）。 */
  const replayHistory = (messages: AgentMessage[]): void => {
    const toText = (content: unknown): string =>
      typeof content === "string" ? content : JSON.stringify(content);
    for (const message of messages) {
      if (message.role === "user") {
        tui ? tui.appendUser(toText(message.content)) : write(`${toText(message.content)}\n`);
      } else if (message.role === "assistant") {
        const text = toText(message.content);
        tui ? tui.appendLine(text) : write(`${text}\n`);
      } else if (message.role === "compaction") {
        const text = (message as { summary?: string }).summary ?? "";
        tui ? tui.appendLine(`[会话摘要] ${text}`) : write(`[会话摘要] ${text}\n`);
      } else if (message.role === "toolResult") {
        const text = toText((message as { content?: unknown }).content);
        tui ? tui.appendLine(`[工具结果] ${text}`) : write(`[工具结果] ${text}\n`);
      }
    }
  };

  /** 若携带 --resume，载入 serve 历史并设置当前会话（不新建设会话）。 */
  if (setup.resumeId) {
    if (isLegacySessionId(setup.resumeId)) {
      write(`\n${new LegacySessionIdError(setup.resumeId).message}\n`);
    } else {
      try {
        const meta = await getConversationMeta(dataDir, setup.resumeId);
        if (meta) {
          const messages = await loadMessages(dataDir, setup.resumeId);
          history.push(...messages);
          sessionId = meta.id;
          sessionTitle = meta.title === "新会话" ? undefined : meta.title;
          replayHistory(messages);
          write(`\n已恢复会话 ${meta.id}（${messages.length} 条消息，标题：${meta.title}）。\n`);
        } else {
          write(`\n未找到会话 "${setup.resumeId}，已按新会话启动。\n`);
        }
      } catch (error) {
        write(`\n恢复会话失败（${error instanceof Error ? error.message : String(error)}）。\n`);
      }
    }
  }

  const renderOptions = {
    workspaceRoot: setup.cwd,
    ...(context?.mcpToolNames ? { mcpToolNames: context.mcpToolNames } : {}),
  };

  /**
   * 收集一次权限卡决议：TTY 走 tui.askToolCall 结构化卡片，非 TTY 用主 readline 三选项问答。
   * 后端 confirm-gate 在裁决前挂起，超时（5 分钟）会自动失败，因此终端必须在此决议。
   *
   * @param payload confirmation_requested 的载荷（toolCallId / toolName / args / summary）。
   * @returns 决议（allow / deny；session 视为本次 allow）。
   */
  const decideConfirmation = async (payload: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    summary: string;
  }): Promise<"allow" | "deny"> => {
    const info = { tool: payload.toolName, summary: payload.summary };
    let decision: "allow" | "session" | "deny";
    if (tui) {
      const result = await tui.askToolCall(info, undefined);
      decision = result ?? "deny";
    } else if (rl) {
      decision = await new Promise<"allow" | "session" | "deny">((resolve) => {
        write(`${payload.summary}\n  1) 允许一次  2) 本会话一律允许  3) 拒绝 > `);
        const onLine = (line: string): void => {
          const choice = line.trim();
          rl.removeListener("line", onLine);
          if (choice === "1") resolve("allow");
          else if (choice === "2") resolve("session");
          else resolve("deny");
        };
        rl.once("line", onLine);
      });
    } else {
      // 既无 TUI 也无 readline（极罕见）：默认拒绝写/执行，避免静默放行。
      decision = "deny";
    }
    return decision === "deny" ? "deny" : "allow";
  };

  /** 会话级订阅：当前与后续所有 run 的事件回流终端（/resume / /clear 共享同一退订）。 */
  const subscribe = (id: string): void => {
    unsubscribe();
    unsubscribe = server.subscribeConversation(id, (event) => {
      if (event.type === "run_status") {
        const status = (event.payload as { status?: string } | null)?.status;
        if (status && TERMINAL_RUN_STATUSES.has(status)) terminalRunIds.add(event.runId);
      } else if (event.type === "confirmation_requested") {
        // D-A3：serve 在写/执行工具前广播并挂起，终端必须决议并回写，否则 run 卡到超时失败。
        const payload = event.payload as ConfirmationRequestedPayload;
        void decideConfirmation(payload)
          .then((decision) => server.resolveConfirmation(event.runId, payload.toolCallId, decision))
          .catch(() => server.resolveConfirmation(event.runId, payload.toolCallId, "deny"));
      }
      renderFrame(event, tracker, renderOptions, activeRun, () => activeRun?.finish(), tui);
    });
  };
  let unsubscribe = (): void => {};

  /** 确保当前会话已创建（首条真实消息物化；单一形态下会话由 serve 持有）。 */
  const ensureConversation = async (): Promise<string> => {
    if (sessionId) return sessionId;
    const fresh = await server.createConversation(sessionTitle ?? "新会话");
    sessionId = fresh.conversationId;
    sessionTitle = fresh.title;
    subscribe(sessionId);
    return sessionId;
  };

  const dispatch = createReplCommands({
    tools,
    ...(context ? { context } : {}),
    server,
    dataDir,
    tracker,
    setup,
    history,
    getModel: () => currentModel,
    setModel: (model) => {
      currentModel = model;
    },
    getSessionId: () => sessionId,
    setSessionId: (id) => {
      sessionId = id;
    },
    getTitle: () => sessionTitle,
    setTitle: (title) => {
      sessionTitle = title;
    },
    permissionSession,
    isFullHistoryLoaded: () => fullHistoryLoaded,
    markFullHistoryLoaded: () => {
      fullHistoryLoaded = true;
    },
    ...(tui ? { tui } : {}),
    cycleVerbosity,
    onExit: () => {
      stopRequested = true;
      followUps.clear();
      closeInput();
    },
    onRenderWelcome: () => {
      renderWelcome(
        { id: currentModel.model.id, provider: currentModel.model.provider },
        tools.map((tool) => tool.name),
        {
          sessionId: sessionId || undefined,
          cwd: setup.cwd,
          mcpServers: context?.mcpServerNames,
          ...(context?.traceUrl ? { traceUrl: context.traceUrl } : {}),
        },
      );
    },
    onSessionSwitched: async (id, title) => {
      // /resume 切换：退订旧会话、载入并订阅新会话、回放历史。
      history.length = 0;
      if (id) {
        const messages = await loadMessages(dataDir, id);
        history.push(...messages);
        sessionId = id;
        sessionTitle = title;
        subscribe(id);
        replayHistory(messages);
      } else {
        sessionId = "";
        sessionTitle = undefined;
        unsubscribe();
      }
      fullHistoryLoaded = true;
      permissionSession.reset();
      tui?.resetView();
    },
  });

  const processLine = async (text: string): Promise<void> => {
    running = true;
    followUps.reset();
    if (!inputClosed && rl) rl.pause();
    try {
      if (text.startsWith("!") || /^#\s/.test(text)) {
        controller = new AbortController();
        try {
          await handleDirectInput(text, {
            cwd: setup.cwd,
            tools,
            history,
            setup,
            tracker,
            beforeToolCall,
            signal: controller.signal,
            getPermissionPreset: () => permissionSession.preset(),
          });
        } finally {
          controller = null;
        }
        return;
      }

      if (await dispatch(text)) return;

      if (activeRun) {
        write("已有进行中的 run，请等待完成或 Ctrl-C 中断。\n");
        return;
      }

      if (!sessionTitle) {
        sessionTitle = text.replace(/\s+/g, " ").slice(0, 40);
      }

      const resolvedId = await ensureConversation();

      // 标题固定取首条用户输入；展开 `@path` 为内容块后随 composer 消息发送。
      const { content, warnings } = await expandFileReferencesDetailed(text, setup.cwd);
      for (const warning of warnings) write(`⚠️ ${warning}\n`);

      const { accepted } = await server.createRun({
        conversationId: resolvedId,
        message: typeof content === "string" ? content : JSON.stringify(content),
        mode: "auto",
        source: "cli",
        requestId: `${resolvedId}:${turnIndex + 1}`,
        ...(setup.maxTurns !== undefined ? { maxTurns: setup.maxTurns } : {}),
        ...(setup.deadlineMs !== undefined ? { deadlineMs: setup.deadlineMs } : {}),
        ...(setup.maxCost !== undefined ? { maxCost: setup.maxCost } : {}),
      });
      turnIndex += 1;
      await new Promise<void>((resolve) => {
        activeRun = { runId: accepted.runId, finish: resolve };
        if (terminalRunIds.has(accepted.runId)) resolve();
      });
      terminalRunIds.delete(accepted.runId);
      activeRun = null;
    } catch (error) {
      write(`\n运行出错：${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      running = false;
      followUps.reset();
      const next = stopRequested ? undefined : followUps.shift();
      if (next !== undefined) {
        void processLine(next);
      } else if (!closed) {
        rl?.resume();
        promptInput();
      }
      maybeFinish();
    }
  };

  if (tui) {
    tui.onSessionSelected = (id) => {
      void processLine(`/resume ${id}`);
    };
  }

  function commitLine(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      if (!running && !closed && !useTui) promptInput();
      return;
    }
    if (closed) return;
    if (running) {
      const index = followUps.enqueue(trimmed);
      echoQueued(trimmed, index);
      return;
    }
    echoSubmitted(trimmed);
    void processLine(trimmed);
  }

  if (rl) {
    rl.on("line", commitLine);
  }

  rl?.on("SIGINT", () => {
    if (controller || activeRun) {
      followUps.disable();
      handleInterrupt();
      write("\n已中断当前运行。\n");
      return;
    }
    stopRequested = true;
    followUps.clear();
    closeInput();
    maybeFinish();
  });

  rl?.on("close", () => {
    inputClosed = true;
    closed = true;
    maybeFinish();
  });

  await new Promise<void>((resolve) => {
    finish = resolve;
    maybeFinish();
  });

  tuiHandle?.dispose();
  // 单一形态下会话由 serve 持久化；退出时打印当前会话 id 供续写。
  if (sessionId) write(`\n会话已保留：${sessionId}（标题：${sessionTitle ?? "新会话"}）\n`);
  setOutputSink(undefined);
}
