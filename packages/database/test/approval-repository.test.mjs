import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresApprovalRepository } from "../dist/index.js";
import { runMigrations } from "../dist/migrate.js";
import { createDatabaseTestContext } from "./helpers/database-test-helper.mjs";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const now = "2026-07-25T08:00:00.000Z";
const farFuture = "2099-01-01T00:00:00.000Z";

test("Approval repository 保证幂等创建、CAS 决定、绑定校验、过期转移与逐列中文注释", { skip: !integrationEnabled }, async () => {
  const context = await createDatabaseTestContext(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  try {
    await runMigrations(context.pool);
    const userOne = "10000000-0000-4000-8000-000000000001";
    const userTwo = "20000000-0000-4000-8000-000000000002";
    await context.pool.query(
      `insert into users(id,created_at,updated_at,last_seen_at)
       values ($1,$3,$3,$3),($2,$3,$3,$3)`,
      [userOne, userTwo, now]
    );
    // 旧 conversation/run repository 已被 v2 取代；approval 表属阶段 6 删除对象，
    // 这里用 SQL 播种旧表行，仅验证 approval repository 自身语义。
    const conversation = { id: "10000000-0000-4000-8000-000000000010" };
    const runId = "10000000-0000-4000-8000-000000000100";
    await context.pool.query(
      `insert into conversations(id,user_id,title,status,created_at,updated_at,last_message_at)
       values ($1,$2,'Approval tests','active',$3,$3,$3)`,
      [conversation.id, userOne, now]
    );
    await context.pool.query(
      `insert into messages(id,conversation_id,user_id,role,content,status,sequence,created_at)
       values ('10000000-0000-4000-8000-000000000200',$1,$2,'user','执行 SQL','completed',1,$3)`,
      [conversation.id, userOne, now]
    );
    await context.pool.query(
      `insert into agent_runs(id,request_id,user_id,conversation_id,user_message_id,mode,source,status,trace_id,model_id,created_at,updated_at)
       values ($1,$3,$2,$4,'10000000-0000-4000-8000-000000000200','auto','composer','running','trace-approval-1','mock',$5,$5)`,
      [runId, userOne, `${userOne}:client-approval`, conversation.id, now]
    );
    const repository = createPostgresApprovalRepository(context.pool);
    const base = {
      approvalId: "approval_trace-approval-1_sql_query_mock_1",
      runId,
      requestId: `${userOne}:client-approval`,
      traceId: "trace-approval-1",
      userId: userOne,
      toolName: "sql_query_mock",
      permissionLevel: "needs_approval",
      reason: "SQL execution requires human approval.",
      reasonCode: "SEC_TOOL_APPROVAL_REQUIRED",
      inputDigest: "input_abc123",
      inputPreview: { sql: "SELECT * FROM metrics" },
      requestedAt: now,
      expiresAt: farFuture
    };

    // 相同 approval id + input digest 幂等创建，只落一行。
    const [first, duplicate] = await Promise.all([
      repository.requestApproval(base),
      repository.requestApproval(base)
    ]);
    assert.equal(first.status, "pending");
    assert.equal(duplicate.status, "pending");
    const count = await context.pool.query("select count(*)::integer as count from tool_approvals where id=$1", [base.approvalId]);
    assert.equal(count.rows[0].count, 1);

    // 相同 id 不同 digest 属于重放/挪用，返回结构化 conflict。
    await assert.rejects(
      () => repository.requestApproval({ ...base, inputDigest: "input_other" }),
      (error) => error.code === "conflict"
    );

    // pending 与过期记录都不会被导出 gate 放行。
    assert.equal(await repository.findApprovedDecision(userOne, runId, base.approvalId), undefined);

    const decideBase = {
      approvalId: base.approvalId,
      runId,
      reviewerUserId: userOne,
      expectedInputDigest: base.inputDigest,
      decidedAt: now
    };

    // digest 不符拒绝，且细分原因为 binding 级别。
    const wrongDigest = await repository.decide({ ...decideBase, decision: "approved", expectedInputDigest: "input_wrong" });
    assert.equal(wrongDigest.ok, false);
    assert.equal(wrongDigest.code, "conflict");
    assert.equal(wrongDigest.conflictReason, "digest");

    // run 与 user 归属任一不匹配统一 not_found，不泄漏资源存在。
    const wrongRun = await repository.decide({ ...decideBase, decision: "approved", runId: "20000000-0000-4000-8000-000000000100" });
    assert.equal(wrongRun.ok, false);
    assert.equal(wrongRun.code, "not_found");
    const wrongUser = await repository.decide({ ...decideBase, decision: "approved", reviewerUserId: userTwo });
    assert.equal(wrongUser.ok, false);
    assert.equal(wrongUser.code, "not_found");
    assert.equal(await repository.findApprovedDecision(userTwo, runId, base.approvalId), undefined);
    // gate 查询也必须限定归属 Run，跨 Run 的同名审批不予放行。
    assert.equal(await repository.findApprovedDecision(userOne, "20000000-0000-4000-8000-000000000100", base.approvalId), undefined);

    // 并发 approved/rejected 只有一个状态迁移成功。
    const [approve, reject] = await Promise.all([
      repository.decide({ ...decideBase, decision: "approved" }),
      repository.decide({ ...decideBase, decision: "rejected" })
    ]);
    assert.equal([approve, reject].filter((result) => result.ok).length, 1);
    const winner = approve.ok ? approve : reject;
    const loser = approve.ok ? reject : approve;
    assert.equal(loser.code, "conflict");
    assert.equal(loser.conflictReason, "decision");

    // 相同决定重试幂等返回既有记录，不同决定返回 conflict。
    const retry = await repository.decide({ ...decideBase, decision: winner.record.decision });
    assert.equal(retry.ok, true);
    assert.equal(retry.idempotent, true);
    const opposite = await repository.decide({ ...decideBase, decision: winner.record.decision === "approved" ? "rejected" : "approved" });
    assert.equal(opposite.ok, false);
    assert.equal(opposite.code, "conflict");

    if (winner.record.decision === "approved") {
      const approved = await repository.findApprovedDecision(userOne, runId, base.approvalId);
      assert.equal(approved?.status, "approved");
      assert.equal(approved?.reviewerUserId, userOne);
    } else {
      assert.equal(await repository.findApprovedDecision(userOne, runId, base.approvalId), undefined);
    }

    // 过期 pending 决定被拒绝，并原子转为 expired。
    const expiredInput = {
      ...base,
      approvalId: "approval_trace-approval-1_sql_query_mock_2",
      inputDigest: "input_expired",
      expiresAt: "2020-01-01T00:00:00.000Z"
    };
    await repository.requestApproval(expiredInput);
    const expired = await repository.decide({
      ...decideBase,
      approvalId: expiredInput.approvalId,
      expectedInputDigest: expiredInput.inputDigest,
      decision: "approved"
    });
    assert.equal(expired.ok, false);
    assert.equal(expired.code, "expired");
    const expiredRow = await context.pool.query("select status from tool_approvals where id=$1", [expiredInput.approvalId]);
    assert.equal(expiredRow.rows[0].status, "expired");
    assert.equal(await repository.findApprovedDecision(userOne, runId, expiredInput.approvalId), undefined);

    // 每一列都必须有中文 COMMENT，供 DBeaver 等工具直接展示。
    const comments = await context.pool.query(
      `select column_name,col_description((quote_ident(table_schema)||'.'||quote_ident(table_name))::regclass::oid,ordinal_position) as comment
         from information_schema.columns where table_schema=current_schema() and table_name='tool_approvals'`
    );
    assert.equal(comments.rows.length, 18);
    assert.equal(comments.rows.every((row) => typeof row.comment === "string" && row.comment.length > 0), true);
  } finally {
    await context.cleanup();
  }
});
