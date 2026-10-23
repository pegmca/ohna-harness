/**
 * REPL 的本地会话命令装配：构造 SessionCommandContext 并注入 slash 分发器。
 *
 * 从 repl.ts 拆出的原因：命令上下文与 handler 表是「会话状态 → 命令实现」的接线，
 * 与输入循环的并发 / EOF 语义无关。拆出后 repl 只保留分发调用，本模块通过 getter/setter
 * 读取调用方的可变绑定，不持有会话状态，也不反向 import repl。
 *
 * 依赖方向：向下依赖 commands / session / ui；调用方注入所有跨轮状态。
 */
import type { ActiveModel } from "@aiagent/ai";
import type { AgentMessage } from "@aiagent/agent";
import type { AgentTool } from "@aiagent/tools";
import {
  clearSession,
  compactNow,
  exportSession,
  printMcp,
  printStatus,
  printTools,
  resumeSession,
  switchModel,
  type SessionCommandContext,
} from "../commands/session-commands.js";
import {
  createSlashDispatcher,
  printUnknownCommand,
  type CommandContext,
  type SlashDispatcher,
} from "../commands/registry.js";
import type { PermissionSession } from "../permission/permission-session.js";
import type { RunSetup } from "../runtime/turn.js";
import { ensureFullHistory } from "../session/session-flow.js";
import { formatCostLine, write, type UsageTracker } from "../ui/render.js";
import type { TuiApp } from "../ui/tui/tui-app.js";
import { printReplCommands } from "../ui/welcome.js";
import type { ReplContext } from "./repl-context.js";

/** 本地命令装配的依赖：所有可变会话状态都用访问器暴露。 */
export interface ReplCommandsOptions {
  /** 已装配的工具列表。 */
  tools: readonly AgentTool<any>[];
  /** MCP / Team 来源标注与闸门回填（可选）。 */
  context?: ReplContext;
  /** 会话存储。 */
  store: SessionCommandContext["store"];
  /** 会话级用量累计器。 */
  tracker: UsageTracker;
  /** 会话级模式配置。 */
  setup: RunSetup;
  /** 当前 history（原地 replace，保持引用稳定）。 */
  history: AgentMessage[];
  /** 读取当前模型（`/model` 切换后 run 与压缩都用最新值）。 */
  getModel(): ActiveModel;
  /** 切换当前模型。 */
  setModel(model: ActiveModel): void;
  /** 读取当前会话 id。 */
  getSessionId(): string;
  /** 切换当前会话 id。 */
  setSessionId(id: string): void;
  /** 读取会话标题。 */
  getTitle(): string | undefined;
  /** 设置会话标题。 */
  setTitle(title: string | undefined): void;
  /** 跨轮权限会话（`/permissions` 与 `/status` 共享）。 */
  permissionSession: PermissionSession;
  /** tail 恢复的 history 是否已补载为完整历史。 */
  isFullHistoryLoaded(): boolean;
  /** 标记 history 已完整（补载成功 / 切换到完整会话后）。 */
  markFullHistoryLoaded(): void;
  /** 整屏 TUI（`/resume` 无参时打开选择器）；readline 分支为 undefined。 */
  tui?: TuiApp;
  /**
   * `/verbose` 的降级入口（非 TTY 无法可靠捕获 ctrl+o）。
   *
   * @param arg 可选 `low` / `medium` / `high`。
   */
  cycleVerbosity(arg: string): void;
  /** `/exit`：清空待处理队列并关闭输入。 */
  onExit(): void;
  /**
   * 会话切换后重渲染欢迎头（logo + 信息行）。
   *
   * BUG「/clear 后 logo 消失」：`resetPresentation` 只清空对话流条目、不重打欢迎头，
   * 因此 `/clear`、`/resume`、fork 切会话后顶部 logo 会消失。由 repl 注入此回调，
   * 在 `onSessionSwitched` 里用新会话 id 重新调用 `renderWelcome`。
   */
  onRenderWelcome?: () => void;
}

/**
 * 创建本地会话语义的 slash 分发器。
 *
 * @param options 会话状态访问器、存储与 UI 动作。
 * @returns 与 web 托管模式同协议的命令分发器（true 表示命令已消费该输入）。
 */
