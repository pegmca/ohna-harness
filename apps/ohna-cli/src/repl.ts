/**
 * 交互式 REPL：readline 输入循环、slash 命令、串行 run 队列与中断语义。
 *
 * 并发治理：readline 在管道 / 粘贴场景会连续派发多行。若每行都直接启动 run，
 * 多个 run 会并发读写同一份 history，导致顺序错乱与重复落盘。这里用 `running` 标志 +
 * `pending` 队列：run 进行中收到的行先入队，当前 run（含落盘）结束后按序串行处理。
 *
 * EOF 语义：stdin 关闭后 readline 不再产生新行，但已入队的行仍要跑完；因此关闭事件
 * 只标记 `closed`，真正 resolve 要等 `running === false && pending.length === 0`。
 *
 * M3：命令解析与分发移到 slash.ts（命令表 + 注入 handler），本文件只提供
 * 本地会话语义下的 handler 实现（/model /compact /tools /resume 直接读写
 * 本文件的会话状态）；web 托管模式在 web-entry.ts 用同一分发器注入 serve 语义。
 */
import * as readline from "node:readline";
import { listAvailableModelProfiles, resolveActiveModelFromEnv, type ActiveModel } from "@aiagent/ai";
import type { AgentTool } from "@aiagent/tools";
import type { AgentMessage } from "@aiagent/agent";
import { compactSessionHistory } from "./session-runtime.js";
import { createToolConfirmGate } from "./confirm.js";
import { formatCostLine, type UsageTracker } from "./render.js";
import {
  openSession,
  persistSession,
  printResumeHint,
  replaceHistory,
} from "./session-flow.js";
import { createSessionStore } from "./session-store.js";
import { printReplCommands, renderWelcome } from "./welcome.js";
import { createSlashDispatcher, printUnknownCommand, type SlashHandlers } from "./slash.js";
import {
  printStopReason,
  reachedCostBudget,
  runTurn,
  type RunSetup,
} from "./turn.js";

