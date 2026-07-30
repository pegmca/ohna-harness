# 05 · Postgres 存储重建：线性消息模型

本文描述会话持久层的推倒重建：废弃现有 entry 式多表拼装，改为「线性消息 + run + append-only run 事件」三张主表，与 pi 的中间表示（`Message`）直接对齐，但**不采用 pi 的 entry 树 / 文件会话**。审批体系相关表随 schema 一起删除。

## 现状

本项目持久层在 `packages/database/`，migration 以编号 SQL 文件管理（`packages/database/migrations/`，由 `src/migrate.ts` 顺序执行，`src/migration-lint.ts` 强制每个字段带 `COMMENT ON COLUMN`）。

当前核心表（均为真实文件）：

- `migrations/0010_conversation.sql`：`conversations`（id/user_id/title/status/时间戳）与 `messages`（`role ∈ user|assistant|system|tool`、`content text` 纯文本、`status` 流式状态机、`client_message_id` 幂等键、`sequence` 会话内单调序号）。
- `migrations/0020_runs.sql`：`agent_runs`（状态机 `queued|running|waiting_approval|succeeded|failed|cancelled`，`user_message_id` / `assistant_message_id` 双消息指针，`version` 乐观锁）与 `run_events`（`event_type ∈ run_status|trace_event|run_result|run_error`，`(run_id, sequence)` 唯一，payload 为脱敏后的 envelope，是 SSE 重放源）。同文件还给 `messages.run_id` 补了外键，并用部分唯一索引保证「每个 run 最多一条 assistant 消息」。
- `migrations/0030_trace.sql`：`traces` + `trace_events`（span/父子 span/stage，独立的 trace 序号体系）。
- `migrations/0040_approval.sql`：`tool_approvals`（pending/approved/rejected/expired 审批状态机，本次改造删除）。
- `migrations/0090_run_model.sql`：`agent_runs.model_id`。
- `migrations/0100_message_attachments.sql`：`chat_attachment_uploads` + `message_attachments`（附件与 `messages` 绑定，RAG grounding 用，**保留**）。

Repository 层（`packages/database/src/`）：

- `conversation-repository.ts`（522 行）：`createPostgresConversationRepositories`，消息 `append` / `appendUserMessageIdempotently` / `list`（游标分页）/ `find`。
- `run-repository.ts`（426 行）：实现 `apps/api/src/application/run-ports.ts` 的 `RunStore` 端口（`create` / `append` / `listEvents` / `recoverStale`）。
- `trace-repository.ts`（192 行）：`createPostgresTraceStore`，`initialize` / `append` / `finalize`。
- `approval-repository.ts` + `approval-decision.ts`（删除对象）。
- `schema.ts`（463 行）：drizzle 风格的 TS 表镜像，与 SQL migration 双写维护。

主要痛点：

1. `messages.content` 是纯 text，assistant 消息的 toolCall / thinking / 多 content 块无处安放，tool 结果用 `role='tool'` 塞文本，与 pi 的 `AssistantMessage.content: ContentBlock[]`、`ToolResultMessage` 结构无法对应，重建 LLM 上下文时要做有损转换。
2. `messages.status`（pending/streaming/completed/...）把「一条 assistant 消息」建模成单条可被流式更新的行，而 pi 模型里一次 run 产生多条消息（user → assistant → toolResult → assistant …），当前用 `messages_run_assistant_uq` 强行限定一 run 一 assistant 消息，与多轮 tool loop 冲突。
3. `traces` / `trace_events` 与 `run_events` 是两套并行的事件序号体系，SSE 重放源和 trace 详情源割裂；新 loop 事件（`agent_start|turn_start|message_start|...`）落到哪张表不清晰。
4. `waiting_approval` 状态、`tool_approvals` 表、approval repository 整条链路随审批体系删除。

## pi 参照

pi 的会话持久化在 coding-agent 层，是**本地 JSONL 文件 + entry 树**，不是数据库：

