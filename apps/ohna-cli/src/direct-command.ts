/**
 * F-7 前缀直通：`!` 直接执行 bash、`#` 追加用户记忆。
 *
 * 关键设计：
 * - `!` 必须经过与模型工具调用完全相同的 `beforeToolCall` 权限闸门（K1 不绕过）；
 *   通过后复用 bash 工具与 render 层事件渲染，因此折叠 / 错误展示 / 命令策略完全一致。
 * - `!` 的结果**不进 history、不进模型上下文**：它是用户与本机的直通操作，不是一轮对话，
 *   既不消耗 token，也不会让后续模型误以为执行过某个任务。
 * - `#` 写 AGENTS.md 后重新解析系统提示词，使记忆从下一轮起生效（失败则提示下次会话生效）。
 *
 * 本模块把前缀分派从 repl.ts 抽出，repl 只保留一行调用；所有失败都转成可读文本，不抛异常。
 */
import type { AssistantMessage } from "@aiagent/ai";
import type { AgentMessage } from "@aiagent/agent";
import type { AgentTool } from "@aiagent/tools";
import { appendMemoryNote } from "./memory-note.js";
import { resolveSystemPrompt } from "./mode.js";
import { renderEvent, write, type UsageTracker } from "./render.js";
import type { ConfirmHook } from "./confirm.js";
import type { RunSetup } from "./turn.js";

/** 直通命令的装配上下文（全部是只读依赖，`setup` 因记忆刷新而可变）。 */
export interface DirectCommandContext {
  /** 工作区根目录。 */
  cwd: string;
  /** 当前已装配的工具表（用于查找 bash）。 */
  tools: readonly AgentTool<any>[];
  /** 会话 history（仅作为闸门上下文的只读快照，不写入）。 */
  history: readonly AgentMessage[];
  /** 会话配置：`#` 成功后原地更新 `systemPrompt`。 */
  setup: RunSetup;
  /** 会话用量累计器（renderEvent 签名需要；直通本身不产生模型用量）。 */
  tracker: UsageTracker;
  /** 权限闸门（与模型工具调用同一个实例，保证规则 / 模式一致）。 */
  beforeToolCall?: ConfirmHook;
  /** 中断信号（Esc / Ctrl-C 可终止长时间运行的 `!` 命令）。 */
  signal?: AbortSignal;
  /** 当前权限预设（`#` 在 plan 模式下必须拒绝写入）；未提供按非 plan 处理。 */
  getPermissionPreset?: () => string;
}

/**
 * 分派以 `!` / `#` 开头的输入。
 *
 * @param text 已 trim 的整行输入。
 * @param ctx 直通上下文。
 * @returns true 表示输入已被直通命令消费（不得进入模型调用）。
 */
export async function handleDirectInput(text: string, ctx: DirectCommandContext): Promise<boolean> {
  if (text.startsWith("!")) {
    const command = text.slice(1).trim();
    if (!command) {
      write("用法：!<bash 命令>（结果只打印，不进入模型上下文）\n");
      return true;
    }
    await runBashDirect(command, ctx);
    return true;
  }

  if (/^#\s/.test(text)) {
    // 记忆写入是副作用：plan 模式只读，必须拒绝而不是偷偷改 AGENTS.md。
    if (ctx.getPermissionPreset?.() === "plan") {
      write("plan 模式禁止写入 AGENTS.md（用 /permissions mode default 切换后可记录）。\n");
      return true;
    }
    const note = text.slice(1).trim();
    const result = await appendMemoryNote(note, ctx.cwd);
    if (!result.ok) {
      write(`${result.reason}\n`);
      return true;
    }
    // 立即重解析系统提示词：这样同一会话的下一轮 run 就能看到新记忆。
    try {
      ctx.setup.systemPrompt = await resolveSystemPrompt(ctx.cwd);
      write(`已记录到 ${result.path}；下一轮生效。\n`);
    } catch (error) {
      write(
        `已记录到 ${result.path}；系统提示词刷新失败（${error instanceof Error ? error.message : String(error)}），下次会话生效。\n`,
      );
    }
    return true;
  }

  return false;
}

/**
 * 直接执行一条 bash 命令：权限闸门 → 工具执行 → 复用 render 事件展示。
 *
 * 伪事件只用于渲染：不进入 history，也不会被 agentLoop 看到。工具执行期间若被中断，
 * 错误同样走 `tool_execution_end(isError)` 渲染，保持与模型调用一致的错误形态。
 *
 * @param command 用户输入 `!` 之后的命令。
 * @param ctx 直通上下文。
 */
export async function runBashDirect(command: string, ctx: DirectCommandContext): Promise<void> {
  const bashTool = ctx.tools.find((tool) => tool.name === "bash");
  if (!bashTool) {
    write("当前工具表中没有 bash 工具，无法直接执行命令。\n");
    return;
  }

  const timestamp = Date.now();
  const toolCallId = `direct-${timestamp}`;
  let args: unknown;
  try {
    // 与 loop 相同：先经 zod 校验再执行；失败时给出结构化提示，绝不把原始异常抛给用户。
    args = bashTool.parameters.parse({ command });
  } catch (error) {
    write(`命令参数无效：${error instanceof Error ? error.message : String(error)}\n`);
    return;
  }

  if (ctx.beforeToolCall) {
    const toolCall = {
      type: "toolCall" as const,
      id: toolCallId,
      name: "bash",
      arguments: { command },
    };
    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content: [toolCall],
      api: "openai-completions",
      provider: "ohna",
      model: "direct",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp,
    };
    let blocked: { block?: boolean; reason?: string } | undefined;
    try {
      blocked = await ctx.beforeToolCall(
        {
          assistantMessage,
          toolCall,
          args,
          context: {
            systemPrompt: ctx.setup.systemPrompt,
            messages: [...ctx.history],
            tools: [...ctx.tools],
          },
        },
        ctx.signal,
      );
    } catch (error) {
      write(`权限检查失败：${error instanceof Error ? error.message : String(error)}\n`);
      return;
    }
    if (blocked?.block) {
      write(`已拒绝执行：${blocked.reason ?? "权限策略拒绝"}\n`);
      return;
    }
  }

  // 伪事件渲染：与模型调用相同的 ⏺ / ⎿ / 折叠 / diff 展示路径。
  renderEvent(
    { type: "tool_execution_start", toolCallId, toolName: "bash", args },
    ctx.tracker,
    { workspaceRoot: ctx.cwd },
  );

  try {
    const result = await bashTool.execute(toolCallId, args, ctx.signal);
    renderEvent(
      { type: "tool_execution_end", toolCallId, toolName: "bash", result, isError: false },
      ctx.tracker,
      { workspaceRoot: ctx.cwd },
    );
  } catch (error) {
    // 工具层抛出的 Error 可能带 details（如 bash 的部分输出）：转成 render 可读的文本结果。
    const message = error instanceof Error ? error.message : String(error);
    const details = (error as { details?: unknown } | null)?.details;
    renderEvent(
      {
        type: "tool_execution_end",
        toolCallId,
        toolName: "bash",
        result: { content: [{ type: "text", text: message }], details },
        isError: true,
      },
      ctx.tracker,
      { workspaceRoot: ctx.cwd },
    );
  }
}
