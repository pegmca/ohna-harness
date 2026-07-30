-- 阶段 3：线性消息 + run 的新持久化 schema（pi 化改造）。
-- 旧表（0000-0100 的 conversations/messages/agent_runs/run_events 等）本阶段保留不 drop，
-- 因此新表统一使用 _v2 后缀避免命名冲突；旧表在阶段 6 统一删除，不做旧数据迁移。

-- conversations_v2：会话主体
create table conversations_v2 (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  title text not null,
  status text not null check (status in ('active', 'archived')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  last_message_at timestamptz not null,
  archived_at timestamptz
);
create index conversations_v2_user_status_last_message_idx
  on conversations_v2(user_id, status, last_message_at desc, id desc);

comment on column conversations_v2.id is '会话唯一标识';
comment on column conversations_v2.user_id is '会话所属用户标识';
comment on column conversations_v2.title is '用户可见的会话标题';
comment on column conversations_v2.status is '会话状态：active 活跃、archived 已归档';
comment on column conversations_v2.created_at is '会话创建时间';
comment on column conversations_v2.updated_at is '会话最近更新时间';
comment on column conversations_v2.last_message_at is '最后一条消息时间，用于会话列表稳定排序';
comment on column conversations_v2.archived_at is '归档时间，未归档为空';

-- messages_v2：线性消息，role 对齐 pi 中间表示，content 存 content 块数组的 JSONB 投影
create table messages_v2 (
  id uuid primary key,
  conversation_id uuid not null references conversations_v2(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  run_id uuid,
  role text not null check (role in ('user', 'assistant', 'toolResult')),
  content jsonb not null,
  message_type text not null default 'normal' check (message_type in ('normal', 'compaction')),
  client_message_id text,
  sequence bigint not null,
  usage jsonb,
  model_id text,
  stop_reason text,
  error_message text,
  created_at timestamptz not null,
  constraint messages_v2_conversation_sequence_uq unique (conversation_id, sequence)
);
create unique index messages_v2_conversation_client_message_uq
  on messages_v2(conversation_id, client_message_id) where client_message_id is not null;
create index messages_v2_conversation_sequence_idx on messages_v2(conversation_id, sequence);

comment on column messages_v2.id is '消息唯一标识';
comment on column messages_v2.conversation_id is '所属会话标识';
comment on column messages_v2.user_id is '所属用户标识，用于数据库层授权过滤';
comment on column messages_v2.run_id is '产生该消息的 Run 标识；客户端手工发送的用户消息可为空';
comment on column messages_v2.role is '消息角色，对齐 pi Message：user、assistant 或 toolResult';
comment on column messages_v2.content is 'pi content 投影的 JSONB：user 为文本或 content 块数组，assistant 为 content 块数组，toolResult 为 toolCallId/toolName/content/isError envelope';
comment on column messages_v2.message_type is '消息类型：normal 普通消息、compaction 压缩摘要消息（投影进上下文时顶替其前的历史）';
comment on column messages_v2.client_message_id is '客户端提交幂等键，同一会话内唯一';
comment on column messages_v2.sequence is '消息在会话内连续递增序号，由会话级行锁在事务内分配';
comment on column messages_v2.usage is 'assistant 消息的 token usage（pi Usage 形状），其余角色为空';
comment on column messages_v2.model_id is 'assistant 消息的服务端模型目录标识，其余角色为空';
comment on column messages_v2.stop_reason is 'assistant 消息停止原因（stop/length/toolUse/error/aborted 等）';
comment on column messages_v2.error_message is 'stop_reason 为 error/aborted 时的脱敏错误说明';
comment on column messages_v2.created_at is '消息创建时间';

-- runs_v2：运行状态机，无 waiting_approval；version 乐观锁由 last_event_sequence 高水位替代
create table runs_v2 (
  id uuid primary key,
  request_id text not null unique,
  user_id uuid not null references users(id) on delete cascade,
  conversation_id uuid not null references conversations_v2(id) on delete cascade,
  user_message_id uuid not null,
  model_id text not null,
  mode text not null check (mode in ('auto', 'report')),
  source text not null check (source in ('composer', 'report_button')),
  status text not null check (status in ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
  intent text,
  workflow_run_id text,
  error jsonb,
  last_event_sequence bigint not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz
);
create index runs_v2_user_updated_idx on runs_v2(user_id, updated_at desc, id desc);
create index runs_v2_conversation_idx on runs_v2(user_id, conversation_id, updated_at desc, id desc);
create index runs_v2_active_idx on runs_v2(updated_at, id) where status in ('queued', 'running');

comment on column runs_v2.id is 'Run 唯一标识';
comment on column runs_v2.request_id is '创建请求幂等标识，同一标识只创建一个 Run';
comment on column runs_v2.user_id is 'Run 所属用户标识，数据库层授权过滤边界';
comment on column runs_v2.conversation_id is 'Run 所属会话标识';
comment on column runs_v2.user_message_id is '触发 Run 的幂等用户消息标识';
comment on column runs_v2.model_id is '本次 Run 选择的服务端模型目录稳定标识';
comment on column runs_v2.mode is '运行模式：auto 自动、report 研报';
comment on column runs_v2.source is '触发入口：composer 输入框、report_button 研报按钮';
comment on column runs_v2.status is 'Run 状态机：queued 排队、running 运行中、completed 完成、failed 失败、cancelled 用户取消、interrupted 进程中断待恢复，终态不可回退';
comment on column runs_v2.intent is 'Agent 路由后识别的意图';
comment on column runs_v2.workflow_run_id is 'Run 触发的研报工作流标识';
comment on column runs_v2.error is '终态结构化错误（已脱敏）';
comment on column runs_v2.last_event_sequence is '该 Run 已持久化的最大事件序号，崩溃恢复与 SSE 续传的高水位';
comment on column runs_v2.created_at is 'Run 创建时间';
comment on column runs_v2.updated_at is 'Run 最近一次事件更新时间';
comment on column runs_v2.started_at is 'Run 首次进入 running 的时间';
comment on column runs_v2.completed_at is 'Run 首次进入终态的时间';

-- run_events_v2：append-only 事件流，SSE 重放与 trace 详情同源
create table run_events_v2 (
  id uuid primary key,
  run_id uuid not null references runs_v2(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  conversation_id uuid not null references conversations_v2(id) on delete cascade,
  sequence bigint not null check (sequence > 0),
  event_type text not null check (event_type in (
    'agent_start', 'agent_end',
    'turn_start', 'turn_end',
    'message_start', 'message_update', 'message_end',
    'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
    'run_status', 'run_error'
  )),
  payload jsonb not null,
  created_at timestamptz not null,
  constraint run_events_v2_run_sequence_uq unique (run_id, sequence)
);
create index run_events_v2_user_run_sequence_idx on run_events_v2(user_id, run_id, sequence);

comment on column run_events_v2.id is '事件唯一标识';
comment on column run_events_v2.run_id is '事件所属 Run 标识';
comment on column run_events_v2.user_id is '事件所属用户标识，用于数据库层授权过滤';
comment on column run_events_v2.conversation_id is '事件所属会话标识';
comment on column run_events_v2.sequence is '事件在单个 Run 内从 1 连续递增的持久序号，SSE Last-Event-ID 续传基准';
comment on column run_events_v2.event_type is '事件类型，loop 事件对齐 pi AgentEvent 命名；run_status/run_error 为服务端生命周期补充';
comment on column run_events_v2.payload is '经递归脱敏后的事件完整 envelope';
comment on column run_events_v2.created_at is '事件持久化时间';

-- messages_v2 与 runs_v2 相互引用（run 指向触发它的用户消息，消息指向产生它的 run），
-- 循环外键必须在两表都创建后用 ALTER TABLE 补齐。
alter table messages_v2
  add constraint messages_v2_run_fk foreign key (run_id) references runs_v2(id) on delete set null;
alter table runs_v2
  add constraint runs_v2_user_message_fk foreign key (user_message_id) references messages_v2(id) on delete restrict;
