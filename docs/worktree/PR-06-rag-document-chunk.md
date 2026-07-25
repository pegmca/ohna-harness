# PR-06：RAG Document / Version / Chunk 持久化

## 目标与启动条件

依赖 PR-00 已合并，可与 PR-01、PR-09 并行。从最新 `origin/master` 创建
`feat/postgres-rag-documents`，使用 `0050_rag_documents.sql`。本 PR 持久化 ingestion
lineage，仍保留内存 VectorStore。

## 数据模型

`documents` 保存逻辑文档：ID、owner user（共享文档可空）、scope
`private/shared/demo`、source type、external ID、title、创建/更新时间和 deleted_at。

`document_versions` 保存不可变版本：document ID、version、content checksum/content type、
source URI、受控 content/storage 字段、parser version、状态、结构化错误、created/indexed
时间。唯一 `(document_id,version)`，同一文档 checksum 幂等。

`chunks` 保存 version ID、chunk index/text/heading、页码/行号、token count、
chunker version、metadata JSONB、content checksum。唯一
`(document_version_id,chunker_version,chunk_index)`。

所有 scope/status 使用 CHECK，字段逐列中文注释。私有文档随用户删除；共享/demo 文档不
依赖伪造 user ID。

## 领域与运行时

- 在 filings/RAG 对应边界定义 Document、Version、Chunk repository port。
- ingestion 在事务中创建或命中版本，解析/chunking 失败保存结构化失败状态并允许重试。
- 相同 checksum 返回已有版本；内容变化递增 version，不覆盖旧 chunk。
- Data Sources list 改为异步 cursor page，按 owner/scope 授权。
- `DataSourceRuntime` 通过 repository 读取文档/chunk；VectorStore 仍为内存测试实现。
- API 不接收任意本地路径，source URI/content 必须遵守现有 ingestion 安全边界。

## 测试与验收

- 相同内容重复 ingest 不重复建版本/chunk。
- 新内容创建新不可变版本，旧 citation 潜在目标仍存在。
- parsing/chunking 失败可查询、可重试。
- 重启后文档和 chunk 列表仍存在。
- private/shared/demo scope 查询正确，两个用户不能读取对方私有正文。
- 运行 filings/RAG/API/database tests、相关 typecheck、根级 test/typecheck/build。

## 提交与 PR

提交建议：`feat(rag): persist document ingestion lineage`。

同步 RAG note 和 Data Sources 文档。Review Agent 重点检查 checksum 幂等、版本不可变、
scope SQL 条件、原始内容存储和删除策略。

