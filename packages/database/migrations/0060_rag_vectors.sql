CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE TABLE chunk_embeddings (
  id uuid PRIMARY KEY,
  chunk_id uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  embedding_provider text NOT NULL,
  embedding_model text NOT NULL CHECK (embedding_model = 'deterministic-mock-embedding-v1'),
  dimensions integer NOT NULL CHECK (dimensions = 32),
  embedding public.vector(32) NOT NULL,
  chunk_content_checksum text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (chunk_id, embedding_model, dimensions)
);

CREATE INDEX chunk_embeddings_embedding_hnsw_idx
  ON chunk_embeddings USING hnsw (embedding public.vector_cosine_ops);
CREATE INDEX chunk_embeddings_model_dimensions_idx
  ON chunk_embeddings (embedding_model, dimensions);

COMMENT ON COLUMN chunk_embeddings.id IS 'chunk embedding 主键';
COMMENT ON COLUMN chunk_embeddings.chunk_id IS '所属 chunk 数据库主键，随 chunk 删除级联';
COMMENT ON COLUMN chunk_embeddings.embedding_provider IS '生成向量的 provider 标识；当前工程闭环为 deterministic mock';
COMMENT ON COLUMN chunk_embeddings.embedding_model IS '生成向量的模型标识，用于隔离不同模型的向量语义';
COMMENT ON COLUMN chunk_embeddings.dimensions IS '向量维度；当前固定为 32，其他维度必须使用兼容 migration 或模型专用列';
COMMENT ON COLUMN chunk_embeddings.embedding IS '固定 32 维 embedding 向量，使用 cosine 距离检索';
COMMENT ON COLUMN chunk_embeddings.chunk_content_checksum IS '生成向量时对应的 chunk 正文 SHA-256 校验和，用于阻止复用过期向量';
COMMENT ON COLUMN chunk_embeddings.created_at IS '当前向量版本创建或因正文校验和变化而刷新的时间';
