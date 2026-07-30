import type { RunEventInputDtoV2, RunSnapshotDtoV2, RunStatusDtoV2, RunStreamEventDtoV2 } from "@aiagent/types";
import type { MessageStore } from "@aiagent/conversation";
import type { RunEventBus, RunExecutionRegistry, RunScheduler, RunStore } from "../application/run-ports.js";

const TERMINAL = new Set<RunStatusDtoV2>(["completed", "failed", "cancelled", "interrupted"]);

/**
 * 创建内存 Run store（仅测试显式使用）：语义对齐 Postgres adapter 的
 * 幂等创建、sequence 分配、终态推导与单向状态机。
 *
 * @param options.messageStore 注入后在 create 事务语义内幂等落用户消息（对齐 Postgres 行为）。
 * @returns 内存 RunStore。
 */
export function createInMemoryRunStore(options: { messageStore?: MessageStore } = {}): RunStore {
  interface StoredRun {
    snapshot: RunSnapshotDtoV2;
    userId: string;
    events: RunStreamEventDtoV2[];
  }
  const runs = new Map<string, StoredRun>();
  return {
    async create(input) {
      const existing = [...runs.values()].find((run) => run.snapshot.requestId === input.requestId && run.userId === input.userId);
      if (existing) return { snapshot: structuredClone(existing.snapshot), created: false };
      // 对齐 Postgres create：触发 Run 的用户消息在同一创建语义内幂等落库。
      if (options.messageStore) {
        await options.messageStore.appendUserMessageIdempotently(input.userId, {
          conversationId: input.conversationId,
          runId: input.runId,
          role: "user",
          content: input.message,
          clientMessageId: input.clientMessageId,
          createdAt: input.createdAt
        });
      }
      const snapshot: RunSnapshotDtoV2 = {
        runId: input.runId,
        requestId: input.requestId,
        conversationId: input.conversationId,
        modelId: input.modelId,
        mode: input.mode,
        source: input.source,
        status: "queued",
        lastEventSequence: 0,
        createdAt: input.createdAt,
        updatedAt: input.createdAt
      };
      runs.set(input.runId, { snapshot, userId: input.userId, events: [] });
      return { snapshot: structuredClone(snapshot), created: true };
    },
    async findById(userId, runId) {
      const run = runs.get(runId);
      return run?.userId === userId ? structuredClone(run.snapshot) : undefined;
    },
    async appendEvent(userId, runId, eventInput: RunEventInputDtoV2) {
      const run = runs.get(runId);
      if (!run || run.userId !== userId || TERMINAL.has(run.snapshot.status)) return undefined;
      const nextStatus = statusFromEvent(eventInput, run.snapshot.status);
      if (!canTransition(run.snapshot.status, nextStatus)) return undefined;
      const event: RunStreamEventDtoV2 = {
        ...structuredClone(eventInput),
        eventId: crypto.randomUUID(),
        sequence: run.events.length + 1
      };
      run.events.push(event);
      run.snapshot = {
        ...run.snapshot,
        status: nextStatus,
        updatedAt: event.createdAt,
        lastEventSequence: event.sequence,
        startedAt: nextStatus === "running" ? run.snapshot.startedAt ?? event.createdAt : run.snapshot.startedAt,
        completedAt: TERMINAL.has(nextStatus) ? run.snapshot.completedAt ?? event.createdAt : run.snapshot.completedAt,
        error: terminalError(eventInput, nextStatus) ?? run.snapshot.error
      };
      return structuredClone(event);
    },
    async listEvents(userId, runId, afterSequence) {
      const run = runs.get(runId);
      return run?.userId === userId
        ? structuredClone(run.events.filter((event) => event.sequence > afterSequence))
        : undefined;
    },
    async recoverStale(before, occurredAt) {
      const recovered: RunStreamEventDtoV2[] = [];
      for (const run of runs.values()) {
        if (TERMINAL.has(run.snapshot.status) || run.snapshot.updatedAt >= before) continue;
        const event = await this.appendEvent(run.userId, run.snapshot.runId, {
          type: "run_status",
          runId: run.snapshot.runId,
          requestId: run.snapshot.requestId,
          conversationId: run.snapshot.conversationId,
          createdAt: occurredAt,
          payload: { status: "interrupted", message: "API 重启前的 Agent run 未完成，已标记为中断。" }
        });
        if (event) recovered.push(event);
      }
      return recovered;
    }
  };
}

