/**
 * 会话开场渲染与会话内命令表。
 *
 * 与 render.ts 分工：render.ts 负责「AgentEvent → stdout」的运行期输出，
 * 本文件只负责会话开场（欢迎头）与 REPL 内斜杠命令的定义与提示，
 * 两者互不引用，保持单文件职责单一。
 */

/**
 * 欢迎头所需的模型信息（从已解析的真实模型上取，避免本模块反向依赖 harness）。
 */
export interface WelcomeModelInfo {
  /** 模型 id，如 deepseek-chat。 */
  id: string;
  /** provider profile 名，如 deepseek / openrouter / bridge_ai。 */
  provider: string;
  /** OpenAI 兼容端点地址。 */
  baseUrl: string;
}

/** REPL 内可识别的会话命令。 */
export type ReplCommand = "help" | "clear" | "exit";

const REPL_COMMANDS: ReadonlyArray<readonly [ReplCommand, readonly string[]]> = [
  ["help", ["/help", "/?", "help"]],
  ["clear", ["/clear", "/reset"]],
  ["exit", ["/exit", "/quit", "/q", ":q", "exit", "quit"]],
];

const RULE = "─".repeat(60);

/**
 * 匹配用户输入的会话内命令（不区分大小写，支持 /help、/clear、/exit 及其别名）。
 *
 * @param text 已 trim 的用户输入。
 * @returns 命中的命令；普通提问返回 null，交由模型处理。
 */
export function matchReplCommand(text: string): ReplCommand | null {
  const input = text.trim().toLowerCase();
  for (const [command, aliases] of REPL_COMMANDS) {
    if (aliases.includes(input)) return command;
  }
  return null;
}

/**
 * 打印会话开场欢迎头：标题 + 生效模型 / 端点 / 工具清单 + 多轮与命令提示。
 * 只写 stdout，不持有任何运行态。
 *
 * @param model 当前生效的真实模型信息。
 * @param toolNames 已装配的工具名列表。
 */
export function renderWelcome(model: WelcomeModelInfo, toolNames: string[]): void {
  const tools = toolNames.length > 0 ? toolNames.join(" · ") : "（无）";
  const lines = [
    RULE,
    "  Immersive Agent CLI · 沉浸式金融研究助手",
    RULE,
    "  模型   " + model.id + "（profile: " + model.provider + "）",
    "  端点   " + model.baseUrl,
    "  工具   " + tools + "（" + String(toolNames.length) + " 个）",
    RULE,
    "  多轮对话已就绪：上下文在本会话内累积，直接输入问题即可。",
    "",
    "  /help    查看会话内命令",
    "  /clear   清空当前会话上下文",
    "  /exit    退出（等价别名：exit、:q）",
    "  Ctrl-C   中断当前回答；空闲时 Ctrl-C 直接退出",
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

/**
 * 打印 REPL 会话内命令列表（供 /help 复用，与欢迎头提示保持同一份文案）。
 */
export function printReplCommands(): void {
  const lines = [
    "会话内命令：",
    "  /help    查看本帮助",
    "  /clear   清空当前会话上下文（保留模型与工具）",
    "  /exit    退出会话（等价别名：exit、:q）",
    "  Ctrl-C   中断当前回答；空闲时 Ctrl-C 直接退出",
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}