-- 0270: 新增长期情节记忆表 memory_episodes，支持跨实例共享的 episodic memory（PG + pgvector）。
--
-- 背景（docs/v1.2 §3 差距#4「向量/记忆索引进程内」）：@aiagent/memory 此前只有进程内的
-- InMemory / Jsonl 实现，episode 记忆随进程退出或跨实例即丢失，无法支撑「跨会话长期记忆」
-- 这一生产级分水岭能力。本迁移把情节记忆外置到 PG，配合 packages/memory 的 PgVectorMemoryStore
-- （注入 QueryExecutor、本地确定性 32 维 embedder）实现跨实例共享。
--
-- 策略：
-- 1) 复用 pgvector 扩展（0060 已 CREATE EXTENSION vector；此处 IF NOT EXISTS 幂等）。
-- 2) 向量列用 halfvec(32) 半精度，维度与 database 包 POSTGRES_RAG_VECTOR_DIMENSIONS 对齐；
--    embedding 由本地确定性 embedder 生成（hashing trick，零依赖），未来可替换为真实语义嵌入。
-- 3) owner_user_id 允许 NULL：学习原型共享记忆、未做多租户；但所有读写都用
--    `owner_user_id IS NOT DISTINCT FROM $owner` 过滤，未来按 owner 隔离零改动。
-- 4) IVFFlat 余弦索引为生产化预备：学习原型数据量小可接受顺序扫描，索引即便存在也对少量
--    数据退化为顺序扫描，不影响正确性；量大后再评估改用 HNSW。
-- 注意：本迁移只新增独立表，不改动任何既有表结构或数据。

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE TABLE memory_episodes (
  id text PRIMARY KEY,                      -- 情节记忆主键（EpisodeId，对齐 @aiagent/types RequestId）
  owner_user_id uuid,                       -- 归属用户；NULL 表示共享记忆（学习原型未做多租户）
  type text NOT NULL,                       -- 记忆类型：observation/decision/result
  content text NOT NULL,                    -- 记忆文本（检索与注入最小单元）
  embedding public.halfvec(32) NOT NULL,    -- 确定性 32 维嵌入向量（pgvector 余弦检索）
  source_turn integer,                      -- 来源轮次（可选，回溯用）
  metadata jsonb,                           -- 业务元数据（工具参数、isError 等）
  created_at timestamptz NOT NULL DEFAULT now()  -- 写入时间
);

CREATE INDEX memory_episodes_owner_idx ON memory_episodes (owner_user_id);
-- 余弦最近邻索引（IVFFlat；学习原型数据量小可接受顺序扫描，索引为生产化预备）
CREATE INDEX memory_episodes_embedding_idx ON memory_episodes USING ivfflat (embedding public.halfvec_cosine_ops) WITH (lists = 10);

COMMENT ON COLUMN memory_episodes.id IS '情节记忆主键（EpisodeId，对齐 @aiagent/types 的 RequestId，去重稳定）';
COMMENT ON COLUMN memory_episodes.owner_user_id IS '归属用户；NULL 表示共享记忆（学习原型未做多租户，未来按 owner 隔离零改动）';
COMMENT ON COLUMN memory_episodes.type IS '记忆类型标签：observation（观察）/ decision（决策）/ result（结果）';
COMMENT ON COLUMN memory_episodes.content IS '记忆文本，是检索与注入 LLM 上下文的最小内容单元';
COMMENT ON COLUMN memory_episodes.embedding IS '确定性 32 维嵌入向量（halfvec），由本地 hashing-trick embedder 生成；未来可替换为真实语义嵌入';
COMMENT ON COLUMN memory_episodes.source_turn IS '来源轮次（可选），用于回溯该记忆产生于哪一轮工具调用或决策';
COMMENT ON COLUMN memory_episodes.metadata IS '任意业务元数据（如工具参数 toolArgs、isError 标记等），jsonb 便于扩展';
COMMENT ON COLUMN memory_episodes.created_at IS '记忆写入时间（timestamptz，默认 now()），同时作为 listEpisodes 的排序依据';
