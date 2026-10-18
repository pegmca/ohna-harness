/**
 * `ohna --web`：进程内托管（D8 主路径）。
 *
 * 复用 `@aiagent/serve` 的 `createOhnaServer` 在**同一进程**内起 HTTP/SSE 服务，
 * 终端 REPL 与浏览器通过 serve 的会话存储看到**同一个 conversation**：
 * - 终端创建（或 /resume 选择）一个 conversation；
 * - 终端输入经 `server.createRun`（source=composer）执行，事件经
 *   `subscribeConversation` 回流渲染（流式 delta / 工具行 / diff / 折叠 / cost）；
 * - 浏览器发的 run（同一会话）也会实时渲染到终端（共享事件流，C-M3-6 的验收路径），
 *   其它会话的 run 不进入终端；
 * - /exit 或空闲 Ctrl-C → `server.shutdown()`（中断在途 run）+ `close()` 干净退出。
 *
 * 本文件只做「入口 + 复用」：不改 serve 内核语义，所有新能力都来自 serve 句柄的
 * 新增方法（createConversation / createRun / subscribeConversation / cancelRun）。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import type { AgentEvent } from "@aiagent/agent";
import { listAvailableModelProfiles, resolveActiveModelFromEnv } from "@aiagent/ai";
import { createCodingToolRegistry } from "@aiagent/coding";
import {
  createOhnaServer,
  listenWithRetry,
  type OhnaServer,
} from "@aiagent/serve";
import type { RunStreamEventDtoV2 } from "@aiagent/types";
import { printProviderError } from "./provider-error.js";
import { loadMcpTools } from "./mcp-config.js";
import { createUsageTracker, renderEvent, type RenderOptions } from "./render.js";
import { createSlashDispatcher, printUnknownCommand } from "./slash.js";
import { CROSS, inputTopBar, inputBottomBar, paint, STOP, supportsAnsi } from "./theme.js";
import { printReplCommands } from "./welcome.js";
import type { CliOptions } from "./args.js";

/** 在途 run 的状态：用于 Ctrl-C 中断与「run 结束后恢复 prompt」。 */
interface ActiveWebRun {
  runId: string;
  /** run_status 终态到达时 resolve。 */
  finish: () => void;
}

/** 可渲染为 AgentEvent 的 run-v2 帧类型（payload 即 AgentEvent JSON）。 */
const AGENT_EVENT_FRAME_TYPES: ReadonlySet<string> = new Set([
  "agent_start",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "agent_end",
]);

/** run-v2 的终态 run_status 取值（与 run-stream-client 的 TERMINAL_STATUSES 一致）。 */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** 跨平台打开浏览器；失败只提示 URL。与 ohna-api 的实现保持同一行为。 */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", url] }
        : { file: "xdg-open", args: [url] };
  try {
    const child = spawn(command.file, command.args, { stdio: "ignore", detached: true });
    child.on("error", () => process.stdout.write(`无法自动打开浏览器，请手动访问：${url}\n`));
    child.unref();
  } catch {
    process.stdout.write(`无法自动打开浏览器，请手动访问：${url}\n`);
  }
}

/**
 * `--web` 托管主流程：装配 serve → 监听 → 建/选会话 → 终端 REPL 与浏览器共享事件流。
 *
 * @param options 已解析的 CLI 选项（web / webDir / webPort / open / mcpConfig / model / yes）。
 */
