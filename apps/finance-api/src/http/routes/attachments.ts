import {
  ingestChatAttachment,
  type AttachmentStore,
  type EmbeddingClient,
  type RagStructuredError
} from "@aiagent/rag";
import { RepositoryError, type AttachmentRepository } from "@aiagent/database";
import type {
  ApiResult,
  ChatAttachmentDto,
  ChatAttachmentUploadRequestDto
} from "@aiagent/types";
import type { IdentitySnapshot } from "@aiagent/identity";
import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { chatAttachmentUploadRequestSchema } from "../schemas.js";
import { createRequestId, fail, ragErrorStatusCode, toApiError, toApiErrorFromRagError } from "../errors.js";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const LEASE_RENEW_INTERVAL_MS = 60_000;

/**
 * 注册 Composer 附件上传入口：附件为**会话级临时**数据，解析→切块→embed 后写入
 * AttachmentStore（生产 Redis，测试内存），**不落主库**（不建 documents/versions/chunks 行）。
 * 主库只保留 chat_attachment_uploads 的上传记录（幂等/审计），其 document_id 存 Redis 附件的逻辑 uuid。
 *
 * @param app Fastify 实例。
 * @param deps 会话级附件存储、embedding provider、上传记录 repository 与身份映射。
 * @returns 无返回值。
 */
export function registerAttachmentRoutes(
  app: FastifyInstance,
  deps: {
    attachmentStore: AttachmentStore;
    /** embedding provider；缺省（未注入）时上传返回 503，不静默降级为无索引。 */
    embeddingClient?: EmbeddingClient;
    attachmentRepository: AttachmentRepository;
    identityByRequest: WeakMap<object, IdentitySnapshot>;
    /**
     * 内联阈值（字符数）：解析文本 ≤ 该值走原文内联，否则切块 + embed + upsert。
     * 缺省由 @aiagent/rag 常量 DEFAULT_ATTACHMENT_INLINE_MAX_CHARS (200_000) 决定。
     */
    inlineMaxChars?: number;
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
          conversationId: input.conversationId,
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
      // 附件索引依赖 embedding provider；未注入时属于"服务端尚未具备能力"（503，可诊断不可重试解决），
      // 与 ingest 内部 embedding_provider_disabled 语义一致。先 fail 上传记录，避免留下永久 uploading 租约。
      const embeddingClient = deps.embeddingClient;
      if (!embeddingClient) {
        await deps.attachmentRepository.fail(
          userId, input.clientAttachmentId, claimed.upload.claimToken, new Date().toISOString()
        );
        const providerDisabled: RagStructuredError = {
          code: "embedding_provider_disabled",
          message: "Embedding provider 未启用，无法为附件建立向量索引。",
          details: { reason: "embedding_client_not_injected" }
        };
        reply.code(ragErrorStatusCode(providerDisabled));
        return fail(toApiErrorFromRagError(providerDisabled, requestId), requestId);
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
      // 附件文档逻辑 id 必须是 uuid：run 请求的 attachmentDocumentIds 按 uuid 校验，
      // 且它同时是 Redis 附件 key、上传记录 document_id 与 citation 来源的共同标识。
      const documentId = randomUUID();
      let result;
      try {
        result = await ingestChatAttachment({
          embeddingClient,
          attachmentStore: deps.attachmentStore,
          conversationId: input.conversationId,
          documentId,
          source: `upload:${input.clientAttachmentId}`,
          fileName: input.fileName,
          contentType: input.contentType,
          content: input.content,
          inlineMaxChars: deps.inlineMaxChars
        });
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
        documentId,
        new Date().toISOString()
      );
      return {
        ok: true,
        requestId,
        data: {
          documentId,
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
