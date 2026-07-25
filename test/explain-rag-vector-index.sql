\set ON_ERROR_STOP on

DROP SCHEMA IF EXISTS pr07_plan_evidence CASCADE;
CREATE SCHEMA pr07_plan_evidence;
SET search_path = pr07_plan_evidence;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE TABLE documents(id uuid PRIMARY KEY, owner_user_id uuid, scope text NOT NULL, deleted_at timestamptz);
CREATE TABLE document_versions(id uuid PRIMARY KEY, document_id uuid NOT NULL, source_uri text NOT NULL, status text NOT NULL);
CREATE TABLE chunks(id uuid PRIMARY KEY, document_version_id uuid NOT NULL, chunk_index integer NOT NULL, chunk_text text NOT NULL, chunker_version text NOT NULL, metadata jsonb NOT NULL);
CREATE TABLE chunk_embeddings(id uuid PRIMARY KEY, chunk_id uuid NOT NULL, embedding_model text NOT NULL, dimensions integer NOT NULL, embedding public.vector(32) NOT NULL);

INSERT INTO documents SELECT md5('d'||g)::uuid, NULL, 'shared', NULL FROM generate_series(1,10000) g;
INSERT INTO document_versions SELECT md5('v'||g)::uuid, md5('d'||g)::uuid, 'demo/plan/'||g, 'indexed' FROM generate_series(1,10000) g;
INSERT INTO chunks SELECT md5('c'||g)::uuid, md5('v'||g)::uuid, 0, 'fixture '||g, 'plan-v1', '{}'::jsonb FROM generate_series(1,10000) g;
INSERT INTO chunk_embeddings
SELECT md5('e'||g)::uuid, md5('c'||g)::uuid, 'deterministic-mock-embedding-v1', 32,
       ('['||array_to_string(array_fill(((g % 17)::float / 17)::text, ARRAY[32]), ',')||']')::public.vector
FROM generate_series(1,10000) g;

CREATE INDEX chunk_embeddings_embedding_hnsw_idx ON chunk_embeddings USING hnsw (embedding public.vector_cosine_ops);
CREATE INDEX chunk_embeddings_model_dimensions_idx ON chunk_embeddings (embedding_model, dimensions);
ANALYZE;

-- 真实检索形状：MATERIALIZED 强制 owner/scope 与状态过滤先于 cosine 排序。
EXPLAIN (ANALYZE, BUFFERS)
WITH authorized_candidates AS MATERIALIZED (
  SELECT e.id AS embedding_id, e.embedding
  FROM chunk_embeddings e
  JOIN chunks c ON c.id = e.chunk_id
  JOIN document_versions v ON v.id = c.document_version_id
  JOIN documents d ON d.id = v.document_id
  WHERE d.deleted_at IS NULL
    AND v.status = 'indexed'
    AND (d.scope IN ('shared','demo') OR (d.scope = 'private' AND d.owner_user_id = NULL::uuid))
    AND e.embedding_model = 'deterministic-mock-embedding-v1'
    AND e.dimensions = 32
)
SELECT embedding_id
FROM authorized_candidates
ORDER BY embedding OPERATOR(public.<=>) ('['||array_to_string(array_fill('0.1'::text, ARRAY[32]), ',')||']')::public.vector
LIMIT 20;

-- 目标规模验证 HNSW 索引/operator class 可用于模型维度一致的近邻路径。
EXPLAIN (ANALYZE, BUFFERS)
SELECT id
FROM chunk_embeddings
WHERE embedding_model = 'deterministic-mock-embedding-v1' AND dimensions = 32
ORDER BY embedding OPERATOR(public.<=>) ('['||array_to_string(array_fill('0.1'::text, ARRAY[32]), ',')||']')::public.vector
LIMIT 20;

DROP SCHEMA pr07_plan_evidence CASCADE;
