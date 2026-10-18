/**
 * CLI 组合根（composition root）：装配真实模型、工具与 agentLoop，并决定单次 / REPL 运行方式。
 *
 * 为什么保留这一层：模型选择、工具注册表、摘要器与用量累计器必须在一个地方接线；
 * 运行期编排已拆到 turn.ts（单轮 run）与 repl.ts（交互循环），避免组合根膨胀到 500 行以上。
 */
import { type ActiveModel, resolveActiveModelFromEnv } from "@aiagent/ai";
import {
  createDefaultToolRegistry,
  createFinancialDataSourceFromEnv,
  type AgentTool,
} from "@aiagent/tools";
import { createCodingToolRegistry } from "@aiagent/coding";
import { createToolConfirmGate } from "./confirm.js";
import { loadMcpTools } from "./mcp-config.js";
import { resolveSystemPrompt } from "./mode.js";
import { createUsageTracker, type UsageTracker } from "./render.js";
import { createLlmSummarizer } from "./session-runtime.js";
import {
  openSession,
  persistSession,
  printResumeHint,
} from "./session-flow.js";
import { createSessionStore, type SessionStore } from "./session-store.js";
import { printStopReason, reachedCostBudget, runTurn, type RunSetup } from "./turn.js";
import { runRepl, type ReplContext } from "./repl.js";
import { runWeb } from "./web-entry.js";
import type { CliOptions } from "./args.js";

/** 公共入口的参数类型仍从 harness 导出，调用方无需感知 args.ts 拆分。 */
export type { CliOptions } from "./args.js";

/**
 * 解析当前环境可用的真实模型。
 *
 * 遍历/选择逻辑已下沉到 `@aiagent/ai` 的 `resolveActiveModelFromEnv`（ohna-cli 与 serve 共用），
 * 这里保留同名薄封装，避免 app 内调用点感知下沉细节。
 *
 * @param modelFlag 可选的 --model 值，用于锁定某个 profile。
 * @returns 可用模型或 null。
 */
export function resolveActiveModel(modelFlag?: string): ActiveModel | null {
  return resolveActiveModelFromEnv(modelFlag);
}

/**
 * 打印「未配置真实 provider」的中文错误（实现已拆到 provider-error.ts，
 * 此处 re-export 保持既有导入路径；拆出原因见该文件说明）。
 */
export { printProviderError } from "./provider-error.js";
import { printProviderError as printProviderErrorImpl } from "./provider-error.js";

/**
 * 单次模式：跑完一轮、压缩并保存会话后返回（由调用方退出进程）。
 *
 * `--max-cost` 在 run 前先检查一次：零预算（0）或恢复会话已超预算时直接落盘并退出，
 * 不调用模型；每轮结束后 `shouldStopAfterTurn` 还会再检查（单轮内可能超出）。
 *
 * @param prompt 用户问题。
 * @param active 已解析的真实模型与凭据。
 * @param tools 已装配的工具列表。
 * @param setup 本轮的模式配置。
 * @param tracker 会话级用量累计器。
 * @param store 会话存储。
 */
