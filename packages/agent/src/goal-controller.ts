/**
 * Goal 模式（/"goal" 思想）的「目标守卫」：在 ReAct loop 之外挂一层完成度判定，
 * 让 agent 跨轮次持续工作直到目标达成，期间实时记录轮次/进度。
 *
 * 设计要点（依赖倒置 + loop 内核零改动）：
 * - GoalJudger 是判定器的抽象接口；CommandJudger（跑命令看退出码）与 LlmJudger
 *   （调一次 LLM 自检返回 JSON）是两种实现，新增判定器只需实现接口。
 * - GoalController 把判定器挂到 AgentLoopConfig 的三个既有钩子
 *   （shouldStopAfterTurn / getFollowUpMessages / prepareNextTurn），把这些钩子
 *   作为「目标守卫」的最小原语。agentLoop 完全不感知 Goal 概念，一行不改。
 * - 控制器是有状态的「守卫」，独立于 agentLoop 之外存活；它只在每轮 turn 结束时
 *   被钩子回调，因此能跨轮累计进度并在未达成时通过 getFollowUpMessages 把一条
 *   meta 用户消息推回 loop，形成「判定未达成 → 继续」的闭环。
 *
 * 复用位置见 agent-loop.ts：prepareNextTurn（agent-loop.ts:254）、
 * shouldStopAfterTurn（agent-loop.ts:269）、getFollowUpMessages（agent-loop.ts:278）。
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Api, AssistantMessage, Context, Model, ToolResultMessage } from "@aiagent/ai";
import { parseJsonWithRepair, streamSimple } from "@aiagent/ai";
import type {
  AgentContext,
  AgentLoopConfig,
  AgentLoopTurnUpdate,
  AgentMessage,
  PrepareNextTurnContext,
  ShouldStopAfterTurnContext,
  StreamFn,
} from "./types.js";

/** 单条命令执行的缺省实现（注入点，测试可替换）。 */
const execAsync = promisify(exec);

/**
 * 判定结果：达成与否 + 可选的理由与子任务进度。
 * completedSteps / remainingSteps 由判定器推断，用于向模型注入「已完成/剩余」避免重复劳动。
 */
export interface GoalJudgeResult {
  /** 目标是否已达成。 */
  achieved: boolean;
  /** 人类可读的判定理由（命令退出信息 / 模型判词）。 */
  reason?: string;
  /** 本轮判定后已完成的子任务（可选，供进度注入）。 */
  completedSteps?: string[];
  /** 剩余待办子任务（可选，供进度注入）。 */
  remainingSteps?: string[];
}

/**
 * 传给判定器的上下文：包含本轮 turn 结束后的完整状态，判定器据此判断目标达成情况。
 */
export interface GoalJudgeContext {
  /** 原始目标文本。 */
  goalText: string;
  /** 本轮完成的 assistant 消息。 */
  message: AssistantMessage;
  /** 随本轮 turn_end 发出的工具结果消息。 */
  toolResults: ToolResultMessage[];
  /** 本轮结束后的 agent 上下文。 */
  context: AgentContext;
  /** 本次 loop 调用产生的新消息。 */
  newMessages: AgentMessage[];
  /** 当前轮次计数（从 1 开始）。 */
  turns: number;
  /** 目标守卫当前累计进度（只读视角）。 */
  progress: Readonly<GoalProgress>;
}

/**
 * 目标判定器抽象：把自然语言 goal 编译成「可判定的完成条件」。
 * 依赖倒置的核心——GoalController 只依赖此接口，具体判定策略由实现决定。
 */
export interface GoalJudger {
  judge(context: GoalJudgeContext): Promise<GoalJudgeResult>;
}

/** 目标进度快照：控制器跨轮维护，调用方可随时 getProgress() 取用。 */
export interface GoalProgress {
  goalText: string;
  /** 目标是否已达成（仅由判定器决定）。 */
  achieved: boolean;
  /** 已完成的子任务。 */
  completedSteps: string[];
  /** 剩余待办子任务。 */
  remainingSteps: string[];
  /** 已进行的轮次数。 */
  turns: number;
  /** 守卫创建时刻（Unix 毫秒）。 */
  startedAt: number;
}

