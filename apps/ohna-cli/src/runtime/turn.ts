/**
 * 单轮 run 的执行层：装配 AgentLoopConfig、消费事件、维护多轮 history。
 *
 * 从 harness 拆出的原因：REPL 拆到 repl.ts 后，harness 只保留组合根（模型/工具/会话装配），
 * 而 `runTurn` 与 REPL 都需要同一份实现。放在独立模块可避免 harness ↔ repl 的运行时循环依赖
 * （架构门禁 no-circular 会直接拒绝）。
 */
import {
  agentLoop,
  createCompactionTransform,
  createLlmTraceStreamFn,
  defaultConvertToLlm,
  isTracedStreamFn,
  type AgentLoopConfig,
  type AgentMessage,
  type StreamFn,
} from "@aiagent/agent";
import { streamSimple, type ActiveModel, type UserMessage } from "@aiagent/ai";
import type { AgentTool } from "@aiagent/tools";
import { resolveMaxTurns } from "./mode.js";
import type { ObservationHandle } from "./observation.js";
import { renderEvent, write, type UsageTracker } from "../ui/render.js";
import {
  filterFailedAssistants,
  resolveCompactionSettings,
  RUN_STOP_REASON_TEXT,
  withSummaryFallback,
  type RunStopReason,
  type RunStopState,
  type SessionSummarizer,
} from "../session/session-runtime.js";
import type { ConfirmHook } from "../permission/confirm.js";

/**
 * 一轮 run 的配置：由 runCli 按命令行参数解析一次，贯穿单次模式与 REPL 所有轮次。
 * ohna 恒为编码助手，配置只承载「系统提示词 / 预算 / 作用域」，不改变 loop 内核契约。
 */
export interface RunSetup {
  systemPrompt: string;
  /** --yes：跳过写/执行的交互确认。 */
  autoApprove: boolean;
  /** 工作区根目录（路径与命令的唯一作用域）。 */
  cwd: string;
  /** --max-turns 覆盖；缺省取 resolveMaxTurns。 */
  maxTurns?: number;
  /** --deadline-ms：单次 run 的墙钟上限（从 run 开始计时）。 */
  deadlineMs?: number;
  /** --max-cost：会话累计成本上限（美元）。 */
  maxCost?: number;
  /** 摘要器：运行期 compaction 与会话级 compaction 共用。 */
  summarizer: SessionSummarizer;
  /** --resume <id>：启动时恢复该会话（单次模式同样生效）。 */
  resumeId?: string;
  /** MCP 发现的工具名（渲染层据此标注来源）。 */
  mcpToolNames?: ReadonlySet<string>;
  /**
   * 覆盖底层 StreamFn（缺省 `@aiagent/ai` 的 `streamSimple`）。
   *
   * 生产路径不设置：留空即走真实 provider。测试注入 stub 时用，
   * 这样 `runTurn` 的观测接线（llm_call 采集）也能被单测覆盖而不联网。
   */
  streamFn?: StreamFn;
}

/** 单轮 run 的返回状态。 */
export interface RunTurnResult {
  /** 合并本轮增量后的 history（已过滤 error/aborted assistant）。 */
  history: AgentMessage[];
  /** 本轮是否发生 provider 错误（单次模式据此设置非零退出码）。 */
  failed: boolean;
}

/**
 * 构造本轮 run 的 AgentLoopConfig。
 *
 * 治理语义（内核零改动，全部由钩子实现）：
 * - `deadlineMs`：从 createConfig 调用时刻起算，`shouldStopAfterTurn` 每轮查时钟；
 * - `maxTurns`：按 --max-turns 或默认值（MAX_TURNS）计数；
 * - `maxCost`：run 前检查 + 每轮结束后检查会话累计 cost（单轮内可能超出）；
 * - 停止原因只在「本轮仍有 toolCall / toolResult」时记录——模型给出最终文本属于自然结束，
 *   此时即便恰好达到 max-turns 也不应打印「已停止」；
 * - `transformContext`：运行期按上下文窗口自动压缩（会话级压缩在 run 结束后另行执行）。
 *
 * @param model 已解析的真实模型。
 * @param apiKey 真实 provider 凭据。
 * @param setup 本轮的系统提示词与预算配置。
 * @param tracker 会话级用量累计器（max-cost 读取其快照）。
 * @param stopState 停止原因槽（供 runTurn 打印可读提示）。
 * @param beforeToolCall 可选的权限闸门钩子。
 * @param getSteeringMessages 可选的 steering 钩子：内核每轮前拉取运行中中途输入（B1 阶段挂载点预留，暂无来源）。
 * @param getFollowUpMessages 可选的 follow-up 钩子：内核将结束时拉取排队消息并继续当前 run（K2）。
 * @returns 可直接传给 agentLoop 的配置。
 */
