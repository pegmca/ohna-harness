# PR-10：Runtime 集成、恢复与全链路验证

## 目标与启动条件

依赖 PR-02 至 PR-09 全部合并。从最新 `origin/master` 创建
`feat/postgres-runtime-integration`。本 PR 不重新设计领域模型，只统一生产 composition、
删除遗留内存事实源并提供恢复和运维证据。

## Runtime 集成

- `createDatabaseRuntime` 暴露 Conversation、Run、Trace、Approval、RAG、Workflow、
  Artifact、Citation repositories；共享一个受控连接池。
- `apps/api/src/server.ts` 作为唯一生产 composition root 注入 dependencies；领域 package
  不读取 `DATABASE_URL`。
- 默认 runtime 使用 PostgreSQL。内存 repository 只由测试显式创建；live bus、
  execution registry 继续留在内存。
- startup 在开始接流量前完成 migration 状态检查和陈旧 Run 恢复；readiness 同时验证
  PostgreSQL 和必要 storage。
- graceful shutdown 先停止接收新 Run，等待有限 drain，标记未完成任务为 interrupted，
  关闭 event subscribers、storage 和 pool。
- 删除旧 API composition 中残留的事实源 Map 和不可达兼容路径。
- 收口 PR-05 遗留边界：Approval decision 与 approval decided trace event 追加不在同一
  DB 事务（decide 提交后由 endpoint 旁路 append，Run 终态时事件可能缺失），需在 runtime
  整合时统一事务或 outbox 语义。

## 全链路验证

建立根目录 `test/` 下的人工/自动验证入口，覆盖：

1. bootstrap identity，创建 conversation，提交 message/run。
2. 观察 SSE，主动断线并按 sequence 重连。
3. 读取 message、Run、Trace、Approval、Workflow、Artifact、Citation。
4. ingest 文档并执行 pgvector/hybrid retrieval。
5. 重启 API 后重复读取，确认终态和文件仍存在。
6. 构造两个用户验证所有详情、下载、审批、citation 越权失败。
7. 并发重复提交验证幂等，取消/成功竞争验证单一终态。
8. 执行 `pg_dump` 到临时文件，恢复到独立空测试库并核对关键行数、外键和抽样内容。
9. PostgreSQL 不可用时 readiness 为 503，API 返回稳定错误且不泄漏 `pg` exception。

执行 `pnpm architecture:check`、`pnpm typecheck`、`pnpm test`、`pnpm build`、
`pnpm smoke:compose`。若环境导致某项无法执行，PR 必须给出具体阻塞和替代证据。

## 文档与验收

- 更新 README 的持久化现状和本地验证方式。
- 更新 ARCHITECTURE runtime view，明确数据库事实源与 live 内存状态。
- 更新持续学习路线的 acceptance evidence。
- 更新 Conversation、Run/SSE、Trace、RAG、Workflow/Artifact 对应 notes。
- `` 补充最终真实表和运维命令时，以实现为准，不复制本目录任务卡。

完成标准：生产 composition 不再使用目标领域的内存事实源；重启、重连、并发、越权、备份
恢复和故障验证全部有证据。

## 提交与 PR

提交建议：`feat(api): integrate postgres persistence runtime`。

Review Agent 重点检查是否仍有隐藏内存事实源、shutdown/recovery 竞态、测试是否真正跨重启、
文档是否反映实际实现。该 PR 通过前不得宣称“会话链路与 RAG 已全部落库”。
