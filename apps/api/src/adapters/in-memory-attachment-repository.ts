import type { AttachmentRepository, AttachmentUploadRecord } from "@aiagent/database";
import { RepositoryError } from "@aiagent/database";

type StoredUpload = AttachmentUploadRecord & { boundMessageId?: string };

/**
 * 创建内存版附件 repository（仅测试显式使用）。
 *
 * 语义对齐 PostgreSQL adapter：claim 幂等、complete 需匹配 claimToken、
 * bind 只允许未绑定或绑定到同一消息，cleanupOrphans 删除未绑定且过期的上传。
 *
 * @returns 测试用 AttachmentRepository。
 */
export function createInMemoryAttachmentRepository(): AttachmentRepository {
  const uploads = new Map<string, StoredUpload>();
  const keyOf = (userId: string, clientAttachmentId: string) => `${userId}:${clientAttachmentId}`;

  return {
    async claim(input, now) {
      const key = keyOf(input.userId, input.clientAttachmentId);
      const existing = uploads.get(key);
      if (existing) {
        if (existing.checksum !== input.checksum) {
          throw new RepositoryError("conflict", "Attachment idempotency key conflicts with existing content.");
        }
        return { created: false, upload: { ...existing } };
      }
      const upload: StoredUpload = {
        ...input,
        status: "uploading",
        uploadedAt: now,
        claimToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.parse(now) + 15 * 60_000).toISOString()
      };
      uploads.set(key, upload);
      return { created: true, upload: { ...upload } };
    },
    async renew(userId, clientAttachmentId, claimToken, now) {
      const key = keyOf(userId, clientAttachmentId);
      const existing = uploads.get(key);
      if (!existing || existing.claimToken !== claimToken || existing.status !== "uploading") return false;
      existing.leaseExpiresAt = new Date(Date.parse(now) + 15 * 60_000).toISOString();
      return true;
    },
    async complete(userId, clientAttachmentId, claimToken, documentId, now) {
      const key = keyOf(userId, clientAttachmentId);
      const existing = uploads.get(key);
      if (!existing || existing.claimToken !== claimToken || existing.status !== "uploading") {
        throw new RepositoryError("conflict", "Attachment upload is no longer completable.");
      }
      existing.documentId = documentId;
      existing.status = "indexed";
      existing.uploadedAt = now;
    },
    async fail(userId, clientAttachmentId, claimToken, now) {
      const key = keyOf(userId, clientAttachmentId);
      const existing = uploads.get(key);
      if (existing && existing.claimToken === claimToken && existing.status === "uploading") {
        existing.status = "failed";
        existing.uploadedAt = now;
      }
    },
    async findByDocumentId(userId, documentId) {
      const found = [...uploads.values()].find(
        (upload) => upload.userId === userId && upload.documentId === documentId
      );
      return found ? { ...found } : undefined;
    },
    async bindMessageByDocumentId(userId, documentId, messageId) {
      const found = [...uploads.values()].find(
        (upload) => upload.userId === userId && upload.documentId === documentId && upload.status === "indexed"
      );
      if (!found) {
        throw new RepositoryError("not_found", "Attachment upload not found or not indexed.");
      }
      found.boundMessageId = messageId;
    },
    async cleanupOrphans(before, limit) {
      let cleaned = 0;
      for (const [key, upload] of uploads) {
        if (cleaned >= limit) break;
        if (!upload.boundMessageId && upload.uploadedAt < before) {
          uploads.delete(key);
          cleaned += 1;
        }
      }
      return cleaned;
    }
  };
}