/** REPL 的装配上下文：MCP 来源标注等跨模块信息。 */
export interface ReplContext {
  /** MCP 发现的工具名（/tools 与欢迎头据此标注来源）。 */
  mcpToolNames?: ReadonlySet<string>;
  /** 已接入的 MCP server 名（欢迎头展示）。 */
  mcpServerNames?: readonly string[];
}

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
  /** run 进行中收到的行，等当前 run 结束后串行处理。 */
  const pending: string[] = [];
  let finish: (() => void) | undefined;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "你> ",
  });

  renderWelcome(
    { id: currentModel.model.id, provider: currentModel.model.provider, baseUrl: currentModel.model.baseUrl },
    tools.map((tool) => tool.name),
    { mode: setup.mode, sessionId, mcpServers: context?.mcpServerNames },
  );
  rl.prompt();

  // coding 模式把主 readline 交给确认闸门复用，避免第二个 readline 与 REPL 抢 stdin；
  // research 模式不挂闸门，保持历史行为。
  const beforeToolCall =
    setup.mode === "coding"
      ? createToolConfirmGate({ autoApprove: setup.autoApprove, cwd: setup.cwd, readline: rl })
      : undefined;

  /** 关闭 readline（若仍打开），标记不再接收新输入。 */
  const closeInput = (): void => {
    closed = true;
    if (!inputClosed) {
      inputClosed = true;
      rl.close();
    }
  };

  /** 所有在途工作结束后 resolve 主 Promise；EOF 与 /exit 共用。 */
  const maybeFinish = (): void => {
    if (!running && pending.length === 0 && closed) finish?.();
  };

  /** /tools：列出当前工具名；MCP 工具追加来源标注。 */
  const printTools = (): void => {
    const mcp = context?.mcpToolNames;
    for (const tool of tools) {
      const source = mcp?.has(tool.name) ? "（MCP）" : "";
      process.stdout.write(`  ${tool.name}${source}\n`);
    }
    process.stdout.write(`共 ${tools.length} 个工具。\n`);
  };

  /** /model：无参列出可用 profile 与当前；带参切换（无效 profile 报错不切换）。 */
  const handleModel = (arg: string): void => {
    if (!arg) {
      const profiles = listAvailableModelProfiles();
      process.stdout.write(`当前模型：${currentModel.model.id}（profile: ${currentModel.model.provider}）\n`);
      process.stdout.write(`可用 profile：${profiles.join("、") || "（无，请检查 .env 中 AIAGENT_LLM_* 配置）"}\n`);
      return;
    }
    const chosen = resolveActiveModelFromEnv(arg);
    if (!chosen) {
      // 无效 profile：报错并保持当前模型不变。
      process.stdout.write(
        `未知或未配置的 profile："${arg}"（可用：${listAvailableModelProfiles().join("、") || "无"}），保持当前模型不变。\n`,
      );
      return;
    }
    currentModel = chosen;
    process.stdout.write(`已切换模型：${chosen.model.id}（profile: ${chosen.model.provider}），对后续 run 生效。\n`);
  };

  /** /compact：立即对当前会话跑一次会话级压缩并打印前后 token。 */
  const handleCompact = async (): Promise<void> => {
    if (history.length === 0) {
      process.stdout.write("当前会话没有历史消息，无需压缩。\n");
      return;
    }
    const result = await compactSessionHistory(history, {
      model: currentModel.model,
      summarizer: setup.summarizer,
      onWarn: (message) => process.stderr.write(`${message}\n`),
    });
    if (!result.compacted) {
      process.stdout.write(
        `未触发压缩：当前约 ${result.tokensBefore} token，未超过压缩阈值（窗口 ${currentModel.model.contextWindow}）。\n`,
      );
      return;
    }
    replaceHistory(history, result.messages);
    process.stdout.write(
      `已压缩：${result.tokensBefore} → ${result.tokensAfter} token / ${result.messageCountBefore} 条 → ${result.messages.length} 条\n`,
    );
    // 压缩结果立即落盘，避免下一次 run 前进程退出丢失摘要。
    await persistSession(store, sessionId, history, {
      model: currentModel.model,
      summarizer: setup.summarizer,
      title: sessionTitle,
      workspaceRoot: setup.cwd,
      usage: tracker,
    });
  };

  /** /resume：无参列出最近会话；带参切换会话并载入历史。 */
  const handleResume = async (arg: string): Promise<void> => {
    if (!arg) {
      const metas = await store.list();
      if (metas.length === 0) {
        process.stdout.write("暂无历史会话。\n");
        return;
      }
      process.stdout.write("最近会话：\n");
      for (const meta of metas.slice(0, 10)) {
        const time = new Date(meta.updatedAt).toLocaleString();
        process.stdout.write(`  ${meta.id}  ${meta.title}  ${time}  ${meta.messageCount} 条\n`);
      }
      process.stdout.write("使用 /resume <id> 切换。\n");
      return;
    }
    try {
      const record = await store.load(arg);
      if (!record) {
        process.stdout.write(`未找到会话 "${arg}"，保持当前会话不变。\n`);
        return;
      }
      replaceHistory(history, record.messages);
      if (record.meta.usage) tracker.restore(record.meta.usage);
      sessionId = record.meta.id;
      sessionTitle = record.meta.title === "新会话" ? undefined : record.meta.title;
      process.stdout.write(
        `已切换到会话 ${sessionId}（${history.length} 条消息，标题：${record.meta.title}）。\n`,
      );
    } catch (error) {
      process.stdout.write(
        `恢复会话失败（${error instanceof Error ? error.message : String(error)}），保持当前会话不变。\n`,
      );
    }
  };

  // 命令分发：slash.ts 负责解析与别名，这里只注入本地会话语义的 handler。
  const dispatch = createSlashDispatcher({
    onUnknown: printUnknownCommand,
    handlers: {
      help: () => printReplCommands(),
      cost: () => {
        process.stdout.write(formatCostLine(tracker) + "\n");
      },
      model: (arg) => handleModel(arg),
      compact: () => handleCompact(),
      tools: () => printTools(),
      resume: (arg) => handleResume(arg),
      clear: async () => {
        // 旧会话已在前一轮结束时落盘；这里只切换新会话，旧文件原样保留。
        history.length = 0;
        tracker.restore({ input: 0, output: 0, total: 0, cost: 0 });
        const meta = await store.create({ workspaceRoot: setup.cwd });
        const previousId = sessionId;
        sessionId = meta.id;
        sessionTitle = undefined;
        process.stdout.write(`已清空上下文并开启新会话：${sessionId}（旧会话 ${previousId} 保留在磁盘）\n`);
      },
      exit: () => {
        // /exit 清空待处理队列并关闭输入；当前 run 结束后主 Promise 才会 resolve。
        stopRequested = true;
        pending.length = 0;
        closeInput();
      },
    } satisfies SlashHandlers,
  });

  /**
   * 处理一行输入：命令即时响应，普通文本启动一轮 run。
   *
   * @param text 已 trim 的输入。
   */
  const processLine = async (text: string): Promise<void> => {
    running = true;
    // stdin 已 EOF 时 readline 已关闭，再 pause 会抛 ERR_USE_AFTER_CLOSE；
    // 队列中的行仍需处理，因此只跳过与终端交互相关的调用。
    if (!inputClosed) rl.pause();
    try {
      // 会话内命令优先于模型调用：不消耗 token，也不进 history。
      if (await dispatch(text)) return;

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

      // 每个用户输入开一个新 run，AbortController 贯穿整条 agentLoop 调用链（含工具执行）。
      controller = new AbortController();
      try {
        const result = await runTurn(
          history,
          text,
          currentModel,
          tools,
          controller.signal,
          setup,
          tracker,
          beforeToolCall,
        );
        // 用新引用替换 history，保证后续轮次能看到完整上下文。
        replaceHistory(history, result.history);
      } catch (error) {
        process.stdout.write(`\n运行出错：${error instanceof Error ? error.message : String(error)}\n`);
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
      // 队列中的行按序处理；/exit 已清空队列，此时直接收尾。
      const next = stopRequested ? undefined : pending.shift();
      if (next !== undefined) {
        void processLine(next);
      } else if (!closed) {
        rl.resume();
        rl.prompt();
      }
      maybeFinish();
    }
  };

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) {
      if (!running && !closed) rl.prompt();
      return;
    }
    if (closed) return;
    if (running) {
      // run 进行中：入队，等当前 run（含落盘）结束再处理。
      pending.push(text);
      return;
    }
    void processLine(text);
  });

  rl.on("SIGINT", () => {
    if (controller) {
      // 有进行中的 run：中断它，会话继续；队列中的输入仍按序处理。
      // 这里不 prompt——processLine 的 finally 会在 run 收尾后统一恢复输入。
      controller.abort();
      controller = null;
      process.stdout.write("\n已中断当前运行。\n");
    } else {
      // 空闲：清空队列并退出进程。
      stopRequested = true;
      pending.length = 0;
      closeInput();
      maybeFinish();
    }
  });

  rl.on("close", () => {
    inputClosed = true;
    closed = true;
    maybeFinish();
  });

  await new Promise<void>((resolve) => {
    finish = resolve;
    // readline 可能已经因 stdin EOF 而关闭（极短管道输入），补一次检查避免悬挂。
    maybeFinish();
  });
  printResumeHint(sessionId, setup.mode);
}
