# PR-01：Conversation / Message 领域与持久化

## 目标与启动条件

依赖 PR-00 已合并。从最新 `origin/master` 创建 `feat/postgres-conversation`，使用
`0010_conversation.sql`。本 PR 只提供领域模型、repository 和 PostgreSQL adapter，不接 Web。

## 数据模型

`conversations`：

- `id uuid PK`、`user_id uuid FK users ON DELETE CASCADE`
- `title text`、`status text CHECK(active, archived)`
- `created_at`、`updated_at`、`last_message_at`、`archived_at`
- 索引 `(user_id, status, last_message_at DESC, id DESC)`

`messages`：

- `id uuid PK`、`conversation_id uuid FK conversations ON DELETE CASCADE`
- `user_id uuid FK users ON DELETE CASCADE`
- `run_id uuid NULL`，本 PR 暂不加 Run 外键，由 PR-03 补充
- `role text CHECK(user, assistant, system, tool)`
- `content text`、`status text CHECK(pending, streaming, completed, failed, cancelled)`
- `client_message_id text NULL`、`sequence bigint`
- `created_at`、`completed_at`
- 唯一 `(conversation_id, sequence)`
- 对非空 client ID 建唯一部分索引 `(conversation_id, client_message_id)`

所有字段在 migration 中逐列添加中文 `COMMENT ON COLUMN`。

## 领域与接口

新建 `packages/conversation`，定义 Conversation、Message、cursor page、结构化错误以及
`ConversationRepository` / `MessageRepository`。方法必须从签名要求 `userId`：

- create/list/find/updateTitle/archive conversation
- append/list/find message
- `appendUserMessageIdempotently` 返回 created 或 existing

cursor 使用 `(lastMessageAt,id)` 和 `(sequence,id)`，服务端编码但不暴露数据库 offset。
message sequence 在事务中锁定 conversation 后分配。重复 client ID 返回原消息，不抛冲突。
adapter 放在 `packages/database` 的独立领域文件，公共入口只导出 factory。

## 测试与验收

- 两个用户不能查询、更新或归档对方会话。
- 相同时间的会话分页依靠 ID 稳定，无重复或遗漏。
- 并发相同 client ID 只创建一条消息。
- 并发不同消息获得唯一且递增的 sequence。
- 归档幂等；归档会话仍可按 ID 读取但不出现在 active 列表。
- migration、schema 和 adapter 字段一致，所有字段有中文注释。
- 运行 conversation/database package tests、相关 typecheck、根级 `pnpm typecheck`。

## 提交与 PR

提交建议：`feat(conversation): add postgres conversation repository`。

PR 不得修改 Workbench 或 Run API。Review Agent 重点检查所有权是否在 SQL 条件中实现、
cursor 稳定性、sequence 并发和 `run_id` 后续兼容性。

