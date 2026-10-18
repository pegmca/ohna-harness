/**
 * CLI 组合根（composition root）：装配真实模型、工具与 agentLoop，并负责多轮上下文与中断传播。
 * 这是 apps/cli 唯一「把依赖接线在一起」的地方——index.ts 只做参数解析，render.ts 只做输出，
 * 本文件承担真实工程意图：真实模型选择、工具注册、单轮/多轮 run、AbortController 贯穿。
 */
import type { Model } from "@aiagent/ai";
import {
  createOpenAiCompatibleRuntime,
} from "@aiagent/ai";
import {
  agentLoop,
  defaultConvertToLlm,
  type AgentLoopConfig,
  type AgentMessage,
} from "@aiagent/agent";
import {
  createDefaultToolRegistry,
  createFinancialDataSourceFromEnv,
  type AgentTool,
} from "@aiagent/tools";
import { createCodingToolRegistry } from "@aiagent/coding";
import { createToolConfirmGate, type ConfirmHook } from "./confirm.js";
import { resolveMaxTurns, resolveSystemPrompt, type CliMode } from "./mode.js";
import { createUsageTracker, renderEvent } from "./render.js";
import { matchReplCommand, printReplCommands, renderWelcome } from "./welcome.js";
import * as readline from "node:readline";

/**
 * 一轮 run 的模式配置：由 runCli 按 --mode 解析一次，贯穿单次模式与 REPL 所有轮次。
 * 模式只影响「工具注册表 / 系统提示词 / 回合预算 / 是否挂确认闸门」，不改变 loop 内核契约。
 */
interface RunSetup {
  mode: CliMode;
  systemPrompt: string;
  /** --yes：跳过写/执行的交互确认。 */
  autoApprove: boolean;
  /** 工作区根目录（coding 模式的路径与命令作用域）。 */
  cwd: string;
}

/**
 * 候选 provider profile 与其缺省 baseUrl。
 * deepseek / openrouter 使用各自网关；bridge_ai 由环境变量覆盖 baseUrl（缺省留空，需显式配置）。
 */
const PROFILES: ReadonlyArray<readonly [string, string]> = [
  ["deepseek", "https://api.deepseek.com/v1"],
  ["openrouter", "https://openrouter.ai/api/v1"],
  ["bridge_ai", ""],
];

/** 解析出的可用真实模型与凭据。 */
export interface ActiveModel {
  model: Model<"openai-completions">;
  apiKey: string;
}

/**
 * 解析当前环境可用的真实模型：遍历各 profile 调 createOpenAiCompatibleRuntime，
 * 收集配置齐全（apiKey + model 均就绪）的 runtime。
 * 若指定了 modelFlag，则只在对应 profile 已配置时返回它；否则返回第一个可用 profile。
 * 全部未配置或指定 profile 不存在时返回 null，由调用方打印错误并以非零码退出（绝不回退 mock）。
 *
 * @param modelFlag 可选的 --model 值，用于锁定某个 profile。
 * @returns 可用模型或 null。
 */
export function resolveActiveModel(modelFlag?: string): ActiveModel | null {
  const all = PROFILES.map(([profile, baseUrl]) => ({
    profile,
    result: createOpenAiCompatibleRuntime(profile, baseUrl),
  }));

  const valid = all
    .filter((entry) => entry.result.runtime)
    .map((entry) => ({ profile: entry.profile, ...entry.result.runtime! }));

  if (valid.length === 0) return null;

  if (modelFlag) {
    const chosen = valid.find((entry) => entry.profile === modelFlag);
    return chosen ?? null;
  }

  return valid[0];
}

/**
 * 打印「未配置真实 provider」的中文错误，并指明需在 .env 配置环境变量（项目已移除 mock）。
 *
 * @param modelFlag 用户指定的 model（若有），用于给出更精确的提示。
 */
export function printProviderError(modelFlag?: string): void {
  const lines: string[] = [];
  if (modelFlag) {
    lines.push(`指定的模型 "${modelFlag}" 未配置有效的真实 provider。`);
  } else {
    lines.push("未检测到任何已配置的真实模型 provider。");
  }
  lines.push("");
  lines.push("本项目已彻底移除 mock，必须提供真实凭据才能运行。请在 .env 中配置以下环境变量之一：");
  lines.push("  AIAGENT_LLM_API_KEY_DEEPSEEK 与 AIAGENT_LLM_MODEL_DEEPSEEK");
  lines.push("  AIAGENT_LLM_API_KEY_OPENROUTER 与 AIAGENT_LLM_MODEL_OPENROUTER");
  lines.push("  AIAGENT_LLM_API_KEY_BRIDGE_AI、AIAGENT_LLM_BASE_URL_BRIDGE_AI 与 AIAGENT_LLM_MODEL_BRIDGE_AI");
  lines.push("");
  lines.push("配置后重新运行：immersive \"你的问题\"");
  process.stderr.write(lines.join("\n") + "\n");
}

