/**
 * Run 管理器：把 `agentLoop` 的事件流翻译成 run-v2 线协议（持久化 + SSE 广播）。
 *
 * 关键设计（03 §6.1 / §6.2）：
 * - sequence 由内存计数器对**所有**帧单调分配（含不落盘的 `message_update`），
 *   JSONL 只存关键事件；`lastEventSequence` 只推进到已落盘序号。
 * - 先落盘、后广播：SSE 客户端看到的事件一定能从 JSONL replay 出来。
 * - 取消终态（Gate 3）：abort 后 `agentLoop` 会发一个**无 error 的 agent_end**，
 *   客户端会据此判定 completed；因此这里在 abort 时丢弃该 agent_end，
 *   改为发送 `run_status{status:"interrupted"}`。
 */
import { randomUUID } from "node:crypto";
import {
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  agentLoop,
  defaultConvertToLlm,
  resolveCompactionSettings
} from "@aiagent/agent";
import { streamSimple } from "@aiagent/ai";
import type { Model } from "@aiagent/ai";
import type {
  LlmCallRecordDto,
  LlmWindowDto,
  RunEventTypeDto,
  RunMetaDtoV2,
  RunSnapshotDtoV2,
  RunStatusDtoV2,
  RunStreamEventDtoV2
} from "@aiagent/types";
import type {
  AsyncConfirmGate,
  ConfirmationDecision,
  ConfirmationRequestedPayload,
  ResolveConfirmationResult
} from "./confirm-gate.js";
import { RunConfirmations } from "./run/confirmations.js";
import type { WorkspaceRegistry, WorkspaceContextCache, WorkspaceMcpRegistry } from "./workspace/index.js";
import {
  compactConversationHistory,
  createServeSummarizer,
  dropBeforeLastCompaction,
  extractCompactionSummary,
} from "./run/compaction.js";
import { toContextEventPayload } from "./run/context-event.js";
import { TeamRunBinding, createSupervisorTracedStreamFn, type TeamRunner } from "./run/team-runner.js";
import { createTitleGenerator } from "./run/title.js";
import { persistRunMessage } from "./run/persist.js";
import { RunCostTracker } from "./run/cost-summary.js";
import { createSubscriptionRegistry, type Subscription, type SubscribeOptions } from "./events/subscription.js";
import { subscribeWithReplay } from "./events/replay.js";

import { isPersistableRunEvent } from "./store/index.js";
import { cloneSnapshot, delay, toRunErrorPayload } from "./run/helpers.js";
import { linearMessageToAgentMessage } from "./run/message-mapping.js";
import { scheduleReclaim, terminalSnapshot } from "./run/terminal.js";
import type {
  ActiveRun,
  CreateRunInput,
  CreateRunResult,
  ResolvedWorkspaceContext,
  RunErrorPayload,
  RunManagerOptions
} from "./run/types.js";
import type { RunConfigSnapshot } from "./model/config.js";

export type {
  CreateRunInput,
  CreateRunResult,
  ResolvedWorkspaceContext,
  RunManagerOptions
} from "./run/types.js";
export { isTerminalStatus } from "./run/helpers.js";
export { linearMessageToAgentMessage } from "./run/message-mapping.js";
export type { Subscription, SubscribeOptions } from "./events/subscription.js";

