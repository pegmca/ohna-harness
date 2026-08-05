-- 阶段 6：删除旧 schema 并把 _v2 新表重命名为最终名称。
-- 本 migration 在 0110-0150 之后执行，目标是把 conversations_v2 / messages_v2 / runs_v2 / run_events_v2
-- 收敛为 conversations / messages / runs / run_events，并清理 0010-0040、0090 留下的旧表。
-- 所有 DDL 使用 IF EXISTS，保证在全新库（旧表从未存在）和已有双套表的库上都能幂等执行。

-- 1. 删除旧表；表间外键相互引用，使用 CASCADE 避免依赖顺序问题。
drop table if exists trace_events cascade;
drop table if exists traces cascade;
drop table if exists tool_approvals cascade;
drop table if exists run_events cascade;
drop table if exists agent_runs cascade;
drop table if exists messages cascade;
drop table if exists conversations cascade;

-- 2. 新表重命名为最终名称（外键引用会随表名自动指向新名，无需重建）。
alter table if exists conversations_v2 rename to conversations;
alter table if exists messages_v2 rename to messages;
alter table if exists runs_v2 rename to runs;
alter table if exists run_events_v2 rename to run_events;

-- 3. 重命名索引与唯一约束，去掉 _v2 后缀；约束名复杂的 FK 保留原名不影响功能。
alter index if exists conversations_v2_user_status_last_message_idx rename to conversations_user_status_last_message_idx;

alter index if exists messages_v2_conversation_sequence_uq rename to messages_conversation_sequence_uq;
alter index if exists messages_v2_conversation_client_message_uq rename to messages_conversation_client_message_uq;
alter index if exists messages_v2_conversation_sequence_idx rename to messages_conversation_sequence_idx;

alter index if exists runs_v2_request_id_key rename to runs_request_id_key;
alter index if exists runs_v2_user_updated_idx rename to runs_user_updated_idx;
alter index if exists runs_v2_conversation_idx rename to runs_conversation_idx;
alter index if exists runs_v2_active_idx rename to runs_active_idx;

alter index if exists run_events_v2_run_sequence_uq rename to run_events_run_sequence_uq;
alter index if exists run_events_v2_user_run_sequence_idx rename to run_events_user_run_sequence_idx;
