/**
 * 会话开场渲染与命令帮助文案。
 *
 * 与 render.ts 分工：render.ts 负责「AgentEvent → stdout」的运行期输出，
 * 本文件只负责会话开场（欢迎头）与 /help 的静态文案。
 * M3 起命令的解析与分发移到 slash.ts（命令表 + 注入式 handler），
 * 本文件不再持有命令表，避免两处维护同一份别名列表。
 *
 * M6（CLI 主题）：TTY 下渲染 `✻ Welcome to ohna!` + 一次性边框面板（工作目录 / 模型 /
 * 工具数与 MCP 来源 / 命令 tips）；非 TTY 保持纯文本头（管道可稳定消费，不含 `\x1b`）。
 */
import { write } from "./render.js";
import { paint, SPIN, supportsAnsi } from "./theme.js";

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
 * CLI 启动 logo：以 ASCII 艺术还原 infinity-icon.svg 的「双环 ∞」形态（交叉双环）。
 * 仅 TTY 欢迎头使用，accent 橙色着色作为品牌标记；非 TTY 不输出（保持管道纯文本）。
 */
export const CLI_LOGO: readonly string[] = [
  "  ____      ____",
  " /    \\____/    \\",
  " \\    /    \\    /",
  "  \\__/      \\__/",
];

/**
 * 打印会话开场欢迎头：标题 + 生效模型 / 端点 / 工具清单 + 会话 id + 多轮与命令提示。
 * 只写 stdout，不持有任何运行态。
 *
 * TTY 门控：支持 ANSI 时输出 `✻` 标题 + 边框面板；否则保持纯文本头（§4.3）。
 *
 * @param model 当前生效的真实模型信息。
 * @param toolNames 已装配的工具名列表。
 * @param options 会话 id、MCP server 名与工作目录。
 */
export function renderWelcome(model: WelcomeModelInfo, toolNames: string[], options?: WelcomeOptions): void {
  const lines = supportsAnsi()
    ? renderTtyWelcome(model, toolNames, options)
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
    "  端点   " + model.baseUrl,
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
 * TTY 欢迎面板：`✻ Welcome to ohna!` + 一次性边框信息框 + 命令 tips。
 *
 * @param model 模型信息。
 * @param toolNames 工具名列表。
 * @param options 可选信息。
 * @returns 行数组。
 */
function renderTtyWelcome(
  model: WelcomeModelInfo,
  toolNames: string[],
  options: WelcomeOptions | undefined,
): string[] {
  const tools = toolNames.length > 0 ? toolNames.join(" · ") : "（无）";
  const info: string[] = [
    `工作目录  ${options?.cwd ?? process.cwd()}`,
    `模型      ${model.id}（profile: ${model.provider}）`,
    `端点      ${model.baseUrl}`,
    `工具      ${tools}（${toolNames.length} 个）`,
  ];
  if (options?.sessionId) {
    info.push(`会话      ${options.sessionId}（--resume ${options.sessionId} 可恢复）`);
  }
  if (options?.mcpServers && options.mcpServers.length > 0) {
    info.push(`MCP       ${options.mcpServers.join(" · ")}`);
  }

  const lines = [
    ...CLI_LOGO.map((line) => paint(line, "accent")),
    "",
    `${paint(SPIN, "accent")} ${paint("Welcome to ohna!", "foreground", "bold")}`,
    "",
    ...frame(info),
    "",
    `  ${paint("/help", "accent")}    查看会话内命令`,
    `  ${paint("/clear", "accent")}   清空当前上下文并另开新会话（旧会话保留在磁盘）`,
    `  ${paint("/cost", "accent")}    查看本会话累计 token 与成本`,
    `  ${paint("/exit", "accent")}    退出（等价别名：exit、:q）`,
    `  ${paint("Ctrl-C", "accent")}   中断当前回答；空闲时 Ctrl-C 直接退出`,
    "",
  ];
  return lines;
}

/**
 * 把信息行包进一次性边框面板（`╭─…─╮` / `│ … │` / `╰─…─╯`）。
 *
 * @param lines 信息行（键值文本）。
 * @returns 带边框的行数组（边框用 dim 色）。
 */
function frame(lines: string[]): string[] {
  const contentWidth = Math.max(...lines.map(displayWidth), 12);
  const top = `╭${"─".repeat(contentWidth + 2)}╮`;
  const bottom = `╰${"─".repeat(contentWidth + 2)}╯`;
  const body = lines.map((line) => `│ ${padToWidth(line, contentWidth)} │`);
  return [paint(top, "dim"), ...body.map((line) => paint(line, "dim")), paint(bottom, "dim")];
}

/**
 * 估算一段文本的终端显示宽度：CJK / 全角字符按 2 列，其余按 1 列。
 *
 * 用于边框面板的列对齐；只做近似估算（组合字符、emoji ZWJ 等不计入），TTY 目检可接受。
 *
 * @param text 文本。
 * @returns 终端列宽。
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * 按终端列宽右补齐到指定宽度（空格填充），保证 CJK 内容在边框内对齐。
 *
 * @param text 文本。
 * @param width 目标列宽。
 * @returns 补齐后的文本。
 */
function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(width - displayWidth(text), 0));
}

/**
 * 打印 REPL 会话内命令列表（供 /help 复用，与欢迎头提示保持同一份文案）。
 */
export function printReplCommands(): void {
  const lines = [
    "会话内命令：",
    "  /help            查看本帮助",
    "  /clear           清空当前上下文并另开新会话（旧会话保留在磁盘）",
    "  /cost            查看本会话累计 token 与成本",
    "  /model [profile] 无参列出可用 profile 与当前；带参切换模型（对后续 run 生效）",
    "  /compact         立即对当前会话做一次上下文压缩（打印压缩前后 token）",
    "  /tools           列出当前工具（MCP 工具标注来源）",
    "  /resume [id]     无参列出最近会话；带参切换会话并载入历史",
    "  /exit            退出会话（等价别名：exit、:q）",
    "  Ctrl-C           中断当前回答；空闲时 Ctrl-C 直接退出",
    "",
    "会话持久化：",
    "  每轮 run 结束自动保存到 ~/.ohna/sessions/<id>.jsonl（纯 JSONL，可直接 cat）。",
    "  退出后可用 ohna --resume <id> 或会话内 /resume <id> 恢复；/clear 另开新会话。",
    "",
  ];
  write(lines.join("\n") + "\n");
}
