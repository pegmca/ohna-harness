# PR-00：PostgreSQL 工程基线

## 目标与启动条件

本任务是所有持久化 PR 的前置任务，从最新 `origin/master` 创建
`chore/postgres-foundation`。只建立 migration、integration test 和 repository 错误基线，
不创建 Conversation、Run、RAG 等业务表。

## 设计与实现

- 检查 `packages/database/src/migrate.ts`，确保每个 migration 在事务内执行，只有成功后才写
  `__aiagent_migrations`；失败输出包含 migration 文件名但不泄漏连接串。
- 建立数据库 integration test helper。测试必须使用明确的独立测试数据库 URL，启动前拒绝
  与开发 `DATABASE_URL` 相同的数据库名；测试结束只清理测试创建的数据或 schema。
- 定义小型 repository 错误 contract，至少区分 `conflict`、`not_found`、
  `database_unavailable`、`invalid_state_transition`，保留可诊断的内部 cause 但不进入 UI。
- 提取通用 PostgreSQL row 时间映射、唯一约束识别和事务 helper，避免后续 adapter 复制。
- 增加 migration 静态检查：新增表中的每个列名都必须在同一 SQL 文件出现对应
  `COMMENT ON COLUMN ... IS '中文说明'`。
- 在数据库 package 的测试/文档中固定后续 migration 编号：
  `0010` Conversation、`0020` Run、`0030` Trace、`0040` Approval、`0050` RAG documents、
  `0060` vector、`0070` Report、`0080` Citation。

不要引入新的生产数据库依赖，不修改 Identity repository 公共行为，不执行真实开发库清理。

## 测试与验收

- 空测试库执行全部 migration 成功。
- 第二次执行 migration 不重复应用。
- 故意失败的测试 migration 回滚，且不会写入 migration 清单。
- 非测试数据库保护逻辑会拒绝危险清理。
- COMMENT 检查能识别缺失注释的 fixture。
- 运行 database package test/typecheck，以及根级 `pnpm typecheck`。

## 提交与 PR

提交建议：`chore(database): establish persistence test foundation`。

PR 必须列出测试数据库安全约束、migration 事务语义、错误 contract 和后续 migration
编号。Review Agent 重点检查测试是否可能误删开发数据，以及 helper 是否把 `pg` 类型泄漏到
领域 package。

