-- 0280: Run 取消标记表，支撑跨实例取消的 queued 竞态兜底。
--
-- 背景：P0 执行注册表外置后，取消意图通过 Redis pub/sub 跨实例广播，
-- 但 pub/sub 无法回放历史消息——若"取消"广播先于 worker claim 后 execute 的订阅到达，
-- 该次取消会丢失。本表持久记录取消意图，execute 启动时回查即可确定性兜底。
--
-- 注意：本表只写"意图"，不改 run 状态机；run 真正终态（cancelled）仍由 agent loop
-- 收到中断后走 agent_end / run_error 推导，保证单一事实源不被旁路。
--
-- 幂等：CREATE TABLE IF NOT EXISTS / ADD COLUMN 已天然幂等。

CREATE TABLE IF NOT EXISTS run_cancellations (
  run_id text primary key,
  created_at timestamptz not null default now()
);

COMMENT ON TABLE run_cancellations IS 'Run 取消意图标记：跨实例取消的兜底层，execute 启动时回查已取消的 queued run';
COMMENT ON COLUMN run_cancellations.run_id IS '被请求取消的 run 标识（与 runs.id 对应）';
COMMENT ON COLUMN run_cancellations.created_at IS '首次取消请求时间，保留不改以反映最早取消时刻';
