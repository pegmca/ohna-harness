-- 阶段 5：report/workflow 回迁为 generate_report 工具后，workflow_node / pdf_export 事件写入 run_events_v2，事件名保持不变。
alter table run_events_v2
  drop constraint run_events_v2_event_type_check,
  add constraint run_events_v2_event_type_check check (event_type in (
    'agent_start', 'agent_end',
    'turn_start', 'turn_end',
    'message_start', 'message_update', 'message_end',
    'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
    'retrieval',
    'workflow_node', 'pdf_export',
    'run_status', 'run_error'
  ));

comment on constraint run_events_v2_event_type_check on run_events_v2 is '事件类型：loop 事件对齐 pi AgentEvent，retrieval 为 RAG grounding 专用事件，workflow_node/pdf_export 为 report 工具发出的研报 workflow 节点与 PDF 导出事件，run_status/run_error 为服务端生命周期补充';
