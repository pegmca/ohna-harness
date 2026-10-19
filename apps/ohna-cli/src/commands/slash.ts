/**
 * REPL 斜杠命令体系：解析、别名与分发。
 *
 * 设计边界（M3）：命令解析与「命令做什么」分离——本模块只负责把输入识别成
 * `{ name, arg }` 并调用注入的 handler；会话状态（history / 模型 / 工具 / serve 会话）
 * 全部由调用方（repl.ts 本地模式 / web-entry.ts 托管模式）持有并通过 handler 闭包提供，
 * 因此本模块不与 repl / harness / serve 形成任何运行时依赖。
 *
 * 命令不消耗 token、不进 history：REPL 循环必须在构造用户消息之前先走命令分发。
 *
 * 输出边界：本模块只经 render 的 `write()` 出口写终端，不直写 stdout——TTY 整屏模式下
 * 输出由 sink 接管进入对话模型，直写会在下一次整屏重绘时被清屏抹掉。
 */

import { write } from "../ui/render.js";

/** 可识别的斜杠命令。 */
export type SlashCommandName =
  | "help"
  | "clear"
  | "cost"
  | "exit"
  | "model"
  | "compact"
  | "tools"
  | "resume"
  | "verbose"
  | "permissions"
  | "status"
  | "mcp"
  | "export";

/** 命令面板条目：命令名（含 `/` 前缀）与一句话描述，供 `/` 面板与 /help 共用。 */
export interface SlashCommandDef {
  /** 面板展示的命令名，如 `/help`。 */
  name: string;
  /** 一句话描述。 */
  description: string;
}

/**
 * 会话内命令的单一来源（single source of truth）。
 *
 * `/` 命令面板与 /help 文案都从这份列表生成，避免两处维护同一份命令名/描述。
 * 顺序即面板展示顺序；解析器仍走 {@link COMMAND_ALIASES}（含旧别名），两者互补：
 * 这里管「展示/过滤」，别名表管「输入 → 命令」的归一化。
 */
export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  { name: "/help", description: "查看会话内命令" },
  { name: "/clear", description: "清空上下文并另开新会话（旧会话保留）" },
  { name: "/cost", description: "查看本会话累计 token 与成本" },
  { name: "/model", description: "无参列出 profile，带参切换模型" },
  { name: "/compact", description: "立即压缩当前会话上下文" },
  { name: "/tools", description: "列出当前工具（MCP 工具标注来源）" },
  { name: "/resume", description: "无参列出最近会话，带参切换会话" },
  { name: "/exit", description: "退出会话（等价别名 exit、:q）" },
  // 面板展示上限为 MAX_PALETTE_ITEMS（现为 12）：当前命令全部可见；/help 始终完整列出。
  { name: "/permissions", description: "查看权限模式与会话规则；clear / mode 管理" },
  { name: "/status", description: "查看模型 / 会话 / 用量 / MCP / 权限快照" },
  { name: "/mcp", description: "列出已接入的 MCP server 与工具" },
  { name: "/export", description: "把当前会话导出为 Markdown" },
];

/**
 * 按前缀过滤命令（大小写不敏感），用于 `/` 命令面板的实时筛选。
 *
 * @param prefix 输入框当前内容（如 `/`、`/he`）；空串返回全部命令。
 * @returns 命中前缀的命令列表（保持 {@link SLASH_COMMANDS} 原始顺序）。
 */
export function filterSlashCommands(prefix: string): SlashCommandDef[] {
  const p = prefix.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(p));
}

/** 命令别名表：keep 旧别名（exit/:q 等）以兼容 M2 的输入习惯与既有脚本。 */
const COMMAND_ALIASES: ReadonlyArray<readonly [SlashCommandName, readonly string[]]> = [
  ["help", ["/help", "/?", "help"]],
  ["clear", ["/clear", "/reset"]],
  ["cost", ["/cost"]],
  ["exit", ["/exit", "/quit", "/q", ":q", "exit", "quit"]],
  ["model", ["/model"]],
  ["compact", ["/compact"]],
  ["tools", ["/tools"]],
  ["resume", ["/resume"]],
  ["permissions", ["/permissions"]],
  ["status", ["/status"]],
  ["mcp", ["/mcp"]],
  ["export", ["/export"]],
  // F-3：/verbose 是「非 TTY 下 ctrl+o 的等价入口」，**刻意不入面板 / /help**：
  // 它是 TTY 能力（ctrl+o）的降级入口而非通用命令，避免主面板出现两条等价路径。
  ["verbose", ["/verbose"]],
];

