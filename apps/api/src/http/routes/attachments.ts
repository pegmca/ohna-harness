import type { DataSourceRuntime } from "@aiagent/rag";
import { RepositoryError, type AttachmentRepository } from "@aiagent/database";
import type {
  ApiResult,
  ChatAttachmentDto,
  ChatAttachmentUploadRequestDto
} from "@aiagent/types";
import type { IdentitySnapshot } from "@aiagent/identity";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { chatAttachmentUploadRequestSchema } from "../schemas.js";
import { createRequestId, fail, ragErrorStatusCode, toApiError, toApiErrorFromRagError } from "../errors.js";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const LEASE_RENEW_INTERVAL_MS = 60_000;

/**
 * 注册 Composer 附件上传入口；原文进入私有 RAG lineage，不在 API 内保存第二份 bytes。
 *
 * @param app Fastify 实例。
 * @param deps RAG runtime 与身份映射。
 * @returns 无返回值。
 */
export function registerAttachmentRoutes(
  app: FastifyInstance,
  deps: {
    dataSourceRuntime: DataSourceRuntime;
    attachmentRepository: AttachmentRepository;
    identityByRequest: WeakMap<object, IdentitySnapshot>;
  }
): void {
  app.post(
    "/api/attachments",
    { bodyLimit: MAX_ATTACHMENT_BYTES + 64 * 1024 },
    async (request, reply): Promise<ApiResult<ChatAttachmentDto>> => {
      const requestId = createRequestId();
      const parsed = chatAttachmentUploadRequestSchema.safeParse(request.body);
      const actualBytes = Buffer.byteLength(parsed.data?.content ?? "", "utf8");
      if (
        !parsed.success
        || actualBytes > MAX_ATTACHMENT_BYTES
        || actualBytes !== parsed.data?.sizeBytes
      ) {
        reply.code(400);
        return fail(toApiError("validation_failed", "附件仅支持 10MB 以内的 Markdown/TXT 文件。", requestId, {
          issues: parsed.success ? undefined : parsed.error.issues
        }), requestId);
      }
      const input = parsed.data satisfies ChatAttachmentUploadRequestDto;
      const userId = deps.identityByRequest.get(request)?.userId;
      if (!userId) {
        reply.code(401);
        return fail(toApiError("unauthorized", "Authentication is required.", requestId), requestId);
      }
      const checksum = createHash("sha256").update(input.content).digest("hex");
      let claimed;
      try {
        claimed = await deps.attachmentRepository.claim({
          userId,
          clientAttachmentId: input.clientAttachmentId,
          checksum,
          fileName: input.fileName,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes
        }, new Date().toISOString());
      } catch (error) {
        if (error instanceof RepositoryError && error.code === "conflict") {
          reply.code(409);
          return fail(toApiError("conflict", error.message, requestId), requestId);
        }
        throw error;
      }
      if (!claimed.created) {
        if (claimed.upload.status === "indexed" && claimed.upload.documentId) {
          return {
            ok: true,
            requestId,
            data: {
              documentId: claimed.upload.documentId,
              clientAttachmentId: input.clientAttachmentId,
              fileName: claimed.upload.fileName,
              contentType: claimed.upload.contentType,
              sizeBytes: claimed.upload.sizeBytes,
              status: "indexed"
            }
          };
        }
        reply.code(409);
        return fail(toApiError("conflict", "附件仍在处理中，请稍后使用相同标识重试。", requestId), requestId);
      }
      // 大文件 indexing 可能超过初始租约；心跳只更新当前 token，过期执行者无法续租或完成。
      const leaseTimer = setInterval(() => {
        void deps.attachmentRepository.renew(
          userId, input.clientAttachmentId, claimed.upload.claimToken, new Date().toISOString()
        ).then((renewed) => {
          if (!renewed) request.log.warn({ clientAttachmentId: input.clientAttachmentId }, "attachment lease was lost");
        }).catch((error: unknown) => {
          request.log.warn({ err: error, clientAttachmentId: input.clientAttachmentId }, "attachment lease renewal failed");
        });
      }, LEASE_RENEW_INTERVAL_MS);
      leaseTimer.unref();
      let result;
      try {
        result = await deps.dataSourceRuntime.ingest({
          source: `upload:${input.clientAttachmentId}`,
          fileName: input.fileName,
          contentType: input.contentType,
          content: input.content
        }, { ownerUserId: userId });
      } finally {
        clearInterval(leaseTimer);
      }
      if (!result.ok) {
        await deps.attachmentRepository.fail(
          userId, input.clientAttachmentId, claimed.upload.claimToken, new Date().toISOString()
        );
        reply.code(ragErrorStatusCode(result.error));
        return fail(toApiErrorFromRagError(result.error, requestId), requestId);
      }
      await deps.attachmentRepository.complete(
        userId,
        input.clientAttachmentId,
        claimed.upload.claimToken,
        result.data.document.documentId,
        new Date().toISOString()
      );
      return {
        ok: true,
        requestId,
        data: {
          documentId: result.data.document.documentId,
          clientAttachmentId: input.clientAttachmentId,
          fileName: input.fileName,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          status: "indexed"
        }
      };
    }
  );
}
