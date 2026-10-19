/**
 * F-8 `/export`：把当前会话历史导出为可读的 Markdown 文件。
 *
 * 为什么导出历史而不是导出 JSONL：JSONL 是持久化格式（每秒都可能有内部字段变化），
 * Markdown 是给人看 / 贴进 issue 的稳定格式；两者职责不同，互不替代。
 *
 * 路径边界：`<exportsDir>/<sessionId>.md`，sessionId 必须是白名单字符，写入前再用
 * `assertPathWithinRoot` 校验一次，避免任何拼接逃逸（`../`、绝对路径、软链）。
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@aiagent/agent";
import { assertPathWithinRoot } from "@aiagent/coding";
import type { UsageSnapshot } from "./usage.js";

/** 工具结果在导出文件中的最大字符数。 */
const TOOL_RESULT_MAX_CHARS = 800;

/** 导出文件总字符预算（2MB 量级）：防止超长会话一次性写出巨大文件。 */
const MAX_EXPORT_CHARS = 2 * 1024 * 1024;

/** 工具调用参数的展示上限。 */
const TOOL_ARGS_MAX_CHARS = 400;

/** 会话 id 白名单：与 session-store 保持一致，杜绝路径分隔符。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 导出输入。 */
export interface ExportSessionInput {
  /** 当前会话 id。 */
  sessionId: string;
  /** 会话标题。 */
  title?: string;
  /** 当前模型 id。 */
  model: string;
  /** 当前 history（导出内存中的最新状态，不要求已落盘）。 */
  messages: readonly AgentMessage[];
  /** 累计用量快照（可选）。 */
  usage?: UsageSnapshot;
}

/** 导出选项（测试可注入目录与时间）。 */
export interface ExportSessionOptions {
  /** 导出目录；缺省 `~/.ohna/exports`。 */
  dir?: string;
  /** 导出时间；缺省当前时间。 */
  now?: Date;
}

/** 导出结果：成功返回文件路径，失败返回结构化原因。 */
export type ExportSessionResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * 导出会话并落盘。
 *
 * @param input 会话快照。
 * @param options 目录 / 时间注入。
 * @returns 写入路径或失败原因。
 */
export async function exportSessionMarkdown(
  input: ExportSessionInput,
  options?: ExportSessionOptions,
): Promise<ExportSessionResult> {
  if (!SESSION_ID_PATTERN.test(input.sessionId)) {
    return { ok: false, reason: `非法会话 id：${input.sessionId}` };
  }

  const dir = path.resolve(options?.dir ?? path.join(os.homedir(), ".ohna", "exports"));
  const target = path.resolve(dir, `${input.sessionId}.md`);
  const markdown = capExportSize(formatSessionMarkdown(input, options?.now ?? new Date()));

  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    return { ok: false, reason: `创建导出目录失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const boundary = assertPathWithinRoot(target, dir);
  if (!boundary.ok) return { ok: false, reason: "导出路径越界，已拒绝写入" };

  try {
    // 会话可能包含代码 / 密钥片段：只允许当前用户读写（已有文件用 chmod 收紧）。
    await fs.writeFile(target, markdown, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(target, 0o600);
  } catch (error) {
    return { ok: false, reason: `写入导出文件失败：${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, path: target };
}

/**
 * 按总字符预算截断导出内容，并在末尾标注截断量。
 *
 * @param markdown 完整 Markdown。
 * @returns 预算内原文或截断后的文本。
 */
function capExportSize(markdown: string): string {
  if (markdown.length <= MAX_EXPORT_CHARS) return markdown;
  const omitted = markdown.length - MAX_EXPORT_CHARS;
  return `${markdown.slice(0, MAX_EXPORT_CHARS)}\n\n…（导出内容超过 2MB 预算，已截断 ${omitted} 字符）\n`;
}

/**
 * 生成 Markdown 正文（纯函数，便于快照测试）。
 *
 * @param input 会话快照。
 * @param now 导出时间。
 * @returns Markdown 文本。
 */
export function formatSessionMarkdown(input: ExportSessionInput, now: Date): string {
  const lines: string[] = [
    "# ohna 会话导出",
    "",
    `- 会话：${input.sessionId}`,
    `- 标题：${input.title ?? "新会话"}`,
    `- 模型：${input.model}`,
    `- 导出时间：${now.toISOString()}`,
    `- 消息数：${input.messages.length}`,
  ];
  if (input.usage) {
    const reasoning = input.usage.reasoning ?? 0;
    const output = reasoning > 0 ? `输出 ${input.usage.output}（推理 ${reasoning}）` : `输出 ${input.usage.output}`;
    lines.push(
      `- 累计用量：token ${input.usage.total}（输入 ${input.usage.input} / ${output}），成本 $${input.usage.cost.toFixed(6)}`,
    );
  }
  lines.push("", "---", "");

  for (const message of input.messages) {
    lines.push(...formatMessage(message), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * 单条消息 → Markdown 段落。
 *
 * @param message 任意 AgentMessage。
 * @returns 段落行数组。
 */
function formatMessage(message: AgentMessage): string[] {
  switch (message.role) {
    case "user":
      return ["## 用户", "", flattenContent(message.content)];
    case "assistant": {
      const lines: string[] = ["## 助手", ""];
      const text = message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (text.trim()) lines.push(text, "");
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        lines.push(
          `### 工具调用 \`${block.name}\``,
          "",
          "```json",
          truncate(safeJson(block.arguments), TOOL_ARGS_MAX_CHARS),
          "```",
          "",
        );
      }
      return lines;
    }
    case "toolResult":
      return [
        `## 工具结果 \`${message.toolName}\`${message.isError ? "（错误）" : ""}`,
        "",
        "```text",
        truncate(flattenContent(message.content), TOOL_RESULT_MAX_CHARS),
        "```",
      ];
    case "compaction":
      return ["## 历史摘要", "", truncate(message.summary, TOOL_RESULT_MAX_CHARS)];
    default:
      return [];
  }
}

/**
 * 把消息 content 展平为纯文本（图片块以占位符表示，避免导出二进制）。
 *
 * @param content 字符串或内容块数组。
 * @returns 纯文本。
 */
function flattenContent(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? (block.text ?? "") : "[图片]"))
    .join("\n");
}

/**
 * 安全 JSON 序列化（循环引用等异常降级为 String）。
 *
 * @param value 任意值。
 * @returns 序列化文本。
 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 按字符数截断并标注省略量。
 *
 * @param text 原文。
 * @param max 最大字符数。
 * @returns 截断文本。
 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（已截断 ${text.length - max} 字符）` : text;
}
