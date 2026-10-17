-- 0290: 写类工具结果去重表 + run 续跑检查点列，收敛 at-least-once 重排的副作用安全。
--
-- 背景：当前 recoverStale 是整 Run 重排（从 request_payload 重建上下文重新执行），
-- 一旦引入写类工具（发单/外呼/写库）at-least-once 重跑会重复副作用。
-- 本迁移提供两道保险：
--   1) tool_results：按 (run_id, tool_call_id) 幂等落工具结果，恢复时据此跳过已完成的写类工具；
--   2) runs.last_checkpoint：每轮提交后写执行检查点，支持"从最近检查点续跑"而非从零重跑。
--
-- 幂等：CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS。

CREATE TABLE IF NOT EXISTS tool_results (
  run_id text not null,
  tool_call_id text not null,
  tool_name text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, tool_call_id)
);

COMMENT ON TABLE tool_results IS '写类工具结果去重表：按 (run_id, tool_call_id) 唯一，恢复续跑时跳过已完成的写类副作用';
COMMENT ON COLUMN tool_results.run_id IS '所属 run 标识（对应 runs.id）';
COMMENT ON COLUMN tool_results.tool_call_id IS '单次工具调用 id（来自 assistant 消息 toolCall 块），与 run_id 共同构成去重键';
COMMENT ON COLUMN tool_results.tool_name IS '工具名称，便于审计与按工具维度统计';
COMMENT ON COLUMN tool_results.result IS '工具结构化结果（持久化以便续跑直接复用，避免重复副作用）';
COMMENT ON COLUMN tool_results.created_at IS '结果落库时间，用于按时间排查去重记录与审计';

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS last_checkpoint jsonb;

COMMENT ON COLUMN runs.last_checkpoint IS '执行检查点：每轮提交后写入（turn/lastEventSequence/createdAt），支持从最近检查点续跑而非整 Run 重排';