/** 从 assistant 消息中抽取纯文本（用于 LLM 判定与日志）。 */
function extractText(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter((c): c is Extract<AssistantMessage["content"][number], { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** 构造一条 user 型的 AgentMessage（meta 续跑指令使用该形状）。 */
function userMetaMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

/**
 * CommandJudger 选项：跑一条 shell 命令，按退出码（0 = 达成）判定。
 * runCommand 可注入，便于测试用 fake 替换真实子进程。
 */
export interface CommandJudgerOptions {
  /** 待执行的 shell 命令（如 "pnpm test && pnpm typecheck"）。 */
  command: string;
  /**
   * 命令执行器（依赖注入点）。缺省走 node:child_process.exec；
   * 测试应注入 fake，避免真实执行与不确定时序。
   */
  runCommand?: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * 缺省命令执行器：包装 node:child_process.exec。
 * exec 在非零退出时会 reject，错误对象上挂 stdout/stderr/code，这里归一化为结构化结果，
 * 保证「判定器不得抛错」的契约（对齐 agent loop 钩子不抛错的纪律）。
 *
 * @param command 待执行命令。
 * @returns 退出码 + 标准输出/错误（各截断到 2KiB 避免理由过长）。
 */
function defaultRunCommand(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return execAsync(command, { maxBuffer: 4 * 1024 * 1024 }).then(
    ({ stdout, stderr }) => ({ exitCode: 0, stdout: stdout.slice(0, 2048), stderr: stderr.slice(0, 2048) }),
    (error: { stdout?: string; stderr?: string; code?: number | string | null }) => ({
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: (error.stdout ?? "").slice(0, 2048),
      stderr: (error.stderr ?? "").slice(0, 2048),
    }),
  );
}

/**
 * 创建命令型判定器：以退出码 0 作为「目标达成」的硬判定。
 * 典型场景——"测试全过 + 类型检查无错"：把 goal 编译成跑命令的断言。
 *
 * @param options 命令与可选注入的执行器。
 * @returns GoalJudger 实现。
 */
export function createCommandJudger(options: CommandJudgerOptions): GoalJudger {
  const run = options.runCommand ?? defaultRunCommand;
  return {
    async judge(context: GoalJudgeContext): Promise<GoalJudgeResult> {
      const { exitCode, stdout, stderr } = await run(options.command);
      const achieved = exitCode === 0;
      // 退出码非零时把 stderr/stdout 片段作为理由，便于排查未达成原因。
      const reason = achieved
        ? `命令退出码 0：${options.command}`
        : `命令退出码 ${exitCode}。stderr=${stderr || "(空)"} stdout=${stdout || "(空)"}`;
      return { achieved, reason, completedSteps: [], remainingSteps: [] };
    },
  };
}

/** LLM 自检判定器的选项：调一次模型判断目标是否达成。 */
export interface LlmJudgerOptions {
  /** 待判定的目标文本（与控制器共享同一份）。 */
  goalText: string;
  /** 用于自检的模型（通常复用主 agent 模型或更小更快的模型）。 */
  model: Model<Api>;
  /** 流式函数（依赖注入点），缺省用 @aiagent/ai 的 streamSimple。 */
  streamFn?: StreamFn;
}

/** 自检判定 prompt 的固定系统提示。 */
const LLM_JUDGE_SYSTEM_PROMPT =
  "你是目标完成度判定器。根据对话历史判断目标是否达成，只输出一个 JSON 对象，不要输出任何额外文字。";

/**
 * 从模型返回文本中剥离可能存在的 markdown 代码围栏，取出可解析的 JSON 文本。
 * 模型常把 JSON 包在 ```json ... ``` 中，先去掉围栏再交给容错解析器。
 *
 * @param text 模型原始输出。
 * @returns 去围栏后的纯 JSON 文本。
 */
function stripCodeFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * 创建 LLM 自检型判定器：把目标与最近一轮对话塞给模型，要求返回
 * { achieved, reason, completedSteps?, remainingSteps? } 的 JSON，再用容错解析器取出。
 * 这是「LLM-as-Judge」的低门槛前哨（见 docs 04 章节）。
 *
 * @param options 目标文本、模型与可选注入的流式函数。
 * @returns GoalJudger 实现。
 */
export function createLlmJudger(options: LlmJudgerOptions): GoalJudger {
  const streamFn = options.streamFn ?? streamSimple;
  return {
    async judge(context: GoalJudgeContext): Promise<GoalJudgeResult> {
      const lastAssistantText = extractText(context.message);
      const toolResultsText = context.toolResults
        .map((t) => `[${t.toolName}] ${t.content.map((c) => ("text" in c ? c.text : "")).join("")}`)
        .join("\n");

      const userPrompt =
        `目标：${options.goalText}\n\n` +
        `最近一轮助手回复：\n${lastAssistantText || "(无)"}\n\n` +
        `最近一次工具结果：\n${toolResultsText || "(无)"}\n\n` +
        `请判断目标是否已达成，并返回 JSON：\n` +
        `{"achieved": true|false, "reason": "理由", "completedSteps": ["已完成子任务"], "remainingSteps": ["剩余子任务"]}`;

      const llmContext: Context = {
        systemPrompt: LLM_JUDGE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
      };

      const stream = await streamFn(options.model, llmContext, {});
      const message = await stream.result();
      const raw = stripCodeFence(extractText(message));

      // 用 ai 包的容错解析：截断/格式不规整也不会抛错，失败时按未达成处理。
      const parsed = parseJsonWithRepair<Partial<GoalJudgeResult>>(raw);
      const achieved = parsed.achieved === true;
      return {
        achieved,
        reason: typeof parsed.reason === "string" ? parsed.reason : raw.slice(0, 256),
        completedSteps: Array.isArray(parsed.completedSteps) ? parsed.completedSteps : [],
        remainingSteps: Array.isArray(parsed.remainingSteps) ? parsed.remainingSteps : [],
      };
    },
  };
}

/** GoalController 构造选项。 */
export interface GoalControllerOptions {
  /** 原始目标文本（自然语言）。 */
  goalText: string;
  /** 已构建的目标判定器（依赖倒置：控制器只依赖 GoalJudger 接口）。 */
  judger: GoalJudger;
  /**
   * 与 judger 共享的模型；LlmJudger 内部已持有权威模型，
   * 此处保留以便编排层用同一 options 对象统一传参（本控制器核心逻辑不依赖它）。
   */
  model?: Model<Api>;
  /** 与 judger 共享的流式函数（缺省 streamSimple，仅作透传/调试用途）。 */
  streamFn?: StreamFn;
  /** 最大轮次预算；超过则强制停止并标记未达成，防止无限循环烧 token。 */
  maxTurns?: number;
}

/**
 * 目标守卫控制器：把判定器接到 agent loop 的三个钩子，形成「判定→续跑」闭环。
 * 状态（轮次/进度）独立于 agentLoop 维护——它是 loop 之外的「守卫」。
 */
export interface GoalController {
  /** 可 spread 进现有 AgentLoopConfig 的钩子子集（shouldStopAfterTurn / getFollowUpMessages / prepareNextTurn）。 */
  readonly hooks: Pick<
    AgentLoopConfig,
    "shouldStopAfterTurn" | "getFollowUpMessages" | "prepareNextTurn"
  >;
  /** 取当前进度快照。 */
  getProgress(): GoalProgress;
}

/**
 * 创建目标守卫控制器。
 *
 * 闭环原理（复用 agent-loop.ts 既有钩子，零改内核）：
 * 1. shouldStopAfterTurn（agent-loop.ts:269）：每轮结束跑判定器；达成→true（正常 agent_end），
 *    超 maxTurns→true（带未达成理由，避免无限循环），否则 false。
 * 2. getFollowUpMessages（agent-loop.ts:278）：未达成时返回一条 meta 用户消息「目标未达成，请继续」，
 *    被 loop 当作 follow-up 推回，从而进入下一轮——这就是闭环。
 * 3. prepareNextTurn（agent-loop.ts:254）：本实现返回 undefined（不替换上下文），进度注入收敛到
 *    getFollowUpMessages 的 meta 消息中，避免每轮重复插入、干扰模型。保持最小侵入。
 *
 * @param options 目标文本、判定器与可选预算。
 * @returns 提供 hooks 与进度查询的控制器。
 */
export function createGoalController(options: GoalControllerOptions): GoalController {
  const { goalText, judger, maxTurns } = options;
  const startedAt = Date.now();

  let turns = 0;
  let achieved = false;
  let lastReason = "";
  let completedSteps: string[] = [];
  let remainingSteps: string[] = [];
  // 超过轮次预算后强制停止的标记（与「判定达成」区分开）。
  let stoppedByBudget = false;

  /** 取当前进度快照（每轮 shouldStopAfterTurn 后更新）。 */
  const getProgress = (): GoalProgress => ({
    goalText,
    achieved,
    completedSteps: [...completedSteps],
    remainingSteps: [...remainingSteps],
    turns,
    startedAt,
  });

  /** 组装一条「继续推进」的 meta 用户消息：含目标、已完成/剩余与轮次，避免模型重复劳动。 */
  const buildFollowUpMessage = (): AgentMessage => {
    const lines = [`目标未达成：${goalText}。请继续推进，避免重复已完成的步骤。`];
    if (completedSteps.length > 0) {
      lines.push(`已完成：${completedSteps.join("；")}。`);
    }
    if (remainingSteps.length > 0) {
      lines.push(`剩余：${remainingSteps.join("；")}。`);
    }
    lines.push(`（已进行 ${turns} 轮）`);
    return userMetaMessage(lines.join("\n"));
  };

  return {
    getProgress,
    hooks: {
      // 挂载点③语义的扩展：把「目标达成」作为停止条件，并叠加 maxTurns 预算护栏。
      shouldStopAfterTurn: async (ctx: ShouldStopAfterTurnContext): Promise<boolean> => {
        turns += 1;
        // 判定器契约：正常应返回结构化结果而非抛错。但自定义判定器 / 其依赖的
        // runCommand / streamFn 可能意外 reject——此处兜底为「未达成」，避免把一次判定
        // 异常升级成 agent_end.error 让整个 goal run 以硬错误结束。
        let result: GoalJudgeResult;
        try {
          result = await judger.judge({
            goalText,
            message: ctx.message,
            toolResults: ctx.toolResults,
            context: ctx.context,
            newMessages: ctx.newMessages,
            turns,
            progress: getProgress(),
          });
        } catch (caught) {
          result = {
            achieved: false,
            reason: `判定器异常：${caught instanceof Error ? caught.message : String(caught)}`,
          };
        }

        achieved = result.achieved;
        lastReason = result.reason ?? "";
        // 已完成子任务按并集累积（跨轮去重），剩余以最新一轮判定为准。
        if (result.completedSteps?.length) {
          const set = new Set([...completedSteps, ...result.completedSteps]);
          completedSteps = [...set];
        }
        if (result.remainingSteps) {
          remainingSteps = [...result.remainingSteps];
        }

        // 轮次预算护栏：达成自然停下；超预算则强制停下并标记未达成，避免烧 token 无限循环。
        if (achieved) return true;
        if (maxTurns !== undefined && turns >= maxTurns) {
          stoppedByBudget = true;
          lastReason = lastReason
            ? `${lastReason}（已达轮次预算 ${maxTurns}，停止）`
            : `已达轮次预算 ${maxTurns}，目标未达成，停止。`;
          return true;
        }
        return false;
      },

      // 挂载点④语义的扩展：未达成且未触发预算停止时，推回一条 meta 用户消息形成续跑闭环。
      getFollowUpMessages: async (): Promise<AgentMessage[]> => {
        if (achieved || stoppedByBudget) return [];
        return [buildFollowUpMessage()];
      },

      // 本实现不替换上下文，进度注入统一收敛到 getFollowUpMessages 的 meta 消息，保持最小侵入。
      prepareNextTurn: (_ctx: PrepareNextTurnContext): AgentLoopTurnUpdate | undefined => {
        return undefined;
      },
    },
  };
}
