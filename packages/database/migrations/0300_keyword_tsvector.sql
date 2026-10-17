-- 0300: 关键词候选检索 trigram GIN 索引，替代 ILIKE 顺序扫描（P3 优化）。
--
-- 背景：P3 把关键词候选外置到共享 chunks 表后，命中判定用 ILIKE ANY('%term%') 顺序扫描。
-- 演示规模可接受，但大规模召回会成为瓶颈（每次检索全表扫描 + 逐行子串匹配）。
--
-- 选型说明（CJK 关键约束）：
--   - to_tsvector / to_tsquery 默认词典对中文按整段而非单字分词，会丢失"资产质量"这类 CJK 短语匹配；
--   - pg_trgm 按字符三元组切分，不依赖词典，对 CJK 子串同样有效，且 gin_trgm_ops 索引可加速 ILIKE 子串匹配；
--   - 因此本迁移选用 pg_trgm GIN 索引而非 tsvector，保证中英文子串命中一致可用。
--
-- 索引表达式与查询谓词严格一致：(chunk_text || ' ' || coalesce(heading, ''))，
-- 使规划器能用 Bitmap Index Scan 命中本索引（集成测试以 enable_seqscan=off + EXPLAIN 验证）。
--
-- 幂等：CREATE EXTENSION IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / COMMENT ON INDEX。

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_chunks_keyword_trgm
  ON chunks USING gin ((chunk_text || ' ' || coalesce(heading, '')) gin_trgm_ops);

COMMENT ON INDEX idx_chunks_keyword_trgm IS '关键词候选检索 trigram GIN 索引：加速 chunk_text 与 heading 的子串匹配（含 CJK 子串），替代 ILIKE 顺序扫描；查询用相同表达式 (chunk_text || 空格 || coalesce(heading,空串)) ilike any(...) 命中本索引';
