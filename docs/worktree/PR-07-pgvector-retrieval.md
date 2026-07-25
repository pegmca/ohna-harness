# PR-07：pgvector 与 Hybrid Retrieval

## 目标与启动条件

依赖 PR-06 已合并。从最新 `origin/master` 创建 `feat/postgres-pgvector`，使用
`0060_rag_vectors.sql`。实现 PostgreSQL `VectorStore` adapter，不改变 RAG 对外检索语义。

## Schema 与索引

- migration 执行 `CREATE EXTENSION IF NOT EXISTS vector`。
- `chunk_embeddings` 保存 ID、chunk ID、provider、model、dimensions、固定维度 vector、
  chunk content checksum 和 created_at。
- 唯一 `(chunk_id,embedding_model,dimensions)`，确保同一派生版本幂等。
- 当前默认使用 deterministic mock 的 32 维 `vector(32)` 完成工程闭环；真实 embedding
  采用其他维度时必须新增兼容 migration/表或模型专用列，禁止混入该索引。
- 使用 cosine operator class 建 HNSW 索引，并建立 model/dimensions 过滤索引。
- 所有字段逐列中文注释。

## 检索行为

- PostgreSQL adapter 实现现有 `VectorStore`，upsert 校验 vector 长度、model 和 checksum。
- search SQL 先连接 document/version/chunk，按 owner/scope、有效状态、model/dimensions
  过滤，再进行 cosine 排序。
- keyword candidate、hybrid score、rerank 和 citation 构造仍由 `packages/rag` 负责。
- 数据库/维度/模型错误映射为现有结构化 RAG 错误，不泄漏 SQL。
- 保留内存 VectorStore 供单测，不再作为默认 Data Sources 事实源。

## 测试与验收

- 重启后 vector search 结果稳定。
- 不同用户私有向量不串；shared/demo 按规则可检索。
- model 或 dimensions 不一致返回结构化失败。
- upsert 同一 chunk/model 幂等，checksum 变化不能静默复用旧向量。
- RAG eval 不低于合并前 baseline。
- 使用代表性 fixture 执行 `EXPLAIN (ANALYZE, BUFFERS)`，记录索引计划；小数据量 planner
  选择顺序扫描不视为失败，但需保留目标规模验证证据。
- 运行 RAG/eval/database tests、根级 test/typecheck/build。

## 提交与 PR

提交建议：`feat(rag): add pgvector retrieval adapter`。

同步 RAG eval note 和 PostgreSQL 使用文档。Review Agent 重点检查授权过滤是否在向量排序
前完成、维度策略、索引 operator class 和 baseline 证据。