export function createReplCommands(options: ReplCommandsOptions): SlashDispatcher {
  const {
    tools,
    context,
    store,
    tracker,
    setup,
    history,
    permissionSession,
  } = options;

  /**
   * 会话命令上下文：把可变绑定（模型 / 会话 id / 标题）以 getter/setter 暴露给
   * session-commands.ts，命令实现不再挤在输入循环里。
   */
  const commandCtx: SessionCommandContext = {
    tools,
    ...(context?.mcpToolNames ? { mcpToolNames: context.mcpToolNames } : {}),
    ...(context?.mcpServerNames ? { mcpServerNames: context.mcpServerNames } : {}),
    ...(context?.teamToolNames ? { teamToolNames: context.teamToolNames } : {}),
    store,
    tracker,
    setup,
    history,
    getModel: () => options.getModel(),
    setModel: (model) => {
      options.setModel(model);
    },
    getSessionId: () => options.getSessionId(),
    setSessionId: (id) => {
      options.setSessionId(id);
    },
    getTitle: () => options.getTitle(),
    setTitle: (title) => {
      options.setTitle(title);
    },
    getPermissionPreset: () => permissionSession.preset(),
    isFullHistoryLoaded: () => options.isFullHistoryLoaded(),
    // /compact 落盘前补载完整历史：tail 恢复后先压缩尾部再覆盖保存会丢掉更早消息。
    ensureFullHistory: async () => {
      if (options.isFullHistoryLoaded()) return;
      const activeSessionId = options.getSessionId();
      const loaded = await ensureFullHistory(store, activeSessionId, history, (message) =>
        write(`⚠️ ${message}\n`),
      );
      if (!loaded) throw new Error(`无法补载会话 ${activeSessionId} 的完整历史`);
      options.markFullHistoryLoaded();
    },
    // /resume 成功切换后清空会话规则（/clear 通过同一钩子完成）。
    // 所有切换路径（/resume 全量 load、fork、/clear 新建）得到的历史都是完整的。
    onSessionSwitched: () => {
      options.markFullHistoryLoaded();
      permissionSession.reset();
      // M2：切会话后清空 TUI 视图状态（expanded / 滚动 / toast），避免旧会话残留。
      options.tui?.resetView();
      // BUG「/clear 后 logo 消失」：会话切换后重打欢迎头（logo + 信息行）。
      options.onRenderWelcome?.();
    },
  };

  // 命令分发：slash.ts 负责解析与别名，这里只注入本地会话语义的 handler。
  return createSlashDispatcher({
    onUnknown: printUnknownCommand,
    context: {
      help: () => printReplCommands(),
      cost: () => {
        write(formatCostLine(tracker) + "\n");
      },
      model: (arg) => switchModel(commandCtx, arg),
      compact: () => compactNow(commandCtx),
      tools: () => printTools(commandCtx),
      resume: async (arg) => {
        const trimmed = arg.trim();
        // TUI 无参：打开可上下选择的会话面板（对齐 Claude Code）；
        // 非 TTY 仍回退为打印列表 + `/resume <id>`。
        if (!trimmed && options.tui) {
          let metas;
          try {
            metas = await store.list();
          } catch (error) {
            write(`读取会话列表失败（${error instanceof Error ? error.message : String(error)}）。\n`);
            return;
          }
          if (metas.length === 0) {
            write("暂无历史会话。\n");
            return;
          }
          options.tui.openSessionPicker(
            metas.map((meta) => ({
              id: meta.id,
              title: meta.title,
              updatedAt: meta.updatedAt,
              messageCount: meta.messageCount,
            })),
          );
          return;
        }
        await resumeSession(commandCtx, arg);
      },
      // F-3 非 TTY 等价入口：readline 下无法可靠捕获 ctrl+o，用 /verbose 循环 verbosity。
      verbose: (arg) => options.cycleVerbosity(arg),
      // B2：/permissions 是无 TTY 环境下 Shift+Tab 的等价管理入口。
      permissions: (arg) => {
        write(permissionSession.handleCommand(arg));
      },
      clear: () => clearSession(commandCtx),
      status: () => printStatus(commandCtx),
      mcp: () => printMcp(commandCtx),
      export: () => exportSession(commandCtx),
      exit: () => {
        // /exit 清空待处理队列并关闭输入；当前 run 结束后主 Promise 才会 resolve。
        options.onExit();
      },
    } satisfies CommandContext,
  });
}
