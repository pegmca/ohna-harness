/**
 * CLI 组合根（composition root）：装配真实模型、工具与 agentLoop，并决定单次 / REPL 运行方式。
 *
 * 单一形态（docs/v1.4/06 D-A1）：执行权唯一归属进程内 serve，终端（TUI/REPL 与非 TTY 回退）
 * 都是 serve 的执行线订阅者——同一 `server.createRun` + `server.subscribeConversation`
 * 事件流。`--prompt` 与交互循环都经同一路径发起 run 并等待终态（D-A4/D-A10）。
 *
 * 模型选择、工具注册表、摘要器与用量累计器在此接线；运行期编排已拆到 turn.ts（单轮 /
 * 单次）与 repl.ts（交互循环）。
 */
import type { ActiveModel } from "@aiagent/ai";
import { resolveActiveModelFromEnv } from "@aiagent/ai";
import type { AgentTool } from "@aiagent/tools";
import { createCodingToolRegistry } from "@aiagent/coding";
import { loadMcpTools } from "../runtime/mcp-config.js";
import { resolveSystemPrompt } from "../runtime/mode.js";
import { createUsageTracker } from "../ui/render.js";
import { createLlmSummarizer, resolveCompactionSettings } from "../runtime/summarizer.js";
import { createObservationRef, createTracedStreamFn, type TraceCounter } from "../runtime/observation.js";
import { runRepl } from "../input/repl.js";
import { runSingleTurn } from "../runtime/single-turn.js";
import type { ReplContext } from "../input/repl-context.js";
import { hostOhnaWeb, type HostResult } from "./web-host.js";
import type { CliOptions } from "./args.js";
import { printProviderError } from "./provider-error.js";
import type { OhnaServer } from "@aiagent/serve";
import type { ConfirmHook } from "../permission/confirm.js";
import { resolveDataDir } from "../session/serve-session.js";

/**
 * 解析当前环境可用的真实模型。
 *
 * @param modelFlag 可选的 --model 值，用于锁定某个 profile。
 * @returns 可用模型或 null。
 */
export function resolveActiveModel(modelFlag?: string): ActiveModel | null {
  return resolveActiveModelFromEnv(modelFlag);
}

/**
 * CLI 主入口：解析模型、装配编码工具集，然后启动 REPL 或单次运行（均经进程内 serve）。
 *
 * @param options 已解析的命令行选项。
 */
export async function runCli(options: CliOptions): Promise<void> {
  if (options.help) return;

  const active = resolveActiveModel(options.model);
  if (!active) {
    printProviderError(options.model);
    process.exit(1);
    return;
  }

  const cwd = process.cwd();
  const codingTools: AgentTool<any>[] = createCodingToolRegistry(cwd);
  const tools: AgentTool<any>[] = [...codingTools];

  const mcpContext: ReplContext = {};
  const mcp = options.mcpConfig ? await loadMcpTools(options.mcpConfig) : null;
  if (mcp) {
    tools.push(...mcp.tools);
    mcpContext.mcpToolNames = new Set(mcp.toolNames);
    mcpContext.mcpServerNames = mcp.serverNames;
  }

  // 唯一的采集 streamFn：Team 子代理与主线程共用同一个 counter，避免同 run 出现两条 callIndex。
  const observationRef = createObservationRef();
  const traceCounter: TraceCounter = { value: 0 };
  // 采集窗口参数（v2.0）：window 是 LlmCallRecordDto 的必填字段，构造 wrapper 时注入；
  // reserveTokens 与 compaction 使用同一 `resolveCompactionSettings`，保证两侧口径一致。
  const traceWindow = {
    contextWindow: active.model.contextWindow,
    maxTokens: active.model.maxTokens,
    reserveTokens: resolveCompactionSettings(active.model.contextWindow).reserveTokens,
  };
  const tracedStreamFn = createTracedStreamFn(() => observationRef.current, traceCounter, traceWindow);

  // Team 唯一装配点在 serve（v2.0，docs/v2.0/04 §2.2 / §7 第 1 步）：CLI 不再自建
  // controller，只把 `--no-team` 开关下传。serve 侧 `createServeTeamSession` 产出的
  // TeamCreate / SendMessage 会并入 agent 工具表，子代理的确认闸门来自 serve 自己的
  // confirm-gate（按 run 建 hook），因此这里也不再有 gateRef 回填链路。
  const teamEnabled = options.team === true;

  const dataDir = resolveDataDir();
  const tracker = createUsageTracker();
  const setup = {
    systemPrompt: await resolveSystemPrompt(cwd),
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
    streamFn: tracedStreamFn,
  };

  // 单一形态：起进程内 serve（observeOnly=false，执行权在 serve），终端与浏览器共享同一会话。
  const hosted = await hostOhnaWeb({
    workspaceRoot: cwd,
    active,
    tools,
    autoApprove: options.yes,
    observeOnly: false,
    port: options.webPort,
    conversationTitle: `CLI · ${(options.resume ?? cwd).slice(0, 8)}`,
    dataDir,
    // v2.0：Team 开关下传，controller 与 team 成本投影由 serve 一套装配产出。
    ...(teamEnabled ? { team: true } : {}),
  });
  const server = hosted?.server;
  if (hosted) mcpContext.traceUrl = hosted.url;

  try {
    if (options.prompt !== undefined) {
      if (!server) {
        process.stderr.write("⚠️ 观测台启动失败，单次模式无法执行。\n");
        process.exitCode = 1;
        return;
      }
      // `teamEnabled` 下 serve 侧 controller 自持权限闸门，CLI 不再回填 gate 引用。
      await runSingleTurn(options.prompt, active, tools, setup, tracker, server, dataDir);
    } else if (server) {
      await runRepl(active, tools, setup, tracker, server, dataDir, mcpContext);
    } else {
      process.stderr.write("⚠️ 观测台启动失败，已退出。\n");
      process.exitCode = 1;
    }
  } finally {
    await shutdownHost(hosted);
  }

  await mcp?.close();
}

/**
 * 关闭观测台（未启动时为空操作）。
 *
 * @param hosted 观测台装配结果。
 */
async function shutdownHost(hosted: HostResult | undefined): Promise<void> {
  if (!hosted) return;
  try {
    await hosted.server.shutdown();
    await hosted.server.close();
  } catch {
    // 退出路径上的关闭失败不值得影响进程退出码。
  }
}
