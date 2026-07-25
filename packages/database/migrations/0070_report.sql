create table workflow_runs (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  conversation_id text not null,
  agent_run_id text not null,
  plan_id text not null,
  workflow_name text not null,
  status text not null check (status in ('pending','running','paused','approved','rejected','succeeded','failed')),
  current_node_id text,
  error jsonb,
  snapshot jsonb not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index workflow_runs_user_updated_idx on workflow_runs(user_id, updated_at desc, id desc);
create index workflow_runs_agent_run_idx on workflow_runs(user_id, agent_run_id);

create table workflow_node_runs (
  id uuid primary key,
  workflow_run_id text not null references workflow_runs(id) on delete cascade,
  node_id text not null,
  node_type text not null,
  title text not null,
  attempt integer not null check (attempt > 0),
  status text not null check (status in ('pending','running','paused','approved','rejected','succeeded','failed','skipped')),
  input_summary jsonb,
  output_summary jsonb,
  error jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer not null check (duration_ms >= 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (workflow_run_id, node_id, attempt)
);

create index workflow_node_runs_workflow_idx on workflow_node_runs(workflow_run_id, created_at, id);

create table artifacts (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  conversation_id text not null,
  agent_run_id text not null,
  workflow_run_id text not null references workflow_runs(id) on delete cascade,
  report_id text not null,
  kind text not null check (kind in ('research_report')),
  status text not null check (status in ('html_preview_only','pdf_ready','pdf_failed')),
  title text not null,
  media_type text not null check (media_type in ('text/html','application/pdf')),
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  checksum_sha256 text,
  storage_provider text check (storage_provider is null or storage_provider in ('local')),
  storage_key text,
  markdown_content text not null,
  html_content text not null,
  payload jsonb not null,
  metadata jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  check (
    (status = 'pdf_ready' and storage_provider is not null and storage_key is not null and checksum_sha256 is not null and size_bytes is not null)
    or status <> 'pdf_ready'
  )
);

create index artifacts_user_updated_idx on artifacts(user_id, updated_at desc, id desc) where deleted_at is null;
create index artifacts_workflow_idx on artifacts(user_id, workflow_run_id) where deleted_at is null;

comment on column workflow_runs.id is 'Workflow 运行唯一标识';
comment on column workflow_runs.user_id is '拥有该 Workflow 的用户标识';
comment on column workflow_runs.conversation_id is '关联会话标识，待会话表合并后由集成任务补充外键';
comment on column workflow_runs.agent_run_id is '触发该 Workflow 的 Agent Run 标识';
comment on column workflow_runs.plan_id is 'Report Planner 计划标识';
comment on column workflow_runs.workflow_name is 'Workflow 定义名称';
comment on column workflow_runs.status is 'Workflow 生命周期状态';
comment on column workflow_runs.current_node_id is '当前或最后执行的节点标识';
comment on column workflow_runs.error is '脱敏后的结构化 Workflow 错误';
comment on column workflow_runs.snapshot is '用于 API 重启后查询的受限 Workflow DTO 快照';
comment on column workflow_runs.started_at is 'Workflow 开始时间';
comment on column workflow_runs.completed_at is 'Workflow 进入终态的时间';
comment on column workflow_runs.created_at is '记录创建时间';
comment on column workflow_runs.updated_at is '记录最后更新时间';
comment on column workflow_node_runs.id is '节点尝试记录唯一标识';
comment on column workflow_node_runs.workflow_run_id is '所属 Workflow 运行标识';
comment on column workflow_node_runs.node_id is 'Workflow 定义中的节点标识';
comment on column workflow_node_runs.node_type is '节点业务类型';
comment on column workflow_node_runs.title is '节点展示标题';
comment on column workflow_node_runs.attempt is '同一节点从 1 开始的执行尝试序号';
comment on column workflow_node_runs.status is '节点尝试状态';
comment on column workflow_node_runs.input_summary is '脱敏且受限的节点输入摘要';
comment on column workflow_node_runs.output_summary is '脱敏且受限的节点输出摘要';
comment on column workflow_node_runs.error is '脱敏后的结构化节点错误';
comment on column workflow_node_runs.started_at is '节点尝试开始时间';
comment on column workflow_node_runs.completed_at is '节点尝试完成时间';
comment on column workflow_node_runs.duration_ms is '节点尝试耗时毫秒数';
comment on column workflow_node_runs.created_at is '节点尝试记录创建时间';
comment on column workflow_node_runs.updated_at is '节点尝试记录最后更新时间';
comment on column artifacts.id is 'Artifact 唯一标识';
comment on column artifacts.user_id is '拥有该 Artifact 的用户标识';
comment on column artifacts.conversation_id is '关联会话标识，待会话表合并后由集成任务补充外键';
comment on column artifacts.agent_run_id is '生成该 Artifact 的 Agent Run 标识';
comment on column artifacts.workflow_run_id is '生成该 Artifact 的 Workflow 运行标识';
comment on column artifacts.report_id is 'Report Planner 计划或报告标识';
comment on column artifacts.kind is 'Artifact 业务类型';
comment on column artifacts.status is 'Artifact 生成状态';
comment on column artifacts.title is 'Artifact 展示标题';
comment on column artifacts.media_type is '当前 Artifact 主要媒体类型';
comment on column artifacts.size_bytes is '外部文件字节数';
comment on column artifacts.checksum_sha256 is '外部文件 SHA-256 校验和';
comment on column artifacts.storage_provider is '外部文件存储适配器类型';
comment on column artifacts.storage_key is '服务端生成的不透明外部存储键';
comment on column artifacts.markdown_content is '受长度限制的 Markdown 预览正文';
comment on column artifacts.html_content is '受长度限制的 HTML 预览正文';
comment on column artifacts.payload is '不含 PDF bytes 的公共 Artifact DTO 快照';
comment on column artifacts.metadata is '非核心扩展元数据';
comment on column artifacts.created_at is 'Artifact 创建时间';
comment on column artifacts.updated_at is 'Artifact 最后更新时间';
comment on column artifacts.deleted_at is 'Artifact 软删除时间，空值表示可见';
