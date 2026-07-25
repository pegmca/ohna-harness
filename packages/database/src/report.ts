import {
  MAX_ARTIFACT_TEXT_LENGTH,
  type ArtifactRecord,
  type ArtifactRepository,
  type PersistedWorkflow,
  type WorkflowRepository
} from "@aiagent/report";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { postgresTimestampToIso, withTransaction } from "./postgres.js";
import { RepositoryError } from "./repository-error.js";

/** @param pool PostgreSQL 连接池。 @returns Workflow repository。 */
export function createPostgresWorkflowRepository(pool: pg.Pool): WorkflowRepository {
  return {
    async save(value) {
      try {
        await withTransaction(pool, async (client) => {
          const now = new Date().toISOString();
          const currentNode = [...value.run.nodes].reverse().find((node) => node.status !== "pending")?.nodeId;
          const result = await client.query(
            `insert into workflow_runs(id,user_id,conversation_id,agent_run_id,plan_id,workflow_name,status,current_node_id,error,snapshot,started_at,completed_at,created_at,updated_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$11,$13)
             on conflict (id) do update set status=excluded.status,current_node_id=excluded.current_node_id,error=excluded.error,
               snapshot=excluded.snapshot,completed_at=excluded.completed_at,updated_at=excluded.updated_at
             where workflow_runs.user_id=excluded.user_id
               and (workflow_runs.status not in ('rejected','succeeded','failed') or workflow_runs.status=excluded.status)
             returning id`,
            [value.run.runId, value.context.userId, value.context.conversationId, value.context.agentRunId,
              value.context.planId, value.run.workflowName, value.run.status, currentNode ?? null,
              value.run.error ?? null, value.run, value.run.startedAt, value.run.completedAt ?? null, now]
          );
          if (!result.rows[0]) throw new RepositoryError("invalid_state_transition", "Workflow terminal status cannot transition.");
          const attemptCounts = countNodeAttempts(value.run);
          for (const node of value.run.nodes) {
            const attempts = attemptCounts.get(node.nodeId) ?? 1;
            for (let attempt = 1; attempt <= attempts; attempt += 1) {
              const isFinalAttempt = attempt === attempts;
              const retry = value.run.recovery?.find((item) => item.nodeId === node.nodeId && item.action === "retried");
              const attemptStatus = isFinalAttempt ? node.status : "failed";
              const attemptError = isFinalAttempt ? node.error ?? null : {
                code: "node_execution_failed",
                message: retry?.reason ?? "Workflow node retryable attempt failed.",
                nodeId: node.nodeId,
                details: { retryable: true, attempt }
              };
              await client.query(
                `insert into workflow_node_runs(id,workflow_run_id,node_id,node_type,title,attempt,status,input_summary,output_summary,error,started_at,completed_at,duration_ms,created_at,updated_at)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
                 on conflict (workflow_run_id,node_id,attempt) do update set status=excluded.status,input_summary=excluded.input_summary,
                   output_summary=excluded.output_summary,error=excluded.error,started_at=excluded.started_at,
                   completed_at=excluded.completed_at,duration_ms=excluded.duration_ms,updated_at=excluded.updated_at
                 where workflow_node_runs.status not in ('rejected','succeeded','failed','skipped')
                    or workflow_node_runs.status=excluded.status`,
                [randomUUID(), value.run.runId, node.nodeId, node.type, node.title, attempt, attemptStatus,
                  node.inputSummary ?? null, isFinalAttempt ? node.outputSummary ?? null : null, attemptError, node.startedAt ?? null,
                  node.completedAt ?? null, Math.max(0, Math.round(node.durationMs)), now]
              );
            }
          }
        });
      } catch (error) {
        if (error instanceof RepositoryError) throw error;
        throw new RepositoryError("database_unavailable", "Workflow persistence is unavailable.", error);
      }
    },
    async findById(userId, workflowRunId) {
      try {
        const result = await pool.query<WorkflowRow>(
          "select user_id,conversation_id,agent_run_id,plan_id,snapshot from workflow_runs where id=$1 and user_id=$2",
          [workflowRunId, userId]
        );
        const row = result.rows[0];
        return row ? {
          context: { userId: row.user_id, conversationId: row.conversation_id, agentRunId: row.agent_run_id, planId: row.plan_id },
          run: row.snapshot
        } : undefined;
      } catch (error) {
        throw new RepositoryError("database_unavailable", "Workflow persistence is unavailable.", error);
      }
    }
  };
}