- `badlogic/packages/coding-agent/src/core/session-manager.ts`：
  - entry 类型（约 L30–L150）：`SessionMessageEntry`（`type:"message"`，内嵌完整 `AgentMessage`）、`CompactionEntry`（`summary` + `firstKeptEntryId` + `tokensBefore`）、`BranchSummaryEntry`、`CustomEntry`、`LabelEntry` 等，每个 entry 带 `id` + `parentId`，构成树。
  - `buildContextEntries`（约 L417–L460）：上下文重建投影——沿 leaf 到 root 取路径，找到**最后一个 compaction entry**，输出 `[compaction] + (firstKeptEntryId 起被保留的 entries) + compaction 之后的所有 entries`。
  - `sessionEntryToContextMessages`（约 L383–L408）：compaction entry 投影为 `createCompactionSummaryMessage(...)` 产生的特殊 user 消息；branch_summary 同理。
  - `SessionManager.branch(branchFromId)`（约 L1360）：树结构存在的核心理由——从任意历史 entry 分叉。
- `badlogic/packages/coding-agent/src/core/messages.ts`：`createCompactionSummaryMessage` / `createCustomMessage` 把特殊 entry 转成可进 LLM 上下文的消息。
- `badlogic/packages/coding-agent/src/core/compaction/compaction.ts`：compaction 生成逻辑（本文只涉及其落库形态，loop 内的触发入口见 04 文档）。
- `badlogic/packages/agent/src/types.ts`（L422–L444）：`AgentEvent` 事件全集——`agent_start|agent_end|turn_start|turn_end|message_start|message_update|message_end|tool_execution_start|tool_execution_update|tool_execution_end`。这是 `run_events.event_type` 的对齐基准。

**我们不照搬的部分**：entry 树 + `parentId` + JSONL 文件。理由见取舍论证。我们借用的是：(a) 消息中间表示直接存 `Message`（content 块数组）；(b) compaction 作为特殊消息参与投影的规则「最后一个 compaction + 其后消息」；(c) loop 事件命名。

## 目标设计

### 总体形态

新 migration 目录从零编号（见迁移策略）。四张主表：`conversations` / `messages` / `runs` / `run_events`。`traces`/`trace_events` 不再单独建表——trace 汇总降为 `runs` 上的计数列，trace 明细事件即 `run_events` 中 `event_type` 为 loop/trace 类的事件行（SSE 重放与 trace 详情同源）。附件两表（`chat_attachment_uploads`、`message_attachments`）与 RAG 两表（`documents`、`document_chunks`）沿用，仅外键改指新表。

### SQL 草案

