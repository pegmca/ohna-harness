/**
 * Run 生命周期的纯函数助手：终态判定、快照克隆、错误收敛与超时等待。
 */
import type { RunSnapshotDtoV2, RunStatusDtoV2 } from "@aiagent/types";
import type { RunErrorPayload } from "./types.js";

/** run-v2 快照终态集合。 */
const TERMINAL_STATUSES: ReadonlySet<RunStatusDtoV2> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

/**
 * 判断状态是否终态。
 *
 * @param status run 状态。
 * @returns 终态返回 true。
 */
export function isTerminalStatus(status: RunStatusDtoV2): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * 克隆快照，避免调用方修改内存状态。
 *
 * @param snapshot 快照。
 * @returns 深拷贝。
 */
export function cloneSnapshot(snapshot: RunSnapshotDtoV2): RunSnapshotDtoV2 {
  return structuredClone(snapshot);
}

/**
 * 把未知异常收敛为可持久化的结构化错误。
 *
 * @param error 原始异常。
 * @param requestId 请求 id。
 * @returns 结构化错误。
 */
export function toRunErrorPayload(error: unknown, requestId: string): RunErrorPayload {
  const message = error instanceof Error ? error.message : "Run 执行失败。";
  return {
    code: "internal_error",
    message: message.slice(0, 300),
    requestId
  };
}

/**
 * 等待指定毫秒数（取消 / 关闭的超时兜底）。
 *
 * 定时器 unref：正常路径下 loop 已收尾时，这个兜底计时器不应阻止进程退出。
 *
 * @param ms 毫秒。
 * @returns 到时 resolve。
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
