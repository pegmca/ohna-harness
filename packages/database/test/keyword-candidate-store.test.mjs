/**
 * P3 关键词候选检索 trigram GIN 索引优化验证（docs/v1.2 §4 P3）。
 *
 * - 单元（无需 Postgres）：用 fake pool 捕获发往 PG 的 SQL，断言命中判定已改为与迁移 0300 索引
 *   完全一致的表达式 `(chunk_text || ' ' || coalesce(heading, '')) ilike any(...)`（不再用 `or c.heading ilike` 顺序扫描），
 *   且行映射仍产出正确的 EmbeddedChunk。
 * - 集成（需 TEST_DATABASE_URL）：迁移建立 idx_chunks_keyword_trgm 后，断言 EXPLAIN 命中该 GIN 索引，
 *   且关键词匹配仍能返回正确候选（中英文子串均可用）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresKeywordCandidateStore } from "../dist/index.js";
import { runMigrations } from "../dist/migrate.js";
import { createDatabaseTestContext } from "./helpers/database-test-helper.mjs";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);

/** 单元：fake pool 捕获 SQL 与参数，不接触真实数据库。 */
test("P3 关键词候选查询改用 trigram GIN 索引表达式，且行映射正确", async () => {
  const captured = { sql: null, params: null };
  const fakePool = {
    async query(sql, params) {
      captured.sql = sql;
      captured.params = params;
      // 返回一行，列名与 store 查询投影一致（chunk_id 为拼接别名）。
      return {
        rows: [{
          chunk_id: "ver-1_v1_chunk_0001",
          document_id: "doc-1",
          source_uri: "demo/report.md",
          chunk_index: 1,
          chunk_text: "公司不良率保持稳定，资产质量持续改善。",
          heading: "资产质量",
          page_number: 3,
          metadata: { charStart: 0, charEnd: 20 }
        }]
      };
    }
  };

  const store = createPostgresKeywordCandidateStore(fakePool, { ownerUserId: null });
  const candidates = await store.findCandidateChunks(["资产质量"], undefined, 10);

  // 新谓词：在索引表达式上做 ILIKE，且不再用 `or c.heading ilike` 的双列顺序扫描。
  assert.equal(captured.sql.includes("c.chunk_text || ' ' || coalesce(c.heading, '')"), true, "应使用与索引一致的连接表达式谓词");
  assert.equal(captured.sql.includes("ilike any"), true, "应保持 ILIKE ANY 子串匹配语义");
  assert.equal(captured.sql.includes("or c.heading ilike"), false, "应移除旧的 heading 单列顺序扫描分支");

  // 行映射：EmbeddedChunk 关键字段正确（embedding 留空，关键词打分在 TS 侧完成）。
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].chunkId, "ver-1_v1_chunk_0001");
  assert.equal(candidates[0].documentId, "doc-1");
  assert.equal(candidates[0].text, "公司不良率保持稳定，资产质量持续改善。");
  assert.equal(candidates[0].heading, "资产质量");
  assert.equal(candidates[0].pageNumber, 3);
});

/** 集成：迁移建立 idx_chunks_keyword_trgm 后，EXPLAIN 命中 GIN 索引，且匹配正确。 */
test("P3 GIN trigram 索引被查询规划器选用，且候选匹配正确", { skip: !integrationEnabled }, async () => {
  const context = await createDatabaseTestContext(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  try {
    await runMigrations(context.pool);
    const now = "2026-07-25T08:00:00.000Z";
    const documentId = randomUUID();
    const versionId = randomUUID();

    await context.pool.query(
      `insert into documents(id, scope, source_type, external_id, title, created_at, updated_at)
       values ($1, 'shared', 'mock_text', $2, '年报', $3, $3)`,
      [documentId, `ext-${documentId}`, now]
    );
    await context.pool.query(
      `insert into document_versions(id, document_id, version, content_checksum, content_type, source_uri, storage_kind, content, parser_version, status, created_at, indexed_at)
       values ($1, $2, 1, 'cs1', 'text/markdown', 'demo/report.md', 'inline', '年报', 'v1', 'indexed', $3, $3)`,
      [versionId, documentId, now]
    );
    await context.pool.query(
      `insert into chunks(id, document_version_id, chunk_index, chunk_text, heading, chunker_version, metadata, content_checksum)
       values ($1, $2, 0, '公司不良率保持稳定，资产质量持续改善。', '资产质量', 'v1', '{"charStart":0,"charEnd":20}'::jsonb, 'cc1'),
              ($3, $2, 1, 'A股营收持续增长，盈利能力修复。', '盈利能力', 'v1', '{"charStart":0,"charEnd":18}'::jsonb, 'cc2')`,
      [randomUUID(), versionId, randomUUID()]
    );

    // 1) EXPLAIN：关闭 seqscan 后，规划器应选用 idx_chunks_keyword_trgm（验证索引确实可被命中，而非仅存在）。
    await context.pool.query("set enable_seqscan = off");
    const explain = await context.pool.query(
      `explain (costs off, summary off)
       select 1 from chunks c
       where (c.chunk_text || ' ' || coalesce(c.heading, '')) ilike any(array['%资产质量%'])`
    );
    const plan = explain.rows.map((row) => row["QUERY PLAN"]).join("\n");
    assert.equal(
      plan.includes("idx_chunks_keyword_trgm"),
      true,
      `trigram GIN 索引应被规划器选用，实际计划：\n${plan}`
    );

    // 2) 候选匹配：中英文子串命中正确（CJK 关键约束——tsvector 默认词典会丢中文短语）。
    const store = createPostgresKeywordCandidateStore(context.pool, { ownerUserId: null });
    const cjk = await store.findCandidateChunks(["资产质量"], undefined, 10);
    assert.equal(cjk.some((c) => c.text.includes("资产质量")), true, "中文子串应命中对应候选");

    const latin = await store.findCandidateChunks(["营收"], undefined, 10);
    assert.equal(latin.some((c) => c.text.includes("营收")), true, "拉丁子串应命中对应候选");
  } finally {
    await context.cleanup();
  }
});
