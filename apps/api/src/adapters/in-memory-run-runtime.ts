import type { AgentRunSnapshotDto, AgentRunStreamEventDto } from "@aiagent/types";
import type { RunEventBus, RunExecutionRegistry, RunScheduler, RunStore } from "../application/run-ports.js";

/** 创建阶段一的内存 Run store；接口保持异步以便阶段二替换为数据库。 */
export function createInMemoryRunStore(): RunStore {
  const snapshots = new Map<string, AgentRunSnapshotDto & { userId: string; attachmentDocumentIds: string[] }>();
  return {
    async create(input) {
      const existing = [...snapshots.values()].find((run) => run.userId === input.userId && run.requestId === input.requestId);
      if (existing) return { snapshot: structuredClone(existing), created: false };
      const snapshot = {
        runId: input.runId, requestId: input.requestId, conversationId: input.conversationId,
        modelId: input.modelId, status: "queued" as const, createdAt: input.createdAt,
        updatedAt: input.createdAt, events: [], userId: input.userId,
        attachmentDocumentIds: [...input.attachmentDocumentIds]
      };
      snapshots.set(input.runId, snapshot);
      return { snapshot: structuredClone(snapshot), created: true };
    },
    async findById(userId, runId) {
      const value = snapshots.get(runId);
      return value?.userId === userId ? structuredClone(value) : undefined;
    },
    async listAttachmentDocumentIds(userId, runId) {
      const value = snapshots.get(runId);
      return value?.userId === userId ? [...value.attachmentDocumentIds] : undefined;
    },
    async append(userId, runId, eventInput) {
      const current = snapshots.get(runId);
      if (!current || current.userId !== userId || isTerminal(current.status)) return undefined;
      const event = { ...eventInput, eventId: crypto.randomUUID(), sequence: current.events.length + 1 } as AgentRunStreamEventDto;
      const status = event.type === "run_status" ? event.status
        : event.type === "run_error" ? event.error.code === "request_cancelled" ? "cancelled" : "failed"
        : event.type === "run_result" ? event.result.ok ? "succeeded" : "failed" : current.status;
      if (!canTransition(current.status, status)) return undefined;
      snapshots.set(runId, {
        ...current, updatedAt: event.createdAt, status, events: [...current.events, event],
        result: event.type === "run_result" ? event.result : current.result,
        error: event.type === "run_error" ? event.error : current.error
      });
      return structuredClone(event);
    },
    async listEvents(userId, runId, afterSequence) {
      const current = snapshots.get(runId);
      return current?.userId === userId ? structuredClone(current.events.filter((event) => event.sequence > afterSequence)) : undefined;
    },
    async recoverStale() {
      return [];
    }
  };
}

/** @param status Run 状态。 @returns 是否已经进入不可回退的终态。 */
function isTerminal(status: AgentRunSnapshotDto["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** @param current 当前状态。 @param next 目标状态。 @returns 是否为合法单向迁移。 */
function canTransition(current: AgentRunSnapshotDto["status"], next: AgentRunSnapshotDto["status"]): boolean {
  if (current === next) return true;
  if (current === "queued") return next === "running" || isTerminal(next);
  if (current === "running") return next === "waiting_approval" || isTerminal(next);
  if (current === "waiting_approval") return next === "running" || isTerminal(next);
  return false;
}

/** 创建只负责实时 fan-out 的事件总线，不混入持久化职责。 */
export function createInMemoryRunEventBus(): RunEventBus {
  const listeners = new Map<string, Set<(event: AgentRunStreamEventDto) => void>>();
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

/** AbortController 属于进程执行态，不能写入可持久化 Run snapshot。 */
export function createInMemoryExecutionRegistry(): RunExecutionRegistry {
  const controllers = new Map<string, AbortController>();
  return {
    create(runId) {
      const controller = new AbortController();
      controllers.set(runId, controller);
      return controller;
    },
    get: (runId) => controllers.get(runId),
    delete: (runId) => { controllers.delete(runId); },
    list: () => [...controllers.keys()]
  };
}

/** 当前 scheduler 使用 microtask；阶段二可在不改 application service 的情况下换成队列。 */
export function createMicrotaskRunScheduler(): RunScheduler {
  return {
    schedule(task) {
      queueMicrotask(() => void task());
    }
  };
}
