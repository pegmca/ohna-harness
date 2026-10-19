/**
 * 交互式 REPL：readline 输入循环、slash 命令、串行 run 队列与中断语义。
 *
 * 并发治理：readline 在管道 / 粘贴场景会连续派发多行。若每行都直接启动 run，
 * 多个 run 会并发读写同一份 history，导致顺序错乱与重复落盘。这里用 `running` 标志 +
 * follow-up.ts 的排队控制器：run 进行中收到的普通文本由内核 follow-up 注入当前 run；
 * slash 命令与窄窗口行留到 run 结束后按序串行处理。
 *
 * EOF 语义：stdin 关闭后 readline 不再产生新行，但已入队的行仍要跑完；因此关闭事件
 * 只标记 `closed`，真正 resolve 要等 `running === false && 队列为空`。
 *
 * M3：命令解析与分发移到 registry.ts（命令表 + 注入 handler）。本文件的职责按
 * 「会话循环 / 终端装配 / UI 动作 / 命令接线」拆分：repl.ts 只保留循环与状态机，
 * 其余分别由 repl-tui.ts、repl-actions.ts、repl-commands.ts 承担。
 */
import * as readline from "node:readline";
import type { ActiveModel } from "@aiagent/ai";
import type { AgentTool } from "@aiagent/tools";
import type { AgentMessage } from "@aiagent/agent";
import { createFollowUpController } from "./follow-up.js";
import { createPermissionSession } from "../permission/permission-session.js";
import { write, type UsageTracker } from "../ui/render.js";
import { createResizeRedraw } from "../ui/tui/resize-redraw.js";
import { expandFileReferencesDetailed } from "../workspace/file-reference.js";
import { handleDirectInput } from "../commands/direct-command.js";
import {
  ensureFullHistory,
  openSession,
  persistSession,
  printResumeHint,
  replaceHistory,
} from "../session/session-flow.js";
import { createSessionStore } from "../session/session-store.js";
import { inputTopBar, paint, supportsAnsi } from "../ui/theme.js";
import { renderWelcome } from "../ui/welcome.js";
import { createReplTui } from "./repl-tui.js";
import { createReplActions, createReplToolGate } from "./repl-actions.js";
import { createReplCommands } from "./repl-commands.js";
import type { ReplContext } from "./repl-context.js";
import {
  printStopReason,
  reachedCostBudget,
  runTurn,
  type RunSetup,
} from "../runtime/turn.js";

/**
 * 交互式 REPL：维护跨轮 history 与会话文件，Ctrl-C 中断当前 run 而不退出会话。
 *
 * @param active 已解析的真实模型与凭据。
 * @param tools 已装配的工具列表。
 * @param setup 会话级模式配置（跨轮复用同一份提示词与预算）。
 * @param tracker 会话级用量累计器（跨 run 累计）。
 * @param context 可选的 MCP 来源信息。
 */
