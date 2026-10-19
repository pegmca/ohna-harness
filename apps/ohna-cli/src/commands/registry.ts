/**
 * 会话内命令的**单一注册表**（Phase C2 · D4）。
 *
 * 改造前命令元数据散落在五处手工同步（命令名 union、面板列表、别名表、handler 结构、
 * 面板条数上限），新增一条命令要改多处且容易脱节。这里把「命令是什么」收敛成
 * {@link CommandDef} 一条记录：别名解析、`/` 面板过滤、`/help` 文案、分发执行全部从
 * 同一张表派生——**新增命令只改 `COMMAND_DEFINITIONS` 一处**。
 *
 * 分层边界与旧 slash.ts 一致：
 * - 本模块只把输入识别成命令并调用注入的 handler；会话状态（history / 模型 / 工具 /
 *   serve 会话）由调用方（repl.ts 本地模式 / web-entry.ts 托管模式）通过
 *   {@link CommandContext} 的闭包提供，因此不与 repl / harness / serve 形成运行时依赖；
 * - 命令不消耗 token、不进 history：REPL 循环必须在构造用户消息之前先走命令分发；
 * - 输出只经 render 的 `write()` 出口，不直写 stdout（TTY 整屏下直写会被下一帧清屏抹掉）。
 */
import { write } from "../ui/render.js";

/** 命令 handler 的统一签名：接收命令名之外的剩余参数（已 trim）。 */
export type CommandHandler = (arg: string) => void | Promise<void>;

/**
 * 调用方注入的 handler 集合。
 *
 * 键名与命令 id 的末段一一对应（`"session.model"` → `model`），因此注册表无需再维护
 * 一份「id → handler 键」的映射表。未提供某字段表示当前模式不注册该命令，
 * 命中时回退到 `onUnknown`。
 */
export interface CommandContext {
  /** /help：查看会话内命令。 */
  help?: CommandHandler;
  /** /clear：清空上下文并另开新会话。 */
  clear?: CommandHandler;
  /** /cost：查看本会话累计 token 与成本。 */
  cost?: CommandHandler;
  /** /exit：退出会话。 */
  exit?: CommandHandler;
  /** /model [profile]：无参列出 profile，带参切换。 */
  model?: CommandHandler;
  /** /compact：立即压缩当前会话上下文。 */
  compact?: CommandHandler;
  /** /tools：列出当前工具。 */
  tools?: CommandHandler;
  /** /resume [id]：无参列出最近会话，带参切换。 */
  resume?: CommandHandler;
  /** /verbose [low|medium|high]：TTY 下 ctrl+o 的降级入口。 */
  verbose?: CommandHandler;
  /** /permissions [clear|mode …]：查看与管理权限模式。 */
  permissions?: CommandHandler;
  /** /status：模型 / 会话 / 用量 / MCP / 权限快照。 */
  status?: CommandHandler;
  /** /mcp：列出已接入的 MCP server 与工具。 */
  mcp?: CommandHandler;
  /** /export：把当前会话导出为 Markdown。 */
  export?: CommandHandler;
}

/**
 * 一条命令的完整定义（唯一契约，勿在别处重复声明命令元数据）。
 */
export interface CommandDef {
  /** 稳定 id，形如 `session.exit`；末段即 {@link CommandContext} 的 handler 键。 */
  id: string;
  /** 短标题（帮助分组用）。 */
  title: string;
  /** 一句话描述（面板与 /help 共用）。 */
  description: string;
  /** 斜杠调用形态：主名 + 历史别名（含不带 `/` 的旧写法）。 */
  slash?: { name: string; aliases?: string[] };
  /** 关联的全局键位 id（如 `ctrl+o`，帮助展示用；键序列本身归 ui/tui/keymap）。 */
  keys?: string;
  /** 是否出现在 `/` 面板与 /help；false 表示隐藏（如 /verbose）。缺省可见。 */
  panel?: boolean;
  /** 执行体：返回 true 表示已处理。 */
  run?: (ctx: CommandContext, arg: string) => Promise<boolean> | void;
}

