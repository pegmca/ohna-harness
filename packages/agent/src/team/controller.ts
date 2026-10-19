/**
 * TeamController：多智能体 Supervisor 编排的运行时核心（P3）。
 *
 * 关键设计：
 * - Supervisor 本身是一个普通 `agentLoop`；本 controller 把两个原语作为 `AgentTool`
 *   注册进 supervisor 的 `context.tools`：`TeamCreate`（建子代理）、`SendMessage`（派发任务）。
 * - 每个子代理 = 一次独立 `agentLoop(prompts, ctx, config)`：天然独立 context + EventStream +
 *   独立 token 预算（零新增 loop 代码，复用内核）。
 * - 上下文隔离 + 摘要回收：子代理只回写 `summary` / `artifacts` 到 team 状态，主上下文
 *   不接触其探索噪声（subagent 第一性价值，对齐 Claude Code Subagent / pi subagent）。
 * - 失败隔离：子代理抛错 / agent_end.error 捕获为结构化 `SubagentResult.error`，以普通文本
 *   回传 supervisor（isError:false），主循环不崩溃。
 */
import { streamSimple } from "@aiagent/ai";
import { agentLoop } from "../agent-loop.js";
import { defaultConvertToLlm } from "../convert.js";
import type { AgentEvent, AgentMessage, AgentLoopConfig, ShouldStopAfterTurnContext, StreamFn } from "../types.js";
import type { AgentTool, AgentToolResult } from "@aiagent/tools";
import type {
  BudgetGuardConfig,
  SubagentResult,
  TeamBudgetAccumulator,
  TeamControllerOptions,
  TeamCreateParams,
  TeamEvent,
  TeamMember,
  TeamMessage,
  TeamState,
} from "./types.js";
import type { Api, Model } from "@aiagent/ai";
import { createSendMessageTool, createTeamCreateTool } from "./tools.js";
import { createBudgetGuard, createMemberStopHook, type MemberBudgetHook } from "./budget.js";
import { AsyncMutex, mapWithConcurrencyLimit, Semaphore } from "./concurrency.js";

/** TeamController 公开接口（orchestrator 之后会 re-export）。 */
export interface TeamController {
  /** 注册进 supervisor `context.tools` 的两个原语（TeamCreate + SendMessage）。 */
  readonly tools: AgentTool[];
  /** 返回 team 状态的只读快照（浅拷贝，调用方不应 mutate 实时引用）。 */
  getTeamState(): TeamState;
  /** 返回人类可读的团队状态字符串（Agent View）。 */
  getTeamView(): string;
  /** 是否存在某成员。 */
  hasMember(name: string): boolean;
  /**
   * 返回团队成本护栏的共享累加器（只读快照引用）。供可观测与单测断言团队累计
   * `totalTokens/totalCost` 是否始终受 ceiling 约束（A-1 原子性验证用）。
   */
  getBudgetAccumulator(): TeamBudgetAccumulator;
  /** 直接注册一个成员（不经由工具调用，供 presets 预置用）。 */
  createMember(params: TeamCreateParams & { modelObject?: Model<Api> }): TeamMember;
  /**
   * 向指定成员派发任务并同步运行其 subagent，回收摘要。
   * 失败返回结构化 error，不抛异常（失败隔离）。成本护栏（若配置了 budget）在此注入
   * 子代理的 shouldStopAfterTurn 钩子；并发受 maxConcurrentMembers 信号量限制。
   *
   * @param name 成员名称。
   * @param content 委派给该成员的任务。
   * @param signal 可选取消信号。
   * @param estimatedTokens 可选派发前预算估算 token 数；若超预算直接拒绝（不跑 subagent）。
   */
  runMember(
    name: string,
    content: string,
    signal?: AbortSignal,
    estimatedTokens?: number,
  ): Promise<SubagentResult>;
  /**
   * 扇出 helper：并发向多个成员派发同一任务，受 maxConcurrentMembers 限制（pi 风格 worker 池）。
   *
   * @param names 成员名称列表。
   * @param content 委派给各成员的任务。
   * @param limit 并发上限；缺省用 controller 的 maxConcurrentMembers。
   * @returns 与 names 顺序一致的结果数组。
   */
  runMembers(names: string[], content: string, limit?: number): Promise<SubagentResult[]>;
}