/**
 * 构造本轮 run 的 AgentLoopConfig。convertToLlm 用默认实现（三元组透传 + 压缩摘要转 user）；
 * shouldStopAfterTurn 用闭包计数器实现按模式的回合预算，避免单轮对话无限展开；
 * beforeToolCall 仅在 coding 模式挂载（写/执行确认闸门），research 模式保持历史行为。
 *
 * @param model 已解析的真实模型。
 * @param apiKey 真实 provider 凭据。
 * @param setup 本轮的模式配置。
 * @param beforeToolCall 可选的权限闸门钩子。
 * @returns 可直接传给 agentLoop 的配置。
 */
function createConfig(
  model: Model<"openai-completions">,
  apiKey: string,
  setup: RunSetup,
  beforeToolCall?: ConfirmHook,
): AgentLoopConfig {
  const maxTurns = resolveMaxTurns(setup.mode);
  let turns = 0;
  return {
    model,
    apiKey,
    convertToLlm: defaultConvertToLlm,
    beforeToolCall,
    shouldStopAfterTurn: () => {
      turns += 1;
      return turns >= maxTurns;
    },
  };
}

/**
 * 执行一轮对话：构造用户消息、调用 agentLoop、逐事件渲染，并返回更新后的多轮 history。
 * history 采用「追加增量」策略——agentLoop 返回的 agent_end.messages 仅含本轮新增消息
 * （它内部用 [...history, ...prompts] 的副本，不回写外部数组），因此这里把增量并入 history，
 * 既保留往轮上下文，又避免重复。
 *
 * @param history 之前所有轮次的消息（会被本轮增量扩展后返回）。
 * @param userText 本轮用户输入。
 * @param active 已解析的真实模型与凭据。
 * @param tools 已装配的工具列表。
 * @param signal run 级 AbortSignal，用于 Ctrl-C 中断当前 run。
 * @param setup 本轮的模式配置（系统提示词 / 回合预算 / 渲染模式）。
 * @param beforeToolCall 可选的权限闸门钩子（coding 模式传入）。
 * @returns 更新后的多轮 history。
 */
async function runTurn(
  history: AgentMessage[],
  userText: string,
  active: ActiveModel,
  tools: AgentTool<any>[],
  signal: AbortSignal,
  setup: RunSetup,
  beforeToolCall?: ConfirmHook,
): Promise<AgentMessage[]> {
  const userMessage: AgentMessage = {
    role: "user",
    content: userText,
    timestamp: Date.now(),
  };

  const config = createConfig(active.model, active.apiKey, setup, beforeToolCall);
  const tracker = createUsageTracker();

  // streamFn 省略：agentLoop 默认走 @aiagent/ai 的 streamSimple，直接对接真实 provider。
  const stream = agentLoop(
    [userMessage],
    { systemPrompt: setup.systemPrompt, messages: history, tools },
    config,
    signal,
  );

  for await (const event of stream) {
    renderEvent(event, tracker, { mode: setup.mode });
    // 成功时 agent_end.messages 为本轮增量（仅 prompts + 本轮新增助手/工具消息）；
    // 错误兜底分支里 agent_end.messages 是 context.messages.slice()（含完整历史+本轮 prompt），
    // 直接并入会把整段历史重复追加。用对象引用去重，只并入 history 尚未持有的新消息，
    // 既保持成功路径不变，又保证错误路径不丢消息、不重复历史。
    if (event.type === "agent_end") {
      const incremental = event.error
        ? event.messages.filter((m) => !history.includes(m))
        : event.messages;
      history = [...history, ...incremental];
    }
  }

  return history;
}

/**
 * 单次模式：跑完一轮后直接返回（由调用方退出进程）。
 *
 * @param prompt 用户问题。
 * @param active 已解析的真实模型与凭据。
 * @param tools 已装配的工具列表。
 * @param setup 本轮的模式配置。
 */
