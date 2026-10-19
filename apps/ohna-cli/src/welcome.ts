/**
 * 会话开场渲染与命令帮助文案。
 *
 * 与 render.ts 分工：render.ts 负责「AgentEvent → stdout」的运行期输出，
 * 本文件只负责会话开场（欢迎头）与 /help 的静态文案。
 * M3 起命令的解析与分发移到 slash.ts（命令表 + 注入式 handler），
 * 本文件不再持有命令表，避免两处维护同一份别名列表。
 *
 * M6（CLI 主题）：TTY 下渲染块状 OHNA logo + 信息行（无边框，长值由 TuiApp 截断兜底）；
 * 命令提示改由输入框内 `/` 面板提供，/help 文案同源于 {@link SLASH_COMMANDS}；
 * 非 TTY 保持纯文本头（管道可稳定消费，不含 `\x1b`）。
 */
import { write } from "./render.js";
import { paint, supportsAnsi } from "./theme.js";
import { SLASH_COMMANDS } from "./slash.js";

/**
 * 欢迎头所需的模型信息（从已解析的真实模型上取，避免本模块反向依赖 harness）。
 */
export interface WelcomeModelInfo {
  /** 模型 id，如 deepseek-chat。 */
  id: string;
  /** provider profile 名，如 deepseek / openrouter / bridge_ai。 */
  provider: string;
}

/** 欢迎头可选信息。 */
export interface WelcomeOptions {
  /** 当前会话 id；提供后打印 `--resume` 提示。 */
  sessionId?: string;
  /** 已接入的 MCP server 名（欢迎头展示来源）。 */
  mcpServers?: readonly string[];
  /** 工作目录（TTY 边框面板展示）；缺省 process.cwd()。 */
  cwd?: string;
}

const RULE = "─".repeat(60);

/** 纯文本欢迎头的标题：ohna 恒为个人编码助手，标题固定，不随任何开关变化。 */
const TITLE = "ohna";

/**
 * CLI 启动 logo：用 `█`（U+2588）块状 pixel-art 拼出大写 "OHNA" 品牌字样——每个字母
 * 7 列宽、5 行高，字母间留 1 列空隙，整体左右对称居中。仅 TTY 欢迎头使用，
 * accent 橙色着色作为品牌标记；非 TTY 不输出（保持管道纯文本）。
 */
export const CLI_LOGO: readonly string[] = [
  "███████ ██   ██ ██   ██ ███████",
  "██   ██ ██   ██ ███  ██ ██   ██",
  "██   ██ ███████ ██ █ ██ ██   ██",
  "██   ██ ██   ██ ██  ███ ███████",
  "███████ ██   ██ ██   ██ ██   ██",
];

/**
 * 打印会话开场欢迎头：标题 + 工具清单 + 会话 id（TTY 无边框 + 块状 logo，不展示
 * 模型 / 端点——模型改由输入框下方的状态行展示；非 TTY 保留模型行、不展示端点，并追加
 * 多轮与命令提示，因非 TTY 没有 `/` 面板）。只写 stdout，不持有任何运行态。
 *
 * TTY 门控：支持 ANSI 时输出块状 OHNA logo + 信息行；否则保持纯文本头（§4.3）。
 *
 * @param model 当前生效的真实模型信息。
 * @param toolNames 已装配的工具名列表。
 * @param options 会话 id、MCP server 名与工作目录。
 */
export function renderWelcome(model: WelcomeModelInfo, toolNames: string[], options?: WelcomeOptions): void {
  const lines = supportsAnsi()
    ? renderTtyWelcome(toolNames, options)
    : renderPlainWelcome(model, toolNames, options);
  // 经统一输出出口：TTY 整屏模式下由 sink 注入为 tui.append，进入对话模型顶部。
  write(lines.join("\n") + "\n");
}

/**
 * 非 TTY 纯文本欢迎头：保持 M2/M3 的既有输出，管道可稳定消费。
 *
 * @param model 模型信息。
 * @param toolNames 工具名列表。
 * @param options 可选信息。
 * @returns 行数组。
 */
