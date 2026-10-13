-- 0230: 扩展 run_events.event_type CHECK 约束，允许新增的 cost_summary 能力事件。
--
-- 背景（docs/v1.1/04-eval-observability.md P3 成本归因）：run-service 在 agent_end 后
-- 在线累加并落一条 cost_summary 事件（按 model / tool 拆分的 token 与成本统计），
-- 供 SLO / 成本观测消费。CHECK 约束此前未包含该类型，落库会触发约束违例。
--
-- 策略：先 DROP 旧约束（若存在），再 ADD 含 cost_summary 的新约束；ADD 不支持 IF NOT EXISTS，
-- 故 DROP IF EXISTS 保证重复运行幂等（与 0070 的维度约束改写同模式）。
-- 注意：仅对 event_type 取值白名单做加法，不改动任何列类型或既有数据。

-- 解除旧 event_type 白名单约束。
ALTER TABLE run_events
  DROP CONSTRAINT IF EXISTS run_events_event_type_check;

-- 写入含 cost_summary 的新白名单（其余 16 个既有类型保持不变）。
ALTER TABLE run_events
  ADD CONSTRAINT run_events_event_type_check
  CHECK (event_type in (
    'agent_start', 'agent_end', 'turn_start', 'turn_end',
    'message_start', 'message_update', 'message_end',
    'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
    'retrieval', 'workflow_node', 'pdf_export', 'mcp_tool_discovered',
    'run_status', 'run_error', 'cost_summary'
  ));

-- 中文注释：约束语义随新增事件类型变化，便于 DBeaver 等工具审计列约束含义。
COMMENT ON COLUMN run_events.event_type IS 'run 事件类型枚举（白名单约束）：loop 事件（agent_* / turn_* / message_* / tool_execution_*）、能力事件（retrieval / workflow_node / pdf_export / mcp_tool_discovered）、服务端生命周期（run_status / run_error）与成本汇总（cost_summary）';