```sql
-- conversations：会话主体，与现状基本一致
CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_message_at timestamptz NOT NULL,
  archived_at timestamptz
);
COMMENT ON COLUMN conversations.id IS '会话唯一标识';
COMMENT ON COLUMN conversations.user_id IS '会话所属用户标识';
COMMENT ON COLUMN conversations.title IS '用户可见的会话标题';
COMMENT ON COLUMN conversations.status IS '会话状态：active 活跃、archived 已归档';
COMMENT ON COLUMN conversations.created_at IS '会话创建时间';
COMMENT ON COLUMN conversations.updated_at IS '会话最近更新时间';
COMMENT ON COLUMN conversations.last_message_at IS '最后一条消息时间，用于会话列表稳定排序';
COMMENT ON COLUMN conversations.archived_at IS '归档时间，未归档为空';

-- messages：线性消息，role 对齐 pi 中间表示，content 存 content 块数组
CREATE TABLE messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'toolResult')),
  content jsonb NOT NULL,
  message_type text NOT NULL DEFAULT 'normal' CHECK (message_type IN ('normal', 'compaction')),
  client_message_id text,
  sequence bigint NOT NULL,
  usage jsonb,
  model_id text,
  stop_reason text,
  error_message text,
  created_at timestamptz NOT NULL,
  CONSTRAINT messages_conversation_sequence_uq UNIQUE (conversation_id, sequence)
);
CREATE UNIQUE INDEX messages_conversation_client_message_uq
  ON messages(conversation_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX messages_conversation_sequence_idx ON messages(conversation_id, sequence);

COMMENT ON COLUMN messages.id IS '消息唯一标识';
COMMENT ON COLUMN messages.conversation_id IS '所属会话标识';
COMMENT ON COLUMN messages.user_id IS '所属用户标识，用于数据库层授权过滤';
COMMENT ON COLUMN messages.run_id IS '产生该消息的 Run 标识；客户端手工发送的用户消息可为空';
COMMENT ON COLUMN messages.role IS '消息角色，对齐 pi Message：user、assistant 或 toolResult';
COMMENT ON COLUMN messages.content IS 'pi content 块数组（text/thinking/toolCall 等）的 JSONB 投影；toolResult 行存 toolCallId/toolName/content/isError';
COMMENT ON COLUMN messages.message_type IS '消息类型：normal 普通消息、compaction 压缩摘要消息（投影进上下文时顶替其前的历史）';
COMMENT ON COLUMN messages.client_message_id IS '客户端提交幂等键，同一会话内唯一';
COMMENT ON COLUMN messages.sequence IS '消息在会话内连续递增序号，由会话级序列分配';
COMMENT ON COLUMN messages.usage IS 'assistant 消息的 token usage（pi Usage 形状），其余角色为空';
COMMENT ON COLUMN messages.model_id IS 'assistant 消息的服务端模型目录标识，其余角色为空';
COMMENT ON COLUMN messages.stop_reason IS 'assistant 消息停止原因（stop/length/toolUse/error/aborted 等）';
COMMENT ON COLUMN messages.error_message IS 'stop_reason 为 error/aborted 时的脱敏错误说明';
COMMENT ON COLUMN messages.created_at IS '消息创建时间';

-- runs：运行状态机，无 waiting_approval
CREATE TABLE runs (
  id uuid PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  model_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('auto', 'report')),
  source text NOT NULL CHECK (source IN ('composer', 'report_button')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
  intent text,
  workflow_run_id text,
  error jsonb,
  last_event_sequence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX runs_user_updated_idx ON runs(user_id, updated_at DESC, id DESC);
CREATE INDEX runs_conversation_idx ON runs(user_id, conversation_id, updated_at DESC, id DESC);
CREATE INDEX runs_active_idx ON runs(updated_at, id) WHERE status IN ('queued', 'running');

COMMENT ON COLUMN runs.id IS 'Run 唯一标识';
COMMENT ON COLUMN runs.request_id IS '创建请求幂等标识，同一标识只创建一个 Run';
COMMENT ON COLUMN runs.user_id IS 'Run 所属用户标识，数据库层授权过滤边界';
COMMENT ON COLUMN runs.conversation_id IS 'Run 所属会话标识';
COMMENT ON COLUMN runs.user_message_id IS '触发 Run 的幂等用户消息标识';
COMMENT ON COLUMN runs.model_id IS '本次 Run 选择的服务端模型目录稳定标识';
COMMENT ON COLUMN runs.mode IS '运行模式：auto 自动、report 研报';
COMMENT ON COLUMN runs.source IS '触发入口：composer 输入框、report_button 研报按钮';
COMMENT ON COLUMN runs.status IS 'Run 状态机：queued 排队、running 运行中、completed 完成、failed 失败、cancelled 用户取消、interrupted 进程中断待恢复，终态不可回退';
COMMENT ON COLUMN runs.intent IS 'Agent 路由后识别的意图';
COMMENT ON COLUMN runs.workflow_run_id IS 'Run 触发的研报工作流标识';
COMMENT ON COLUMN runs.error IS '终态结构化错误（已脱敏）';
COMMENT ON COLUMN runs.last_event_sequence IS '该 Run 已持久化的最大事件序号，崩溃恢复与 SSE 续传的高水位';
COMMENT ON COLUMN runs.created_at IS 'Run 创建时间';
COMMENT ON COLUMN runs.updated_at IS 'Run 最近一次事件更新时间';
COMMENT ON COLUMN runs.started_at IS 'Run 首次进入 running 的时间';
COMMENT ON COLUMN runs.completed_at IS 'Run 首次进入终态的时间';

-- run_events：append-only 事件流，SSE 重放与 trace 详情同源
CREATE TABLE run_events (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type IN (
    'agent_start', 'agent_end',
    'turn_start', 'turn_end',
    'message_start', 'message_update', 'message_end',
    'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
    'run_status', 'run_error'
  )),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT run_events_run_sequence_uq UNIQUE (run_id, sequence)
);
CREATE INDEX run_events_user_run_sequence_idx ON run_events(user_id, run_id, sequence);

COMMENT ON COLUMN run_events.id IS '事件唯一标识';
COMMENT ON COLUMN run_events.run_id IS '事件所属 Run 标识';
COMMENT ON COLUMN run_events.user_id IS '事件所属用户标识，用于数据库层授权过滤';
COMMENT ON COLUMN run_events.conversation_id IS '事件所属会话标识';
COMMENT ON COLUMN run_events.sequence IS '事件在单个 Run 内从 1 连续递增的持久序号，SSE Last-Event-ID 续传基准';
COMMENT ON COLUMN run_events.event_type IS '事件类型，loop 事件对齐 pi AgentEvent 命名；run_status/run_error 为服务端生命周期补充';
COMMENT ON COLUMN run_events.payload IS '经 zod 校验与递归脱敏后的事件完整 envelope';
COMMENT ON COLUMN run_events.created_at IS '事件持久化时间';
```

