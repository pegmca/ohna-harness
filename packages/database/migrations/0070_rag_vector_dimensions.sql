-- 0070: 放宽 chunk_embeddings 向量维度，支持生产真实 embedding（1536 维）。
--
-- DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS=1536：与 P1 真实模型（如 OpenAI text-embedding-3-small）
-- 约定一致。0060 把 embedding 锁死为 vector(32) + deterministic-mock 模型；本迁移将列固定为 vector(1536)，
-- 生产写入 1536 维真实 embedding（维度白名单为 [1536]，非 1536 维度需在应用层被结构化错误拦截）。
--
-- 幂等：所有 DDL 用 IF EXISTS / 守卫包裹，重复运行不报错。
-- 事务：本迁移由 migrate.ts 在单事务内执行，故不使用 CREATE INDEX CONCURRENTLY（事务块内不允许），
-- 与 0060 的普通 CREATE INDEX 保持一致。

-- HNSW 索引依赖向量列维度，变更列类型前必须删除（普通 DROP，索引重建在变更后）。
DROP INDEX IF EXISTS chunk_embeddings_embedding_hnsw_idx;

-- 解除 0060 锁死的模型与维度 CHECK 约束。
ALTER TABLE chunk_embeddings
  DROP CONSTRAINT IF EXISTS chunk_embeddings_embedding_model_check;
ALTER TABLE chunk_embeddings
  DROP CONSTRAINT IF EXISTS chunk_embeddings_dimensions_check;

-- 将向量列扩展为 1536 维。vector 类型维度存放在 atttypmod，可直接比较。
-- 若库中存在 32 维旧向量则无法原地 resize：embedding 为可重算派生数据，清空后重新 ingest 即可恢复。
--
-- ⚠️ 一次性、潜在数据丢失迁移（release note）：下方 TRUNCATE 会清空所有遗留 32 维向量。
-- embedding 是派生数据，重新摄取可恢复，但本步不可回滚；仅在从 0060（vector(32)）升级到 0070（vector(1536)）
-- 的首次运行触发。已在 vector(1536) 上的库会跳过 TRUNCATE 与 ALTER。
DO $$
BEGIN
  IF (
    SELECT atttypmod
      FROM pg_attribute
     WHERE attrelid = 'chunk_embeddings'::regclass
       AND attname = 'embedding'
  ) <> 1536 THEN
    IF EXISTS (SELECT 1 FROM chunk_embeddings) THEN
      RAISE NOTICE '0070: chunk_embeddings 含旧维度向量，迁移将清空并需要重新 ingest';
      -- 一次性清空遗留 32 维向量（潜在数据丢失，仅本次升级触发，重新摄取可恢复）。
      TRUNCATE chunk_embeddings;
    END IF;
    ALTER TABLE chunk_embeddings
      ALTER COLUMN embedding TYPE public.vector(1536);
  END IF;
END $$;

-- 宽松维度校验：>0 且 <= 1536，覆盖生产 1536 维并保证未来更小维度可读。
-- ADD CONSTRAINT 不支持 IF NOT EXISTS，先 DROP IF EXISTS 保证重复运行幂等。
ALTER TABLE chunk_embeddings
  DROP CONSTRAINT IF EXISTS chunk_embeddings_dimensions_check;
ALTER TABLE chunk_embeddings
  ADD CONSTRAINT chunk_embeddings_dimensions_check
  CHECK (dimensions > 0 AND dimensions <= 1536);

-- 重建 HNSW 余弦索引（使用 1536 维列类型），与普通 0060 建索引方式一致。
CREATE INDEX IF NOT EXISTS chunk_embeddings_embedding_hnsw_idx
  ON chunk_embeddings USING hnsw (embedding public.vector_cosine_ops);

-- 中文注释：字段语义变更需同步更新，便于 DBeaver 等工具直接展示。
COMMENT ON COLUMN chunk_embeddings.embedding_model IS '生成向量的模型标识，用于隔离不同模型的向量语义；本列已放宽，可写入生产真实模型或 deterministic mock';
COMMENT ON COLUMN chunk_embeddings.dimensions IS '向量维度；生产默认 1536（DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS），宽松 CHECK 仅约束 0<dimensions<=1536';
COMMENT ON COLUMN chunk_embeddings.embedding IS 'chunk embedding 向量，使用 cosine 距离检索；固定为 vector(1536) 维（DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS）。pgvector 列维度创建时固定，非 1536 的生产维度需新增迁移重建列类型与 HNSW 索引，不可原地 resize';