/** Run 管理器。 */
export class RunManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly model: Model<"openai-completions">;
  private readonly confirmGate: AsyncConfirmGate | undefined;
  private readonly confirmations: RunConfirmations;
  /** 会话级订阅（--web 终端共享同一会话事件流）：conversationId → listener 集合。 */
  private readonly conversationSubscribers = new Map<string, Set<(event: RunStreamEventDtoV2) => void>>();
  /** 会话级「只收新 run」订阅：订阅时间点之后创建的 run 才投递（不回放历史）。 */
  private readonly futureConversationSubscribers = new Map<string, Set<(event: RunStreamEventDtoV2) => void>>();
  /** run 前压缩的摘要器；懒构造，测试可通过 options.summarizer 注入。 */
  private summarizer: RunManagerOptions["summarizer"];
  /** 语义标题生成器；懒构造，测试可通过 options.titleGenerator 注入。 */
  private titleGenerator: RunManagerOptions["titleGenerator"];
  /**
   * 会话级累计成本（美元）：按 conversationId 维度累加每轮 LLM 调用的 usage.cost.total，
   * 供 `--max-cost` 预算在 run 前 / 每轮后检查。serve 单进程单实例，内存累加即可；
   * 进程重启后从会话消息无法精确回填，但 budget 是「软护栏」，重启用 0 不阻断 run。
   */
  private readonly conversationCost = new Map<string, number>();
  /**
   * 成本观测协作者（G-T1）：按 run 建立聚合、逐事件累加、终态投影 `cost_summary`。
   * 独立成对象以把「成本产线」与 run 状态机解耦（run-manager 已接近单文件行数上限）。
   */
  private readonly costTracker: RunCostTracker;
  /** Team 开关的 run 级装配（关时零开销：begin 直接返回 undefined）。 */
  private readonly teamBinding: TeamRunBinding;
  /** 工作区授权注册表（spec §6）；缺省 undefined 时资源操作不反查授权（测试 / 无工作区模式）。 */
  private readonly workspaceRegistry?: WorkspaceRegistry;
  /** 按 canonical 根缓存的系统提示词与工具集；run 创建时按会话 workspace 解析上下文。 */
  private readonly workspaceContextCache?: WorkspaceContextCache;
  /** 按 workspace 隔离的 MCP 会话生命周期容器。 */
  private readonly workspaceMcpRegistry?: WorkspaceMcpRegistry;
  /** 资源操作前的归属授权校验（fail-closed）；缺省为空操作。 */
  private readonly assertAuthorized: (id: string) => Promise<void>;
  /** runtime 级订阅登记表：原子 startRun 与显式订阅共用。 */
  private readonly runtimeSubscriptions = createSubscriptionRegistry();
  /**
   * @param options 模型、工具、store、确认闸门与可选 streamFn（测试注入）。
   */
  constructor(private readonly options: RunManagerOptions) {
    this.model = options.model;
    this.teamBinding = new TeamRunBinding({
      ...(options.team ? { team: true } : {}),
      ...(options.teamSession ? { session: options.teamSession } : {}),
      base: options.streamFn ?? streamSimple,
      window: {
        contextWindow: options.model.contextWindow,
        maxTokens: options.model.maxTokens,
        reserveTokens: resolveCompactionSettings(options.model.contextWindow).reserveTokens
      }
    });
    // serve 侧 controller 是团队状态的**首选**来源；组合根注入的 getTeamState 保留为
    // fallback（03 已接通的参数链不回退，docs/v2.0/04 §2.2）。
    // spec §7.4：TeamController 按 conversationId 持有，成本投影必须回到「本 run 所属会话」
    // 的 controller（按 conversationId 解析），而非全局 last-active。因此 costTracker 注入
    // 的是「按 conversationId 取读取器」的工厂；组合根注入的 getTeamState 保留为兜底。
    this.costTracker = new RunCostTracker(
      options.model.id,
      options.getTeamState
        ? () => options.getTeamState
        : (conversationId: string) =>
            options.team ? this.teamBinding.getTeamStateFor(conversationId) : undefined
    );
    this.confirmGate = options.confirmGate;
    this.summarizer = options.summarizer;
    this.titleGenerator = options.titleGenerator;
    this.confirmations = new RunConfirmations(
      options.confirmGate,
      (runId) => this.active.get(runId),
      (run, type, payload) => this.emitFrame(run, type, payload)
    );
    this.workspaceRegistry = options.workspaceRegistry;
    this.workspaceContextCache = options.workspaceContextCache;
    this.workspaceMcpRegistry = options.workspaceMcpRegistry;
    this.assertAuthorized = options.assertAuthorized ?? (async () => undefined);
  }

  /**
   * 把「等待用户确认」落盘为 `confirmation_requested` 并广播。
   *
   * @param runId run id。
   * @param payload 工具调用摘要。
   */
  async emitConfirmationRequested(
    runId: string,
    payload: ConfirmationRequestedPayload
  ): Promise<void> {
    await this.confirmations.emitRequested(runId, payload);
  }

  /**
   * 提交用户决定（供确认路由 / 进程内入口调用）。
   *
   * @param runId run id。
   * @param toolCallId 工具调用 id。
   * @param decision allow / deny。
   * @returns 结构化结果。
   */
  async resolveConfirmation(
    runId: string,
    toolCallId: string,
    decision: ConfirmationDecision,
    options?: { assertAuthorized?: (id: string) => Promise<void> }
  ): Promise<ResolveConfirmationResult> {
    // 资源操作前反查工作区授权（fail-closed）；未授权 / 已撤销的工作区一律拒绝。
    const authorize = options?.assertAuthorized ?? this.assertAuthorized;
    await authorize(runId);
    return this.confirmations.resolve(runId, toolCallId, decision);
  }

  /**
   * 是否处于 `--auto-approve` 模式。
   *
   * @returns 自动批准返回 true。
   */
  isAutoApprove(): boolean {
    return this.confirmations.isAutoApprove();
  }

  /**
   * 等待 run 进入终态（调度器释放会话链的依据）。
   *
   * 只等待终态信号，不等待终态后的广播/落盘清理：下一个同会话 run 可以在前一个 run
   * 已确定结束后启动，但不会与它的执行重叠。
   *
   * @param runId run id。
   * @returns 终态达成。
   */
  async waitTerminal(runId: string): Promise<void> {
    const run = this.active.get(runId);
    if (!run || run.terminal) return;
    await run.terminalDone;
  }

  /**
   * 累加某会话的累计成本（美元）。
   *
   * @param conversationId 会话 id。
   * @param cost 本次 LLM 调用的成本（来自 `llm_call` usage）。
   */
  private addConversationCost(conversationId: string, cost: number): void {
    const current = this.conversationCost.get(conversationId) ?? 0;
    this.conversationCost.set(conversationId, current + cost);
  }

  /**
   * 判断某会话累计成本是否已达预算。
   *
   * @param conversationId 会话 id。
   * @param maxCost 成本上限（美元）。
   * @returns 已超或达到上限返回 true。
   */
  private reachedConversationCost(conversationId: string, maxCost: number): boolean {
    return (this.conversationCost.get(conversationId) ?? 0) >= maxCost;
  }

  /**
   * 某 run 当前待确认数量。
   *
   * @param runId run id。
   * @returns 待确认数量。
   */
  pendingConfirmationCount(runId: string): number {
    return this.confirmations.pendingCount(runId);
  }

  /**
   * 为一段文本生成语义会话标题（BUG-002）。
   *
   * 标题生成是会话体验增强而非功能前提：LLM 调用失败（异常 / 空返回 / error / aborted /
   * 超时）一律返回 undefined，由调用方降级为 `deriveTitle` 截断标题，绝不阻断消息发送。
   * 生成器懒构造一次复用同一 model + apiKey + streamFn，与 compaction 摘要器共享凭据。
   *
   * @param text 首条用户消息。
   * @param signal 可选取消信号（测试 / 关闭时传入）。
   * @returns 语义标题；失败时 undefined。
   */
  async generateTitle(text: string, signal?: AbortSignal): Promise<string | undefined> {
    const generator =
      this.titleGenerator ??
      (this.titleGenerator = createTitleGenerator({
        model: this.model,
        apiKey: this.options.apiKey,
        ...(this.options.streamFn ? { streamFn: this.options.streamFn } : {})
      }));
    return generator(text, signal);
  }

  /**
   * 创建并启动一次 run：先载入历史并做 run 前压缩（L3-3），落用户消息与 run_meta，再异步执行 loop。
   *
   * 压缩发生在追加本轮 prompt 之前：超窗时摘要前缀并持久化一条
   * `messageType:"compaction"` 的线性消息，本次 run 使用压缩后的 history。
   *
   * @param input 请求输入（conversation 必须已存在）。
   * @returns 202 所需的 accepted DTO 与初始快照。
   */
  async createRun(input: CreateRunInput): Promise<CreateRunResult> {
    const message = input.message.trim();
    const runId = randomUUID();
    const createdAt = new Date().toISOString();
    const config = input.config;
    const model = config?.model ?? this.model;
    const apiKey = config?.apiKey ?? this.options.apiKey;

    // 先取历史再追加本轮 prompt：agentLoop 会自行追加 prompt，避免重复。
    const storedHistory = await this.options.messageStore.list(input.conversationId);
    const mapped = storedHistory
      .map((dto) => linearMessageToAgentMessage(dto, model))
      .filter((message): message is AgentMessage => message !== null);
    const { messages: compactedHistory, compaction } = await this.compactHistoryForRun(
      input.conversationId,
      mapped,
      config
    );
    // 压缩审计写 stderr：serve 无 CLI 落盘日志，这是「run 前发生了压缩」的唯一日志观测点。
    if (compaction.compacted) {
      process.stderr.write(
        `[ohna] 会话 ${input.conversationId} 载入历史超窗，已压缩：约 ${compaction.tokensBefore} → ${compaction.tokensAfter} token\n`
      );
    }
    const history = compactedHistory;

    const userMessage = await this.options.messageStore.append(input.conversationId, {
      role: "user",
      content: message,
      runId
    });
    await this.options.sessionStore.touch(input.conversationId);

    await this.options.runStore.create({
      runId,
      requestId: input.requestId,
      conversationId: input.conversationId,
      modelId: model.id,
      mode: input.mode,
      source: input.source,
      userMessageId: userMessage.messageId,
      createdAt
    });

    const snapshot: RunSnapshotDtoV2 = {
      runId,
      requestId: input.requestId,
      conversationId: input.conversationId,
      userMessageId: userMessage.messageId,
      modelId: model.id,
      mode: input.mode,
      source: input.source,
      status: "running",
      lastEventSequence: 0,
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt
    };

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let resolveTerminalDone!: () => void;
    const terminalDone = new Promise<void>((resolve) => {
      resolveTerminalDone = resolve;
    });

    const run: ActiveRun = {
      snapshot,
      requestId: input.requestId,
      controller: new AbortController(),
      done,
      terminalDone,
      resolveTerminalDone,
      sequence: 0,
      lastPersistedSequence: 0,
      subscribers: new Set(),
      terminal: false,
      skipFirstUserMessage: true,
      ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
      ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
      ...(input.maxCost !== undefined ? { maxCost: input.maxCost } : {}),
      ...(config ? { config } : {})
    };
    this.active.set(runId, run);
    // 原子创建：run 处于 active 后先登记缓冲 listener，再发射早期事件。
    // 若先发 user_message，订阅注册前的时间窗内事件只能靠后续 replay 补齐，
    // 违反 spec §5.3 的「create + first subscribe 同一操作」约束。
    const atomicBuffer: RunStreamEventDtoV2[] = [];
    const atomicSubscription = this.runtimeSubscriptions.register((event) => {
      atomicBuffer.push(event);
    });
    // 记录订阅 id，终态时由 detachAtomicSubscription 释放（见 finishStatus / forceTerminal）。
    run.atomicSubscriptionId = atomicSubscription.subscriptionId;
    run.subscribers.add((event) => {
      this.runtimeSubscriptions.get(atomicSubscription.subscriptionId)?.(event);
    });

    // G-T1：成本聚合状态必须在**任何可能收尾的入口**之前建立。cancel / shutdown 可以在
    // execute 尚未启动（run 前压缩、workspace 解析期间）就调 finishStatus；若把 begin 放在
    // execute 入口，这些 run 会静默缺失 cost_summary，被下游误读为「零成本」。
    // 工具表此时还未知（execute 会按会话 workspace 重新解析），故先在 execute 内补种 byTool。
    this.costTracker.begin(runId, input.conversationId, model.id);

    // 会话级订阅（--web 共享事件流）：新 run 必须先接到其会话的订阅者上，
    // 再广播 user_message（否则订阅者会漏掉 sequence 最早的 user_message 帧）。
    const conversationListeners = this.conversationSubscribers.get(input.conversationId);
    if (conversationListeners) {
      for (const listener of conversationListeners) run.subscribers.add(listener);
    }

    // 会话级「只收新 run」订阅（subscribeConversationWithReplay）：本 run 在订阅之后才创建，
    // 因此直接接入其事件流（不回放历史，符合 spec §5.4）。
    const futureListeners = this.futureConversationSubscribers.get(input.conversationId);
    if (futureListeners) {
      for (const listener of futureListeners) run.subscribers.add(listener);
    }

    // U1：用户消息落盘后、loop 启动前广播为总线一等事件，使 Web 发起的轮次在终端 / 其它
    // Web 端有「用户气泡的权威来源」（sequence 早于 agent_start）。source 区分来源端：
    // 终端发起记 "cli"、浏览器 composer 发起记 "web"（协议层不绑定 UI 组件名）。
    await this.emitFrame(run, "user_message", {
      messageId: userMessage.messageId,
      content: message,
      runId,
      source: input.source === "report_button" || input.source === "composer" ? "web" : "cli"
    });

    // context_event（docs/v2.0/04 §3.2，缺口 3）：只在压缩**真的发生**时发射。
    //
    // 为什么在此处（而非压缩刚结束处）：run 帧需要一个已建立的 ActiveRun 来分配 sequence
    // 并落盘。`runStore.create` 在其后、`emitFrame(user_message)` 之前完成，因此这里
    // ① run 已落盘（replay 有主）、② sequence 可分配且已从 1 起连续、③ 事件早于 agent_start
    // （消费侧读到「本轮上下文被换过」再看到首次 LLM 调用，语义顺序正确）。
    // 未压缩（compacted=false）不发射——估算过了但没超窗不是上下文结构变化。
    const contextEvent = toContextEventPayload(compaction);
    if (contextEvent) await this.emitFrame(run, "context_event", contextEvent);

    // BUG-002 方案 2：按会话持久化的 workspaceRoot 动态装配上下文（编码工具 + 系统提示词）。
    // 解析失败回退 undefined（execute 内退回构造时的单工作区语义），不阻断本次 run。
    if (config?.workspace && this.workspaceRegistry) {
      this.workspaceRegistry.bindRun(runId, input.conversationId, config.workspace.workspaceId);
    }
    const workspace = config?.workspace ?? await this.resolveWorkspaceContext(input.conversationId, input.workspaceId);

    // 兜底捕获 execute 逃逸的异常（通常是落盘/广播二次失败，如磁盘写满）：
    // 必须转成结构化错误并强制内存终态，避免 run 永远 running + unhandled rejection。
    void this.execute(run, history, message, workspace)
      .catch(async (error: unknown) => {
        if (run.terminal) return;
        const payload = toRunErrorPayload(error, run.requestId);
        try {
          await this.emitFrame(run, "run_error", { error: payload });
          await this.finishStatus(run, "failed", payload);
        } catch {
          // 二次失败（run_error / run_status 也写不进去）时不再依赖磁盘，直接推进内存终态。
          await this.forceTerminal(run, "failed", payload);
        }
      })
      .finally(() => {
        resolveDone();
      });

    return {
      accepted: {
        runId,
        requestId: input.requestId,
        conversationId: input.conversationId,
        modelId: snapshot.modelId,
        status: "running",
        eventsUrl: `/api/runs/${encodeURIComponent(runId)}/events`,
        snapshotUrl: `/api/runs/${encodeURIComponent(runId)}`
      },
      snapshot: cloneSnapshot(snapshot),
      subscriptionId: atomicSubscription.subscriptionId,
      initialEvents: atomicBuffer
    };
  }

  /**
   * 按会话列出 run 摘要（观测台 runs 侧栏）。
   *
   * @param conversationId 会话 id。
   * @returns run 摘要列表（创建时间倒序）；状态优先取内存态活跃 run。
   */
  async listRunsByConversation(conversationId: string): Promise<RunMetaDtoV2[]> {
    // 资源操作前反查工作区授权（fail-closed）。
    await this.assertAuthorized(conversationId);
    return await this.options.runStore.listRunsByConversation(
      conversationId,
      (runId) => this.active.get(runId)?.snapshot.status
    );
  }

  /**
   * 读取快照：内存中的活跃 run 优先，否则从 JSONL 重建。
   *
   * @param runId run id。
   * @returns 快照或 null。
   */
  async getSnapshot(
    runId: string,
    options?: { assertAuthorized?: (id: string) => Promise<void> }
  ): Promise<RunSnapshotDtoV2 | null> {
    // 资源操作前反查工作区授权（fail-closed）。
    const authorize = options?.assertAuthorized ?? this.assertAuthorized;
    await authorize(runId);
    const run = this.active.get(runId);
    if (run) return cloneSnapshot(run.snapshot);
    return await this.options.runStore.getRun(runId);
  }

  /**
   * 订阅活跃 run 的实时事件；run 不在内存时返回 noop（调用方应走 replay）。
   *
   * @param runId run id。
   * @param listener 事件回调（同步执行，不得抛错）。
   * @returns 退订函数。
   */
  subscribe(runId: string, listener: (event: RunStreamEventDtoV2) => void): () => void {
    const run = this.active.get(runId);
    if (!run) return () => undefined;
    run.subscribers.add(listener);
    return () => {
      run.subscribers.delete(listener);
    };
  }

  /**
   * 会话级订阅（D8 共享事件流）：订阅某会话下当前与后续所有 run 的事件。
   *
   * `ohna --web` 的终端用它与浏览器看同一会话；其它会话的 run 不会进入终端。
   * listener 同步执行、不得抛错（与 subscribe 一致，单客户端失败不影响 run）。
   *
   * @param conversationId 会话 id。
   * @param listener 事件回调。
   * @returns 退订函数。
   */
  subscribeConversation(
    conversationId: string,
    listener: (event: RunStreamEventDtoV2) => void,
    liveOnly?: boolean
  ): () => void {
    let listeners = this.conversationSubscribers.get(conversationId);
    if (!listeners) {
      listeners = new Set();
      this.conversationSubscribers.set(conversationId, listeners);
    }
    listeners.add(listener);
    // 已在途的 run 也要接上（例如终端重启后 attach 到进行中的 run）。
    for (const run of this.active.values()) {
      if (run.snapshot.conversationId === conversationId) run.subscribers.add(listener);
    }
    // liveOnly 仅影响是否回放历史；会话订阅本身即 live（无独立 replay 通道），此处忽略该位。
    void liveOnly;
    return () => {
      listeners.delete(listener);
      for (const run of this.active.values()) {
        if (run.snapshot.conversationId === conversationId) run.subscribers.delete(listener);
      }
    };
  }

  /**
   * runtime 级 run 订阅：先登记 live listener，再回放已落盘事件并合并。
   *
   * 与 `subscribe` 的分工：`subscribe` 只挂活跃 run（Task 11 过渡用）；本方法把
   * SSE 层的 replay/live 语义移入 runtime，终态后仍可读取历史。
   *
   * @param runId run id。
   * @param options 订阅选项（afterSequence + onEvent）。
   * @returns 订阅句柄。
   */
  async subscribeWithReplay(runId: string, options: SubscribeOptions): Promise<Subscription> {
    // 先同步挂接 live listener（registerRuntimeSubscription 的 attach 回调同步执行），
    // 保证 subscribe 调用返回前 listener 已登记到 run/会话订阅集——否则与 createRun 的
    // 「先挂会话订阅者、再广播 user_message」存在竞态（订阅晚于 user_message 首帧）。
    // 授权在挂接后异步校验；未授权时 run 不会创建，已挂接的 listener 不会收到事件。
    const subscription = this.registerRuntimeSubscription((listener) => {
      const unsubscribe = subscribeWithReplay({
        afterSequence: options.afterSequence,
        ...(options.liveOnly ? { liveOnly: true } : {}),
        readEvents: () => this.options.runStore.listEvents(runId),
        attachLive: (liveListener) => this.subscribe(runId, liveListener),
        onEvent: (event) => options.onEvent(event)
      });
      return { detach: unsubscribe, listener };
    });
    await this.assertAuthorized(runId);
    return subscription;
  }

  /**
   * runtime 级会话订阅：只接收新 run，不隐式回放历史 run。
   *
   * 与公开 `subscribeConversation`（会 attach 到在途 run）不同，本方法只监听订阅之后
   * 新创建的 run——历史 run 的 Trace 来自 run 列表 + 单 run replay，不在此隐式回放；
   * 既满足 spec §5.4「会话订阅只收新 run」，又不破坏 Task 11 过渡所需的公开方法。
   *
   * @param conversationId 会话 id。
   * @param options 订阅选项（onEvent 接收新 run 事件；afterSequence 在此语义无效）。
   * @returns 订阅句柄。
   */
  async subscribeConversationWithReplay(
    conversationId: string,
    options: SubscribeOptions
  ): Promise<Subscription> {
    // 先同步挂接：subscribeConversation 同步把 listener 登记进 conversationSubscribers，
    // 与 subscribeWithReplay 同口径，避免「先 createRun、后 subscribe」漏掉 user_message 首帧。
    const subscription = this.registerRuntimeSubscription((listener) => {
      // 与公开 subscribeConversation 一致：attach 到在途 run，保证订阅建立时 진행중인 run
      // 的终态事件也能被投递（句柄冒烟测试依赖此行为）。options.afterSequence 在会话维度
      // 无效，由逐 run 的 SSE 重连各自处理。
      // listener 必须直接转发到 options.onEvent：registerRuntimeSubscription 把 runtimeListener
      // 重赋为 attached.listener，若此处返回透传 runtimeListener 的 wrapper 会形成自引用递归，
      // 事件永远到达不了真实回调（句柄冒烟测试依赖此投递路径）。
      const detach = this.subscribeConversation(
        conversationId,
        (event) => options.onEvent(event),
        options.liveOnly === true
      );
      return { detach, listener: (event) => options.onEvent(event) };
    });
    await this.assertAuthorized(conversationId);
    return subscription;
  }

  /**
   * 会话级「只收新 run」订阅：在建立订阅的时间点之后创建的 run 才会投递事件，
   * 已存在的在途 run 与历史 run 一律不投递（历史 Trace 由单 run replay 负责）。
   * 公开 `subscribeConversation` 仍保留 attach 在途 run 的行为给 Task 11 过渡使用。
   *
   * @param conversationId 会话 id。
   * @param listener 事件回调。
   * @returns 退订函数。
   */
  private subscribeFutureConversation(
    conversationId: string,
    listener: (event: RunStreamEventDtoV2) => void
  ): () => void {
    const listeners = this.futureConversationSubscribers.get(conversationId) ?? new Set();
    this.futureConversationSubscribers.set(conversationId, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.futureConversationSubscribers.delete(conversationId);
    };
  }

  /**
   * 按订阅 id 取得原子 startRun 建立的 live listener。
   *
   * @param subscriptionId 订阅 id。
   * @returns listener；订阅不存在或已退订返回 undefined。
   */
  getRuntimeSubscriptionListener(
    subscriptionId: string
  ): ((event: RunStreamEventDtoV2) => void) | undefined {
    return this.runtimeSubscriptions.get(subscriptionId);
  }

  /**
   * 关闭全部 runtime 订阅（run 关闭链路使用）。
   */
  closeRuntimeSubscriptions(): void {
    this.runtimeSubscriptions.close();
  }

  /**
   * 释放原子 startRun 建立的缓冲订阅。
   *
   * createRun 返回的 subscriptionId 仅用于「无事件窗口」地把 initialEvents 交给调用方；
   * 调用方后续通过 subscribeRun 自行续接实时事件。run 终态后该缓冲订阅已无意义，
   * 必须释放其 listener，避免 run 离开 active 后仍被持续投递（内存泄漏 + 重复消费）。
   *
   * @param runId 已终态的 run id。
   */
  private detachAtomicSubscription(runId: string): void {
    const run = this.active.get(runId);
    const subscriptionId = run?.atomicSubscriptionId;
    if (!subscriptionId) return;
    const listener = this.runtimeSubscriptions.get(subscriptionId);
    if (listener) {
      // registry.register 已生成 Subscription.unsubscribe 闭包，这里用其身份直接删除。
      this.runtimeSubscriptions.remove(subscriptionId);
    }
  }

  /**
   * 登记 runtime 订阅并生成 id。
   *
   * @param attach 与 RunManager live 通道的挂接函数。
   * @returns 订阅句柄。
   */
  private registerRuntimeSubscription(
    attach: (
      listener: (event: RunStreamEventDtoV2) => void
    ) => { detach: () => void; listener: (event: RunStreamEventDtoV2) => void }
  ): Subscription {
    let runtimeListener: (event: RunStreamEventDtoV2) => void = () => undefined;
    const subscription = this.runtimeSubscriptions.register((event) => runtimeListener(event));
    const attached = attach((event) => runtimeListener(event));
    runtimeListener = attached.listener;
    const unsubscribe = subscription.unsubscribe.bind(subscription);
    subscription.unsubscribe = () => {
      unsubscribe();
      attached.detach();
    };
    return subscription;
  }

  /**
   * run 前的会话级压缩编排（L3-3）：append-only 载入语义 → 双基准估算 → 摘要 → 硬收敛 → 持久化摘要。
   *
   * 摘要持久化为一条 `messageType:"compaction"` 的线性消息（role=user，content=摘要文本），
   * 后续 run 载入时还原为 CompactionMessage 并由 dropBeforeLastCompaction 实现「替换前缀」。
   * 硬收敛只作用于本次 run 的内存历史（磁盘消息保持线性完整，见 run/compaction.ts 的取舍说明）。
   *
   * @param conversationId 会话 id。
   * @param messages 载入映射后的历史。
   * @returns 本次 run 使用的历史与压缩审计信息。
   */
  private async compactHistoryForRun(
    conversationId: string,
    messages: AgentMessage[],
    config?: RunConfigSnapshot
  ): Promise<{
    messages: AgentMessage[];
    compaction: {
      compacted: boolean;
      tokensBefore: number;
      tokensAfter: number;
      retainedMessages: number;
      summary?: string;
    };
  }> {
    // 压缩摘要请求发生在 runId 分配前、不挂 trace（见计划 §8-7 开放项）。
    const summarizer = this.summarizer ?? createServeSummarizer({
      model: config?.model ?? this.model,
      apiKey: config?.apiKey ?? this.options.apiKey,
      ...(this.options.streamFn ? { streamFn: this.options.streamFn } : {})
    });
    const result = await compactConversationHistory(messages, {
      model: config?.model ?? this.model,
      summarizer,
      onWarn: (warning) => process.stderr.write(`[ohna] ${warning}\n`)
    });
    if (!result.compacted) {
      return {
        messages: dropBeforeLastCompaction(result.messages),
        compaction: {
          compacted: false,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          retainedMessages: 0
        }
      };
    }
    const summary = extractCompactionSummary(result.messages);
    if (summary) {
      // 摘要持久化：即使本次进程崩溃，下次 run 也能从磁盘还原压缩语义（不重复摘要旧前缀）。
      await this.options.messageStore.append(conversationId, {
        role: "user",
        content: summary.summary,
        messageType: "compaction"
      });
    }
    return {
      messages: result.messages,
      compaction: {
        compacted: true,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        // 「保留轮数」口径 = 压缩后进入本次 run 的历史消息条数（含摘要自身）：
        // 它正是模型这一轮实际看到的前缀长度，比「摘要覆盖了多少条」更贴近消费侧的疑问。
        retainedMessages: result.messages.length,
        ...(summary ? { summary: summary.summary } : {})
      }
    };
  }

  /**
   * 取消 run：abort → 等待 loop 收尾（有超时兜底）→ 追发 interrupted 终态。
   *
   * @param runId run id。
   * @returns 取消后的快照；run 不存在返回 null。
   */
  async cancel(
    runId: string,
    options?: { assertAuthorized?: (id: string) => Promise<void> }
  ): Promise<RunSnapshotDtoV2 | null> {
    // 资源操作前反查工作区授权（fail-closed）。
    const authorize = options?.assertAuthorized ?? this.assertAuthorized;
    await authorize(runId);
    const run = this.active.get(runId);
    if (!run) return await this.options.runStore.getRun(runId);
    if (run.terminal) return cloneSnapshot(run.snapshot);

    // 先释放挂起的确认（deny），否则 loop 会一直等 beforeToolCall，abort 也唤醒不了它。
    this.confirmGate?.cancelRun(runId);
    run.controller.abort();
    // 等待 loop 自行收尾；慢 stream 若忽略 signal，最多等 5s 后强制落 interrupted。
    await Promise.race([run.done, delay(5_000)]);
    if (!run.terminal) {
      await this.finishStatus(run, "interrupted");
    }
    return cloneSnapshot(run.snapshot);
  }

  /**
   * 优雅关闭：中断所有在途 run 并关闭 store 写入队列。
   */
  async shutdown(): Promise<void> {
    const running = [...this.active.values()].filter((run) => !run.terminal);
    await Promise.all(
      running.map(async (run) => {
        this.confirmGate?.cancelRun(run.snapshot.runId);
        run.controller.abort();
        await Promise.race([run.done, delay(5_000)]);
        if (!run.terminal) await this.finishStatus(run, "interrupted");
      })
    );
    await Promise.all([
      this.options.sessionStore.close(),
      this.options.messageStore.close(),
      this.options.runStore.close()
    ]);
  }

  /**
   * 解析本次 run 的会话级工作区上下文（BUG-002 方案 2）。
   *
   * 未注入 resolver 时返回 undefined，表示回退构造时的单工作区语义；
   * resolver 抛错同样回退 undefined，会话元数据读取或提示词装配失败都不能阻断 run。
   *
   * @param conversationId 会话 id。
   * @returns 会话上下文，或 undefined（回退单工作区）。
   */
  /**
   * 解析本次 run 的会话级工作区上下文（spec §6.2）。
   *
   * 优先按 `workspaceId` 从注册表解析（run 创建入参携带，跨工作区会话续写场景），
   * 否则按会话持久化的 workspaceId 反查。解析到的归属会在此处把 run 绑定到工作区，
   * 使后续 getSnapshot / cancel / resolveConfirmation 能凭 runId 反查授权。
   * 注册表 / 上下文缓存缺位时返回 undefined，回退构造时的单工作区语义，不阻断 run。
   *
   * @param conversationId 会话 id。
   * @param workspaceId 可选的显式工作区 id（run 创建入参携带）。
   * @returns 会话上下文，或 undefined（回退单工作区）。
   */
  private async resolveWorkspaceContext(
    conversationId: string,
    workspaceId?: string
  ): Promise<ResolvedWorkspaceContext | undefined> {
    const registry = this.workspaceRegistry;
    if (!registry) return undefined;
    try {
      // 先按显式 workspaceId 解析，否则按会话反查持久化的 workspaceId。
      const resolved =
        (workspaceId ? await registry.resolveAuthorizedWorkspace(workspaceId) : undefined) ??
        (await registry.resolveConversationWorkspace(conversationId));
      // run 绑定到工作区：后续资源操作可凭 runId 反查授权。
      registry.bindRun(this.activeRunIdFor(conversationId), conversationId, resolved.workspaceId);
      const context = await this.workspaceContextCache?.get(resolved.workspaceRoot);
      return context
        ? { workspaceRoot: context.workspaceRoot, systemPrompt: context.systemPrompt, tools: context.tools }
        : undefined;
    } catch {
      // 解析失败静默回退：跨工作区续写是增强能力，不是 run 的前置条件。
      return undefined;
    }
  }

  /**
   * 取当前活跃 run 的 id（按 conversation 反查），用于把 run 绑定到工作区。
   *
   * @param conversationId 会话 id。
   * @returns 活跃 run id；无活跃 run 时返回空串（绑定会被忽略）。
   */
  private activeRunIdFor(conversationId: string): string {
    for (const run of this.active.values()) {
      if (run.snapshot.conversationId === conversationId) return run.snapshot.runId;
    }
    return "";
  }

  /**
   * 执行 loop 并消费事件流。
   *
   * @param run 活跃 run 状态。
   * @param history 本轮之前的历史消息。
   * @param prompt 本轮用户输入。
   * @param workspace 会话级工作区上下文；undefined 时退回构造时的单工作区语义。
   */
  private async execute(
    run: ActiveRun,
    history: AgentMessage[],
    prompt: string,
    workspace?: ResolvedWorkspaceContext
  ): Promise<void> {
    const context: AgentContext = {
      systemPrompt: workspace?.systemPrompt ?? run.config?.workspace.systemPrompt ?? this.options.systemPrompt,
      messages: history,
      tools: workspace?.tools ?? run.config?.workspace.tools ?? this.options.tools
    };
    const runId = run.snapshot.runId;
    const confirmHook = this.confirmGate?.createHook(runId);
    // Team 接线（docs/v2.0/04 §2.2）：装配细节全部收在 run/team-runner.ts，本处只做 begin/release。
    const teamRunner = this.teamBinding.begin(
      {
        runId,
        conversationId: run.snapshot.conversationId,
        ...(run.config ? { team: run.config.team } : {}),
        ...(confirmHook ? { beforeToolCall: confirmHook } : {}),
        emit: {
          subagent: (event) => {
            void this.emitTypedFrame(run, event.type, event).catch(() => undefined);
          },
          llmCall: (record) => {
            void this.emitLlmCall(run, record).catch(() => undefined);
          }
        }
      },
      context.tools ?? []
    );
    try {
      await this.continueRun(run, context, prompt, confirmHook, teamRunner);
    } finally {
      teamRunner?.release();
    }
  }

  /**
   * `llm_call` 的单一发射点：累计会话成本 + 写 run 事件流（Team 开 / 关两条路径共用）。
   *
   * @param run 活跃 run。
   * @param record 采集层产出的调用记录。
   */
  private async emitLlmCall(run: ActiveRun, record: LlmCallRecordDto): Promise<void> {
    // 累计本会话成本：每轮 LLM 调用的 usage.cost.total 累加到会话级护栏。
    const cost = record.response?.usage?.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      this.addConversationCost(run.snapshot.conversationId, cost);
    }
    await this.emitTypedFrame(run, "llm_call", record);
  }

  /**
   * 执行 loop 并消费事件流（`execute` 的实体：Team 绑定在其前建立、在其后释放）。
   *
   * @param run 活跃 run 状态。
   * @param context 本轮 agent 上下文（工具表已按会话 workspace 解析）。
   * @param prompt 本轮用户输入。
   * @param confirmHook 本 run 的权限闸门钩子。
   * @param teamRunner Team 开关打开时的 run 级句柄；关闭时 undefined。
   */
  private async continueRun(
    run: ActiveRun,
    context: AgentContext,
    prompt: string,
    confirmHook: ReturnType<NonNullable<RunManagerOptions["confirmGate"]>["createHook"]> | undefined,
    teamRunner?: TeamRunner
  ): Promise<void> {
    const runId = run.snapshot.runId;
    // 本 run 实际生效的工具表此时才确定（会话级 workspace 可能与实例主工作区不同），
    // 用它补种 cost_summary 的 byTool 桶；聚合器本身在 createRun 已建立。
    this.costTracker.seedTools(runId, context.tools ?? []);
    // A1：预算护栏（deadline / max-turns），与 CLI 侧 createConfig 语义对齐（内核零改动）。
    const deadlineAt =
      run.deadlineMs !== undefined ? Date.now() + run.deadlineMs : undefined;
    let turns = 0;
    const config: AgentLoopConfig = {
      model: run.config?.model ?? this.model,
      apiKey: run.config?.apiKey ?? this.options.apiKey,
      convertToLlm: defaultConvertToLlm,
      // 写/执行前挂起等待浏览器确认；只读工具在闸门内部直接放行。
      ...(confirmHook ? { beforeToolCall: confirmHook } : {}),
      ...(run.deadlineMs !== undefined ? { deadlineMs: run.deadlineMs } : {}),
      // 运行期预算停止：达到 deadline / max-turns 时干净收尾（run_status=interrupted）。
      // maxCost 在 run 前与每轮后单独检查（见下方循环），这里只处理时间/回合两项。
      // 闭包为 async：决定停止时 await finishStatus(interrupted) 后再返回 true，
      // 确保 run.terminal 已置位、run_status 已广播，后续 agent_end 被 for-await 的
      // `if (!run.terminal)` 守卫跳过，终态稳定为 interrupted 而非 completed。
      shouldStopAfterTurn: async ({ message, toolResults }) => {
        turns += 1;
        // 仅当本轮仍会调用工具时才算「中断」；纯文本收尾属自然结束，不误报。
        const hasToolCall = message.content.some((block) => block.type === "toolCall");
        if (!hasToolCall && toolResults.length === 0) return false;
        if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
          await this.finishStatus(run, "interrupted", {
            code: "deadline_exceeded",
            message: `已达到 run 截止时间（${run.deadlineMs}ms）。`,
            requestId: run.requestId
          });
          return true;
        }
        if (run.maxTurns !== undefined && turns >= run.maxTurns) {
          await this.finishStatus(run, "interrupted", {
            code: "max_turns_exceeded",
            message: `已达到单 run 最大回合数（${run.maxTurns}）。`,
            requestId: run.requestId
          });
          return true;
        }
        return false;
      }
    };
    const userMessage: AgentMessage = { role: "user", content: prompt, timestamp: Date.now() };

    // 每个 run 独立包一层采集：callIndex 是 run 内序号，wrapper 的闭包计数器不能跨 run 共享。
    // Team 打开时用 teamRunner 的 streamFn（与子代理共用同一 wrapper → callIndex 连续，S1）；
    // 关闭时主线程同样带 supervisor 身份，两分支不产生归因口径分裂（04 §1.3）。
    const tracedStreamFn =
      teamRunner?.streamFn ??
      createSupervisorTracedStreamFn(
        this.options.streamFn ?? streamSimple,
        // sink 同步契约：emitFrame 在第一个 await 前分配 sequence，llm_call 不会与后续
        // agent 事件乱序；异步失败一律吞掉（观测不得打断 run）。
        (record) => {
          void this.emitLlmCall(run, record).catch(() => undefined);
        },
        // v2.0（docs/v2.0/04 §1.1 / §3.2）：window 在构造 wrapper 时注入，与 run 前压缩同源。
        run.config?.compaction
          ? {
              contextWindow: run.config.compaction.contextWindow,
              maxTokens: run.config.compaction.maxTokens,
              reserveTokens: run.config.compaction.reserveTokens
            }
          : {
              contextWindow: this.model.contextWindow,
              maxTokens: this.model.maxTokens,
              reserveTokens: resolveCompactionSettings(this.model.contextWindow).reserveTokens
            }
      );

    try {
      // A1：run 前检查成本预算；零预算（maxCost=0）或已超预算则不调用模型，直接终态。
      if (run.maxCost !== undefined && this.reachedConversationCost(run.snapshot.conversationId, run.maxCost)) {
        await this.finishStatus(run, "interrupted", {
          code: "budget_exceeded",
          message: `已达到会话成本上限 $${run.maxCost}。`,
          requestId: run.requestId
        });
        return;
      }

      // Team 打开时工具表已并入 TeamCreate / SendMessage；关闭时原样进入 loop。
      const tools = teamRunner?.tools;
      const loopContext: AgentContext = tools ? { ...context, tools: [...tools] } : context;
      const stream = agentLoop([userMessage], loopContext, config, run.controller.signal, tracedStreamFn);
      for await (const event of stream) {
        // A1：每轮结束后若已超成本预算，干净收尾（单轮内可能超出，故轮后再查一次）。
        if (!run.terminal && run.maxCost !== undefined
          && this.reachedConversationCost(run.snapshot.conversationId, run.maxCost)) {
          await this.finishStatus(run, "interrupted", {
            code: "budget_exceeded",
            message: `已达到会话成本上限 $${run.maxCost}。`,
            requestId: run.requestId
          });
          return;
        }
        // 取消超时兜底可能已把 run 标记终态；剩余事件只消费不落盘/不广播。
        if (!run.terminal) await this.handleAgentEvent(run, event);
      }
      if (!run.terminal) {
        // 事件流意外结束（没有 agent_end）也必须有明确终态，避免快照永远 running。
        await this.finishStatus(
          run,
          run.controller.signal.aborted ? "interrupted" : "failed",
          run.controller.signal.aborted
            ? undefined
            : { code: "agent_failed", message: "Agent loop 意外结束。", requestId: run.requestId }
        );
      }
    } catch (error) {
      if (run.terminal) return;
      if (run.controller.signal.aborted) {
        await this.finishStatus(run, "interrupted");
        return;
      }
      const payload = toRunErrorPayload(error, run.requestId);
      await this.emitFrame(run, "run_error", { error: payload });
      await this.finishStatus(run, "failed", payload);
    }
  }

  /**
   * 处理单个 loop 事件：agent_end 决定终态，其余事件映射为 run-v2 帧。
   *
   * 成本观测（G-T1）：`turn_end` 累加模型 usage、`tool_execution_end` 记录工具调用；
   * 终态前由 `finishStatus` 统一发 `cost_summary`，避免 completed / failed 两条分支各写一份。
   *
   * @param run 活跃 run。
   * @param event loop 事件。
   */
  private async handleAgentEvent(run: ActiveRun, event: AgentEvent): Promise<void> {
    if (event.type === "agent_end") {
      if (run.controller.signal.aborted) {
        // Gate 3：丢弃无 error 的 agent_end，避免客户端把取消显示成 completed。
        await this.finishStatus(run, "interrupted");
        return;
      }
      if (event.error) {
        await this.emitTypedFrame(run, event.type, event);
        await this.finishStatus(run, "failed", {
          code: event.error.code,
          message: event.error.message,
          requestId: run.requestId,
          details: { loopCode: event.error.code }
        });
        return;
      }
      await this.emitTypedFrame(run, event.type, event);
      await this.finishStatus(run, "completed");
      return;
    }

    // 成本累加发生在发帧之前：即便后续广播失败，聚合数据也已就位（观测数据不依赖 IO 成功）。
    this.costTracker.observe(run.snapshot.runId, event);

    if (event.type === "message_end") {
      await persistRunMessage(this.options, run, event.message);
    }
    await this.emitTypedFrame(run, event.type, event);
  }

  /**
   * 把任意类型的负载包装成 canonical envelope 并入队。
   *
   * 与 `emitFrame` 的分层：这里只负责「事件类型 → 线协议类型」的窄化，
   * 托管 run 的 loop 事件与采集层的 `llm_call` 记录走同一条路径。
   *
   * @param run 活跃 run。
   * @param type 事件类型。
   * @param payload 事件负载。
   */
  private async emitTypedFrame(
    run: ActiveRun,
    type: RunEventTypeDto,
    payload: unknown
  ): Promise<void> {
    await this.emitFrame(run, type, payload);
  }

  /**
   * 分配 sequence、落盘关键事件并广播。
   *
   * @param run 活跃 run。
   * @param type 事件类型。
   * @param payload 事件负载。
   */
  private async emitFrame(run: ActiveRun, type: RunEventTypeDto, payload: unknown): Promise<void> {
    const sequence = run.sequence + 1;
    run.sequence = sequence;
    const createdAt = new Date().toISOString();
    const event: RunStreamEventDtoV2 = {
      eventId: randomUUID(),
      runId: run.snapshot.runId,
      requestId: run.requestId,
      conversationId: run.snapshot.conversationId,
      sequence,
      type,
      payload,
      createdAt
    };

    if (isPersistableRunEvent(type)) {
      await this.options.runStore.appendEvent(run.snapshot.runId, event);
      run.lastPersistedSequence = sequence;
    }

    run.snapshot = {
      ...run.snapshot,
      lastEventSequence: run.lastPersistedSequence,
      updatedAt: createdAt
    };

    for (const listener of run.subscribers) {
      try {
        listener(event);
      } catch {
        // 单个 SSE 客户端写失败不应中断 run；清理交给 connection close。
      }
    }
  }

  /**
   * 收尾终态：发 cost_summary、run_status、更新快照、标记 store 状态。并发调用复用同一 Promise。
   *
   * 顺序（important）：`cost_summary` 在 `run_status` **之前**发——客户端以 run_status 作为
   * 「run 已结束」的判据，先发成本汇总保证订阅者在终态帧到达时已持有团队成本段。
   * 这条事件是 best-effort：投影或落盘失败都不得改变 run 的终态（观测数据不能拖垮执行）。
   *
   * @param run 活跃 run。
   * @param status 终态。
   * @param error 失败 / 取消时的结构化错误。
   */
  private finishStatus(
    run: ActiveRun,
    status: RunStatusDtoV2,
    error?: RunErrorPayload
  ): Promise<void> {
    if (run.terminal) return Promise.resolve();
    if (run.finishPromise) return run.finishPromise;

    run.finishPromise = (async () => {
      // G-T1：成本汇总先于终态帧发出（客户端以 run_status 判「run 结束」，届时须已持有团队成本段）。
      // 投影 / 发帧失败一律吞掉——成本是观测性数据，绝不能把一次成功的 run 变成 failed。
      try {
        const costPayload = this.costTracker.project(
          run.snapshot.runId,
          status,
          run.snapshot.conversationId
        );
        if (costPayload) await this.emitFrame(run, "cost_summary", costPayload);
      } catch (error) {
        // 不改变终态（观测数据不能拖垮执行），但必须留下诊断线索：getTeamState 抛错、
        // payload 序列化失败、runStore.appendEvent 写失败都会走到这里，静默吞掉会让
        // 「成本段缺失」在排障时无从归因。serve 无 CLI 日志通道，stderr 是既有惯例。
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[ohna] run ${run.snapshot.runId} 的 cost_summary 投影/落盘失败（终态仍为 ${status}）：${reason}\n`
        );
      }
      const payload: Record<string, unknown> = { status };
      if (error) payload.error = error;
      await this.emitFrame(run, "run_status", payload);
      if (status === "failed" && error) {
        // provider / loop 失败也要留下可恢复的用户可见终态；否则刷新后只剩孤立 user 消息，
        // 真实错误只存在 run JSONL 的 Trace 中，会话时间线会误以为该轮从未产生回答。
        await this.options.messageStore.append(run.snapshot.conversationId, {
          role: "assistant",
          content: [{ type: "text", text: `${error.code}: ${error.message}` }],
          modelId: run.snapshot.modelId,
          stopReason: "error",
          runId: run.snapshot.runId
        });
        await this.options.sessionStore.touch(run.snapshot.conversationId);
      }
      run.snapshot = terminalSnapshot(run.snapshot, status, error);
      run.terminal = true;
      run.resolveTerminalDone();
      await this.options.runStore.markStatus(run.snapshot.runId, status);
      // run 已结束：清理可能残留的待确认项（deny 释放），避免悬挂与内存泄漏。
      this.confirmGate?.clearRun(run.snapshot.runId);
      // 原子 startRun 的缓冲订阅此时已完成使命：initialEvents 已随 createRun 返回，
      // 后续事件由调用方自行 subscribeRun 续接，释放其 listener 避免内存泄漏与重复投递。
      this.detachAtomicSubscription(run.snapshot.runId);
      scheduleReclaim(run, this.active);
    })();

    return run.finishPromise;
  }

  /**
   * 强制推进内存终态，不依赖 JSONL 写入成功（P3-4 兜底）。
   *
   * 仅在 `run_status` / `run_error` 的落盘或广播本身失败时使用：即使磁盘不可写，
   * GET / DELETE 也必须看到明确终态，不能永久停在 running。
   *
   * @param run 活跃 run。
   * @param status 终态。
   * @param error 结构化错误。
   */
  private async forceTerminal(
    run: ActiveRun,
    status: RunStatusDtoV2,
    error?: RunErrorPayload
  ): Promise<void> {
    if (run.terminal) return;
    run.snapshot = terminalSnapshot(run.snapshot, status, error);
    run.terminal = true;
    run.resolveTerminalDone();
    await this.options.runStore.markStatus(run.snapshot.runId, status);
    this.confirmGate?.clearRun(run.snapshot.runId);
    // 兜底终态同样释放原子订阅（不依赖磁盘写入成功）。
    this.detachAtomicSubscription(run.snapshot.runId);
    scheduleReclaim(run, this.active);
  }
}