/** 面板 / /help 使用的展示条目：命令名（含 `/`）与描述。 */
export interface SlashCommandDef {
  /** 面板展示的命令名，如 `/help`。 */
  name: string;
  /** 一句话描述。 */
  description: string;
}

/** 解析出的命令调用。 */
export interface SlashInvocation {
  /** 命令短名（不含 `/`，如 `model`）。 */
  name: string;
  /** 除命令名外的剩余参数（已 trim）。 */
  arg: string;
}

/** 命令分发器：返回 true 表示输入已被命令消费（不进入模型调用）。 */
export type SlashDispatcher = (text: string) => Promise<boolean>;

/** 分发器的构造参数。 */
export interface SlashDispatcherOptions {
  /** 调用方注入的 handler 集合。 */
  context: CommandContext;
  /** 命中未知 / 未注册命令时的提示（如「未知命令 /foo」）。 */
  onUnknown?: (name: string) => void;
  /** 可注入的自定义注册表（测试「新增命令只改一处」用）；缺省全局注册表。 */
  registry?: CommandRegistry;
}

/**
 * 命令注册表：解析、过滤、帮助与查找都从同一份定义派生。
 *
 * 做成类而非若干常量，是为了让测试能构造带额外命令的注册表，验证
 * 「新增命令只改一处」——parser / filter / help 无需任何修改即可感知新命令。
 */
export class CommandRegistry {
  /** 全部命令定义（顺序即面板展示顺序）。 */
  readonly definitions: readonly CommandDef[];
  /** 斜杠名（含别名，小写）→ 定义。 */
  private readonly slashIndex = new Map<string, CommandDef>();

  /**
   * @param definitions 命令定义列表（顺序即面板顺序）。
   */
  constructor(definitions: readonly CommandDef[]) {
    this.definitions = [...definitions];
    for (const def of this.definitions) {
      if (!def.slash) continue;
      for (const alias of slashForms(def)) this.slashIndex.set(alias, def);
    }
  }

  /**
   * 按 id 或短名查找命令。
   *
   * @param id 完整 id（`session.exit`）或短名（`exit`）。
   * @returns 命中的定义；未命中返回 undefined。
   */
  get(id: string): CommandDef | undefined {
    const key = id.includes(".") ? id.slice(id.lastIndexOf(".") + 1) : id;
    return this.definitions.find((def) => def.id === id || def.id.slice(def.id.lastIndexOf(".") + 1) === key);
  }

  /** 面板可见的命令（有 slash 且未被 `panel:false` 隐藏）。 */
  panelDefinitions(): CommandDef[] {
    return this.definitions.filter((def) => def.slash !== undefined && def.panel !== false);
  }

  /** 面板 / /help 的展示条目。 */
  panelEntries(): SlashCommandDef[] {
    return this.panelDefinitions().map((def) => ({
      name: def.slash!.name,
      description: def.description,
    }));
  }

  /**
   * 把一行输入解析为命令调用。
   *
   * @param text 已 trim 的用户输入。
   * @returns 命中的命令；普通提问 / 未知命令返回 null（交由模型处理）。
   */
  parse(text: string): SlashInvocation | null {
    const input = text.trim();
    const spaceIndex = input.search(/\s/);
    const head = (spaceIndex === -1 ? input : input.slice(0, spaceIndex)).toLowerCase();
    const arg = spaceIndex === -1 ? "" : input.slice(spaceIndex + 1).trim();
    const def = this.slashIndex.get(head);
    if (!def) return null;
    return { name: shortName(def), arg };
  }

  /**
   * 按前缀过滤面板命令（大小写不敏感）。
   *
   * @param prefix 输入框当前内容（如 `/`、`/he`）；空串返回全部。
   * @returns 命中前缀的命令列表（保持定义顺序）。
   */
  filter(prefix: string): SlashCommandDef[] {
    const p = prefix.toLowerCase();
    return this.panelEntries().filter((entry) => entry.name.toLowerCase().startsWith(p));
  }