/** 解析出的命令调用。 */
export interface SlashInvocation {
  name: SlashCommandName;
  /** 除命令名外的剩余参数（已 trim；如 /model deepseek 的 "deepseek"）。 */
  arg: string;
}

/**
 * 把一行输入解析为斜杠命令。
 *
 * @param text 已 trim 的用户输入。
 * @returns 命中的命令；普通提问返回 null，交由模型处理。
 */
export function parseSlashCommand(text: string): SlashInvocation | null {
  const input = text.trim();
  const spaceIndex = input.search(/\s/);
  const head = (spaceIndex === -1 ? input : input.slice(0, spaceIndex)).toLowerCase();
  const arg = spaceIndex === -1 ? "" : input.slice(spaceIndex + 1).trim();
  for (const [name, aliases] of COMMAND_ALIASES) {
    if (aliases.includes(head)) return { name, arg };
  }
  return null;
}

/** 命令处理器集合：调用方只注册当前模式支持的命令；未注册的命令回退到 onUnknown。 */
export interface SlashHandlers {
  help?: () => void | Promise<void>;
  clear?: () => void | Promise<void>;
  cost?: () => void | Promise<void>;
  exit?: () => void | Promise<void>;
  /** /model [profile]：无参列出可用 profile 与当前；带参切换。 */
  model?: (arg: string) => void | Promise<void>;
  /** /compact：立即做一次会话级压缩。 */
  compact?: () => void | Promise<void>;
  /** /tools：列出当前工具名（MCP 工具标注来源）。 */
  tools?: () => void | Promise<void>;
  /** /resume [id]：无参列出最近会话；带参切换会话并载入历史。 */
  resume?: (arg: string) => void | Promise<void>;
  /** /verbose：切换详细模式（思考过程 / 折叠块全文）；非 TTY 下 ctrl+o 的等价入口。 */
  verbose?: () => void | Promise<void>;
  /**
   * /permissions：无参展示当前模式 + 会话规则；`clear` 清空规则；
   * `mode <preset>` 便于非 TTY 环境切换（TTY 下等价入口是 Shift+Tab）。
   */
  permissions?: (arg: string) => void | Promise<void>;
  /** /status：模型 / 会话 / 用量 / MCP / Team / 权限快照。 */
  status?: () => void | Promise<void>;
  /** /mcp：列出已接入的 MCP server 与工具。 */
  mcp?: () => void | Promise<void>;
  /** /export：把当前 history 导出为 Markdown。 */
  export?: () => void | Promise<void>;
}

/** 分发器的构造参数。 */
export interface SlashDispatcherOptions {
  handlers: SlashHandlers;
  /** 命中未知 / 未注册命令时的提示（如「未知命令 /foo」）。 */
  onUnknown?: (name: string) => void;
}

/** 命令分发器：返回 true 表示输入已被命令消费（不进入模型调用）。 */
export type SlashDispatcher = (text: string) => Promise<boolean>;

/**
 * 创建命令分发器：把解析与执行绑定到调用方注入的 handlers。
 *
 * @param options handlers 与未知命令提示。
 * @returns 异步分发器（handler 允许是 async，如 /resume 读盘、/compact 摘要）。
 */
export function createSlashDispatcher(options: SlashDispatcherOptions): SlashDispatcher {
  return async (text) => {
    const invocation = parseSlashCommand(text);
    if (!invocation) return false;
    const handler = options.handlers[invocation.name];
    if (!handler) {
      options.onUnknown?.(invocation.name);
      return true;
    }
    await handler(invocation.arg);
    return true;
  };
}

/**
 * 打印未知命令提示（本地 / web 模式共用的默认文案）。
 *
 * @param text 用户原始输入。
 */
export function printUnknownCommand(text: string): void {
  // 经 render 的统一输出出口：TTY 整屏模式下会被 sink 注入进对话模型，
  // 直写 process.stdout 则会被下一帧 clearScreen 抹掉（用户完全看不到）。
  write(`未知命令：${text}（输入 /help 查看可用命令）\n`);
}
