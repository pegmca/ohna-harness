-- 0250: 将 chunk_embeddings 向量列从 vector(1536) 改为 halfvec(2048)，支持 2048 维模型。
--
-- 背景：pgvector 的 vector 类型 HNSW 索引最多支持 2000 维；
-- nvidia/llama-nemotron-embed-vl-1b-v2 输出 2048 维，超出 vector 类型 HNSW 限制。
-- halfvec 类型（半精度浮点）HNSW 最多支持 4000 维，可容纳 2048 维且占用更少存储。
--
-- 0070 把向量列固定为 vector(1536)（OpenAI text-embedding-3-small 约定）；
-- 本迁移将列改为 halfvec(2048)，CHECK 放宽至 <= 2048，HNSW 算子类改为 halfvec_cosine_ops。
-- vector→halfvec 支持隐式转换，但维度不同时无法原地 resize，需先 TRUNCATE（embedding 为派生数据，可重新 ingest）。
--
-- 幂等：所有 DDL 用 IF EXISTS / 守卫包裹，重复运行不报错。
-- 事务：本迁移由 migrate.ts 在单事务内执行，故不使用 CREATE INDEX CONCURRENTLY（事务块内不允许），
-- 与 0060/0070 的普通 CREATE INDEX 保持一致。

-- HNSW 索引依赖向量列维度，变更列类型前必须删除。
DROP INDEX IF EXISTS chunk_embeddings_embedding_hnsw_idx;

-- 解除 0070 的维度 CHECK 约束，准备放宽到 2048。
ALTER TABLE chunk_embeddings
  DROP CONSTRAINT IF EXISTS chunk_embeddings_dimensions_check;

-- 检测当前列类型：如果不是 halfvec(2048) 则需要变更。
-- halfvec 的 typmod 计算方式与 vector 相同（atttypmod = 维度数）。
-- vector→halfvec 跨类型转换需要显式 ALTER COLUMN TYPE，维度不同时无法自动转换，
-- 因此 TRUNCATE 清空旧向量（embedding 是派生数据，重新 ingest 可恢复）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
     WHERE a.attrelid = 'chunk_embeddings'::regclass
       AND a.attname = 'embedding'
       AND t.typname = 'halfvec'
       AND a.atttypmod = 2048
  ) THEN
    IF EXISTS (SELECT 1 FROM chunk_embeddings) THEN
      RAISE NOTICE '0250: chunk_embeddings 含旧类型/维度向量，迁移将清空并需要重新 ingest';
      TRUNCATE chunk_embeddings;
    END IF;
    ALTER TABLE chunk_embeddings
      ALTER COLUMN embedding TYPE public.halfvec(2048);
  END IF;
END $$;

-- 放宽维度校验：>0 且 <= 2048，覆盖 1536 与 2048 维生产模型。
-- ADD CONSTRAINT 不支持 IF NOT EXISTS，先 DROP IF EXISTS 保证重复运行幂等。
ALTER TABLE chunk_embeddings
  DROP CONSTRAINT IF EXISTS chunk_embeddings_dimensions_check;
ALTER TABLE chunk_embeddings
  ADD CONSTRAINT chunk_embeddings_dimensions_check
  CHECK (dimensions > 0 AND dimensions <= 2048);

-- 重建 HNSW 余弦索引，halfvec 类型使用 halfvec_cosine_ops 算子类。
CREATE INDEX IF NOT EXISTS chunk_embeddings_embedding_hnsw_idx
  ON chunk_embeddings USING hnsw (embedding public.halfvec_cosine_ops);

-- 中文注释：字段语义变更需同步更新，便于 DBeaver 等工具直接展示。
COMMENT ON COLUMN chunk_embeddings.dimensions IS '向量维度；生产支持 1536 或 2048，宽松 CHECK 仅约束 0<dimensions<=2048';
COMMENT ON COLUMN chunk_embeddings.embedding IS 'chunk embedding 向量，使用 halfvec 半精度类型 + cosine 距离检索；固定为 halfvec(2048) 维，覆盖 nvidia/llama-nemotron-embed-vl-1b-v2（2048）与 OpenAI text-embedding-3-small（1536）。halfvec HNSW 最多支持 4000 维，优于 vector 类型的 2000 维限制';
