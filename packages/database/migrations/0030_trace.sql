CREATE TABLE traces (
  id text PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  run_id uuid NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL,
  duration_ms integer NOT NULL DEFAULT 0,
  model_call_count integer NOT NULL DEFAULT 0,
  tool_call_count integer NOT NULL DEFAULT 0,
  retrieval_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  input_tokens integer,
  output_tokens integer,
  known_token_total integer NOT NULL DEFAULT 0,
  unknown_token_call_count integer NOT NULL DEFAULT 0,
  last_sequence bigint NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT traces_status_check CHECK (status IN ('running','succeeded','failed')),
  CONSTRAINT traces_counts_check CHECK (
    duration_ms >= 0 AND model_call_count >= 0 AND tool_call_count >= 0
    AND retrieval_count >= 0 AND error_count >= 0 AND known_token_total >= 0
    AND unknown_token_call_count >= 0 AND last_sequence >= 0
  )
);

CREATE INDEX traces_user_request_idx ON traces(user_id, request_id);

CREATE TABLE trace_events (
  id uuid PRIMARY KEY,
  trace_id text NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  event_type text NOT NULL,
  span_id text,
  parent_span_id text,
  stage text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT trace_events_sequence_check CHECK (sequence > 0),
  CONSTRAINT trace_events_trace_sequence_uq UNIQUE (trace_id, sequence)
);

CREATE INDEX trace_events_user_trace_sequence_idx ON trace_events(user_id, trace_id, sequence);

COMMENT ON COLUMN traces.id IS 'Trace 稳定标识';
COMMENT ON COLUMN traces.request_id IS '对外请求唯一标识';
COMMENT ON COLUMN traces.run_id IS '关联的 Agent Run 标识';
COMMENT ON COLUMN traces.user_id IS 'Trace 所属用户标识';
COMMENT ON COLUMN traces.status IS 'Trace 汇总状态：running、succeeded 或 failed';
COMMENT ON COLUMN traces.duration_ms IS 'Trace 从开始到结束的毫秒耗时';
COMMENT ON COLUMN traces.model_call_count IS '模型调用次数';
COMMENT ON COLUMN traces.tool_call_count IS '工具及 MCP 工具调用次数';
COMMENT ON COLUMN traces.retrieval_count IS '检索调用次数';
COMMENT ON COLUMN traces.error_count IS '失败或拒绝事件数量';
COMMENT ON COLUMN traces.input_tokens IS '已知输入 token 总数；存在未知调用时为空';
COMMENT ON COLUMN traces.output_tokens IS '已知输出 token 总数；存在未知调用时为空';
COMMENT ON COLUMN traces.known_token_total IS '所有已知输入与输出 token 合计';
COMMENT ON COLUMN traces.unknown_token_call_count IS '缺少完整 token usage 的模型调用次数';
COMMENT ON COLUMN traces.last_sequence IS '当前 Trace 已提交的最大连续事件序号';
COMMENT ON COLUMN traces.started_at IS 'Trace 开始时间';
COMMENT ON COLUMN traces.completed_at IS 'Trace 结束时间，运行中为空';

COMMENT ON COLUMN trace_events.id IS 'Trace 事件 UUID';
COMMENT ON COLUMN trace_events.trace_id IS '所属 Trace 标识';
COMMENT ON COLUMN trace_events.run_id IS '关联的 Agent Run 标识';
COMMENT ON COLUMN trace_events.user_id IS '事件所属用户标识';
COMMENT ON COLUMN trace_events.sequence IS 'Trace 内从 1 开始连续递增的事件序号';
COMMENT ON COLUMN trace_events.event_type IS 'canonical Trace 事件类型';
COMMENT ON COLUMN trace_events.span_id IS '当前事件 span 标识';
COMMENT ON COLUMN trace_events.parent_span_id IS '父 span 标识';
COMMENT ON COLUMN trace_events.stage IS '事件所属 Agent、工具或工作流阶段';
COMMENT ON COLUMN trace_events.payload IS '写库前完成递归脱敏和截断的事件 JSON';
COMMENT ON COLUMN trace_events.created_at IS '事件发生时间';
