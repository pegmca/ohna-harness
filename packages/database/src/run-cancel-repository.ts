import type pg from "pg";

/**
 * Run 取消标记存储（跨实例取消兜底层）。
 *
 * 进程内 pub/sub 无法回放历史消息：若"取消"广播先于 worker claim 后 execute 的订阅到达，
 * 该次取消会丢失。用一张小表持久记录取消意图，execute 启动时回查即可确定性兜底。
 * 与事件总线/Redis 取消信号互补：signal 负责在途 run 的即时中断，本表负责 queued run 的确定性兜底。
 *
 * 该 store 只写"意图"，不改变 run 状态机：run 的真正终态（cancelled）仍由 agent loop 在
 * 收到中断后走 agent_end / run_error 推导，保证单一事实源不被旁路。
 */
export interface RunCancelStore {
  /** 记录某 run 已被请求取消（幂等：重复标记不报错）。 */
  markCancelled(runId: string): Promise<void>;
  /** @returns 该 run 是否已被请求取消。 */
  isCancelled(runId: string): Promise<boolean>;
}

/**
 * 创建 PostgreSQL 实现的 Run 取消标记存储。
 *
 * @param pool PostgreSQL 连接池。
 * @returns 取消标记存储。
 */
export function createPostgresRunCancelStore(pool: pg.Pool): RunCancelStore {
  return {
    async markCancelled(runId: string): Promise<void> {
      // 幂等 upsert：重复取消不报错，也不更新已有 created_at（保留首次取消时间）。
      await pool.query(
        `insert into run_cancellations(run_id, created_at) values ($1, now())
           on conflict (run_id) do nothing`,
        [runId]
      );
    },
    async isCancelled(runId: string): Promise<boolean> {
      const result = await pool.query<{ run_id: string }>(
        "select run_id from run_cancellations where run_id=$1",
        [runId]
      );
      return (result.rowCount ?? 0) > 0;
    }
  };
}