async function runSingleTurn(
  prompt: string,
  active: ActiveModel,
  tools: AgentTool<any>[],
  setup: RunSetup,
): Promise<void> {
  const controller = new AbortController();
  // 单次模式无 readline，需显式把进程 SIGINT 接到 AbortController（与 REPL 对齐），
  // 使 Ctrl-C 能中断当前 run 而非静默忽略；run 结束后移除监听，避免泄漏到进程退出前。
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    // 单次模式没有主 readline，确认闸门会临时创建一个（交互确认仍可用）。
    const beforeToolCall =
      setup.mode === "coding"
        ? createToolConfirmGate({ autoApprove: setup.autoApprove, cwd: setup.cwd })
        : undefined;
    await runTurn([], prompt, active, tools, controller.signal, setup, beforeToolCall);
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

/**
 * 交互式 REPL：基于 Node readline 持续读取用户输入，维护跨轮 history。
 * Ctrl-C 语义：当前有进行中的 run 则 abort 中断该 run 并继续会话；否则关闭并退出进程。
 *
 * @param active 已解析的真实模型与凭据。
 * @param tools 已装配的工具列表。
 * @param setup 会话级模式配置（跨轮复用同一份提示词与预算）。
 */
async function runRepl(active: ActiveModel, tools: AgentTool<any>[], setup: RunSetup): Promise<void> {
  const history: AgentMessage[] = [];
  let controller: AbortController | null = null;
  /** readline 是否已关闭（Ctrl-D / EOF / /exit）；关闭后不得再 resume 或 prompt。 */
  let closed = false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "你> ",
  });

  renderWelcome(
    { id: active.model.id, provider: active.model.provider, baseUrl: active.model.baseUrl },
    tools.map((tool) => tool.name),
  );
  rl.prompt();

  // coding 模式把主 readline 交给确认闸门复用，避免第二个 readline 与 REPL 抢 stdin；
  // research 模式不挂闸门，保持历史行为。
  const beforeToolCall =
    setup.mode === "coding"
      ? createToolConfirmGate({ autoApprove: setup.autoApprove, cwd: setup.cwd, readline: rl })
      : undefined;

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }

    // 会话内命令优先于模型调用：/help /clear /exit 不消耗 token，也不进 history。
    const command = matchReplCommand(text);
    if (command === "help") {
      printReplCommands();
      rl.prompt();
      return;
    }
    if (command === "clear") {
      history.length = 0;
      process.stdout.write("已清空本会话上下文。\n");
      rl.prompt();
      return;
    }
    if (command === "exit") {
      rl.close();
      return;
    }

    // 每个用户输入开一个新 run，AbortController 贯穿整条 agentLoop 调用链（含工具执行）。
    controller = new AbortController();
    rl.pause();
    try {
      const updated = await runTurn(history, text, active, tools, controller.signal, setup, beforeToolCall);
      // 用新引用替换 history，保证后续轮次能看到完整上下文。
      history.length = 0;
      history.push(...updated);
    } catch (error) {
      process.stdout.write(`\n运行出错：${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      controller = null;
      // run 期间 stdin 可能已 EOF（管道输入）或用户已 /exit，此时 readline 已关闭，
      // 再 resume/prompt 会抛 ERR_USE_AFTER_CLOSE，必须按 closed 短路。
      if (!closed) {
        rl.resume();
        rl.prompt();
      }
    }
  });

  rl.on("SIGINT", () => {
    if (controller) {
      // 有进行中的 run：中断它，会话继续。
      controller.abort();
      controller = null;
      process.stdout.write("\n已中断当前运行。\n");
      rl.prompt();
    } else {
      // 空闲：退出进程。
      rl.close();
    }
  });

  await new Promise<void>((resolve) =>
    rl.on("close", () => {
      closed = true;
      resolve();
    }),
  );
}

/** CLI 入口参数（已由 index.ts 完成解析）。 */
export interface CliOptions {
  model?: string;
  prompt?: string;
  help: boolean;
  /** 运行模式：research 为默认（金融研究），coding 为编码助手。 */
  mode: CliMode;
  /** true 表示 --yes：跳过写文件与执行命令的交互确认。 */
  yes: boolean;
}

/**
 * CLI 主入口：解析模型、装配工具、按模式启动 REPL 或单次运行。
 * 若没有任何真实 provider 可用，打印清晰错误并以非零码退出，绝不静默回退 mock。
 *
 * @param options 已解析的命令行选项。
 */
export async function runCli(options: CliOptions): Promise<void> {
  if (options.help) return; // --help 已由 index.ts 打印，此处仅短路。

  const active = resolveActiveModel(options.model);
  if (!active) {
    printProviderError(options.model);
    process.exit(1);
    return;
  }

  const cwd = process.cwd();
  // 组合根按模式选注册表：coding 用编码工具集（作用域限定在 cwd），research 沿用金融工具集。
  const tools =
    options.mode === "coding"
      ? createCodingToolRegistry(cwd)
      : createDefaultToolRegistry(createFinancialDataSourceFromEnv()).list();

  const setup: RunSetup = {
    mode: options.mode,
    systemPrompt: await resolveSystemPrompt(options.mode, cwd),
    autoApprove: options.yes,
    cwd,
  };

  if (options.prompt !== undefined) {
    await runSingleTurn(options.prompt, active, tools, setup);
  } else {
    await runRepl(active, tools, setup);
  }
}
