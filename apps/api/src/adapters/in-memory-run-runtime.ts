import type { AgentRunSnapshotDto, AgentRunStreamEventDto } from "@aiagent/types";
import type { RunEventBus, RunExecutionRegistry, RunScheduler, RunStore } from "../application/run-ports.js";

/** 创建阶段一的内存 Run store；接口保持异步以便阶段二替换为数据库。 */
export function createInMemoryRunStore(): RunStore {
  const snapshots = new Map<string, AgentRunSnapshotDto>();
  return {
    async insert(snapshot) {
      if (snapshots.has(snapshot.runId)) throw new Error(`Run already exists: ${snapshot.runId}`);
      snapshots.set(snapshot.runId, structuredClone(snapshot));
    },
    async findById(runId) {
      const value = snapshots.get(runId);
      return value ? structuredClone(value) : undefined;
    },
    async save(snapshot) {
      snapshots.set(snapshot.runId, structuredClone(snapshot));
    }
  };
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
    delete: (runId) => { controllers.delete(runId); }
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
