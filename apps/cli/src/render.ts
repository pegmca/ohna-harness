/**
 * 终端渲染层：把 agent loop 产出的 AgentEvent 转成可读的命令行输出。
 * 该模块只负责「事件 → stdout」，不持有任何运行态；多轮状态（history / abort）由 harness 维护。
 */
import type { AgentEvent } from "@aiagent/agent";
import type { Usage } from "@aiagent/ai";

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
 */
export function renderEvent(event: AgentEvent, tracker: UsageTracker): void {
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
      process.stdout.write(`▸ 调用 ${event.toolName}(${shortJson(event.args)})\n`);
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
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return String(value);
  }
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
