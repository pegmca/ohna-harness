import { isSafeRagSourceUri } from "@aiagent/rag";
import { z } from "zod";

export const agentRunRequestSchema = z.object({
  message: z.string(),
  conversationId: z.string().min(1),
  mode: z.enum(["auto", "report"]),
  source: z.enum(["composer", "report_button"]),
  clientMessageId: z.string().min(1).max(200).optional()
});
export const runEventsQuerySchema = z.object({
  afterSequence: z.coerce.number().int().min(0).optional()
});
export const createConversationRequestSchema = z.object({
  title: z.string().trim().min(1).max(120)
}).strict();
export const conversationPageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).default(30)
});
export const updateConversationRequestSchema = z.union([
  z.object({ title: z.string().trim().min(1).max(120) }).strict(),
  z.object({ archive: z.literal(true) }).strict()
]);
export const identityBootstrapSchema = z.object({
  visitorId: z.string().min(8).max(256).regex(/^[A-Za-z0-9_-]+$/),
  fingerprintVersion: z.string().min(1).max(40)
});
export const dataSourceIngestRequestSchema = z.object({
  // source 安全边界与 RAG runtime 写入口一致：拒绝本地路径、file: URI 和目录穿越。
  source: z.string().min(1).refine(isSafeRagSourceUri, {
    message: "source 仅支持 http(s) URL、mock:/demo: URI 或相对逻辑标识"
  }),
  fileName: z.string().min(1),
  contentType: z.string().min(1).optional(),
  content: z.string().min(1)
});
export const dataSourceDocumentsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50)
});
export const dataSourceChunksQuerySchema = dataSourceDocumentsQuerySchema.extend({
  documentId: z.string().min(1).optional()
});
export const ragSearchRequestSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().optional()
});
export const ragAnswerRequestSchema = z.object({
  question: z.string().min(1),
  topK: z.number().int().positive().optional()
});
export const approvalDecisionRequestSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reviewerNote: z.string().max(240).optional(),
  inputDigest: z.string().min(1)
});