/** @param pool PostgreSQL 连接池。 @returns Artifact repository。 */
export function createPostgresArtifactRepository(pool: pg.Pool): ArtifactRepository {
  return {
    async save(value) {
      assertArtifactTextLimit(value);
      try {
        const result = await pool.query(
          `insert into artifacts(id,user_id,conversation_id,agent_run_id,workflow_run_id,report_id,kind,status,title,media_type,size_bytes,checksum_sha256,storage_provider,storage_key,markdown_content,html_content,payload,metadata,created_at,updated_at,deleted_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           on conflict (id) do update set status=excluded.status,title=excluded.title,media_type=excluded.media_type,
             size_bytes=excluded.size_bytes,checksum_sha256=excluded.checksum_sha256,storage_provider=excluded.storage_provider,
             storage_key=excluded.storage_key,markdown_content=excluded.markdown_content,html_content=excluded.html_content,
             payload=excluded.payload,metadata=excluded.metadata,updated_at=excluded.updated_at
           where artifacts.user_id=excluded.user_id and artifacts.deleted_at is null returning id`,
          [value.artifact.artifactId, value.userId, value.conversationId, value.agentRunId, value.artifact.workflowRunId,
            value.artifact.reportId, value.kind, value.artifact.status, value.artifact.title, value.mediaType,
            value.sizeBytes ?? null, value.checksumSha256 ?? null, value.storageProvider ?? null, value.storageKey ?? null,
            value.artifact.markdown, value.artifact.html, value.artifact, value.metadata, value.artifact.createdAt,
            value.updatedAt, value.deletedAt ?? null]
        );
        if (!result.rows[0]) throw new RepositoryError("conflict", "Artifact ownership or deletion conflict.");
        return value;
      } catch (error) {
        if (error instanceof RepositoryError) throw error;
        throw new RepositoryError("database_unavailable", "Artifact persistence is unavailable.", error);
      }
    },
    async findById(userId, artifactId) {
      try {
        const result = await pool.query<ArtifactRow>(
          `select user_id,conversation_id,agent_run_id,kind,media_type,size_bytes,checksum_sha256,
                  storage_provider,storage_key,payload,metadata,updated_at,deleted_at
             from artifacts where id=$1 and user_id=$2 and deleted_at is null`,
          [artifactId, userId]
        );
        return result.rows[0] ? mapArtifact(result.rows[0]) : undefined;
      } catch (error) {
        throw new RepositoryError("database_unavailable", "Artifact persistence is unavailable.", error);
      }
    },
    async softDelete(userId, artifactId, deletedAt) {
      try {
        const result = await pool.query(
          "update artifacts set deleted_at=$3,updated_at=$3 where id=$1 and user_id=$2 and deleted_at is null",
          [artifactId, userId, deletedAt]
        );
        return (result.rowCount ?? 0) === 1;
      } catch (error) {
        throw new RepositoryError("database_unavailable", "Artifact persistence is unavailable.", error);
      }
    }
  };
}

interface WorkflowRow {
  user_id: string; conversation_id: string; agent_run_id: string; plan_id: string; snapshot: PersistedWorkflow["run"];
}
interface ArtifactRow {
  user_id: string; conversation_id: string; agent_run_id: string; kind: ArtifactRecord["kind"];
  media_type: ArtifactRecord["mediaType"]; size_bytes: string | number | null; checksum_sha256: string | null;
  storage_provider: ArtifactRecord["storageProvider"] | null; storage_key: string | null;
  payload: ArtifactRecord["artifact"]; metadata: Record<string, unknown>; updated_at: Date | string; deleted_at: Date | string | null;
}

/** @param run Workflow DTO。 @returns 每个节点的 attempt 数量。 */
function countNodeAttempts(run: PersistedWorkflow["run"]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of run.events) {
    if (event.type === "node_started" && event.nodeId) counts.set(event.nodeId, (counts.get(event.nodeId) ?? 0) + 1);
  }
  return counts;
}

/** @param row PostgreSQL 行。 @returns Artifact record。 */
function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    artifact: row.payload, userId: row.user_id, conversationId: row.conversation_id, agentRunId: row.agent_run_id,
    kind: row.kind, mediaType: row.media_type, sizeBytes: row.size_bytes === null ? undefined : Number(row.size_bytes),
    checksumSha256: row.checksum_sha256 ?? undefined, storageProvider: row.storage_provider ?? undefined,
    storageKey: row.storage_key ?? undefined, metadata: row.metadata, updatedAt: postgresTimestampToIso(row.updated_at),
    deletedAt: row.deleted_at ? postgresTimestampToIso(row.deleted_at) : undefined
  };
}

/** @param value Artifact record。 @returns 校验通过时无返回值。 */
function assertArtifactTextLimit(value: ArtifactRecord): void {
  if (value.artifact.markdown.length > MAX_ARTIFACT_TEXT_LENGTH || value.artifact.html.length > MAX_ARTIFACT_TEXT_LENGTH) {
    throw new RepositoryError("conflict", "Artifact preview content exceeds the persistence limit.");
  }
}