function renderPlainWelcome(
  model: WelcomeModelInfo,
  toolNames: string[],
  options: WelcomeOptions | undefined,
): string[] {
  const tools = toolNames.length > 0 ? toolNames.join(" · ") : "（无）";
  const lines = [
    RULE,
    "  " + TITLE,
    RULE,
    "  模型   " + model.id + "（profile: " + model.provider + "）",
    "  工具   " + tools + "（" + String(toolNames.length) + " 个）",
  ];
  if (options?.sessionId) {
    lines.push("  会话   " + options.sessionId + "（--resume " + options.sessionId + " 可恢复）");
  }
  if (options?.mcpServers && options.mcpServers.length > 0) {
    lines.push("  MCP    " + options.mcpServers.join(" · "));
  }
  lines.push(
    RULE,
    "  多轮对话已就绪：上下文在本会话内累积，每轮结束自动保存到 ~/.ohna/sessions。",
    "",
    "  /help    查看会话内命令",
    "  /clear   清空当前上下文并另开新会话（旧会话保留在磁盘）",
    "  /cost    查看本会话累计 token 与成本",
    "  /exit    退出（等价别名：exit、:q）",
    "  Ctrl-C   中断当前回答；空闲时 Ctrl-C 直接退出",
    "",
  );
  return lines;
}

/**
 * TTY 欢迎头：无边框 CodeBuddy 风格——块状 OHNA logo + 信息行。
 *
 * 不再用边框面板（旧实现的边框宽度由最长行决定，长 cwd / session id 会把面板撑到
 * 超过终端宽度、折行丢右边框）；长值一律交给 TuiApp 的 `truncateToWidth` 兜底裁剪。
 * 命令提示也不写在欢迎头里，改由输入框内的 `/` 命令面板提供（/help 文案同源于
 * {@link SLASH_COMMANDS}）。模型名与端点也不在此展示：模型名移入输入框下方的状态行
 * （随 `/model` 切换实时刷新），端点属于服务地址、对用户无展示价值。
 *
 * @param toolNames 工具名列表。
 * @param options 可选信息。
 * @returns 行数组。
 */
function renderTtyWelcome(
  toolNames: string[],
  options: WelcomeOptions | undefined,
): string[] {
  const tools = toolNames.length > 0 ? toolNames.join(" · ") : "（无）";
  const info: string[] = [
    `工作目录  ${options?.cwd ?? process.cwd()}`,
    `工具      ${tools}（${toolNames.length} 个）`,
  ];
  if (options?.sessionId) {
    info.push(`会话      ${options.sessionId}（--resume ${options.sessionId} 可恢复）`);
  }
  if (options?.mcpServers && options.mcpServers.length > 0) {
    info.push(`MCP       ${options.mcpServers.join(" · ")}`);
  }

  return [
    ...CLI_LOGO.map((line) => paint(line, "accent")),
    "",
    ...info,
    "",
  ];
}

/**
 * 打印 REPL 会话内命令列表（供 /help 复用）：命令行由 {@link SLASH_COMMANDS} 生成，
 * 与 `/` 命令面板共用同一份命令名/描述，避免两处维护。
 */
export function printReplCommands(): void {
  const pad = Math.max(...SLASH_COMMANDS.map((c) => c.name.length));
  const lines = [
    "会话内命令：",
    ...SLASH_COMMANDS.map((c) => `  ${c.name.padEnd(pad)}  ${c.description}`),
    `  ${"Ctrl-C".padEnd(pad)}  中断当前回答；空闲时 Ctrl-C 直接退出`,
    "",
    "会话持久化：",
    "  每轮 run 结束自动保存到 ~/.ohna/sessions/<id>.jsonl（纯 JSONL，可直接 cat）。",
    "  退出后可用 ohna --resume <id> 或会话内 /resume <id> 恢复；/clear 另开新会话。",
    "",
  ];
  write(lines.join("\n") + "\n");
}