要点说明：

- `messages.content jsonb` 存 pi `Message.content` 块数组原样投影（含 `toolCall` 块的 `id/name/arguments`），`toolResult` 行的 `toolCallId/toolName/isError` 一并放 content envelope，读回即可直接喂 `convertToLlm`，无需二次转换。
- `messages.status` 删除：消息一旦落库即终态（pi 语义：消息是 immutable 的）；流式中间态只存在于 `run_events`（`message_update`），不写 `messages` 表。assistant 消息在 `message_end`（或 run 终态兜底）时一次性落库。
- `runs.status` 用 `completed` 替换 `succeeded`（与 pi「run 结束」语义对齐，同时避免和旧数据枚举混淆），删除 `waiting_approval`，新增 `interrupted`（进程崩溃/部署打断，恢复入口）。
- `version` 乐观锁列由 `last_event_sequence` 高水位替代，append 事件同事务内 `UPDATE runs SET last_event_sequence = $n` 天然互斥。

### Repository 接口草案

```ts
/** 消息存储端口：线性 append + 投影读取。 */
export interface MessageStore {
  /** 追加一条终态消息；sequence 由会话级序列在事务内分配。 */
  append(input: AppendMessageInput): Promise<StoredMessage>;
  /** 以 client_message_id 幂等写入用户消息；冲突时返回既有行（created=false）。 */
  appendUserMessageIdempotently(input: AppendUserMessageInput): Promise<{ message: StoredMessage; created: boolean }>;
  /** 时间线读取（UI 用）：按 sequence 游标分页，含 compaction 消息原样返回。 */
  list(input: ListMessagesInput): Promise<CursorPage<StoredMessage>>;
  /**
   * LLM 上下文投影（agent loop 用）：
   * 取会话内最后一个 message_type='compaction' 的消息 + 其 sequence 之后的全部 normal 消息；
   * 无 compaction 时返回全量。返回顺序按 sequence 升序，直接可转 pi Message[]。
   */
  listForContext(conversationId: string): Promise<StoredMessage[]>;
}

/** 消息存储记录：数据库行到 pi Message 的一对一投影。 */
export interface StoredMessage {
  id: string;
  conversationId: string;
  runId: string | null;
  role: "user" | "assistant" | "toolResult";
  /** pi content 块数组投影；toolResult 含 toolCallId/toolName/isError。 */
  content: unknown;
  messageType: "normal" | "compaction";
  clientMessageId: string | null;
  sequence: number;
  usage?: Usage;          // 仅 assistant
  modelId?: string;       // 仅 assistant
  stopReason?: string;    // 仅 assistant
  createdAt: string;
}

/** 运行存储端口：对齐现有 RunStore，事件类型换为新 loop 事件。 */
export interface RunStore {
  create(input: CreateRunInput): Promise<{ run: RunSnapshot; created: boolean }>;
  findById(userId: string, runId: string): Promise<RunSnapshot | undefined>;
  /** 追加事件：同事务分配 sequence、更新 runs.last_event_sequence、必要时推进 runs.status。 */
  appendEvent(userId: string, runId: string, event: AgentRunEventInput): Promise<StoredRunEvent | undefined>;
  /** SSE 重放源：返回 sequence > afterSequence 的全部事件，升序。 */
  listEvents(userId: string, runId: string, afterSequence: number): Promise<StoredRunEvent[] | undefined>;
  /** 崩溃恢复：把 updatedAt 早于 before 的非终态 run 标记 interrupted 并补 run_status 事件。 */
  recoverStale(before: string, occurredAt: string): Promise<StoredRunEvent[]>;
}
```