  /**
   * 生成 /help 的命令行文案（名称与描述两列对齐）。
   *
   * @returns 每个面板命令一行；无命令时为空数组。
   */
  helpLines(): string[] {
    const entries = this.panelEntries();
    if (entries.length === 0) return [];
    const pad = Math.max(...entries.map((entry) => entry.name.length));
    return entries.map((entry) => `  ${entry.name.padEnd(pad)}  ${entry.description}`);
  }
}

/**
 * 命令定义表：顺序即 `/` 面板与 /help 的展示顺序。
 *
 * `/verbose` 刻意排在最后并 `panel:false`：它是 TTY 能力（ctrl+o）的降级入口，
 * 不是通用命令，避免主面板出现两条等价路径。
 */
export const COMMAND_DEFINITIONS: readonly CommandDef[] = [
  {
    id: "session.help",
    title: "帮助",
    description: "查看会话内命令",
    slash: { name: "/help", aliases: ["/?", "help"] },
    run: async (ctx, arg) => {
      await ctx.help?.(arg);
      return true;
    },
  },
  {
    id: "session.clear",
    title: "新会话",
    description: "清空上下文并另开新会话（旧会话保留）",
    slash: { name: "/clear", aliases: ["/reset"] },
    run: async (ctx, arg) => {
      await ctx.clear?.(arg);
      return true;
    },
  },
  {
    id: "session.cost",
    title: "成本",
    description: "查看本会话累计 token 与成本",
    slash: { name: "/cost" },
    run: async (ctx, arg) => {
      await ctx.cost?.(arg);
      return true;
    },
  },
  {
    id: "session.model",
    title: "模型",
    description: "无参列出 profile，带参切换模型",
    slash: { name: "/model" },
    run: async (ctx, arg) => {
      await ctx.model?.(arg);
      return true;
    },
  },
  {
    id: "session.compact",
    title: "压缩",
    description: "立即压缩当前会话上下文",
    slash: { name: "/compact" },
    run: async (ctx, arg) => {
      await ctx.compact?.(arg);
      return true;
    },
  },
  {
    id: "session.tools",
    title: "工具",
    description: "列出当前工具（MCP 工具标注来源）",
    slash: { name: "/tools" },
    run: async (ctx, arg) => {
      await ctx.tools?.(arg);
      return true;
    },
  },
  {
    id: "session.resume",
    title: "恢复会话",
    description: "无参列出最近会话，带参切换会话",
    slash: { name: "/resume" },
    run: async (ctx, arg) => {
      await ctx.resume?.(arg);
      return true;
    },
  },
  {
    id: "session.exit",
    title: "退出",
    description: "退出会话（等价别名 exit、:q）",
    slash: { name: "/exit", aliases: ["/quit", "/q", ":q", "exit", "quit"] },
    run: async (ctx, arg) => {
      await ctx.exit?.(arg);
      return true;
    },
  },
  {
    id: "session.permissions",
    title: "权限",
    description: "查看权限模式与会话规则；clear / mode 管理",
    slash: { name: "/permissions" },
    keys: "shift+tab",
    run: async (ctx, arg) => {
      await ctx.permissions?.(arg);
      return true;
    },
  },
  {
    id: "session.status",
    title: "状态",
    description: "查看模型 / 会话 / 用量 / MCP / 权限快照",
    slash: { name: "/status" },
    run: async (ctx, arg) => {
      await ctx.status?.(arg);
      return true;
    },
  },
  {
    id: "session.mcp",
    title: "MCP",
    description: "列出已接入的 MCP server 与工具",
    slash: { name: "/mcp" },
    run: async (ctx, arg) => {
      await ctx.mcp?.(arg);
      return true;
    },
  },
  {
    id: "session.export",
    title: "导出",
    description: "把当前会话导出为 Markdown",
    slash: { name: "/export" },
    run: async (ctx, arg) => {
      await ctx.export?.(arg);
      return true;
    },
  },
  {
    id: "session.verbose",
    title: "详细度",
    description: "循环或设置 verbosity（low → medium → high；Ctrl+O 是折叠分组，不是本命令）",
    slash: { name: "/verbose" },
    panel: false,
    run: async (ctx, arg) => {
      await ctx.verbose?.(arg);
      return true;
    },
  },
];