export function createConfig(
  model: ActiveModel["model"],
  apiKey: string,
  setup: RunSetup,
  tracker: UsageTracker,
  stopState: RunStopState,
  beforeToolCall?: ConfirmHook,
  getSteeringMessages?: () => Promise<AgentMessage[]>,
  getFollowUpMessages?: () => Promise<AgentMessage[]>,
): AgentLoopConfig {
  const maxTurns = setup.maxTurns ?? resolveMaxTurns();
  const deadlineAt = setup.deadlineMs !== undefined ? Date.now() + setup.deadlineMs : undefined;
  let turns = 0;

  return {
    model,
    apiKey,
    convertToLlm: defaultConvertToLlm,
    beforeToolCall,
    // K2：运行中中途输入（steering）与排队继续（follow-up）由上层 REPL 注入，内核零改动。
    getSteeringMessages,
    getFollowUpMessages,
    deadlineMs: setup.deadlineMs,
    // 运行期压缩：摘要失败时用确定性兜底，保证正在进行的 run 不被摘要异常打断。
    transformContext: createCompactionTransform({
      model,
      settings: resolveCompactionSettings(model.contextWindow),
      summarizer: withSummaryFallback(setup.summarizer, (message) => process.stderr.write(`${message}\n`)),
    }),
    shouldStopAfterTurn: ({ message, toolResults }) => {
      turns += 1;
      // 只有本轮还会继续调用工具时，预算/时限停止才是有意义的「中断」；
      // 文本回合代表任务自然收尾，不能误报「已停止」。
      const hasToolCall = message.content.some((block) => block.type === "toolCall");
      if (!hasToolCall && toolResults.length === 0) return false;

      // 顺序：时间 → 成本 → 回合数。三者同时命中时优先报告更「硬」的外部约束。
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        stopState.reason = "deadline";
        return true;
      }
      if (setup.maxCost !== undefined && tracker.snapshot().cost >= setup.maxCost) {
        stopState.reason = "max_cost";
        return true;
      }
      if (turns >= maxTurns) {
        stopState.reason = "max_turns";
        return true;
      }
      return false;
    },
  };
}

/**
 * 判断会话累计成本是否已到达预算，并打印统一停止提示。
 *
 * run 前与每轮结束后共用：`--max-cost 0` 表示零预算，启动即停、不调用模型。
 *
 * @param tracker 会话级用量累计器。
 * @param maxCost 成本上限（美元）；undefined 表示不限制。
 * @returns true 表示已达上限，调用方必须跳过模型调用。
 */
export function reachedCostBudget(tracker: UsageTracker, maxCost: number | undefined): boolean {
  if (maxCost === undefined) return false;
  return tracker.snapshot().cost >= maxCost;
}

/**
 * 打印预算/时限停止原因（自然结束时不会调用）。
 *
 * @param reason 停止原因。
 */
export function printStopReason(reason: RunStopReason): void {
  // 走 write()：整屏模式下停止原因会进对话模型，直写 stdout 会被下一帧清屏抹掉。
  write(`\n⏹ 已停止：${RUN_STOP_REASON_TEXT[reason]}\n`);
}

/**
 * 执行一轮对话：构造用户消息、调用 agentLoop、逐事件渲染，并把增量并入多轮 history。
 *
 * history 采用「追加增量」策略——agentLoop 返回的 agent_end.messages 仅含本轮新增消息
 * （它内部用 [...history, ...prompts] 的副本，不回写外部数组），因此这里把增量并入 history，
 * 既保留往轮上下文，又避免重复。
 *
 * @param history 之前所有轮次的消息（会被本轮增量扩展后返回）。
 * @param userText 本轮用户输入；字符串或内容块数组（`@` 文件引用会展开为数组）。
 * @param active 已解析的真实模型与凭据。
 * @param tools 已装配的工具列表。
 * @param signal run 级 AbortSignal，用于 Ctrl-C 中断当前 run。
 * @param setup 本轮的配置（系统提示词 / 预算 / 作用域）。
 * @param tracker 会话级用量累计器（跨 run 复用，agent_end 打印累计值）。
 * @param beforeToolCall 权限闸门钩子（写文件与执行命令前询问，--yes 时自动放行）。
 * @param getSteeringMessages 可选的 steering 钩子（透传给 createConfig；REPL 注入）。
 * @param getFollowUpMessages 可选的 follow-up 钩子（透传给 createConfig；REPL 注入）。
 * @param observation 可选的观测句柄（W3）：事件与 `llm_call` 记录镜像给它，执行权不变。
 * @returns 更新后的 history 与本轮是否失败。
 */