### Compaction 落库与投影规则

- compaction 发生时，loop 产出的摘要作为一条 `role='user'`、`message_type='compaction'` 的消息写入 `messages` 表（content 为单 text 块，文本即 pi `createCompactionSummaryMessage` 同款包裹格式），`run_id` 指向触发它的 run，正常占一个 `sequence`。
- **上下文重建**：`listForContext` 取「最后一个 compaction 消息 + 其 sequence 之后的全部消息」。与 pi `buildContextEntries` 等价，但线性模型下无需 `firstKeptEntryId` 指针——pi 需要它是因为压缩可能保留树中部的旧 entry；线性表只按时间序追加，compaction 之前的消息一律不进上下文，无例外。
- **UI 时间线**：`list` 返回全量（含 compaction 行），前端把 compaction 行渲染为可折叠的「历史已压缩」分隔条，被压缩的旧消息仍可见。
- 不做分支（branch）：线性表天然不支持，也不提供「从某条消息重开」入口；需要重问就发新消息。这是相对 pi 的能力删减，见取舍。

### SSE fan-out 改造点

沿用现有 `RunEventBus` 端口（`apps/api/src/application/run-ports.ts` L21–24：`publish` / `subscribe`）与「先落库后广播」的顺序不变，改造集中在三处：

1. **事件载荷换型**：`AgentRunStreamEventDto` 的 `type` 从 `run_status|trace_event|run_result|run_error` 换成新 `run_events.event_type` 枚举；`trace_event` 包装层删除，loop 事件直接作为顶层事件发布。`packages/trace` 的 trace 事件体系随之收敛（详见 06 文档），数据库层不再维护 `traces`/`trace_events` 表。
2. **重放源不变**：`apps/api/src/http/routes/runs.ts` 的 SSE handler 继续走 `listEvents(afterSequence)` → `subscribe(runId)` 两段式（补发 + 实时），`Last-Event-ID` 仍映射 `run_events.sequence`。因 `sequence` 语义与唯一约束未变，断线续传逻辑零改动。
3. **run 终态推导**：`run-service.ts` 目前消费 `run_result/run_error` 推进状态机；改为消费 `agent_end`（正常终态）与 `run_error`（异常终态），`run_status` 仅保留 queued→running 与 interrupted 恢复两类服务端事件。

### 迁移策略

- **推倒重来**：新建 migration 目录起点（如 `migrations/v2/0001_init.sql` 或将现有文件移入 `migrations/legacy/`），新 schema 从 0001 重新编号；`schema.ts` 的表镜像同步重写，删除 `tool_approvals`、`traces`、`trace_events` 镜像。
- **旧数据不迁移**：学习/原型阶段接受丢数据；部署时 drop 旧库或换库名。`migrate.ts` 增加「 legacy 表存在则拒绝启动并提示清库」的保护，避免新旧表混跑。
- 附件/RAG 四表（`documents`、`document_chunks`、`chat_attachment_uploads`、`message_attachments`）的 DDL 原样并入新初始 migration，仅外键指向新 `messages.id`；历史附件数据随旧库一起丢弃。