/** 生成一个简单唯一 id（学习版，不引入额外依赖）。 */
function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 从子代理的最终消息集中提取「摘要 + 产物引用」。
 * 摘要取最后一条 assistant 文本；产物收集所有 toolResult 的工具名 + 短摘要。
 *
 * @param messages 子代理 agentLoop 最终回写的消息集（含 prompt 与工具结果）。
 * @returns 摘要文本与产物引用列表。
 */
function extractSummary(messages: AgentMessage[]): { summary: string; artifacts: string[] } {
  let summary = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (text) {
        summary = text;
        break;
      }
    }
  }
  const artifacts = messages
    .filter((m) => m.role === "toolResult")
    .map((m) => {
      const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join(" ").slice(0, 120);
      return `${m.toolName}:${text || "(空)"}`;
    });
  return { summary: summary || "(子代理无文本输出)", artifacts };
}

/**
 * 创建 TeamController（Supervisor 编排层）。
 *
 * @param options 可用工具池、默认 model、可解析 model、可注入的 streamFn/convertToLlm。
 * @returns 持有 TeamState 并暴露 TeamCreate/SendMessage 两个工具的 controller。
 */
export function createTeamController(options: TeamControllerOptions): TeamController {
  const state: TeamState = {
    members: new Map<string, TeamMember>(),
    inboundQueues: new Map<string, TeamMessage[]>(),
    events: [],
  };

  const streamFn: StreamFn = options.streamFn ?? (streamSimple as StreamFn);
  const convertToLlm = options.convertToLlm ?? defaultConvertToLlm;

  // 成本护栏（P0）：团队聚合累加器跨成员共享，实现「团队总 ceiling」约束。
  const budgetConfig: BudgetGuardConfig | undefined = options.budget;
  const accumulator: TeamBudgetAccumulator = { totalTokens: 0, totalCost: 0 };

  // 最小并发（P0）：信号量把同时在飞的子代理数限制在 maxConcurrentMembers（默认 1=顺序）。
  const semaphore = new Semaphore(options.maxConcurrentMembers ?? 1);

  // 并发观测（SLO 容量证据）：维护「在飞成员计数」与其峰值，供 projectTeamCostSummary 投影
  // team.peakConcurrency。与信号量解耦计数，真实反映「一次 supervisor 编排实际并发了多少子代理」，
  // 比 maxConcurrentMembers 上限更能暴露运行期并发压力（受控、无额外依赖）。
  let runningMemberCount = 0;
  let peakConcurrency = 0;

  // 团队成本护栏互斥锁（A-1 修复）：把跨成员共享累加器的「读-判-写」串行化，
  // 保证团队总 ceiling 在并发下原子生效、不被双双放行突破。
  const budgetMutex = new AsyncMutex();

  /** 解析成员应使用的工具子集：按 allowedTools 名从可用池过滤（权限最小化）。 */
  function resolveTools(member: TeamMember): AgentTool[] {
    const pool = options.availableTools ?? [];
    // 语义区分：undefined = 未指定（全量池）；[] = 显式授权零工具（权限最小化的极端情形）。
    // 若把空数组也当全量，TeamCreate 传 `tools: []` 会意外拿到全部写工具，与 schema 语义相反。
    if (member.allowedTools === undefined) return pool;
    const allowed = new Set(member.allowedTools);
    return pool.filter((t) => allowed.has(t.name));
  }

  /** 解析成员应使用的 Model：显式对象优先，其次按 id 经 resolveModel，否则 defaultModel。 */
  function resolveModel(params: TeamMemberSeed): TeamMember["model"] {
    if (params.modelObject) return params.modelObject;
    if (params.model) {
      const m = options.resolveModel?.(params.model);
      if (!m) {
        throw new Error(`unknown_model: resolveModel 未能解析 model id "${params.model}"`);
      }
      return m;
    }
    return options.defaultModel;
  }

  /** 把一条跨 agent 消息投入接收方 inbound 队列并投影事件。 */
  function enqueueMessage(from: string, to: string, content: string): TeamMessage {
    const message: TeamMessage = { id: nextId("msg"), from, to, content, timestamp: Date.now() };
    const queue = state.inboundQueues.get(to) ?? [];
    queue.push(message);
    state.inboundQueues.set(to, queue);
    state.events.push({ type: "message_sent", timestamp: message.timestamp, member: to, detail: from });
    return message;
  }

  function recordEvent(event: TeamEvent): void {
    state.events.push(event);
  }

  /** createMember 的可选扩展：允许直接传入已解析的 Model 对象（presets 用）。 */
  type TeamMemberSeed = TeamCreateParams & { modelObject?: Model<Api> };

  function createMember(params: TeamMemberSeed): TeamMember {
    if (state.members.has(params.name)) {
      throw new Error(`duplicate_member: 成员 "${params.name}" 已存在`);
    }
    const member: TeamMember = {
      name: params.name,
      role: params.role,
      model: resolveModel(params),
      allowedTools: params.tools,
      systemPrompt: params.systemPrompt,
      status: "idle",
    };
    state.members.set(member.name, member);
    state.inboundQueues.set(member.name, []);
    recordEvent({ type: "member_created", timestamp: Date.now(), member: member.name, detail: member.role });
    return member;
  }

  /**
   * 运行某成员的 subagent（一次独立 agentLoop），回收摘要到 team 状态。
   * 并发受信号量限制（maxConcurrentMembers）；成本护栏（若配置）通过 shouldStopAfterTurn
   * 钩子注入，触发时干净停止并回写部分摘要。失败返回结构化 error，不抛异常（失败隔离）。
   *
   * @param name 成员名称。
   * @param content 委派任务。
   * @param signal 可选取消信号。
   * @param estimatedTokens 可选派发前预算估算；超预算直接拒绝，不跑 subagent。
   */
  async function runMember(
    name: string,
    content: string,
    signal?: AbortSignal,
    estimatedTokens?: number,
  ): Promise<SubagentResult> {
    const member = state.members.get(name);
    if (!member) {
      return {
        member: name,
        status: "failed",
        summary: "",
        artifacts: [],
        error: { code: "member_not_found", message: `成员 "${name}" 不存在` },
      };
    }

    // 成员时延埋点：从入口到收尾的墙钟时间（SLO 容量证据）。仅当真实进入 runMember 才计时，
    // 失败早退路径（member_not_found / 预算预检拒绝）不回填——那些路径并未真正运行 subagent。
    const memberStartMs = Date.now();

    // 派发前预算估算（纯函数）：明显超预算直接拒绝，避免跑后才发现失控。
    if (budgetConfig && estimatedTokens !== undefined) {
      const ok = createBudgetGuard(member.model, estimatedTokens, budgetConfig, accumulator);
      if (!ok) {
        member.status = "failed";
        member.budgetExceeded = true;
        member.usage = { tokens: 0, cost: 0 };
        recordEvent({ type: "member_failed", timestamp: Date.now(), member: name, detail: "budget_precheck" });
        return {
          member: name,
          status: "failed",
          summary: "",
          artifacts: [],
          error: { code: "budget_exceeded", message: "派发前预算估算超限，已拒绝运行" },
          usage: { tokens: 0, cost: 0 },
          budgetExceeded: true,
          model: member.model.id,
        };
      }
    }

    enqueueMessage("supervisor", name, content);
    member.status = "running";
    recordEvent({ type: "member_started", timestamp: Date.now(), member: name });

    // 上下文隔离：子代理持独立 messages，只以委派内容为 prompt 起手。
    // 注意：prompt 只通过 agentLoop 的 prompts 参数注入一次（agentLoop 会把它并入
    // context.messages），不要再预先塞进 subContext.messages，否则任务会在子代理上下文里重复出现。
    const taskMessage: AgentMessage = { role: "user", content, timestamp: Date.now() };
    const subContext = {
      systemPrompt: member.systemPrompt ?? `你是团队中的「${member.role}」成员。`,
      messages: [] as AgentMessage[],
      tools: resolveTools(member),
    };

    // 成本护栏句柄与用量快照在 acquire 之后才确定（deadline 起点见下），先声明占位。
    let budgetHook: MemberBudgetHook | undefined;
    // 捕获护栏是否被触发（shouldStopAfterTurn 返回 true），用于标记 budgetExceeded。
    let stoppedByBudget = false;
    // 用量快照：仅当配置了成本护栏才回写（A-4 修复：未配置预算不再渲染"0 tokens"行）。
    let usage: { tokens: number; cost: number } | undefined;

    // 最小并发：入口 acquire 限制在飞数，finally release 保证信号量归还（含异常路径）。
    await semaphore.acquire();
    // 在飞成员计数 +1，并刷新峰值（容量证据）；与信号量同生命周期，异常路径也经 finally 归位。
    runningMemberCount++;
    peakConcurrency = Math.max(peakConcurrency, runningMemberCount);
    try {
      // 成本护栏（P0）：复用 shouldStopAfterTurn 钩子，闭包累计并跨成员共享累加器，
      // 触发时返回 true 干净停止子代理——agent-loop 内核零改动。
      // A-3 修复：deadline 起点 = 成功拿到许可之后，避免排队等待期被计入墙钟，
      // 首个 turn 不会一 acquire 就被误判超时。
      const deadlineAt = budgetConfig?.deadlineMs !== undefined ? Date.now() + budgetConfig.deadlineMs : undefined;
      budgetHook = budgetConfig
        ? createMemberStopHook(member.model, budgetConfig, accumulator, budgetMutex, deadlineAt)
        : undefined;
      const hook = budgetHook;
      const subConfig: AgentLoopConfig = {
        model: member.model,
        convertToLlm,
        // K3 策略继承：把 supervisor 的 beforeToolCall 原样透传给子代理。
        // 子代理的 `context.tools` 是它自己的工具子集，权限闸门从该上下文解析 effect，
        // 因此 write/edit/bash 在子代理内部同样会走 ask/deny，并写入共享 PolicyState。
        // 仅在调用方提供时注入，保持「无权限装配」场景（如纯离线测试）零多余钩子。
        ...(options.beforeToolCall ? { beforeToolCall: options.beforeToolCall } : {}),
        // A-2 修复：不再向 subConfig 注入 deadlineMs——agent-loop 从不消费它，
        // 真正生效的是护栏闭包内的墙钟自查（见 ）。
        ...(hook
          ? {
              shouldStopAfterTurn: async (ctx: ShouldStopAfterTurnContext): Promise<boolean> => {
                // 钩子内部已用 mutex 串行化读-判-写；此处仅捕获是否被护栏停止以标记 budgetExceeded。
                const stop = await hook.shouldStopAfterTurn(ctx);
                if (stop) stoppedByBudget = true;
                return stop;
              },
            }
          : {}),
      };

      const stream = agentLoop([taskMessage], subContext, subConfig, signal, streamFn);

      // 消费事件流：捕获 agent_end.error（错误即数据，不抛），其余仅投影。
      let endError: { code: string; message: string } | undefined;
      for await (const event of stream) {
        if (event.type === "agent_end" && event.error) {
          endError = { code: event.error.code, message: event.error.message };
        }
      }
      const messages = await stream.result();
      const { summary, artifacts } = extractSummary(messages);

      // 用量回收：per-member 用量取自护栏句柄；未配置预算则留空（不渲染冗余行）。
      usage = budgetHook ? { ...budgetHook.usage } : undefined;

      // 失败判定：agent_end.error（兜底收尾）或最终 assistant 的 stopReason 为 error/aborted。
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      const aborted =
        endError || (lastAssistant && (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted"));
      if (aborted) {
        const error =
          endError ??
          (lastAssistant
            ? { code: "subagent_failed", message: `stopReason: ${lastAssistant.stopReason}` }
            : { code: "subagent_failed", message: "unknown" });
        member.status = "failed";
        member.summary = summary;
        member.artifacts = artifacts;
        member.usage = usage;
        recordEvent({ type: "member_failed", timestamp: Date.now(), member: name, detail: error.message });
        return { member: name, status: "failed", summary, artifacts, error, usage, model: member.model.id };
      }

      // 成本护栏触发（shouldStopAfterTurn 返回 true）也会以 agent_end 干净收尾：
      // 此时无 endError，走「done」分支，但标记 budgetExceeded 让上层可观测。
      const budgetExceeded = budgetHook ? stoppedByBudget : false;
      member.status = "done";
      member.summary = summary;
      member.artifacts = artifacts;
      member.usage = usage;
      if (budgetExceeded) member.budgetExceeded = true;
      recordEvent({ type: "member_completed", timestamp: Date.now(), member: name });
      return { member: name, status: "done", summary, artifacts, usage, budgetExceeded, model: member.model.id };
    } catch (caught) {
      // 兜底失败隔离：任何意外异常都收敛为结构化错误，主循环不崩溃。
      const error = { code: "subagent_failed", message: caught instanceof Error ? caught.message : String(caught) };
      member.status = "failed";
      member.summary = member.summary ?? "";
      // 用量仅在配置了护栏时回写（A-4）；未配置则保持 undefined，不渲染冗余行。
      member.usage = budgetHook ? { ...budgetHook.usage } : undefined;
      recordEvent({ type: "member_failed", timestamp: Date.now(), member: name, detail: error.message });
      return {
        member: name,
        status: "failed",
        summary: "",
        artifacts: [],
        error,
        usage: budgetHook ? { ...budgetHook.usage } : undefined,
        model: member.model.id,
      };
    } finally {
      semaphore.release();
      // 在飞计数归位（异常路径也执行）；并把本次观测到的并发峰值写回 team 状态，供投影读取。
      runningMemberCount = Math.max(0, runningMemberCount - 1);
      state.peakConcurrency = peakConcurrency;
      // 回填成员墙钟时延（SLO 证据）：无论成功/失败/预算停止，真实运行过的成员都有时长。
      member.durationMs = Date.now() - memberStartMs;
    }
  }

  /** 只读快照：浅拷贝成员与队列，避免调用方直接 mutate 实时状态。 */
  function getTeamState(): TeamState {
    const members = new Map<string, TeamMember>();
    for (const [k, v] of state.members) members.set(k, { ...v });
    const inboundQueues = new Map<string, TeamMessage[]>();
    for (const [k, v] of state.inboundQueues) inboundQueues.set(k, v.slice());
    // peakConcurrency 仅当确实观测到并发（>0）才带入快照，避免把「未并发」误报为容量 0。
    const snapshot: TeamState = { members, inboundQueues, events: state.events.slice() };
    if (state.peakConcurrency !== undefined && state.peakConcurrency > 0) {
      snapshot.peakConcurrency = state.peakConcurrency;
    }
    return snapshot;
  }

  function hasMember(name: string): boolean {
    return state.members.has(name);
  }

  const tools: AgentTool[] = [
    createTeamCreateTool({ createMember, runMember }),
    createSendMessageTool({ createMember, runMember }),
  ];

  /**
   * 扇出 helper：并发向多个成员派发同一任务，受 maxConcurrentMembers 信号量限制
   * （pi 风格 worker 池：N 个 worker 从自增 nextIndex 取任务并发 await）。
   *
   * @param names 成员名称列表。
   * @param content 委派给各成员的任务。
   * @param limit 并发上限；缺省用 controller 的 maxConcurrentMembers。
   * @returns 与 names 顺序一致的结果数组。
   */
  async function runMembers(names: string[], content: string, limit?: number): Promise<SubagentResult[]> {
    const concurrency = limit ?? options.maxConcurrentMembers ?? 1;
    return mapWithConcurrencyLimit(names, concurrency, (n) => runMember(n, content));
  }

  return {
    tools,
    getTeamState,
    // 0 参便捷方法：对当前快照调用模块级 getTeamView(state) 渲染视图。
    getTeamView: () => getTeamView(getTeamState()),
    hasMember,
    getBudgetAccumulator: () => accumulator,
    createMember,
    runMember,
    runMembers,
  };
}

/**
 * 把 TeamState 渲染成人类可读状态字符串（Agent View / 看板）。纯函数，便于测试与复用。
 *
 * @param state team 状态快照。
 * @returns 多行状态文本。
 */
export function getTeamView(state: TeamState): string {
  const lines: string[] = [`Team: ${state.members.size} members`];
  let teamTokens = 0;
  let teamCost = 0;
  for (const [name, member] of state.members) {
    const tools = member.allowedTools ? member.allowedTools.join(",") || "(无)" : "(全量)";
    lines.push(`- ${name} [${member.status}] ${member.role} | model=${member.model.id} tools=${tools}`);
    // 成本可观测：仅当确有用量（tokens 或 cost 任一 > 0）才显示该行；
    // 未配置预算或零用量的成员不再渲染"用量: 0 tokens / $0.000000"（A-4 修复）。
    if (member.usage && (member.usage.tokens > 0 || member.usage.cost > 0)) {
      teamTokens += member.usage.tokens;
      teamCost += member.usage.cost;
      const flag = member.budgetExceeded ? " ⚠预算超限" : "";
      lines.push(`   用量: ${member.usage.tokens} tokens / $${member.usage.cost.toFixed(6)}${flag}`);
    }
    if (member.summary) lines.push(`   摘要: ${member.summary.slice(0, 80)}`);
  }
  // 团队总成本行：聚合各成员用量，对应「多代理 15× token 必须收口」的演示证据。
  if (teamTokens > 0 || teamCost > 0) {
    lines.push(`团队总计: ${teamTokens} tokens / $${teamCost.toFixed(6)}`);
  }
  return lines.join("\n");
}