/** 全局注册表（生产装配的唯一来源）。 */
export const COMMAND_REGISTRY = new CommandRegistry(COMMAND_DEFINITIONS);

/**
 * 取出命令的短名：优先用斜杠主名去掉 `/`，否则取 id 末段。
 *
 * @param def 命令定义。
 * @returns 不含 `/` 的短名（如 `model`）。
 */
export function shortName(def: CommandDef): string {
  if (def.slash) return def.slash.name.replace(/^\//, "");
  return def.id.slice(def.id.lastIndexOf(".") + 1);
}

/**
 * 列出命令的全部斜杠写法（主名 + 别名，统一小写）。
 *
 * @param def 命令定义。
 * @returns 可用于输入匹配的小写形式列表。
 */
function slashForms(def: CommandDef): string[] {
  if (!def.slash) return [];
  return [def.slash.name, ...(def.slash.aliases ?? [])].map((form) => form.toLowerCase());
}

/**
 * 把命令 id 末段解析为 {@link CommandContext} 的 handler 键。
 *
 * @param def 命令定义。
 * @returns handler 键（如 `session.exit` → `exit`）。
 */
function handlerKey(def: CommandDef): keyof CommandContext {
  return def.id.slice(def.id.lastIndexOf(".") + 1) as keyof CommandContext;
}

/**
 * 按注册表解析一行输入为命令。
 *
 * @param text 已 trim 的用户输入。
 * @param registry 注册表（缺省全局）。
 * @returns 命中的命令；普通提问 / 未知命令返回 null。
 */
export function parseSlashCommand(text: string, registry: CommandRegistry = COMMAND_REGISTRY): SlashInvocation | null {
  return registry.parse(text);
}

/**
 * 按前缀过滤面板命令。
 *
 * @param prefix 输入框当前内容（如 `/`、`/he`）。
 * @param registry 注册表（缺省全局）。
 * @returns 命中前缀的命令列表。
 */
export function filterSlashCommands(prefix: string, registry: CommandRegistry = COMMAND_REGISTRY): SlashCommandDef[] {
  return registry.filter(prefix);
}

/**
 * @param registry 注册表（缺省全局）。
 * @returns 面板可见命令的展示条目。
 */
export function listPanelCommands(registry: CommandRegistry = COMMAND_REGISTRY): SlashCommandDef[] {
  return registry.panelEntries();
}

/**
 * 创建命令分发器：把解析与执行绑定到调用方注入的 handlers。
 *
 * 分发逻辑只认「注册表 + 上下文」：解析、别名、handler 键都从 {@link CommandDef}
 * 派生，因此新增命令无需改动本函数。
 *
 * @param options context 与未知命令提示（可选注入自定义注册表）。
 * @returns 异步分发器（handler 允许 async，如 /resume 读盘、/compact 摘要）。
 */
export function createSlashDispatcher(options: SlashDispatcherOptions): SlashDispatcher {
  const registry = options.registry ?? COMMAND_REGISTRY;
  return async (text) => {
    const invocation = registry.parse(text);
    if (!invocation) return false;
    const def = registry.get(invocation.name);
    const handler = def ? options.context[handlerKey(def)] : undefined;
    if (!def || !def.run || !handler) {
      options.onUnknown?.(invocation.name);
      return true;
    }
    await def.run(options.context, invocation.arg);
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
