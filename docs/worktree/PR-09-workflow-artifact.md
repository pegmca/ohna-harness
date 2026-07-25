# PR-09：Workflow 与 Artifact 持久化

## 目标与启动条件

依赖 PR-00 已合并，可与 PR-01、PR-06 并行。从最新 `origin/master` 创建
`feat/postgres-report-artifacts`，使用 `0070_report.sql`。替换 Workflow、Artifact metadata
和 PDF bytes 的内存 Map。

## 数据与存储

`workflow_runs` 保存 ID、user/conversation/agent run/plan ID、状态、当前节点、结构化错误
和生命周期时间。`workflow_node_runs` 保存 workflow、node ID、attempt、状态、输入/输出
摘要、错误和时间；唯一 `(workflow_run_id,node_id,attempt)`。

`artifacts` 保存 ID、user/conversation/run/workflow ID、kind、status、title、media type、
size/checksum、storage provider/key、受限 text content、metadata、创建/更新时间和 deleted_at。
所有状态使用 CHECK，所有字段逐列中文注释。

在 report 边界定义 Workflow repository、Artifact repository 和 `ArtifactStorage` port。
PostgreSQL 只存 metadata 和受限 Markdown/HTML；PDF bytes 写本地 storage adapter。storage
根目录来自 composition root 配置，key 由服务端随机生成，禁止用户路径。写 PDF 使用同目录
临时文件、fsync/关闭后原子 rename；失败清理临时文件并持久化结构化失败。

下载先按 artifact user 授权，再读取 storage key。删除先软删 metadata；物理文件清理由
后续维护任务处理，避免数据库事务与文件系统伪装成原子事务。

## 测试与验收

- 重启后 Workflow、HTML/Markdown preview 和已生成 PDF 可查询。
- 路径穿越、任意绝对路径、控制字符文件名均被拒绝。
- PDF 失败可重试，不暴露半成品。
- 两个用户不能预览、生成或下载对方 Artifact。
- node attempt 和状态迁移可审计，终态不可回退。
- 内存 Workflow/Artifact/PDF Map 移除或只留测试 adapter。
- 运行 workflow/report/API/database tests、根级 test/typecheck/build。

## 提交与 PR

提交建议：`feat(report): persist workflows and artifacts`。

同步 Report/Workflow note、README 和安全文档。Review Agent 重点检查文件路径边界、数据库
与文件失败补偿、owner 授权和大内容是否错误写入 JSONB。