export async function runRepl(
  active: ActiveModel,
  tools: AgentTool<any>[],
  setup: RunSetup,
  tracker: UsageTracker,
  context?: ReplContext,
): Promise<void> {
  const history: AgentMessage[] = [];
  const store = createSessionStore();
  const session = await openSession(store, setup.resumeId, setup.cwd);
  history.push(...session.messages);
  if (session.usage) tracker.restore(session.usage);
  let sessionId = session.id;
  let sessionTitle = session.title;
  /**
   * C4 数据安全：tail 恢复（hasMore）时 history 只是磁盘历史的严格后缀，此时任何
   * persistSession 都会把文件截断成尾部。首次真正需要完整上下文（run / 预算写盘 /
   * /compact）前先 ensureFullHistory；补载成功后置 true，后续无需重复读盘。
   * 新建会话、全量 /resume、fork、/clear 得到的历史本身就是完整的。
   */
  let fullHistoryLoaded = !session.hasMore;
  // /model 可在会话内切换 profile：当前模型放在可变绑定中，后续 run 与压缩都用它。
  let currentModel: ActiveModel = active;
  let controller: AbortController | null = null;
  /** readline 是否已关闭（Ctrl-D / EOF / /exit）；关闭后不得再 prompt。 */
  let closed = false;
  /** readline 底层接口是否已调用 close，避免重复关闭。 */
  let inputClosed = false;
  /** 是否已收到 /exit：队列清空后不再处理后续输入。 */
  let stopRequested = false;
  /** 当前是否有 run / 命令正在处理。 */
  let running = false;
  /**
   * K2 排队协议：pending 队列 + steering / follow-up 钩子 + abort 闸门都收敛在
   * follow-up.ts（slash 命令不会被注入模型；中断后消息留给串行兜底）。
   */
  const followUps = createFollowUpController();
  let finish: (() => void) | undefined;

  /**
   * B2 权限会话（跨轮持有）：预设 + 会话 allowlist + plan 模式的工具视图。
   * 闸门通过 getPreset 实时读取模式，因此 Shift+Tab / `/permissions mode` 无需重建钩子。
   */
  const permissionSession = createPermissionSession({
    autoApprove: setup.autoApprove,
    tools,
  });

  // TTY（支持 ANSI 颜色）走整屏 TUI；否则保留旧 readline 路径（非 TTY 完全不变）。
  const useTui = supportsAnsi();
  let tuiHandle: ReturnType<typeof createReplTui> | undefined;
  let rl: readline.Interface | undefined;

  if (useTui) {
    // 整屏 TUI：把 render 输出注入对话模型，并禁用 spinner（避免 \r\x1b[K 污染）。
    tuiHandle = createReplTui({
      cwd: setup.cwd,
      getModel: () => currentModel,
      tracker,
      getPermissionPreset: () => permissionSession.preset(),
    });
  } else {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "│ > ",
    });
  }
  const tui = tuiHandle?.tui;

  // 终端动作（verbosity / 权限模式 / 折叠 / 回显）只依赖 TUI 与权限会话。
  const actions = createReplActions({
    ...(tui ? { tui } : {}),
    permissionSession,
  });
  const { cyclePermissionMode, cycleVerbosity, toggleLastGroup, echoQueued, echoSubmitted } = actions;

  /**
   * 打印输入区顶线（TTY 门控）后进入 readline prompt。
   *
   * 顶线是「打印式」普通内容，不是 readline 的 prompt 一部分：node:readline 会把
   * prompt + line 当一个逻辑行做列折算，多行 prompt 会导致行编辑错位（§3.4 降级方案）。
   */
  const promptInput = (): void => {
    // 整屏 TUI 自行渲染输入区，无需 prompt / 顶线。
    if (useTui) return;
    if (supportsAnsi()) {
      const cols = process.stdout.columns || 80;
      write(paint(inputTopBar(cols), "dim"));
      resizeRedraw?.noteWidth(cols);
    }
    rl!.prompt();
  };

  /**
   * 非 TTY readline 的 resize 修正：抽到 resize-redraw.ts，内部负责同宽去抖与重绘防重入。
   * 只有 TTY 的 readline 路径需要它（整屏 TUI 由 Screen 全量重绘）。
   */
  const resizeRedraw =
    supportsAnsi() && !useTui
      ? createResizeRedraw({
          shouldRedraw: () => !running && !closed && !inputClosed,
          currentLine: () => rl?.line ?? "",
          prompt: promptInput,
        })
      : undefined;
  resizeRedraw?.start();

  renderWelcome(
    { id: currentModel.model.id, provider: currentModel.model.provider },
    tools.map((tool) => tool.name),
    { sessionId, cwd: setup.cwd, mcpServers: context?.mcpServerNames },
  );

  if (tuiHandle) {
    // 整屏 TUI：提交/中断/Esc/verbose 切换/Shift+Tab 模式循环交给编辑器，启动后由 Screen 接管终端。
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

  // 恒挂确认闸门：ohna 就是编码助手，mutating 工具执行前必须按当前权限策略处理
  // （read 工具由 effect 声明直接放行；--yes 初始化为 bypass）。
  // TTY 整屏用 tui.confirm 收集三选项，否则复用主 readline。
  // C3/D7：TTY 走结构化 askToolCall（权限卡 + diff 预览 + Toast 日志）；非 TTY 继续
  // readline 字符串三选一问答，行为零变化。
  const beforeToolCall = createReplToolGate({
    autoApprove: setup.autoApprove,
    cwd: setup.cwd,
    permissionSession,
    ...(tui ? { tui } : { readline: rl! }),
  });
  // K3 时序回填：team controller 在组合根已创建，但其子代理的 beforeToolCall 是可变引用；
  // 此处把「真正持有 readline/TUI 与 PolicyState 的闸门」写回，保证子代理与 supervisor 同审。
  context?.onGateReady?.(beforeToolCall);

  /** 关闭输入（readline 则关闭，TUI 仅置标志）；标记不再接收新输入。 */
  const closeInput = (): void => {
    closed = true;
    if (!inputClosed) {
      inputClosed = true;
      rl?.close();
    }
  };

  /** TUI 中断处理：有 run 则中断它，空闲则退出会话。（函数声明以便上方 onSubmit 装配时引用） */
  function handleInterrupt(): void {
    if (controller) {
      // abort 闸门：阻止 follow-up 把排队消息注入一个即将终止的 run。
      followUps.disable();
      controller.abort();
      controller = null;
      tui?.appendLine("已中断当前运行。");
    } else {
      stopRequested = true;
      followUps.clear();
      closeInput();
      maybeFinish();
    }
  }

  /**
   * TUI Esc 处理（F-2）：仅中断当前 run，空闲时不退出。
   *
   * 刻意复用 {@link handleInterrupt} 的「有 controller」分支，而不是复制 abort 逻辑：
   * Esc 与 Ctrl+C 在 run 进行中必须是同一条中断路径；唯一差异是空闲分支——Ctrl+C
   * 退出会话，Esc 无操作（双击 Esc 的占位手势由 TuiApp 自行处理）。
   */
  function handleEscape(): void {
    if (controller) handleInterrupt();
  }

  /** 所有在途工作结束后 resolve 主 Promise；EOF 与 /exit 共用。 */
  const maybeFinish = (): void => {
    if (!running && !followUps.hasPending() && closed) finish?.();
  };

  /**
   * 会话命令分发：repl-commands.ts 用 getter/setter 读取会话状态，避免把输入循环
   * 搬进命令模块；`/exit` 的队列清理仍由本文件负责。
   */
  const dispatch = createReplCommands({
    tools,
    ...(context ? { context } : {}),
    store,
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
      // /exit 清空待处理队列并关闭输入；当前 run 结束后主 Promise 才会 resolve。
      stopRequested = true;
      followUps.clear();
      closeInput();
    },
  });

  /**
   * 处理一行输入：命令即时响应，普通文本启动一轮 run。
   *
   * @param text 已 trim 的输入。
   */
  const processLine = async (text: string): Promise<void> => {
    running = true;
    // 新 run（或新命令）开始：解除上一轮 abort 留下的 follow-up 闸门。
    followUps.reset();
    // stdin 已 EOF 时 readline 已关闭，再 pause 会抛 ERR_USE_AFTER_CLOSE；
    // 队列中的行仍需处理，因此只跳过与终端交互相关的调用（TUI 下无 readline）。
    if (!inputClosed && rl) rl.pause();
    try {
      // F-7：`!` bash 直通 / `# ` 快速记忆。两者都不进 history、不消耗 token；
      // `!` 结果只打印（直通语义），`#` 写入 AGENTS.md 后刷新系统提示词。
      if (text.startsWith("!") || /^#\s/.test(text)) {
        controller = new AbortController();
        try {
          await handleDirectInput(text, { cwd: setup.cwd, tools, history, setup, tracker, beforeToolCall, signal: controller.signal, getPermissionPreset: () => permissionSession.preset() });
        } finally { controller = null; }
        return;
      }

      // 会话内命令优先于模型调用：不消耗 token，也不进 history。
      if (await dispatch(text)) return;

      // C4：普通文本会进入 run / 预算写盘 / persistSession，必须先把 tail 历史补全。
      // 补载失败时跳过本轮——宁可不执行，也不能用 80 条后缀覆盖磁盘上的完整会话。
      if (!fullHistoryLoaded) {
        fullHistoryLoaded = await ensureFullHistory(store, sessionId, history, (message) =>
          write(`⚠️ ${message}\n`),
        );
        if (!fullHistoryLoaded) {
          write("⚠️ 已跳过本轮：未补载完整历史时落盘会覆盖磁盘上的更早消息。\n");
          return;
        }
      }

      // 标题固定取首条用户输入（压缩后 history 可能不再以 user 开头，不能临时推导）。
      if (!sessionTitle) {
        sessionTitle = text.replace(/\s+/g, " ").slice(0, 40);
      }

      // run 前检查预算：--max-cost 0 即零预算，不调用模型；恢复会话已超预算同样立即停。
      if (reachedCostBudget(tracker, setup.maxCost)) {
        printStopReason("max_cost");
        replaceHistory(
          history,
          await persistSession(store, sessionId, history, {
            model: currentModel.model,
            summarizer: setup.summarizer,
            title: sessionTitle,
            workspaceRoot: setup.cwd,
            usage: tracker,
          }),
        );
        return;
      }

      // F-6：展开 `@path` 为内容块数组（无引用时仍是原字符串）。失败只提示 + 说明块，
      // 不阻断本轮提问；文件读取限定在工作区内且受敏感路径策略约束。
      const { content, warnings } = await expandFileReferencesDetailed(text, setup.cwd);
      for (const warning of warnings) write(`⚠️ ${warning}\n`);

      // 每个用户输入开一个新 run，AbortController 贯穿整条 agentLoop 调用链（含工具执行）。
      controller = new AbortController();
      try {
        const result = await runTurn(
          history,
          content,
          currentModel,
          // plan 模式不注册 mutating 工具：策略 deny 是兜底，过滤工具表才是「零尝试」。
          permissionSession.activeTools(),
          controller.signal,
          setup,
          tracker,
          beforeToolCall,
          () => followUps.getSteeringMessages(),
          () => followUps.getFollowUpMessages(),
        );
        // 用新引用替换 history，保证后续轮次能看到完整上下文。
        replaceHistory(history, result.history);
      } catch (error) {
        write(`\n运行出错：${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        controller = null;
        // 每轮结束都做「会话级压缩 + 落盘」；失败只告警，不阻断会话继续。
        replaceHistory(
          history,
          await persistSession(store, sessionId, history, {
            model: currentModel.model,
            summarizer: setup.summarizer,
            title: sessionTitle,
            workspaceRoot: setup.cwd,
            usage: tracker,
          }),
        );
      }
    } finally {
      running = false;
      // K2：follow-up 已把普通文本注入当前 run；队列里只剩两类行：
      // 1）slash 命令（绝不注入模型），2）最后一次 follow-up 检查之后到达的窄窗口行。
      // 两者都按提交顺序串行交给 processLine。/exit 已清空队列，此时直接收尾。
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

  // `/resume` 选择器选中会话：复用 processLine 的命令分发 + 串行保护，避免与在途 run 竞态。
  if (tui) {
    tui.onSessionSelected = (id) => {
      void processLine(`/resume ${id}`);
    };
  }

  // 提交一行：命令即时响应，普通文本启动一轮 run；run 进行中入队，空闲 Ctrl-C 退出。
  // 声明为函数（hoisted），以便上方 `tui!.onSubmit = commitLine` 在其定义前引用。
  function commitLine(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      if (!running && !closed && !useTui) promptInput();
      return;
    }
    if (closed) return;
    if (running) {
      // K2/F-2：run 进行中入队；follow-up 只会注入普通文本，slash 命令留到 run 结束后分发。
      const index = followUps.enqueue(trimmed);
      echoQueued(trimmed, index);
      return;
    }
    // 提交：TTY 下把用户输入回显进对话区；readline 下打印输入框下边框闭合盒子。
    echoSubmitted(trimmed);
    void processLine(trimmed);
  }

  if (rl) {
    rl.on("line", commitLine);
  }

  rl?.on("SIGINT", () => {
    if (controller) {
      // 有进行中的 run：中断它，会话继续；队列中的命令/窄窗口行仍按序处理。
      // abort 闸门阻止 follow-up 把排队消息注入即将终止的 run。
      followUps.disable();
      controller.abort();
      controller = null;
      write("\n已中断当前运行。\n");
    } else {
      // 空闲：清空队列并退出进程。
      stopRequested = true;
      followUps.clear();
      closeInput();
      maybeFinish();
    }
  });

  rl?.on("close", () => {
    inputClosed = true;
    closed = true;
    maybeFinish();
  });

  await new Promise<void>((resolve) => {
    finish = resolve;
    // readline 可能已经因 stdin EOF 而关闭（极短管道输入），补一次检查避免悬挂。
    maybeFinish();
  });

  // 退出 TUI：复位输出 sink（先复位，避免后续输出进对话模型）、停 Screen 还原终端、恢复 spinner。
  tuiHandle?.dispose();
  printResumeHint(sessionId);
}