export async function runTurn(
  history: AgentMessage[],
  userText: UserMessage["content"],
  active: ActiveModel,
  tools: AgentTool<any>[],
  signal: AbortSignal,
  setup: RunSetup,
  tracker: UsageTracker,
  beforeToolCall?: ConfirmHook,
  getSteeringMessages?: () => Promise<AgentMessage[]>,
  getFollowUpMessages?: () => Promise<AgentMessage[]>,
  observation?: ObservationHandle,
): Promise<RunTurnResult> {
  const userMessage: AgentMessage = {
    role: "user",
    content: userText,
    timestamp: Date.now(),
  };

  const stopState: RunStopState = {};
  let failed = false;

  // createConfig / streamFn 构造 / agentLoop 调用都必须在 try 内：任一步同步抛错也要走
  // finally 的 observation.end()，否则镜像 run 会永远停在 running（直到 shutdown 才 interrupted）。
  try {
    const config = createConfig(
      active.model,
      active.apiKey,
      setup,
      tracker,
      stopState,
      beforeToolCall,
      getSteeringMessages,
      getFollowUpMessages,
    );

    // 观测（W3）：有句柄时把底层 streamFn 包一层采集层，每次 LLM 调用产出一条 llm_call。
    // 若调用方传入的 streamFn 已带采集标记（组合根共享给 Team 的转发器），**不再二次包装**——
    // 两层 wrapper 会各自计数，同一 run 出现重复 callIndex（S1）。
    // 无句柄且未注入时把 undefined 交给 agentLoop，走其默认 streamSimple。
    const streamFn = observation && !isTracedStreamFn(setup.streamFn)
      ? createLlmTraceStreamFn(setup.streamFn ?? (streamSimple as StreamFn), (record) =>
          observation.push({ type: "llm_call", payload: record }),
        )
      : setup.streamFn;

    const stream = agentLoop(
      [userMessage],
      { systemPrompt: setup.systemPrompt, messages: history, tools },
      config,
      signal,
      streamFn,
    );

    for await (const event of stream) {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "error"
      ) {
        failed = true;
      }
      if (event.type === "agent_end" && event.error) {
        // 钩子 / transformContext 抛错时 loop 会补发带 error 的 agent_end：这也是一次失败的 run，
        // 单次模式必须非零退出（REPL 由 renderEvent 打印后继续，不中断会话）。
        failed = true;
      }
      // 观测镜像：在渲染之前推给 sink，保证「先落观测、后给人看」，且不改变事件顺序。
      observation?.push(event);
      renderEvent(event, tracker, {
        workspaceRoot: setup.cwd,
        ...(setup.mcpToolNames ? { mcpToolNames: setup.mcpToolNames } : {}),
      });
      // 成功时 agent_end.messages 为本轮增量（仅 prompts + 本轮新增助手/工具消息）；
      // 错误兜底分支里 agent_end.messages 是 context.messages.slice()（含完整历史+本轮 prompt），
      // 直接并入会把整段历史重复追加。用对象引用去重，只并入 history 尚未持有的新消息，
      // 既保持成功路径不变，又保证错误路径不丢消息、不重复历史。
      if (event.type === "agent_end") {
        const incremental = event.error
          ? event.messages.filter((message) => !history.includes(message))
          : event.messages;
        // error/aborted assistant 不进入内存 history：下一轮不能把无效回复再发给模型。
        history = [...history, ...filterFailedAssistants(incremental)];
      }
    }
  } catch (error) {
    // 构造期 / 迭代期抛错都算失败：镜像 run 不能因为「还没读到事件」被标成 completed。
    failed = true;
    throw error;
  } finally {
    // 无论正常结束、抛错还是 Ctrl-C 中断，观测型 run 都必须有终态，否则 web 端永远是 running。
    observation?.end({ failed });
  }

  // 预算/时限停止是「正常收尾」，单独打印原因，避免用户误以为任务失败。
  if (stopState.reason) printStopReason(stopState.reason);

  return { history, failed };
}
