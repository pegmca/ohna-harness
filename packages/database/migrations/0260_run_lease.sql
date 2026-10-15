-- 0260: Run 队列租约列 + 请求快照列，支撑 worker 解耦。
--
-- 背景：当前 run 执行与 HTTP 同进程（microtask scheduler），崩溃/重启丢 run。
-- 本迁移新增 lease_until / claimed_by / request_payload 三列，支撑：
-- - FOR UPDATE SKIP LOCKED 抢占（worker claim）
-- - lease 续期 + 过期回收（at-least-once 语义）
-- - request 快照重建执行上下文（worker claim 后无需跨进程传 request）
--
-- 幂等：ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS。

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS claimed_by text;
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS request_payload jsonb;

COMMENT ON COLUMN runs.lease_until IS 'worker 租约到期时间；NULL 表示未被 claim 或已终态，worker 通过 FOR UPDATE SKIP LOCKED 抢占后设置';
COMMENT ON COLUMN runs.claimed_by IS '当前持有租约的 worker 标识（进程级 UUID）；终态后保留最后持有者，用于审计';
COMMENT ON COLUMN runs.request_payload IS 'create 时的完整请求快照（message/attachmentDocumentIds/metadata），worker claim 后据此重建执行上下文';

-- 部分索引：只索引 queued 状态的行，worker 轮询扫描效率高（跳过已终态与 running 行）。
CREATE INDEX IF NOT EXISTS runs_queue_idx
  ON runs(updated_at, id)
  WHERE status = 'queued';
