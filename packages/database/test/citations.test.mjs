import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createPostgresArtifactRepository,
  createPostgresCitationRepository,
  createPostgresRagDocumentRepository,
  createPostgresRunRepository
} from "../dist/index.js";
import { runMigrations } from "../dist/migrate.js";
import { createDatabaseTestContext } from "./helpers/database-test-helper.mjs";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const now = "2026-07-25T08:00:00.000Z";

test("Citation 持久化：固定 chunk/version 回链、原子写入、用户隔离、归档不泄漏与 verifier 状态机", { skip: !integrationEnabled }, async () => {
  const context = await createDatabaseTestContext(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  try {
    await runMigrations(context.pool, join(packageDir, "migrations"));
    const userA = randomUUID();
    const userB = randomUUID();
    await context.pool.query(
      "insert into users(id,created_at,updated_at,last_seen_at) values ($1,$3,$3,$3),($2,$3,$3,$3)",
      [userA, userB, now]
    );

    // 私有文档 + 两个 indexed chunks，作为 citation 的固定回链目标。
    const ragRepository = createPostgresRagDocumentRepository(context.pool);
    const ingestion = await ragRepository.saveIngestion({
      ownerUserId: userA,
      scope: "private",
      sourceType: "mock_text",
      externalId: `ext-${randomUUID()}`,
      title: "资产质量周报",
      sourceUri: "demo/asset-quality",
      contentType: "text/markdown",
      contentChecksum: `checksum-${randomUUID()}`,
      content: "# 资产质量\n不良率保持稳定。",
      parserVersion: "parsing-markdown-txt-v1",
      chunkerVersion: "heading-aware-1200-150-v1",
      outcome: {
        status: "indexed",
        chunks: [
          { chunkIndex: 0, text: "不良率保持稳定。", heading: "资产质量", metadata: {}, contentChecksum: "c0" },
          { chunkIndex: 1, text: "拨备覆盖率上升。", heading: "资产质量", metadata: {}, contentChecksum: "c1" }
        ]
      },
      now
    });
    assert.equal(ingestion.kind, "created");
    const chunk = ingestion.chunks[0];

    // --- message citations：阶段 5 后 message_citations.message_id 外键指向 messages，
    // 读取侧也改查 messages；这里用 SQL 播种 messages/message_citations 行验证读取与状态机。
    const conversationId = randomUUID();
    const agentRunId = randomUUID();
    await context.pool.query(
      `insert into conversations(id,user_id,title,status,created_at,updated_at,last_message_at)
       values ($1,$2,'citations','active',$3,$3,$3)`,
      [conversationId, userA, now]
    );
    // 触发 Run 的用户消息与 Run 行：messages.run_id 与 runs.user_message_id 互为外键，
    // 必须通过 RunRepository.create 的事务顺序创建。
    await createPostgresRunRepository(context.pool).create({
      runId: agentRunId,
      requestId: randomUUID(),
      userId: userA,
      conversationId,
      message: "citation test prompt",
      clientMessageId: randomUUID(),
      mode: "auto",
      source: "composer",
      modelId: "mock",
      createdAt: now
    });

    const assistantMessageId = randomUUID();
    await context.pool.query(
      `insert into messages(
         id,conversation_id,user_id,run_id,role,content,message_type,client_message_id,sequence,
         usage,model_id,stop_reason,error_message,created_at
       ) values ($1,$2,$3,$4,'assistant',to_jsonb($5::text),'normal',null,2,null,null,null,null,$6)`,
      [assistantMessageId, conversationId, userA, agentRunId, "不良率稳定 [1]。", now]
    );
    const chunkRow = (await context.pool.query(
      `select c.id,c.document_version_id from chunks c
        join document_versions v on v.id=c.document_version_id
       where v.document_id=$1 order by c.chunk_index limit 1`,
      [chunk.documentId]
    )).rows[0];
    await context.pool.query(
      `insert into message_citations(id,user_id,message_id,chunk_id,document_version_id,ordinal,claim,quote,score,verifier_status,created_at)
       values ($1,$2,$3,$4,$5,1,'资产质量','不良率保持稳定。',0.87,'unverified',$6)`,
      [randomUUID(), userA, assistantMessageId, chunkRow.id, chunkRow.document_version_id, now]
    );

    const citations = createPostgresCitationRepository(context.pool);
    const listed = await citations.listMessageCitations(userA, assistantMessageId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].ordinal, 1);
    assert.equal(listed[0].claim, "资产质量");
    assert.equal(listed[0].verifierStatus, "unverified");
    assert.equal(listed[0].source.status, "accessible");
    assert.equal(listed[0].source.chunkId, chunk.chunkId);
    assert.equal(listed[0].source.documentVersionId, chunk.documentVersionId);
    assert.equal(listed[0].source.quote, "不良率保持稳定。");
    assert.equal(listed[0].source.score, 0.87);
    // 越权：userB 不能通过 message/citation ID 读取 userA 的引用。
    assert.equal(await citations.listMessageCitations(userB, assistantMessageId), undefined);
    assert.deepEqual(
      await citations.updateMessageCitationVerifierStatus(userB, listed[0].citationId, "verified"),
      { status: "not_found" }
    );

    // --- saveMessageCitations 写路径：run-service 在 assistant message 落库后调用。
    const secondMessageId = randomUUID();
    await context.pool.query(
      `insert into messages(
         id,conversation_id,user_id,run_id,role,content,message_type,client_message_id,sequence,
         usage,model_id,stop_reason,error_message,created_at
       ) values ($1,$2,$3,$4,'assistant',to_jsonb($5::text),'normal',null,3,null,null,null,null,$6)`,
      [secondMessageId, conversationId, userA, agentRunId, "拨备覆盖率上升 [1]。", now]
    );
    await citations.saveMessageCitations(userA, secondMessageId, [
      { ordinal: 1, chunkId: chunk.chunkId, claim: "拨备覆盖", quote: "拨备覆盖率上升。", score: 0.91 }
    ]);
    const savedListed = await citations.listMessageCitations(userA, secondMessageId);
    assert.equal(savedListed.length, 1);
    assert.equal(savedListed[0].claim, "拨备覆盖");
    assert.equal(savedListed[0].source.status, "accessible");
    assert.equal(savedListed[0].source.chunkId, chunk.chunkId);

    // --- verifier 状态机：自动终态不可互改，人工终态不可覆盖 ---
    assert.deepEqual(
      await citations.updateMessageCitationVerifierStatus(userA, listed[0].citationId, "verified"),
      { status: "updated", verifierStatus: "verified" }
    );
    assert.deepEqual(
      await citations.updateMessageCitationVerifierStatus(userA, listed[0].citationId, "rejected"),
      { status: "invalid_transition", current: "verified" }
    );
    assert.deepEqual(
      await citations.updateMessageCitationVerifierStatus(userA, listed[0].citationId, "manual_rejected"),
      { status: "updated", verifierStatus: "manual_rejected" }
    );
    assert.deepEqual(
      await citations.updateMessageCitationVerifierStatus(userA, listed[0].citationId, "manual_verified"),
      { status: "invalid_transition", current: "manual_rejected" }
    );

    // --- 被引用 chunk/version 默认保留：物理删除被引用 chunk 受 FK restrict 阻止 ---
    await assert.rejects(
      context.pool.query("delete from chunks where id=$1", [(await context.pool.query(
        "select chunk_id from message_citations where message_id=$1", [assistantMessageId]
      )).rows[0].chunk_id])
    );

    // --- 文档归档后：序号与 claim 保留，来源不可访问且不泄漏 quote/sourceUri ---
    await context.pool.query("update documents set deleted_at=$2 where id=$1", [chunk.documentId, "2026-07-25T09:00:00.000Z"]);
    const archived = await citations.listMessageCitations(userA, assistantMessageId);
    assert.equal(archived.length, 1);
    assert.equal(archived[0].ordinal, 1);
    assert.equal(archived[0].claim, "资产质量");
    assert.equal(archived[0].source.status, "inaccessible");
    assert.equal("quote" in archived[0].source, false);
    assert.equal("sourceUri" in archived[0].source, false);

    // --- artifact citations：同事务写入、幂等重存、软删除级联 ---
    const artifactRepository = createPostgresArtifactRepository(context.pool);
    const artifact = {
      userId: userA, conversationId, agentRunId,
      kind: "research_report", mediaType: "text/html", metadata: {}, updatedAt: now,
      artifact: {
        artifactId: `artifact-${randomUUID()}`, reportId: "plan-1", workflowRunId: "workflow-1",
        status: "html_preview_only", title: "报告", markdown: "# 报告", html: "<h1>报告</h1>",
        citations: [
          { id: "rc-1", claimId: "claim-1", supportsFinding: "不良率稳定", quote: "不良率保持稳定。", source: "demo/asset-quality", chunkId: chunk.chunkId, chunkIndex: 0 },
          { id: "rc-2", supportsFinding: "外部数据", quote: "外部工具快照。", source: "tool://metrics" }
        ],
        citationVerification: { decision: "pass", verified: true, missingClaims: [], missingMetrics: [] },
        pdfExport: { status: "queued", message: "等待导出" }, createdAt: now
      }
    };
    // workflow_run_id 外键：直接落一行 workflow_runs 满足约束。
    await context.pool.query(
      `insert into workflow_runs(id,user_id,conversation_id,agent_run_id,plan_id,workflow_name,status,snapshot,started_at,created_at,updated_at)
       values ('workflow-1',$1,$2,$3,'plan-1','report','succeeded','{}',$4,$4,$4)`,
      [userA, conversationId, agentRunId, now]
    );
    await artifactRepository.save(artifact);
    const artifactListed = await citations.listArtifactCitations(userA, artifact.artifact.artifactId);
    assert.equal(artifactListed.length, 2);
    assert.deepEqual(artifactListed.map((item) => item.ordinal), [1, 2]);
    assert.equal(artifactListed[0].claim, "claim-1");
    assert.equal(artifactListed[0].verifierStatus, "verified");
    assert.equal(artifactListed[0].source.status, "inaccessible"); // 文档已归档
    assert.equal(artifactListed[1].source.status, "unresolved"); // 非 RAG 来源无回链，仅 quote 快照
    assert.equal(artifactListed[1].source.quote, "外部工具快照。");
    assert.equal(await citations.listArtifactCitations(userB, artifact.artifact.artifactId), undefined);

    // 幂等：重复保存相同 artifact 不产生重复 ordinal。
    await artifactRepository.save(artifact);
    const ordinalCount = await context.pool.query(
      "select count(*)::integer as count from artifact_citations where artifact_id=$1",
      [artifact.artifact.artifactId]
    );
    assert.equal(ordinalCount.rows[0].count, 2);

    // 原子性：越权 save 整体回滚，artifact 与 citations 都不变。
    await assert.rejects(
      artifactRepository.save({ ...artifact, userId: userB }),
      (error) => error.code === "conflict"
    );
    const afterConflict = await context.pool.query(
      "select count(*)::integer as count from artifact_citations where artifact_id=$1",
      [artifact.artifact.artifactId]
    );
    assert.equal(afterConflict.rows[0].count, 2);
    assert.equal((await artifactRepository.findById(userA, artifact.artifact.artifactId)).artifact.title, "报告");

    // 软删除级联删除 citation 关系。
    assert.equal(await artifactRepository.softDelete(userA, artifact.artifact.artifactId, "2026-07-25T10:00:00.000Z"), true);
    const afterDelete = await context.pool.query(
      "select count(*)::integer as count from artifact_citations where artifact_id=$1",
      [artifact.artifact.artifactId]
    );
    assert.equal(afterDelete.rows[0].count, 0);
    assert.equal(await citations.listArtifactCitations(userA, artifact.artifact.artifactId), undefined);

    // 每个字段都有中文注释（migration lint 语义的数据库侧验证）。
    const comments = await context.pool.query(
      `select table_name,column_name,col_description((quote_ident(table_schema)||'.'||quote_ident(table_name))::regclass::oid,ordinal_position) as comment
         from information_schema.columns where table_schema=current_schema() and table_name in ('message_citations','artifact_citations')`
    );
    assert.equal(comments.rows.length, 22);
    assert.equal(comments.rows.every((row) => typeof row.comment === "string" && /[\u3400-\u9fff]/.test(row.comment)), true);
  } finally {
    await context.cleanup();
  }
});
