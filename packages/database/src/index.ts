import type {
  ConsumeQqBindingResult,
  IdentityChallenge,
  IdentityRepository,
  IdentitySession,
  IdentityUser,
  QqIdentity
} from "@aiagent/identity";
import type { RagDocumentRepository } from "@aiagent/rag";
import { randomUUID } from "node:crypto";
import pg from "pg";
export { findMissingColumnComments, type MigrationCommentIssue } from "./migration-lint.js";
export { createPostgresRagDocumentRepository } from "./rag-documents.js";
export { RepositoryError, type RepositoryErrorCode } from "./repository-error.js";
export { isPostgresUniqueViolation, postgresTimestampToIso } from "./postgres.js";
export {
  createPostgresConversationRepositories,
  type PostgresConversationRepositories
} from "./conversation-repository.js";
import { isPostgresUniqueViolation, postgresTimestampToIso } from "./postgres.js";
import { createPostgresRagDocumentRepository } from "./rag-documents.js";
import { createPostgresConversationRepositories } from "./conversation-repository.js";
import type { ArtifactRepository, WorkflowRepository } from "@aiagent/report";
import { createPostgresArtifactRepository, createPostgresWorkflowRepository } from "./report.js";
export { createPostgresArtifactRepository, createPostgresWorkflowRepository } from "./report.js";

const { Pool } = pg;

export interface DatabaseRuntime {
  pool: pg.Pool;
  conversationRepository: import("@aiagent/conversation").ConversationRepository;
  messageRepository: import("@aiagent/conversation").MessageRepository;
  identityRepository: IdentityRepository;
  ragDocumentRepository: RagDocumentRepository;
  workflowRepository: WorkflowRepository;
  artifactRepository: ArtifactRepository;
  close(): Promise<void>;
  ping(): Promise<boolean>;
}

/**
 * 创建 PostgreSQL runtime，连接池与 repository 在 composition root 中共享。
 *
 * @param databaseUrl PostgreSQL 连接字符串。
 * @returns 数据库 runtime。
 */
export function createDatabaseRuntime(databaseUrl: string): DatabaseRuntime {
  if (!databaseUrl.trim()) throw new Error("DATABASE_URL is required.");
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const conversations = createPostgresConversationRepositories(pool);
  return {
    pool,
    ...conversations,
    identityRepository: createPostgresIdentityRepository(pool),
    ragDocumentRepository: createPostgresRagDocumentRepository(pool),
    workflowRepository: createPostgresWorkflowRepository(pool),
    artifactRepository: createPostgresArtifactRepository(pool),
    async close() { await pool.end(); },
    async ping() {
      try {
        await pool.query("select 1");
        return true;
      } catch {
        return false;
      }
    }
  };
}

/**
 * 创建 PostgreSQL 身份 repository；所有绑定冲突依靠事务和唯一约束封闭处理。
 *
 * @param pool PostgreSQL 连接池。
 * @returns 身份 repository。
 */
