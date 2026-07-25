CREATE TABLE agent_runs (
  id uuid PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  assistant_message_id uuid REFERENCES messages(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('auto', 'report')),
  source text NOT NULL CHECK (source IN ('composer', 'report_button')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled')),
  intent text,
  trace_id text NOT NULL,
  workflow_run_id text,
  result jsonb,
  error jsonb,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX agent_runs_user_updated_idx ON agent_runs(user_id, updated_at DESC, id DESC);
CREATE INDEX agent_runs_conversation_updated_idx ON agent_runs(user_id, conversation_id, updated_at DESC, id DESC);
CREATE INDEX agent_runs_non_terminal_updated_idx
  ON agent_runs(updated_at, id)
  WHERE status IN ('queued', 'running', 'waiting_approval');

COMMENT ON COLUMN agent_runs.id IS 'Agent Run 唯一标识';
COMMENT ON COLUMN agent_runs.request_id IS '创建请求幂等标识，同一标识只创建一个 Run';
COMMENT ON COLUMN agent_runs.user_id IS 'Run 所属用户标识，用于数据库层授权过滤';
COMMENT ON COLUMN agent_runs.conversation_id IS 'Run 所属会话标识';
COMMENT ON COLUMN agent_runs.user_message_id IS '触发 Run 的幂等用户消息标识';
COMMENT ON COLUMN agent_runs.assistant_message_id IS '为 Run 预留并最终承载回答的助手消息标识';
COMMENT ON COLUMN agent_runs.mode IS '运行模式：自动或研报';
COMMENT ON COLUMN agent_runs.source IS '运行触发入口：输入框或研报按钮';
COMMENT ON COLUMN agent_runs.status IS 'Run 生命周期状态，终态不可回退';
COMMENT ON COLUMN agent_runs.intent IS 'Agent 路由后识别的意图';
COMMENT ON COLUMN agent_runs.trace_id IS 'Run 对应的 trace 标识';
COMMENT ON COLUMN agent_runs.workflow_run_id IS 'Run 触发的研报工作流标识';
COMMENT ON COLUMN agent_runs.result IS '已校验并脱敏的终态结果投影';
COMMENT ON COLUMN agent_runs.error IS '已脱敏的结构化终态错误';
COMMENT ON COLUMN agent_runs.version IS '每次事件提交后递增的乐观版本号';
COMMENT ON COLUMN agent_runs.created_at IS 'Run 创建时间';
COMMENT ON COLUMN agent_runs.updated_at IS 'Run 最近一次事件更新时间';
COMMENT ON COLUMN agent_runs.started_at IS 'Run 首次进入运行态的时间';
COMMENT ON COLUMN agent_runs.completed_at IS 'Run 首次进入终态的时间';

CREATE TABLE run_events (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  trace_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type IN ('run_status', 'trace_event', 'run_result', 'run_error')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT run_events_run_sequence_uq UNIQUE (run_id, sequence)
);

CREATE INDEX run_events_user_run_sequence_idx ON run_events(user_id, run_id, sequence);

COMMENT ON COLUMN run_events.id IS 'Canonical Run Event 唯一标识，同时作为事件 envelope 标识';
COMMENT ON COLUMN run_events.run_id IS '事件所属 Run 标识';
COMMENT ON COLUMN run_events.user_id IS '事件所属用户标识，用于数据库层授权过滤';
COMMENT ON COLUMN run_events.conversation_id IS '事件所属会话标识';
COMMENT ON COLUMN run_events.trace_id IS '事件关联的 trace 标识';
COMMENT ON COLUMN run_events.sequence IS '事件在单个 Run 内连续递增的持久序号';
COMMENT ON COLUMN run_events.event_type IS 'Canonical event 类型';
COMMENT ON COLUMN run_events.payload IS '经 schema 校验与脱敏后的事件完整 envelope';
COMMENT ON COLUMN run_events.created_at IS '事件持久化创建时间';

ALTER TABLE messages
  ADD CONSTRAINT messages_run_id_fk
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX messages_run_assistant_uq
  ON messages(run_id)
  WHERE run_id IS NOT NULL AND role = 'assistant';

COMMENT ON COLUMN messages.run_id IS '消息关联的 Agent Run 标识；每个 Run 最多关联一条助手消息';
