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
  defaultConvertToLlm
} from "@aiagent/agent";
import type { Model } from "@aiagent/ai";
import type {
  RunEventTypeDto,
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
import {
  compactConversationHistory,
  createServeSummarizer,
  dropBeforeLastCompaction,
  extractCompactionSummary,
} from "./run/compaction.js";
import { persistRunMessage } from "./run/persist.js";
import { isPersistableRunEvent } from "./store/index.js";
import { cloneSnapshot, delay, toRunErrorPayload } from "./run/helpers.js";
import { linearMessageToAgentMessage } from "./run/message-mapping.js";
import { scheduleReclaim, terminalSnapshot } from "./run/terminal.js";
import type {
  ActiveRun,
  CreateRunInput,
  CreateRunResult,
  RunErrorPayload,
  RunManagerOptions
} from "./run/types.js";

export type {
  CreateRunInput,
  CreateRunResult,
  RunManagerOptions
} from "./run/types.js";
export { isTerminalStatus } from "./run/helpers.js";
export { linearMessageToAgentMessage } from "./run/message-mapping.js";

/** Run 管理器。 */
export class RunManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly model: Model<"openai-completions">;
  private readonly confirmGate: AsyncConfirmGate | undefined;
  private readonly confirmations: RunConfirmations;
  /** 会话级订阅（--web 终端共享同一会话事件流）：conversationId → listener 集合。 */
  private readonly conversationSubscribers = new Map<string, Set<(event: RunStreamEventDtoV2) => void>>();
  /** run 前压缩的摘要器；懒构造，测试可通过 options.summarizer 注入。 */
  private summarizer: RunManagerOptions["summarizer"];
  /**
   * @param options 模型、工具、store、确认闸门与可选 streamFn（测试注入）。
   */
  constructor(private readonly options: RunManagerOptions) {
    this.model = options.model;
    this.confirmGate = options.confirmGate;
    this.summarizer = options.summarizer;
    this.confirmations = new RunConfirmations(
      options.confirmGate,
      (runId) => this.active.get(runId),
      (run, type, payload) => this.emitFrame(run, type, payload)
    );
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
  resolveConfirmation(
    runId: string,
    toolCallId: string,
    decision: ConfirmationDecision
  ): ResolveConfirmationResult {
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
   * 某 run 当前待确认数量。
   *
   * @param runId run id。
   * @returns 待确认数量。
   */
  pendingConfirmationCount(runId: string): number {
    return this.confirmations.pendingCount(runId);
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

    // 先取历史再追加本轮 prompt：agentLoop 会自行追加 prompt，避免重复。
    const storedHistory = await this.options.messageStore.list(input.conversationId);
    const mapped = storedHistory
      .map((dto) => linearMessageToAgentMessage(dto, this.model))
      .filter((message): message is AgentMessage => message !== null);
    const { messages: compactedHistory, compaction } = await this.compactHistoryForRun(
      input.conversationId,
      mapped
    );
    // 压缩审计写 stderr：serve 无 CLI 落盘日志，这是「run 前发生了压缩」的唯一观测点。
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
      modelId: this.model.id,
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
      modelId: this.model.id,
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

    const run: ActiveRun = {
      snapshot,
      requestId: input.requestId,
      controller: new AbortController(),
      done,
      sequence: 0,
      lastPersistedSequence: 0,
      subscribers: new Set(),
      terminal: false,
      skipFirstUserMessage: true
    };
    this.active.set(runId, run);

    // 会话级订阅（--web 共享事件流）：新 run 自动接到其会话的订阅者上。
    const conversationListeners = this.conversationSubscribers.get(input.conversationId);
    if (conversationListeners) {
      for (const listener of conversationListeners) run.subscribers.add(listener);
    }

    // 兜底捕获 execute 逃逸的异常（通常是落盘/广播二次失败，如磁盘写满）：
    // 必须转成结构化错误并强制内存终态，避免 run 永远 running + unhandled rejection。
    void this.execute(run, history, message)
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
      snapshot: cloneSnapshot(snapshot)
    };
  }

  /**
   * 读取快照：内存中的活跃 run 优先，否则从 JSONL 重建。
   *
   * @param runId run id。
   * @returns 快照或 null。
   */
  async getSnapshot(runId: string): Promise<RunSnapshotDtoV2 | null> {
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
    listener: (event: RunStreamEventDtoV2) => void
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
    return () => {
      listeners.delete(listener);
      for (const run of this.active.values()) {
        if (run.snapshot.conversationId === conversationId) run.subscribers.delete(listener);
      }
    };
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
    messages: AgentMessage[]
  ): Promise<{ messages: AgentMessage[]; compaction: { compacted: boolean; tokensBefore: number; tokensAfter: number } }> {
    const summarizer =
      this.summarizer ??
      (this.summarizer = createServeSummarizer({
        model: this.model,
        apiKey: this.options.apiKey,
        ...(this.options.streamFn ? { streamFn: this.options.streamFn } : {})
      }));
    const result = await compactConversationHistory(messages, {
      model: this.model,
      summarizer,
      onWarn: (warning) => process.stderr.write(`[ohna] ${warning}\n`)
    });
    if (!result.compacted) {
      return {
        messages: dropBeforeLastCompaction(result.messages),
        compaction: { compacted: false, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter }
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
        tokensAfter: result.tokensAfter
      }
    };
  }

  /**
   * 取消 run：abort → 等待 loop 收尾（有超时兜底）→ 追发 interrupted 终态。
   *
   * @param runId run id。
   * @returns 取消后的快照；run 不存在返回 null。
   */
  async cancel(runId: string): Promise<RunSnapshotDtoV2 | null> {
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
   * 执行 loop 并消费事件流。
   *
   * @param run 活跃 run 状态。
   * @param history 本轮之前的历史消息。
   * @param prompt 本轮用户输入。
   */
  private async execute(run: ActiveRun, history: AgentMessage[], prompt: string): Promise<void> {
    const context: AgentContext = {
      systemPrompt: this.options.systemPrompt,
      messages: history,
      tools: this.options.tools
    };
    const runId = run.snapshot.runId;
    const confirmHook = this.confirmGate?.createHook(runId);
    const config: AgentLoopConfig = {
      model: this.model,
      apiKey: this.options.apiKey,
      convertToLlm: defaultConvertToLlm,
      // 写/执行前挂起等待浏览器确认；只读工具在闸门内部直接放行。
      ...(confirmHook ? { beforeToolCall: confirmHook } : {})
    };
    const userMessage: AgentMessage = { role: "user", content: prompt, timestamp: Date.now() };

    try {
      const stream = agentLoop([userMessage], context, config, run.controller.signal, this.options.streamFn);
      for await (const event of stream) {
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
        await this.emitAgentEvent(run, event);
        await this.finishStatus(run, "failed", {
          code: event.error.code,
          message: event.error.message,
          requestId: run.requestId,
          details: { loopCode: event.error.code }
        });
        return;
      }
      await this.emitAgentEvent(run, event);
      await this.finishStatus(run, "completed");
      return;
    }

    if (event.type === "message_end") {
      await persistRunMessage(this.options, run, event.message);
    }
    await this.emitAgentEvent(run, event);
  }

  /**
   * 把 loop 事件包装成 canonical envelope。
   *
   * @param run 活跃 run。
   * @param event loop 事件。
   */
  private async emitAgentEvent(run: ActiveRun, event: AgentEvent): Promise<void> {
    await this.emitFrame(run, event.type as RunEventTypeDto, event);
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
   * 收尾终态：发 run_status、更新快照、标记 store 状态。并发调用复用同一 Promise。
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
      const payload: Record<string, unknown> = { status };
      if (error) payload.error = error;
      await this.emitFrame(run, "run_status", payload);
      run.snapshot = terminalSnapshot(run.snapshot, status, error);
      run.terminal = true;
      await this.options.runStore.markStatus(run.snapshot.runId, status);
      // run 已结束：清理可能残留的待确认项（deny 释放），避免悬挂与内存泄漏。
      this.confirmGate?.clearRun(run.snapshot.runId);
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
    await this.options.runStore.markStatus(run.snapshot.runId, status);
    this.confirmGate?.clearRun(run.snapshot.runId);
    scheduleReclaim(run, this.active);
  }
}