/** @param event 事件输入。 @param current 当前状态。 @returns 推导后的状态（与 Postgres adapter 同规则）。 */
function statusFromEvent(event: RunEventInputDtoV2, current: RunStatusDtoV2): RunStatusDtoV2 {
  if (event.type === "run_status") {
    return (event.payload as { status?: RunStatusDtoV2 }).status ?? current;
  }
  if (event.type === "run_error") {
    return (event.payload as { error?: { code?: string } }).error?.code === "request_cancelled" ? "cancelled" : "failed";
  }
  if (event.type === "agent_end") {
    const payload = event.payload as { error?: unknown; messages?: { role: string; stopReason?: string }[] };
    if (payload.error) return "failed";
    const lastAssistant = [...(payload.messages ?? [])].reverse().find((m) => m.role === "assistant");
    if (lastAssistant?.stopReason === "aborted") return "cancelled";
    if (lastAssistant?.stopReason === "error") return "failed";
    return "completed";
  }
  return current;
}

/** @param event 事件输入。 @param nextStatus 推导后的状态。 @returns 终态结构化错误。 */
function terminalError(event: RunEventInputDtoV2, nextStatus: RunStatusDtoV2): RunSnapshotDtoV2["error"] | undefined {
  if (event.type === "run_error") return (event.payload as { error?: RunSnapshotDtoV2["error"] }).error;
  if (event.type === "agent_end" && (nextStatus === "failed" || nextStatus === "cancelled")) {
    const payload = event.payload as { error?: { code: string; message: string } };
    if (payload.error) return { ...payload.error, requestId: event.requestId };
    return {
      code: nextStatus === "cancelled" ? "request_cancelled" : "agent_failed",
      message: nextStatus === "cancelled" ? "Agent run 已取消。" : "Agent run 执行失败。",
      requestId: event.requestId
    };
  }
  return undefined;
}

/** @param current 当前状态。 @param next 目标状态。 @returns 是否为合法单向迁移。 */
function canTransition(current: RunStatusDtoV2, next: RunStatusDtoV2): boolean {
  if (current === next) return true;
  if (current === "queued") return next === "running" || TERMINAL.has(next);
  if (current === "running") return TERMINAL.has(next);
  return false;
}

/** 创建只负责实时 fan-out 的事件总线，不混入持久化职责。 */
export function createInMemoryRunEventBus(): RunEventBus {
  const listeners = new Map<string, Set<(event: RunStreamEventDtoV2) => void>>();
  return {
    publish(event) {
      for (const listener of listeners.get(event.runId) ?? []) listener(event);
    },
    subscribe(runId, listener) {
      const subscribers = listeners.get(runId) ?? new Set();
      subscribers.add(listener);
      listeners.set(runId, subscribers);
      return () => {
        subscribers.delete(listener);
        if (!subscribers.size) listeners.delete(runId);
      };
    }
  };
}

/** 创建内存执行注册表；abort 只发信号，执行体自行收尾。 */
export function createInMemoryExecutionRegistry(): RunExecutionRegistry {
  const controllers = new Map<string, AbortController>();
  return {
    create(runId) {
      const controller = new AbortController();
      controllers.set(runId, controller);
      return controller;
    },
    get: (runId) => controllers.get(runId),
    delete: (runId) => {
      controllers.delete(runId);
    },
    list: () => [...controllers.keys()]
  };
}

/** 创建微任务调度器；生产语义是不阻塞 HTTP 响应。 */
export function createMicrotaskRunScheduler(): RunScheduler {
  return {
    schedule(task) {
      queueMicrotask(() => {
        void task().catch(() => undefined);
      });
    }
  };
}