export async function runWeb(options: CliOptions): Promise<void> {
  const workspaceRoot = path.resolve(options.webDir ?? process.cwd());
  try {
    const stat = await fs.stat(workspaceRoot);
    if (!stat.isDirectory()) throw new Error("not a directory");
  } catch {
    process.stderr.write(`工作区目录不存在或不可访问：${workspaceRoot}\n`);
    process.exitCode = 1;
    return;
  }

  const active = resolveActiveModelFromEnv(options.model);
  if (!active) {
    printProviderError(options.model);
    process.exitCode = 1;
    return;
  }

  // 工具装配与本地 coding 模式一致；--mcp 追加外部工具（失败只警告，不中断托管）。
  const tools = createCodingToolRegistry(workspaceRoot);
  const mcpToolNames = new Set<string>();
  let mcpServerNames: string[] = [];
  const mcp = options.mcpConfig ? await loadMcpTools(options.mcpConfig) : null;
  if (mcp) {
    tools.push(...mcp.tools);
    for (const name of mcp.toolNames) mcpToolNames.add(name);
    mcpServerNames = mcp.serverNames;
  }

  const server: OhnaServer = await createOhnaServer({
    workspaceRoot,
    model: active.model,
    apiKey: active.apiKey,
    tools,
    autoApprove: options.yes,
  });

  const listening = await listenWithRetry(server, options.webPort);

  // 终端与浏览器共享同一会话：conversation 由 serve 的 sessionStore 持有，
  // 浏览器 GET /api/conversations 能看到它；/resume 可切换到浏览器创建的会话。
  const conversation = await server.createConversation("终端会话");
  let conversationId = conversation.conversationId;
  let conversationTitle = conversation.title;

  const tracker = createUsageTracker();
  const renderOptions: RenderOptions = {
    mode: "coding",
    workspaceRoot,
    mcpToolNames,
  };

  /** 在途 run 状态（本终端创建的最近一次 run）。 */
  let activeRun: ActiveWebRun | null = null;

  // 终态 runId 记录：createRun 与订阅回调之间存在「run 已终态但 activeRun 未赋值」的窗口，
  // 命中该集合时在赋值后立即 resolve，避免 REPL 挂在等待终态上（幂等 resolve 安全）。
  const terminalRunIds = new Set<string>();

  // 会话级订阅先于 REPL 建立：浏览器在同一会话发的 run 也实时渲染到终端（C-M3-6）。
  let unsubscribe = server.subscribeConversation(conversationId, (event) => {
    if (event.type === "run_status") {
      const status = (event.payload as { status?: string } | null)?.status;
      if (status && TERMINAL_RUN_STATUSES.has(status)) terminalRunIds.add(event.runId);
    }
    renderFrame(event, tracker, renderOptions, activeRun, () => {
      activeRun?.finish();
    });
  });

  process.stdout.write(
    [
      "ohna --web · 进程内托管已启动",
      `  工作目录：${workspaceRoot}`,
      `  模型：${active.model.id}（${active.model.provider}）`,
      `  地址：${listening.url}`,
      `  会话：${conversationId}（终端与浏览器共享同一会话）`,
      `  确认方式：${options.yes ? "已自动批准写/执行（--yes）" : "写/执行需在终端或浏览器确认"}`,
      "",
    ].join("\n"),
  );
  if (options.open) {
    openBrowser(listening.url);
  } else {
    process.stdout.write(`已跳过自动打开浏览器（--no-open），请手动访问：${listening.url}\n`);
  }
  process.stdout.write("\n  /help 查看命令；输入问题开始对话（浏览器可见同一会话）。\n\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "│ > " });

  /** 上次绘制顶线时的列宽：用于屏蔽「同宽 resize 虚假事件」与自触发风暴。 */
  let lastColumns = process.stdout.columns || 80;
  /** 重绘防重入：rl.prompt() 可能同步派发 resize，包成临界区避免递归风暴。 */
  let redrawing = false;

  /**
   * 打印输入区顶线（TTY 门控）后进入 readline prompt（§3.4 降级：打印式顶线 + 单行 prompt）。
   */
  const promptInput = (): void => {
    if (supportsAnsi()) {
      const cols = process.stdout.columns || 80;
      process.stdout.write(paint(inputTopBar(cols), "dim"));
      lastColumns = cols;
    }
    rl.prompt();
  };
  promptInput();

  let closed = false;
  let stopRequested = false;
  let running = false;
  const pending: string[] = [];
  let finish: (() => void) | undefined;

  /**
   * 终端尺寸变化：仅当空闲（无 run、未 EOF、未关闭）且当前输入行为空时才重绘当前输入
   * 框顶线到新列宽。有未提交输入时不重绘（避免 readline 行缓冲视觉错位）；run 进行中
   * 不重绘（避免污染流式输出）。已滚入历史的旧顶线无法回改，此为单框修正。
   */
  if (supportsAnsi()) {
    process.stdout.on("resize", () => {
      if (running || closed) return;
      if (rl.line !== "") return;
      if (redrawing) return; // 防重入：避免 rl.prompt() 触发同步 resize 造成递归风暴
      const cols = process.stdout.columns || 80;
      if (cols === lastColumns) return; // 宽度未变不重绘，屏蔽持续同宽 resize 虚假事件
      redrawing = true;
      try {
        lastColumns = cols;
        process.stdout.write("\r\x1b[1A\x1b[2K"); // 回到顶线行并清空
        process.stdout.write(paint(inputTopBar(cols), "dim")); // 新宽度顶线
        process.stdout.write("\r\x1b[2K"); // 清空旧 prompt 行
        rl.prompt();
      } finally {
        redrawing = false;
      }
    });
  }

  /** 切换会话：退订旧会话、订阅新会话（/resume 与 /clear 共用）。 */
  const switchConversation = async (nextId: string, title: string): Promise<void> => {
    unsubscribe();
    conversationId = nextId;
    conversationTitle = title;
    unsubscribe = server.subscribeConversation(conversationId, (event) => {
      if (event.type === "run_status") {
        const status = (event.payload as { status?: string } | null)?.status;
        if (status && TERMINAL_RUN_STATUSES.has(status)) terminalRunIds.add(event.runId);
      }
      renderFrame(event, tracker, renderOptions, activeRun, () => activeRun?.finish());
    });
  };

  const dispatch = createSlashDispatcher({
    onUnknown: printUnknownCommand,
    handlers: {
      help: () => printReplCommands(),
      cost: () => {
        const snapshot = tracker.snapshot();
        process.stdout.write(
          snapshot.total === 0
            ? "累计用量：暂无（本会话尚未产生模型调用）\n"
            : `累计用量：token ${snapshot.total}（输入 ${snapshot.input} / 输出 ${snapshot.output}），成本 $${snapshot.cost.toFixed(6)}\n`,
        );
      },
      tools: () => {
        for (const tool of tools) {
          process.stdout.write(`  ${tool.name}${mcpToolNames.has(tool.name) ? "（MCP）" : ""}\n`);
        }
        process.stdout.write(`共 ${tools.length} 个工具。\n`);
      },
      model: (arg) => {
        if (!arg) {
          process.stdout.write(
            `当前模型：${active.model.id}（profile: ${active.model.provider}）\n` +
              `可用 profile：${listAvailableModelProfiles().join("、") || "（无）"}\n` +
              "提示：--web 托管模式下模型在启动时装配，切换 profile 请重启进程。\n",
          );
          return;
        }
        process.stdout.write(
          "提示：--web 托管模式下模型在启动时装配，切换 profile 请用 --model <profile> 重启进程。\n",
        );
      },
      // web 模式的压缩由 serve 在每次 run 前自动管理（L3-3）；不提供手动触发端点。
      compact: () => {
        process.stdout.write(
          "web 托管模式下，会话压缩由 serve 在每次 run 前自动管理（超窗时摘要并落盘 compaction 消息），无需手动触发。\n",
        );
      },
      resume: async (arg) => {
        const conversations = await server.listConversations();
        if (!arg) {
          if (conversations.length === 0) {
            process.stdout.write("暂无历史会话。\n");
            return;
          }
          process.stdout.write("最近会话（serve 会话存储）：\n");
          for (const item of conversations.slice(0, 10)) {
            process.stdout.write(`  ${item.conversationId}  ${item.title}  ${item.updatedAt}\n`);
          }
          process.stdout.write("使用 /resume <id> 切换（终端与浏览器将共享切换后的会话）。\n");
          return;
        }
        const target = conversations.find((item) => item.conversationId === arg);
        if (!target) {
          process.stdout.write(`未找到会话 "${arg}"，保持当前会话不变。\n`);
          return;
        }
        await switchConversation(target.conversationId, target.title);
        process.stdout.write(`已切换到会话 ${target.conversationId}（标题：${target.title}）。\n`);
      },
      clear: async () => {
        const previousId = conversationId;
        const fresh = await server.createConversation();
        await switchConversation(fresh.conversationId, fresh.title);
        process.stdout.write(
          `已另开新会话：${fresh.conversationId}（旧会话 ${previousId} 保留在 serve 会话存储）\n`,
        );
      },
      exit: () => {
        stopRequested = true;
        pending.length = 0;
        closed = true;
        rl.close();
      },
    },
  });

  /**
   * 处理一行输入：命令即时响应；普通文本经 serve 创建 run 并等待终态。
   *
   * @param text 已 trim 的输入。
   */
  const processLine = async (text: string): Promise<void> => {
    running = true;
    // 对齐 repl.ts 的 run 期间 pause 语义：浏览器/终端发起的 run 期间挂起 prompt，
    // 避免 spinner 与 readline 的输入区顶线打架（§3.3 web 模式对齐）。
    if (!closed) rl.pause();
    try {
      if (await dispatch(text)) return;

      if (activeRun) {
        process.stdout.write("已有进行中的 run，请等待完成或 Ctrl-C 中断。\n");
        return;
      }

      // 终端输入与浏览器 composer 走同一条 run-v2 路径：同一会话、同一事件流。
      const { accepted } = await server.createRun({
        conversationId,
        message: text,
        mode: "auto",
        source: "composer",
      });
      await new Promise<void>((resolve) => {
        activeRun = { runId: accepted.runId, finish: resolve };
        // 竞态兜底：run 在 createRun 返回与赋值之间已终态（stub/极速响应），立即收尾。
        if (terminalRunIds.has(accepted.runId)) resolve();
      });
      terminalRunIds.delete(accepted.runId);
      activeRun = null;
    } catch (error) {
      process.stdout.write(`\n运行出错：${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      running = false;
      const next = stopRequested ? undefined : pending.shift();
      if (next !== undefined) {
        void processLine(next);
      } else if (!closed) {
        rl.resume();
        promptInput();
      }
      if (closed && !running && pending.length === 0) finish?.();
    }
  };

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) {
      if (!running && !closed) promptInput();
      return;
    }
    if (closed) return;
    if (running) {
      pending.push(text);
      return;
    }
    // 提交输入：先打印输入框下边框，把当前输入行在滚动历史里闭合为完整盒子。
    if (supportsAnsi()) {
      process.stdout.write(paint(inputBottomBar(process.stdout.columns || 80), "dim"));
    }
    void processLine(text);
  });

  rl.on("SIGINT", () => {
    if (activeRun) {
      // 有在途 run：走 serve 的取消语义（deny 挂起确认 → abort → interrupted 终态）。
      const runId = activeRun.runId;
      process.stdout.write("\n正在中断当前 run…\n");
      void server.cancelRun(runId);
      return;
    }
    stopRequested = true;
    pending.length = 0;
    closed = true;
    rl.close();
    finish?.();
  });

  rl.on("close", () => {
    closed = true;
    if (!running && pending.length === 0) finish?.();
  });

  await new Promise<void>((resolve) => {
    finish = resolve;
  });

  // 干净退出：中断在途 run（shutdown 内部 abort + interrupted 落盘）→ 关闭 HTTP → 关闭 MCP 子进程。
  await server.shutdown();
  await server.close();
  await mcp?.close();
  process.stdout.write(`\n会话已保留：${conversationId}（标题：${conversationTitle}）\n浏览器可继续访问 ${listening.url} 查看历史。\n`);
}

/**
 * 渲染单帧 run-v2 事件：AgentEvent 帧交给 renderEvent（流式 delta / 工具 / diff / 折叠），
 * run_status 终态触发在途 run 的收尾回调。
 *
 * @param event run-v2 帧。
 * @param tracker 会话级用量累计器。
 * @param options 渲染选项。
 * @param activeRun 在途 run（匹配 runId 时终态收尾）。
 * @param onFinish 终态回调。
 */
function renderFrame(
  event: RunStreamEventDtoV2,
  tracker: ReturnType<typeof createUsageTracker>,
  options: RenderOptions,
  activeRun: ActiveWebRun | null,
  onFinish: () => void,
): void {
  if (event.type === "run_status") {
    if (activeRun && event.runId === activeRun.runId) onFinish();
    const status = (event.payload as { status?: string } | null)?.status;
    if (status === "interrupted") process.stdout.write("\n" + paint(`${STOP} run 已中断。`, "dim") + "\n");
    if (status === "failed") process.stdout.write("\n" + paint(`${CROSS} run 失败。`, "error") + "\n");
    return;
  }
  if (event.type === "run_error") {
    const error = (event.payload as { error?: { message?: string } } | null)?.error;
    process.stdout.write("\n" + paint(`${CROSS} run 错误：${error?.message ?? "未知错误"}`, "error") + "\n");
    return;
  }
  // 确认事件 / MCP discovery 事件由浏览器与日志侧消费，终端不重复渲染。
  if (!AGENT_EVENT_FRAME_TYPES.has(event.type)) return;
  renderEvent(event.payload as AgentEvent, tracker, options);
}
