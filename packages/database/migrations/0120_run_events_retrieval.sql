-- 阶段 5：RAG grounding 的 retrieval trace 事件写入 run_events_v2，事件名保持不变。
alter table run_events_v2
  drop constraint run_events_v2_event_type_check,
  add constraint run_events_v2_event_type_check check (event_type in (
    'agent_start', 'agent_end',
    'turn_start', 'turn_end',
    'message_start', 'message_update', 'message_end',
    'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
    'retrieval',
    'run_status', 'run_error'
  ));

comment on constraint run_events_v2_event_type_check on run_events_v2 is '事件类型：loop 事件对齐 pi AgentEvent，retrieval 为 RAG grounding 专用 trace 事件，run_status/run_error 为服务端生命周期补充';
