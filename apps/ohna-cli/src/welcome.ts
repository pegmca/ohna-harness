/**
 * 会话开场渲染与命令帮助文案。
 *
 * 与 render.ts 分工：render.ts 负责「AgentEvent → stdout」的运行期输出，
 * 本文件只负责会话开场（欢迎头）与 /help 的静态文案。
 * M3 起命令的解析与分发移到 slash.ts（命令表 + 注入式 handler），
 * 本文件不再持有命令表，避免两处维护同一份别名列表。
 */
import type { CliMode } from "./mode.js";

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
  /** 运行模式：决定标题文案（coding / research）。 */
  mode?: CliMode;
  /** 当前会话 id；提供后打印 `--resume` 提示。 */
  sessionId?: string;
  /** 已接入的 MCP server 名（欢迎头展示来源）。 */
  mcpServers?: readonly string[];
}

const RULE = "─".repeat(60);

/**
 * 打印会话开场欢迎头：标题 + 生效模型 / 端点 / 工具清单 + 会话 id + 多轮与命令提示。
 * 只写 stdout，不持有任何运行态。
 *
 * @param model 当前生效的真实模型信息。
 * @param toolNames 已装配的工具名列表。
 * @param options 模式、会话 id 与 MCP server 名。
 */
export function renderWelcome(model: WelcomeModelInfo, toolNames: string[], options?: WelcomeOptions): void {
  const tools = toolNames.length > 0 ? toolNames.join(" · ") : "（无）";
  // 产品 B 已改名 ohna，标题不能再沿用金融研究的旧文案（M2 清理改名遗漏）。
  const title = options?.mode === "coding" ? "ohna · 本地编码 Agent" : "ohna";
  const lines = [
    RULE,
    "  " + title,
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
  process.stdout.write(lines.join("\n") + "\n");
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
  process.stdout.write(lines.join("\n") + "\n");
}
