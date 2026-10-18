/**
 * 终态收尾的内存侧原语。
 *
 * 两个目标：
 * 1. 快照推进到终态是纯数据变换，与「run_status 是否成功落盘」解耦；
 * 2. 终态 run 在 active Map 中只保留有限时间，避免长期运行无界增长（P3-5）。
 */
import type { RunSnapshotDtoV2, RunStatusDtoV2 } from "@aiagent/types";
import { isTerminalStatus } from "./helpers.js";
import type { ActiveRun, RunErrorPayload } from "./types.js";

/** 终态 run 在 active Map 中的保留时长：刚结束的 GET / DELETE 仍命中内存。 */
export const TERMINAL_RETENTION_MS = 5 * 60_000;

/**
 * 生成终态快照（不修改入参）。
 *
 * @param snapshot 当前快照。
 * @param status 终态。
 * @param error 失败 / 中断时的结构化错误。
 * @returns 新的终态快照。
 */
export function terminalSnapshot(
  snapshot: RunSnapshotDtoV2,
  status: RunStatusDtoV2,
  error?: RunErrorPayload
): RunSnapshotDtoV2 {
  const completedAt = new Date().toISOString();
  return {
    ...snapshot,
    status,
    updatedAt: completedAt,
    ...(isTerminalStatus(status) ? { completedAt } : {}),
    ...(error ? { error } : {})
  };
}

/**
 * 终态 run 延迟从 active Map 回收（定时器 unref，不阻止进程退出）。
 *
 * 超时后查询回落到 runs JSONL 重建，因此只影响「是否命中内存」，不影响正确性。
 *
 * @param run 已终态的活跃 run。
 * @param active 活跃 run 表。
 * @param ttlMs 保留时长。
 */
export function scheduleReclaim(
  run: ActiveRun,
  active: Map<string, ActiveRun>,
  ttlMs: number = TERMINAL_RETENTION_MS
): void {
  if (run.reclaimTimer) return;
  const runId = run.snapshot.runId;
  const timer = setTimeout(() => {
    // 只删除同一个对象，避免极端情况下误删同 id 的新 run。
    if (active.get(runId) === run) active.delete(runId);
  }, ttlMs);
  timer.unref?.();
  run.reclaimTimer = timer;
}
