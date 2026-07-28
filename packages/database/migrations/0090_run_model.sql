ALTER TABLE agent_runs
  ADD COLUMN model_id text NOT NULL DEFAULT 'legacy';

COMMENT ON COLUMN agent_runs.model_id IS '本次 Run 选择的服务端模型目录稳定标识；历史数据为 legacy';

ALTER TABLE agent_runs
  ALTER COLUMN model_id DROP DEFAULT;

