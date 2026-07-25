import assert from "node:assert/strict";
import { test } from "node:test";
import { createPostgresArtifactRepository, createPostgresWorkflowRepository } from "../dist/index.js";
import { runMigrations } from "../dist/migrate.js";
import { createDatabaseTestContext } from "./helpers/database-test-helper.mjs";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);

test("workflow and artifact persist across repository instances with owner isolation and terminal audit", { skip: !integrationEnabled }, async () => {
  const context = await createDatabaseTestContext(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  try {
    await runMigrations(context.pool, new URL("../migrations", import.meta.url).pathname);
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    const now = new Date().toISOString();
    await context.pool.query(
      "insert into users(id,created_at,updated_at,last_seen_at) values ($1,$3,$3,$3),($2,$3,$3,$3)",
      [userA, userB, now]
    );
    const workflow = createWorkflow(userA, now);
    await createPostgresWorkflowRepository(context.pool).save(workflow);
    const artifact = createArtifact(userA, now);
    await createPostgresArtifactRepository(context.pool).save(artifact);

    const secondPool = context.createPool();
    try {
      assert.equal((await createPostgresWorkflowRepository(secondPool).findById(userA, workflow.run.runId)).run.status, "succeeded");
      assert.equal(await createPostgresWorkflowRepository(secondPool).findById(userB, workflow.run.runId), undefined);
      assert.equal((await createPostgresArtifactRepository(secondPool).findById(userA, artifact.artifact.artifactId)).artifact.html, "<h1>报告</h1>");
      assert.equal(await createPostgresArtifactRepository(secondPool).findById(userB, artifact.artifact.artifactId), undefined);
      const attempts = await secondPool.query("select attempt,status from workflow_node_runs where workflow_run_id=$1 order by attempt", [workflow.run.runId]);
      assert.deepEqual(attempts.rows, [{ attempt: 1, status: "failed" }, { attempt: 2, status: "succeeded" }]);
      await assert.rejects(
        () => createPostgresWorkflowRepository(secondPool).save({ ...workflow, run: { ...workflow.run, status: "running" } }),
        (error) => error.code === "invalid_state_transition"
      );
    } finally {
      await secondPool.end();
    }
  } finally {
    await context.cleanup();
  }
});

/** @param userId 用户 ID。 @param now 时间。 @returns Workflow fixture。 */
function createWorkflow(userId, now) {
  return {
    context: { userId, conversationId: "conversation-1", agentRunId: "run-1", planId: "plan-1" },
    run: {
      runId: "workflow-1", workflowName: "report", status: "succeeded", startedAt: now, completedAt: now,
      durationMs: 2, maxSteps: 4, executedSteps: 2, edges: [], error: undefined,
      events: [
        { id: "e1", type: "node_started", nodeId: "writer", createdAt: now },
        { id: "e2", type: "node_started", nodeId: "writer", createdAt: now },
        { id: "e3", type: "node_succeeded", nodeId: "writer", createdAt: now }
      ],
      nodes: [{ nodeId: "writer", type: "report.writer", title: "Writer", status: "succeeded", startedAt: now, completedAt: now, durationMs: 2 }]
    }
  };
}

/** @param userId 用户 ID。 @param now 时间。 @returns Artifact fixture。 */
function createArtifact(userId, now) {
  return {
    userId, conversationId: "conversation-1", agentRunId: "run-1", kind: "research_report", mediaType: "text/html",
    metadata: {}, updatedAt: now,
    artifact: {
      artifactId: "artifact-1", reportId: "plan-1", workflowRunId: "workflow-1", status: "html_preview_only",
      title: "报告", markdown: "# 报告", html: "<h1>报告</h1>", citations: [],
      citationVerification: { decision: "pass", verified: true, missingClaims: [], missingMetrics: [] },
      pdfExport: { status: "queued", message: "等待导出" }, createdAt: now
    }
  };
}
