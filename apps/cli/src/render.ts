/**
 * 终端渲染层：把 agent loop 产出的 AgentEvent 转成可读的命令行输出。
 * 该模块只负责「事件 → stdout」，不持有任何运行态；多轮状态（history / abort）由 harness 维护。
 */
import * as path from "node:path";
import type { AgentEvent } from "@aiagent/agent";
import type { Usage } from "@aiagent/ai";
import type { CliMode } from "./mode.js";

/** 渲染选项：按运行模式调整工具调用的展示密度。 */
export interface RenderOptions {
  /** 运行模式；coding 模式下工具入参按「路径 / 命令」一行展示，避免整段 JSON 刷屏。 */
  mode?: CliMode;
}

/** 单轮 run 的 token / 成本累计器：逐条吸收 assistant 消息的 usage。 */
export interface UsageTracker {
  /** 累加一条 assistant 消息的用量。 */
  add(usage: Usage): void;
  /** 生成本轮小结文案；无任何用量时返回 null（例如被中断的空 run）。 */
  line(): string | null;
}

/**
 * 创建用量累计器：累计输入/输出 token 与总成本，供 agent_end 小结打印。
 *
 * @returns 可累加并输出小结的 UsageTracker。
 */
export function createUsageTracker(): UsageTracker {
  let input = 0;
  let output = 0;
  let total = 0;
  let cost = 0;

  return {
    add(usage: Usage): void {
      input += usage.input;
      output += usage.output;
      total += usage.totalTokens;
      cost += usage.cost.total;
    },
    line(): string | null {
      if (total === 0) return null;
      return `本轮 token: ${total}（输入 ${input} / 输出 ${output}），成本 $${cost.toFixed(6)}`;
    },
  };
}

/**
 * 把单个 AgentEvent 渲染到终端。
 * 文本增量用 process.stdout.write 实时打印；工具调用与结果各占一行，保持简洁不刷屏；
 * assistant 消息结束时补换行并累计 usage；agent_end 打印小结（含异常）。
 *
 * @param event 来自 agentLoop 的事件。
 * @param tracker 当前 run 的用量累计器（message_end 时吸收 usage，agent_end 时输出小结）。
 * @param options 渲染选项（模式）。
 */
export function renderEvent(event: AgentEvent, tracker: UsageTracker, options?: RenderOptions): void {
  switch (event.type) {
    case "message_update": {
      // 仅转发文本增量；thinking / toolcall 增量不在 CLI 主输出中渲染，避免打断正文流。
      const inner = event.assistantMessageEvent;
      if (inner.type === "text_delta") {
        process.stdout.write(inner.delta);
      }
      return;
    }

    case "tool_execution_start": {
      process.stdout.write(`▸ 调用 ${event.toolName}(${formatToolArgs(event.toolName, event.args, options)})\n`);
      return;
    }

    case "tool_execution_end": {
      if (event.isError) {
        process.stdout.write(`✖ ${event.toolName} 失败：${extractResultText(event.result)}\n`);
      } else {
        process.stdout.write(`✓ ${event.toolName} 完成\n`);
      }
      return;
    }

    case "message_end": {
      // 仅 assistant 消息携带 usage；user 的 prompt 消息与 toolResult 不计入模型用量。
      const message = event.message;
      if (message.role === "assistant") {
        tracker.add(message.usage);
        process.stdout.write("\n");
      }
      return;
    }

    case "agent_end": {
      const summary = tracker.line();
      if (summary) process.stdout.write(`\n${summary}\n`);
      if (event.error) {
        process.stdout.write(`\n✖ 运行异常终止（${event.error.code}）：${event.error.message}\n`);
      }
      return;
    }

    default:
      // agent_start / turn_start / turn_end / message_start / tool_execution_update 等
      // 在 CLI 中无需独立展示，避免噪声。
      return;
  }
}

/**
 * 工具入参的紧凑 JSON 表示，超长截断，避免一行刷屏。
 *
 * @param value 工具入参对象。
 * @returns 紧凑字符串。
 */
function shortJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (!text) return "{}";
    return truncateText(text, 200);
  } catch {
    return String(value);
  }
}

/**
 * 把路径渲染成相对当前工作目录的形式（越界则保留绝对形式，越界本身会被工具层拒绝）。
 *
 * @param target 绝对路径或相对路径。
 * @returns 便于阅读的路径文本。
 */
function toRelative(target: string): string {
  const cwd = process.cwd();
  const absolute = path.isAbsolute(target) ? target : path.resolve(cwd, target);
  const relative = path.relative(cwd, absolute);
  const shown = relative && !relative.startsWith("..") ? relative : absolute;
  return truncateText(shown, 160);
}

/**
 * 单行文本截断，超长用省略号收尾。
 *
 * @param text 原始文本。
 * @param max 最大长度。
 * @returns 截断后的文本。
 */
function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 工具入参的一行展示：coding 模式下写/读/编辑显示相对路径、bash 显示命令、grep/find 显示模式，
 * 其余情况（research 模式或结构意外）回退到紧凑 JSON，保持既有输出风格。
 *
 * @param toolName 工具名。
 * @param args 工具入参。
 * @param options 渲染选项。
 * @returns 一行入参文本。
 */
function formatToolArgs(toolName: string, args: unknown, options?: RenderOptions): string {
  if (options?.mode !== "coding" || typeof args !== "object" || args === null) return shortJson(args);

  const record = args as Record<string, unknown>;
  if (typeof record.command === "string") return truncateText(record.command.replace(/\s+/g, " "), 160);

  const relativePath = typeof record.path === "string" ? toRelative(record.path) : undefined;
  if (toolName === "grep" || toolName === "find") {
    const pattern = typeof record.pattern === "string" ? record.pattern : "";
    return relativePath ? `${pattern} 于 ${relativePath}` : pattern;
  }
  if (relativePath) return relativePath;
  return shortJson(args);
}

/**
 * 从工具执行结果中提取一句可读文本：优先取 content 内的 text 块，其次 message 字段。
 *
 * @param result 工具回传的结构化结果（形状不固定）。
 * @returns 可读文本。
 */
function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;

  if (result && typeof result === "object") {
    const record = result as { content?: unknown; message?: unknown };
    if (Array.isArray(record.content)) {
      const text = record.content
        .filter((block): block is { type: string; text: string } =>
          !!block && typeof block === "object" && (block as { type?: string }).type === "text",
        )
        .map((block) => block.text)
        .join("");
      if (text) return text;
    }
    if (typeof record.message === "string") return record.message;
  }

  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
