import type pg from "pg";
import { randomUUID } from "node:crypto";
import { RepositoryError } from "./repository-error.js";
import { postgresTimestampToIso, withTransaction } from "./postgres.js";

const ATTACHMENT_LEASE_MS = 15 * 60_000;

export interface AttachmentUploadRecord {
  userId: string;
  clientAttachmentId: string;
  checksum: string;
  documentId?: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  status: "uploading" | "indexed" | "failed";
  uploadedAt: string;
  claimToken: string;
  leaseExpiresAt: string;
}

export interface AttachmentRepository {
  claim(input: Omit<AttachmentUploadRecord, "documentId" | "status" | "uploadedAt" | "claimToken" | "leaseExpiresAt">, now: string):
    Promise<{ created: boolean; upload: AttachmentUploadRecord }>;
  renew(userId: string, clientAttachmentId: string, claimToken: string, now: string): Promise<boolean>;
  complete(userId: string, clientAttachmentId: string, claimToken: string, documentId: string, now: string): Promise<void>;
  fail(userId: string, clientAttachmentId: string, claimToken: string, now: string): Promise<void>;
  /**
   * 按 documentId 查找当前用户已 indexed 的上传记录，用于 run 创建前校验附件归属。
   *
   * @param userId 当前用户。
   * @param documentId RAG 文档 ID。
   * @returns 上传记录；不存在或不属于该用户时返回 undefined。
   */
  findByDocumentId(userId: string, documentId: string): Promise<AttachmentUploadRecord | undefined>;
  /**
   * 把已 indexed 的附件绑定到触发它的用户消息，避免孤儿清理误删。
   *
   * @param userId 当前用户。
   * @param documentId RAG 文档 ID。
   * @param messageId 用户消息 ID。
   */
  bindMessageByDocumentId(userId: string, documentId: string, messageId: string): Promise<void>;
  cleanupOrphans(before: string, limit: number, now: string): Promise<number>;
}