export function createPostgresIdentityRepository(pool: pg.Pool): IdentityRepository {
  return {
    async findOrCreateUserByFingerprint(fingerprintDigest, fingerprintVersion, now) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const existing = await client.query<IdentityUserRow>(
          `select u.id, u.created_at, u.last_seen_at
             from browser_identities b join users u on u.id = b.user_id
            where b.fingerprint_digest = $1 for update`,
          [fingerprintDigest]
        );
        if (existing.rows[0]) {
          await client.query("update browser_identities set last_seen_at = $2 where fingerprint_digest = $1", [fingerprintDigest, now]);
          await client.query("update users set last_seen_at = $2, updated_at = $2 where id = $1", [existing.rows[0].id, now]);
          await client.query("commit");
          return mapUser({ ...existing.rows[0], last_seen_at: now });
        }
        const userId = randomUUID();
        await client.query("insert into users(id, created_at, updated_at, last_seen_at) values ($1,$2,$2,$2)", [userId, now]);
        try {
          await client.query(
            "insert into browser_identities(id,user_id,fingerprint_digest,fingerprint_version,created_at,last_seen_at) values ($1,$2,$3,$4,$5,$5)",
            [randomUUID(), userId, fingerprintDigest, fingerprintVersion, now]
          );
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          await client.query("rollback");
          const winner = await pool.query<IdentityUserRow>(
            `select u.id, u.created_at, u.last_seen_at
               from browser_identities b join users u on u.id = b.user_id
              where b.fingerprint_digest = $1`,
            [fingerprintDigest]
          );
          if (!winner.rows[0]) throw error;
          return mapUser(winner.rows[0]);
        }
        await client.query(
          "insert into identity_audit_events(id,user_id,event_type,created_at) values ($1,$2,'user_created',$3)",
          [randomUUID(), userId, now]
        );
        await client.query("commit");
        return { userId, createdAt: now, lastSeenAt: now };
      } catch (error) {
        if (!isTransactionClosed(error)) await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async createSession(userId, tokenDigest, expiresAt, now) {
      await pool.query(
        "insert into user_sessions(id,user_id,token_digest,created_at,last_seen_at,expires_at) values ($1,$2,$3,$4,$4,$5)",
        [randomUUID(), userId, tokenDigest, now, expiresAt]
      );
    },
    async findSession(tokenDigest, now) {
      const result = await pool.query<SessionRow>(
        "select user_id, expires_at, revoked_at from user_sessions where token_digest=$1 and expires_at>$2 and revoked_at is null",
        [tokenDigest, now]
      );
      if (!result.rows[0]) return undefined;
      await pool.query("update user_sessions set last_seen_at=$2 where token_digest=$1", [tokenDigest, now]);
      return mapSession(result.rows[0]);
    },
    async getUser(userId) {
      const result = await pool.query<IdentityUserRow>("select id,created_at,last_seen_at from users where id=$1", [userId]);
      return result.rows[0] ? mapUser(result.rows[0]) : undefined;
    },
    async getQqIdentityByUserId(userId) {
      const result = await pool.query<QqIdentityRow>("select user_id,bot_account_id,qq_open_id,bound_at from qq_identities where user_id=$1", [userId]);
      return result.rows[0] ? mapQq(result.rows[0]) : undefined;
    },
    async getQqIdentity(botAccountId, qqOpenId) {
      const result = await pool.query<QqIdentityRow>(
        "select user_id,bot_account_id,qq_open_id,bound_at from qq_identities where bot_account_id=$1 and qq_open_id=$2",
        [botAccountId, qqOpenId]
      );
      return result.rows[0] ? mapQq(result.rows[0]) : undefined;
    },
    async createChallenge(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          "update identity_challenges set failed_at=now() where user_id=$1 and purpose=$2 and consumed_at is null and failed_at is null",
          [input.userId, input.purpose]
        );
        await client.query(
          `insert into identity_challenges(id,user_id,purpose,code_digest,expires_at,attempts,max_attempts,created_at)
           values ($1,$2,$3,$4,$5,$6,$7,now())`,
          [input.challengeId, input.userId, input.purpose, input.codeDigest, input.expiresAt, input.attempts, input.maxAttempts]
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async getChallenge(challengeId, userId) {
      const result = await pool.query<ChallengeRow>(
        "select * from identity_challenges where id=$1 and user_id=$2",
        [challengeId, userId]
      );
      return result.rows[0] ? mapChallenge(result.rows[0]) : undefined;
    },
    async consumeQqBinding(codeDigest, botAccountId, qqOpenId, now): Promise<ConsumeQqBindingResult> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const challengeResult = await client.query<ChallengeRow>(
          "select * from identity_challenges where code_digest=$1 and purpose='bind_qq' for update",
          [codeDigest]
        );
        const row = challengeResult.rows[0];
        if (!row) { await client.query("rollback"); return { status: "not_found" }; }
        if (row.failed_at || row.attempts >= row.max_attempts) { await client.query("rollback"); return { status: "failed" }; }
        if (row.consumed_at) {
          const current = await findQqWithClient(client, row.user_id);
          await client.query("rollback");
          return current ? { status: "already_bound", identity: current } : { status: "failed" };
        }
        if (Date.parse(toIso(row.expires_at)) <= Date.parse(now)) { await client.query("rollback"); return { status: "expired" }; }
        const byExternal = await client.query<QqIdentityRow>(
          "select user_id,bot_account_id,qq_open_id,bound_at from qq_identities where bot_account_id=$1 and qq_open_id=$2",
          [botAccountId, qqOpenId]
        );
        if (byExternal.rows[0] && byExternal.rows[0].user_id !== row.user_id) {
          await client.query("rollback");
          return { status: "conflict" };
        }
        const byUser = await client.query<QqIdentityRow>(
          "select user_id,bot_account_id,qq_open_id,bound_at from qq_identities where user_id=$1",
          [row.user_id]
        );
        if (byUser.rows[0] && (byUser.rows[0].bot_account_id !== botAccountId || byUser.rows[0].qq_open_id !== qqOpenId)) {
          await client.query("rollback");
          return { status: "conflict" };
        }
        const existing = byExternal.rows[0] ?? byUser.rows[0];
        if (!existing) {
          await client.query(
            "insert into qq_identities(id,user_id,bot_account_id,qq_open_id,bound_at) values ($1,$2,$3,$4,$5)",
            [randomUUID(), row.user_id, botAccountId, qqOpenId, now]
          );
        }
        await client.query("update identity_challenges set consumed_at=$2 where id=$1", [row.id, now]);
        await client.query(
          "insert into identity_audit_events(id,user_id,event_type,created_at) values ($1,$2,'qq_bound',$3)",
          [randomUUID(), row.user_id, now]
        );
        await client.query("commit");
        const identity = existing ? mapQq(existing) : { userId: row.user_id, botAccountId, qqOpenId, boundAt: now };
        return { status: existing ? "already_bound" : "bound", identity };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        if (isUniqueViolation(error)) return { status: "conflict" };
        throw error;
      } finally {
        client.release();
      }
    },
    async unbindQqByUserId(userId, now) {
      const result = await pool.query("delete from qq_identities where user_id=$1", [userId]);
      if ((result.rowCount ?? 0) > 0) {
        await pool.query(
          "insert into identity_audit_events(id,user_id,event_type,created_at) values ($1,$2,'qq_unbound',$3)",
          [randomUUID(), userId, now]
        );
        return true;
      }
      return false;
    },
    async consumeQqUnbind(codeDigest, botAccountId, qqOpenId, now) {
      const identity = await this.getQqIdentity(botAccountId, qqOpenId);
      if (!identity) return false;
      const result = await pool.query(
        `update identity_challenges set consumed_at=$4
          where user_id=$1 and purpose='unbind_qq' and code_digest=$2
            and consumed_at is null and failed_at is null and expires_at>$3`,
        [identity.userId, codeDigest, now, now]
      );
      return (result.rowCount ?? 0) > 0 && this.unbindQqByUserId(identity.userId, now);
    },
    async claimQqMessage(botAccountId, platformMessageId, userId, now) {
      const result = await pool.query(
        `insert into qq_message_receipts(id,bot_account_id,platform_message_id,user_id,status,created_at)
         values ($1,$2,$3,$4,'processing',$5) on conflict (bot_account_id,platform_message_id) do nothing`,
        [randomUUID(), botAccountId, platformMessageId, userId ?? null, now]
      );
      return (result.rowCount ?? 0) === 1;
    },
    async completeQqMessage(botAccountId, platformMessageId, status, now, errorCode) {
      await pool.query(
        "update qq_message_receipts set status=$3,completed_at=$4,error_code=$5 where bot_account_id=$1 and platform_message_id=$2",
        [botAccountId, platformMessageId, status, now, errorCode ?? null]
      );
    }
  };
}