async function runSingleTurn(
  prompt: string,
  active: ActiveModel,
  tools: AgentTool<any>[],
  setup: RunSetup,
  tracker: UsageTracker,
  store: SessionStore,
): Promise<void> {
  const controller = new AbortController();
  // 单次模式无 readline，需显式把进程 SIGINT 接到 AbortController（与 REPL 对齐），
  // 使 Ctrl-C 能中断当前 run 而非静默忽略；run 结束后移除监听，避免泄漏到进程退出前。
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    // 单次模式也落盘：退出后仍可用 --resume 接续；传了 --resume 时先恢复历史再追加本轮。
    const session = await openSession(store, setup.resumeId, setup.cwd);
    if (session.usage) tracker.restore(session.usage);
    const title = session.title ?? prompt.replace(/\s+/g, " ").slice(0, 40);
    const beforeToolCall =
      setup.mode === "coding"
        ? createToolConfirmGate({ autoApprove: setup.autoApprove, cwd: setup.cwd })
        : undefined;

    // 零预算 / 恢复后已超预算：不调用模型，仍然把当前会话落盘，保证 --resume 可继续。
    if (reachedCostBudget(tracker, setup.maxCost)) {
      printStopReason("max_cost");
      await persistSession(store, session.id, session.messages, {
        model: active.model,
        summarizer: setup.summarizer,
        title,
        workspaceRoot: setup.cwd,
        usage: tracker,
      });
      printResumeHint(session.id, setup.mode);
      return;
    }

    const result = await runTurn(
      session.messages,
      prompt,
      active,
      tools,
      controller.signal,
      setup,
      tracker,
      beforeToolCall,
    );
    await persistSession(store, session.id, result.history, {
      model: active.model,
      summarizer: setup.summarizer,
      title,
      workspaceRoot: setup.cwd,
      usage: tracker,
    });
    printResumeHint(session.id, setup.mode);
    // provider 错误已由 renderEvent 打印；单次模式用非零退出码让脚本/CI 能感知失败。
    if (result.failed) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

/**
 * CLI 主入口：解析模型、装配工具、按模式启动 REPL 或单次运行。
 * 若没有任何真实 provider 可用，打印清晰错误并以非零码退出，绝不静默回退 mock。
 *
 * M3：`--web` 走进程内托管（web-entry.ts）；`--mcp` 挂载外部工具（失败只警告）。
 *
 * @param options 已解析的命令行选项。
 */
export async function runCli(options: CliOptions): Promise<void> {
  if (options.help) return; // --help 已由 index.ts 打印，此处仅短路。

  // --web：进程内托管（D8 主路径），工具装配与会话语义都在 web-entry 内完成。
  if (options.web) {
    await runWeb(options);
    return;
  }

  const active = resolveActiveModel(options.model);
  if (!active) {
    printProviderErrorImpl(options.model);
    process.exit(1);
    return;
  }

  const cwd = process.cwd();
  // 组合根按模式选注册表：coding 用编码工具集（作用域限定在 cwd），research 沿用金融工具集。
  const tools: AgentTool<any>[] =
    options.mode === "coding"
      ? createCodingToolRegistry(cwd)
      : createDefaultToolRegistry(createFinancialDataSourceFromEnv()).list();

  // --mcp：外部 MCP server 接线（失败只打印结构化警告，不中断启动）。
  const mcpContext: ReplContext = {};
  const mcp = options.mcpConfig ? await loadMcpTools(options.mcpConfig) : null;
  if (mcp) {
    tools.push(...mcp.tools);
    mcpContext.mcpToolNames = new Set(mcp.toolNames);
    mcpContext.mcpServerNames = mcp.serverNames;
  }

  try {
    // 先建 tracker 再建摘要器：摘要调用的 usage 必须计入同一会话累计（/cost、header、--max-cost）。
    const tracker = createUsageTracker();
    const setup: RunSetup = {
      mode: options.mode,
      systemPrompt: await resolveSystemPrompt(options.mode, cwd),
      autoApprove: options.yes,
      cwd,
      maxTurns: options.maxTurns,
      deadlineMs: options.deadlineMs,
      maxCost: options.maxCost,
      summarizer: createLlmSummarizer({
        model: active.model,
        apiKey: active.apiKey,
        onUsage: (usage) => tracker.add(usage),
      }),
      resumeId: options.resume,
      mcpToolNames: mcpContext.mcpToolNames,
    };

    if (options.prompt !== undefined) {
      await runSingleTurn(options.prompt, active, tools, setup, tracker, createSessionStore());
    } else {
      await runRepl(active, tools, setup, tracker, mcpContext);
    }
  } finally {
    // MCP stdio 子进程的管道会保持事件循环存活：退出前必须关闭，否则 REPL 结束后进程无法退出。
    await mcp?.close();
  }
}