/** @param pool PostgreSQL pool。 @returns 聊天附件上传 repository。 */
export function createPostgresAttachmentRepository(pool: pg.Pool): AttachmentRepository {
  return {
    async claim(input, now) {
      return withTransaction(pool, async (client) => {
        const claimToken = randomUUID();
        const leaseExpiresAt = leaseExpiry(now);
        const inserted = await client.query<UploadRow>(
          `insert into chat_attachment_uploads(
             id,user_id,client_attachment_id,content_checksum,claim_token,lease_expires_at,
             file_name,content_type,size_bytes,status,uploaded_at,updated_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'uploading',$10,$10)
           on conflict (user_id,client_attachment_id) do nothing returning *`,
          [randomUUID(), input.userId, input.clientAttachmentId, input.checksum, claimToken, leaseExpiresAt,
            input.fileName, input.contentType, input.sizeBytes, now]
        );
        if (inserted.rows[0]) return { created: true, upload: mapUpload(inserted.rows[0]) };
        const existing = await client.query<UploadRow>(
          "select * from chat_attachment_uploads where user_id=$1 and client_attachment_id=$2 for update",
          [input.userId, input.clientAttachmentId]
        );
        const row = existing.rows[0];
        if (!row) throw new RepositoryError("database_unavailable", "Attachment claim was not readable.");
        if (row.content_checksum !== input.checksum) {
          throw new RepositoryError("conflict", "Attachment idempotency key conflicts with existing content.");
        }
        const leaseExpired = new Date(row.lease_expires_at).getTime() <= new Date(now).getTime();
        if (row.status === "failed" || (row.status === "uploading" && leaseExpired)) {
          const retried = await client.query<UploadRow>(
            `update chat_attachment_uploads
                set status='uploading',claim_token=$3,lease_expires_at=$4,updated_at=$5
              where user_id=$1 and client_attachment_id=$2 returning *`,
            [input.userId, input.clientAttachmentId, claimToken, leaseExpiresAt, now]
          );
          return { created: true, upload: mapUpload(retried.rows[0] ?? row) };
        }
        return { created: false, upload: mapUpload(row) };
      });
    },
    async renew(userId, clientAttachmentId, claimToken, now) {
      const renewed = await pool.query(
        `update chat_attachment_uploads set lease_expires_at=$4,updated_at=$5
          where user_id=$1 and client_attachment_id=$2 and claim_token=$3 and status='uploading'`,
        [userId, clientAttachmentId, claimToken, leaseExpiry(now), now]
      );
      return renewed.rowCount === 1;
    },
    async complete(userId, clientAttachmentId, claimToken, documentId, now) {
      const completed = await pool.query(
        `update chat_attachment_uploads set document_id=$3,status='indexed',updated_at=$4
          where user_id=$1 and client_attachment_id=$2 and claim_token=$5 and status='uploading'`,
        [userId, clientAttachmentId, documentId, now, claimToken]
      );
      if (completed.rowCount !== 1) {
        throw new RepositoryError("conflict", "Attachment upload is no longer completable.");
      }
    },
    async fail(userId, clientAttachmentId, claimToken, now) {
      await pool.query(
        `update chat_attachment_uploads set status='failed',updated_at=$3
          where user_id=$1 and client_attachment_id=$2 and claim_token=$4 and status='uploading'`,
        [userId, clientAttachmentId, now, claimToken]
      );
    },
    async findByDocumentId(userId, documentId) {
      const result = await pool.query<UploadRow>(
        "select * from chat_attachment_uploads where user_id=$1 and document_id=$2",
        [userId, documentId]
      );
      return result.rows[0] ? mapUpload(result.rows[0]) : undefined;
    },
    async bindMessageByDocumentId(userId, documentId, messageId) {
      const result = await pool.query(
        `update chat_attachment_uploads
            set bound_message_id=$3, updated_at=now()
          where user_id=$1 and document_id=$2 and status='indexed'`,
        [userId, documentId, messageId]
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new RepositoryError("not_found", "Attachment upload not found or not indexed.");
      }
    },
    async cleanupOrphans(before, limit, now) {
      return withTransaction(pool, async (client) => {
        const candidates = await client.query<{ id: string; document_id: string | null }>(
          `select id,document_id from chat_attachment_uploads
            where status in ('uploading','indexed','failed') and bound_message_id is null and uploaded_at<$1
            order by uploaded_at,id for update skip locked limit $2`,
          [before, Math.max(1, Math.min(500, limit))]
        );
        if (candidates.rows.length === 0) return 0;
        const ids = candidates.rows.map((row) => row.id);
        const documentIds = candidates.rows.flatMap((row) => row.document_id ? [row.document_id] : []);
        if (documentIds.length > 0) {
          await client.query(
            "update documents set deleted_at=$2 where id=any($1::uuid[]) and deleted_at is null",
            [documentIds, now]
          );
        }
        await client.query("delete from chat_attachment_uploads where id=any($1::uuid[])", [ids]);
        return ids.length;
      });
    }
  };
}

/** @param now 当前 ISO 时间。 @returns 覆盖正常解析、切块和 embedding 的租约终点。 */
function leaseExpiry(now: string): string {
  return new Date(new Date(now).getTime() + ATTACHMENT_LEASE_MS).toISOString();
}

interface UploadRow {
  user_id: string; client_attachment_id: string; content_checksum: string; document_id: string | null;
  file_name: string; content_type: string; size_bytes: string | number;
  status: AttachmentUploadRecord["status"]; uploaded_at: Date | string;
  claim_token: string; lease_expires_at: Date | string;
}

/** @param row 数据库行。 @returns 上传领域记录。 */
function mapUpload(row: UploadRow): AttachmentUploadRecord {
  return {
    userId: row.user_id,
    clientAttachmentId: row.client_attachment_id,
    checksum: row.content_checksum,
    documentId: row.document_id ?? undefined,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    uploadedAt: postgresTimestampToIso(row.uploaded_at),
    claimToken: row.claim_token,
    leaseExpiresAt: postgresTimestampToIso(row.lease_expires_at)
  };
}