interface IdentityUserRow { id: string; created_at: Date | string; last_seen_at: Date | string }
interface SessionRow { user_id: string; expires_at: Date | string; revoked_at: Date | string | null }
interface QqIdentityRow { user_id: string; bot_account_id: string; qq_open_id: string; bound_at: Date | string }
interface ChallengeRow {
  id: string; user_id: string; purpose: "bind_qq" | "unbind_qq"; code_digest: string;
  expires_at: Date | string; attempts: number; max_attempts: number;
  consumed_at: Date | string | null; failed_at: Date | string | null;
}

function mapUser(row: IdentityUserRow): IdentityUser {
  return { userId: row.id, createdAt: toIso(row.created_at), lastSeenAt: toIso(row.last_seen_at) };
}
function mapSession(row: SessionRow): IdentitySession {
  return { userId: row.user_id, expiresAt: toIso(row.expires_at), revokedAt: row.revoked_at ? toIso(row.revoked_at) : undefined };
}
function mapQq(row: QqIdentityRow): QqIdentity {
  return { userId: row.user_id, botAccountId: row.bot_account_id, qqOpenId: row.qq_open_id, boundAt: toIso(row.bound_at) };
}
function mapChallenge(row: ChallengeRow): IdentityChallenge {
  return {
    challengeId: row.id,
    userId: row.user_id,
    purpose: row.purpose,
    codeDigest: row.code_digest,
    expiresAt: toIso(row.expires_at),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    consumedAt: row.consumed_at ? toIso(row.consumed_at) : undefined,
    failedAt: row.failed_at ? toIso(row.failed_at) : undefined
  };
}
async function findQqWithClient(client: pg.PoolClient, userId: string): Promise<QqIdentity | undefined> {
  const result = await client.query<QqIdentityRow>("select user_id,bot_account_id,qq_open_id,bound_at from qq_identities where user_id=$1", [userId]);
  return result.rows[0] ? mapQq(result.rows[0]) : undefined;
}
function toIso(value: Date | string): string { return postgresTimestampToIso(value); }
function isUniqueViolation(error: unknown): boolean { return isPostgresUniqueViolation(error); }
function isTransactionClosed(error: unknown): boolean { return error instanceof Error && error.message.includes("ROLLBACK"); }