## 取舍论证

- **线性表 vs pi 的 entry 树**：pi 用树是为 `branch()`（任意历史点分叉重试）和 JSONL append-only 文件格式服务。我们是 Postgres 多用户 Web 产品：分叉需求不存在（重问=新消息），且树在 SQL 里要靠递归 CTE 重建路径，复杂度远高于 `ORDER BY sequence`。线性表让投影规则退化为一条 `WHERE sequence > (SELECT max(sequence) ... WHERE message_type='compaction')`，这是本次设计最大的简化来源。
- **content jsonb vs 拆 tool_calls 子表**：content 块数组只在「整读整写」场景使用（loop 重建上下文、UI 渲染整行），从不按块查询；jsonb 避免 N+1 join，且与 pi `Message` 序列化零转换。代价是 DB 层无法按 toolName 统计——该需求由 `run_events.tool_execution_*` 事件承担。
- **消息落库即终态 vs 旧 messages.status 流式更新**：pi 语义下消息 immutable，流式增量只属于事件流。单行流式更新（旧设计）会把「消息」和「事件」两个关注点揉进一张表，且与多消息 run 冲突。代价是崩溃时最后一条未完成的 assistant 消息不落库——由 `run_events` 重放可恢复 UI 展示，上下文重建自然跳过残次消息，语义反而更干净。
- **trace 并入 run_events vs 双轨**：现有 `traces/trace_events` 与 `run_events` 是同一事实的两次持久化（序号、脱敏、授权字段全部重复）。新 loop 事件本身就是结构化 trace，双轨没有信息增量。token/工具计数等汇总需要时可由事件流离线聚合，不建实时汇总表（eval 场景直接查事件）。
- **runs.status 增加 interrupted**：崩溃恢复（现有 `recoverStale`）需要区分「用户取消」与「进程死了」，旧 schema 把后者也塞进 failed/cancelled，恢复语义含糊。

## 删除清单

随新 schema 与审批体系移除（路径均已核实存在）：

| 对象 | 路径 |
| --- | --- |
| `tool_approvals` 表 DDL | `packages/database/migrations/0040_approval.sql`（整文件随旧 migration 目录废弃） |
| Approval repository | `packages/database/src/approval-repository.ts`、`packages/database/src/approval-decision.ts` |
| Approval 表 TS 镜像 | `packages/database/src/schema.ts` 中 `toolApprovals` 定义（约 L339–L365） |
| 内存审批适配器 | `apps/api/src/adapters/in-memory-approval-repository.ts` |
| 审批 HTTP 路由 | `apps/api/src/http/routes/approvals.ts`（及 `apps/api/src/server.ts`、`apps/api/src/index.ts` 中的挂载与装配） |
| executor 权限门与审批端口 | `packages/tools/src/executor.ts`（permission 检查段）、`packages/tools/src/approval-repository.ts`、`packages/tools/src/types.ts` 中 permission/approval 类型、`packages/tools/src/tools/sql-query-mock.ts` 的审批模拟 |
| 审批相关 trace 事件 | `packages/trace/src/index.ts` 中 approval/permission 事件类型 |
| 前端审批 UI | `apps/web/src/features/workbench/` 下 `run-process.tsx`、`live-run-projection.ts`、`run-details.tsx`、`chat.tsx`、`Workbench.tsx`、`types.ts`、`format.ts` 中的审批卡片/投影分支 |
| 测试 | `packages/database/test/approval-repository.test.mjs` |
| `traces` / `trace_events` 表 | `packages/database/migrations/0030_trace.sql` 随旧目录废弃；`packages/database/src/trace-repository.ts` 删除（由 run_events 承担，见 06） |
| `messages.status` 列与 `role='system'/'tool'` 枚举 | 新 messages 表不再包含 |
| `runs.status='waiting_approval'` / `'succeeded'` 枚举 | 新 runs 表不再包含 |
