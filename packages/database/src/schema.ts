import { sql } from "drizzle-orm";
import { bigint, check, customType, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" }).notNull()
});

export const browserIdentities = pgTable("browser_identities", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  fingerprintDigest: text("fingerprint_digest").notNull(),
  fingerprintVersion: text("fingerprint_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  uniqueIndex("browser_identities_fingerprint_uq").on(table.fingerprintDigest),
  index("browser_identities_user_idx").on(table.userId)
]);

export const userSessions = pgTable("user_sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenDigest: text("token_digest").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" })
}, (table) => [
  uniqueIndex("user_sessions_token_uq").on(table.tokenDigest),
  index("user_sessions_user_idx").on(table.userId)
]);

export const qqIdentities = pgTable("qq_identities", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  botAccountId: text("bot_account_id").notNull(),
  qqOpenId: text("qq_open_id").notNull(),
  boundAt: timestamp("bound_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  uniqueIndex("qq_identities_user_uq").on(table.userId),
  uniqueIndex("qq_identities_external_uq").on(table.botAccountId, table.qqOpenId)
]);

export const identityChallenges = pgTable("identity_challenges", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  codeDigest: text("code_digest").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "string" }),
  failedAt: timestamp("failed_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  uniqueIndex("identity_challenges_code_uq").on(table.codeDigest),
  index("identity_challenges_user_idx").on(table.userId, table.purpose)
]);

export const qqMessageReceipts = pgTable("qq_message_receipts", {
  id: uuid("id").primaryKey(),
  botAccountId: text("bot_account_id").notNull(),
  platformMessageId: text("platform_message_id").notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  status: text("status").notNull(),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" })
}, (table) => [
  uniqueIndex("qq_message_receipts_platform_uq").on(table.botAccountId, table.platformMessageId)
]);

export const workflowRuns = pgTable("workflow_runs", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id").notNull(),
  agentRunId: text("agent_run_id").notNull(),
  planId: text("plan_id").notNull(),
  workflowName: text("workflow_name").notNull(),
  status: text("status").notNull(),
  currentNodeId: text("current_node_id"),
  error: jsonb("error"),
  snapshot: jsonb("snapshot").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  check("workflow_runs_status_check", sql`${table.status} in ('pending','running','paused','approved','rejected','succeeded','failed')`),
  index("workflow_runs_user_updated_idx").on(table.userId, table.updatedAt, table.id),
  index("workflow_runs_agent_run_idx").on(table.userId, table.agentRunId)
]);

export const workflowNodeRuns = pgTable("workflow_node_runs", {
  id: uuid("id").primaryKey(),
  workflowRunId: text("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull(),
  nodeType: text("node_type").notNull(),
  title: text("title").notNull(),
  attempt: integer("attempt").notNull(),
  status: text("status").notNull(),
  inputSummary: jsonb("input_summary"),
  outputSummary: jsonb("output_summary"),
  error: jsonb("error"),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  durationMs: integer("duration_ms").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  unique("workflow_node_runs_workflow_node_attempt_uq").on(table.workflowRunId, table.nodeId, table.attempt),
  check("workflow_node_runs_attempt_check", sql`${table.attempt} > 0`),
  check("workflow_node_runs_duration_check", sql`${table.durationMs} >= 0`),
  check("workflow_node_runs_status_check", sql`${table.status} in ('pending','running','paused','approved','rejected','succeeded','failed','skipped')`),
  index("workflow_node_runs_workflow_idx").on(table.workflowRunId, table.createdAt, table.id)
]);

export const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id").notNull(),
  agentRunId: text("agent_run_id").notNull(),
  workflowRunId: text("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
  reportId: text("report_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  title: text("title").notNull(),
  mediaType: text("media_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  checksumSha256: text("checksum_sha256"),
  storageProvider: text("storage_provider"),
  storageKey: text("storage_key"),
  markdownContent: text("markdown_content").notNull(),
  htmlContent: text("html_content").notNull(),
  payload: jsonb("payload").notNull(),
  metadata: jsonb("metadata").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" })
}, (table) => [
  check("artifacts_kind_check", sql`${table.kind} in ('research_report')`),
  check("artifacts_status_check", sql`${table.status} in ('html_preview_only','pdf_ready','pdf_failed')`),
  check("artifacts_media_type_check", sql`${table.mediaType} in ('text/html','application/pdf')`),
  check("artifacts_size_check", sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`),
  index("artifacts_user_updated_idx").on(table.userId, table.updatedAt, table.id),
  index("artifacts_workflow_idx").on(table.userId, table.workflowRunId)
]);

export const identityAuditEvents = pgTable("identity_audit_events", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(),
  reasonCode: text("reason_code"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  index("identity_audit_events_user_idx").on(table.userId, table.createdAt)
]);

// RAG 文档 lineage 三张表镜像 0050_rag_documents.sql；CHECK 约束以 migration 为准。
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey(),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(),
  sourceType: text("source_type").notNull(),
  externalId: text("external_id").notNull(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" })
}, (table) => [
  uniqueIndex("documents_owner_external_uq")
    .on(sql`coalesce(${table.ownerUserId}, '00000000-0000-0000-0000-000000000000'::uuid)`, table.externalId)
    .where(sql`${table.deletedAt} is null`),
  index("documents_owner_scope_idx").on(table.ownerUserId, table.scope),
  check("documents_owner_scope_check", sql`(${table.scope} = 'private') = (${table.ownerUserId} is not null)`)
]);

export const documentVersions = pgTable("document_versions", {
  id: uuid("id").primaryKey(),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  contentChecksum: text("content_checksum").notNull(),
  contentType: text("content_type").notNull(),
  sourceUri: text("source_uri").notNull(),
  storageKind: text("storage_kind").notNull(),
  content: text("content").notNull(),
  parserVersion: text("parser_version").notNull(),
  status: text("status").notNull(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  errorDetails: jsonb("error_details"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  indexedAt: timestamp("indexed_at", { withTimezone: true, mode: "string" })
}, (table) => [
  uniqueIndex("document_versions_document_id_version_key").on(table.documentId, table.version),
  uniqueIndex("document_versions_document_id_content_checksum_key").on(table.documentId, table.contentChecksum)
]);

export const chunks = pgTable("chunks", {
  id: uuid("id").primaryKey(),
  documentVersionId: uuid("document_version_id").notNull().references(() => documentVersions.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  chunkText: text("chunk_text").notNull(),
  heading: text("heading"),
  pageNumber: integer("page_number"),
  lineStart: integer("line_start"),
  lineEnd: integer("line_end"),
  tokenCount: integer("token_count"),
  chunkerVersion: text("chunker_version").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  contentChecksum: text("content_checksum").notNull()
}, (table) => [
  uniqueIndex("chunks_document_version_id_chunker_version_chunk_index_key").on(table.documentVersionId, table.chunkerVersion, table.chunkIndex),
  index("chunks_document_version_idx").on(table.documentVersionId)
]);

const vector32 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "public.vector(32)";
  }
});

// pgvector 表镜像 0060_rag_vectors.sql；HNSW operator class 由 migration 明确声明。
export const chunkEmbeddings = pgTable("chunk_embeddings", {
  id: uuid("id").primaryKey(),
  chunkId: uuid("chunk_id").notNull().references(() => chunks.id, { onDelete: "cascade" }),
  embeddingProvider: text("embedding_provider").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  dimensions: integer("dimensions").notNull(),
  embedding: vector32("embedding").notNull(),
  chunkContentChecksum: text("chunk_content_checksum").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  uniqueIndex("chunk_embeddings_chunk_model_dimensions_uq").on(table.chunkId, table.embeddingModel, table.dimensions),
  index("chunk_embeddings_model_dimensions_idx").on(table.embeddingModel, table.dimensions),
  check("chunk_embeddings_model_check", sql`${table.embeddingModel} = 'deterministic-mock-embedding-v1'`),
  check("chunk_embeddings_dimensions_check", sql`${table.dimensions} = 32`)
]);

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  status: text("status", { enum: ["active", "archived"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: "string" }).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" })
}, (table) => [
  index("conversations_user_status_last_message_idx").on(
    table.userId,
    table.status,
    table.lastMessageAt.desc(),
    table.id.desc()
  )
]);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  runId: uuid("run_id"),
  role: text("role", { enum: ["user", "assistant", "system", "tool"] }).notNull(),
  content: text("content").notNull(),
  status: text("status", { enum: ["pending", "streaming", "completed", "failed", "cancelled"] }).notNull(),
  clientMessageId: text("client_message_id"),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" })
}, (table) => [
  uniqueIndex("messages_conversation_sequence_uq").on(table.conversationId, table.sequence),
  uniqueIndex("messages_conversation_client_message_uq")
    .on(table.conversationId, table.clientMessageId)
    .where(sql`${table.clientMessageId} is not null`)
]);

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey(),
  requestId: text("request_id").notNull().unique(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  userMessageId: uuid("user_message_id").notNull(),
  assistantMessageId: uuid("assistant_message_id"),
  mode: text("mode").notNull(),
  source: text("source").notNull(),
  modelId: text("model_id").notNull(),
  status: text("status").notNull(),
  intent: text("intent"),
  traceId: text("trace_id").notNull(),
  workflowRunId: text("workflow_run_id"),
  result: jsonb("result"),
  error: jsonb("error"),
  version: bigint("version", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" })
});

export const messageAttachments = pgTable("message_attachments", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messagesV2.id, { onDelete: "cascade" }),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "restrict" }),
  ordinal: integer("ordinal").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  uniqueIndex("message_attachments_message_document_uq").on(table.messageId, table.documentId),
  uniqueIndex("message_attachments_message_ordinal_uq").on(table.messageId, table.ordinal),
  index("message_attachments_user_message_idx").on(table.userId, table.messageId, table.ordinal)
]);

export const chatAttachmentUploads = pgTable("chat_attachment_uploads", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  clientAttachmentId: text("client_attachment_id").notNull(),
  contentChecksum: text("content_checksum").notNull(),
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "restrict" }),
  boundMessageId: uuid("bound_message_id").references(() => messagesV2.id, { onDelete: "restrict" }),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  status: text("status").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  uniqueIndex("chat_attachment_uploads_user_client_uq").on(table.userId, table.clientAttachmentId),
  uniqueIndex("chat_attachment_uploads_document_uq").on(table.documentId),
  uniqueIndex("chat_attachment_uploads_message_document_uq").on(table.boundMessageId, table.documentId),
  index("chat_attachment_uploads_orphan_idx").on(table.uploadedAt, table.id)
]);

// Approval 表镜像 0040_approval.sql；状态与决定由 CHECK 与 repository CAS 共同保证。
export const toolApprovals = pgTable("tool_approvals", {
  id: text("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  traceId: text("trace_id").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  toolName: text("tool_name"),
  permissionLevel: text("permission_level"),
  reason: text("reason"),
  reasonCode: text("reason_code"),
  inputDigest: text("input_digest").notNull(),
  inputPreview: jsonb("input_preview"),
  status: text("status").notNull(),
  decision: text("decision"),
  requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" }).notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
  reviewerUserId: uuid("reviewer_user_id"),
  reviewerNote: text("reviewer_note")
}, (table) => [
  check("tool_approvals_permission_level_check", sql`${table.permissionLevel} in ('safe','needs_approval','blocked')`),
  check("tool_approvals_status_check", sql`${table.status} in ('pending','approved','rejected','expired')`),
  check("tool_approvals_decision_check", sql`${table.decision} in ('approved','rejected')`),
  index("tool_approvals_user_status_requested_idx").on(table.userId, table.status, table.requestedAt),
  index("tool_approvals_run_idx").on(table.runId)
]);

export const runEvents = pgTable("run_events", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  traceId: text("trace_id").notNull(),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  uniqueIndex("run_events_run_sequence_uq").on(table.runId, table.sequence),
  index("run_events_user_run_sequence_idx").on(table.userId, table.runId, table.sequence)
]);

export const traces = pgTable("traces", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().unique(),
  runId: uuid("run_id").notNull().unique().references(() => agentRuns.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  modelCallCount: integer("model_call_count").notNull().default(0),
  toolCallCount: integer("tool_call_count").notNull().default(0),
  retrievalCount: integer("retrieval_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  knownTokenTotal: integer("known_token_total").notNull().default(0),
  unknownTokenCallCount: integer("unknown_token_call_count").notNull().default(0),
  lastSequence: bigint("last_sequence", { mode: "number" }).notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" })
}, (table) => [
  check("traces_status_check", sql`${table.status} in ('running','succeeded','failed')`),
  index("traces_user_request_idx").on(table.userId, table.requestId)
]);

export const traceEvents = pgTable("trace_events", {
  id: uuid("id").primaryKey(),
  traceId: text("trace_id").notNull().references(() => traces.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  eventType: text("event_type").notNull(),
  spanId: text("span_id"),
  parentSpanId: text("parent_span_id"),
  stage: text("stage"),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  uniqueIndex("trace_events_trace_sequence_uq").on(table.traceId, table.sequence),
  index("trace_events_user_trace_sequence_idx").on(table.userId, table.traceId, table.sequence)
]);

// Citation 表镜像 0080_citations.sql；被引用 chunk/version 默认保留（restrict），生成物删除级联。
export const messageCitations = pgTable("message_citations", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messagesV2.id, { onDelete: "cascade" }),
  chunkId: uuid("chunk_id").references(() => chunks.id, { onDelete: "restrict" }),
  documentVersionId: uuid("document_version_id").references(() => documentVersions.id, { onDelete: "restrict" }),
  ordinal: integer("ordinal").notNull(),
  claim: text("claim").notNull(),
  quote: text("quote").notNull(),
  score: doublePrecision("score"),
  verifierStatus: text("verifier_status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  uniqueIndex("message_citations_message_id_ordinal_key").on(table.messageId, table.ordinal),
  index("message_citations_chunk_idx").on(table.chunkId),
  index("message_citations_document_version_idx").on(table.documentVersionId),
  index("message_citations_user_message_idx").on(table.userId, table.messageId, table.ordinal),
  check("message_citations_ordinal_check", sql`${table.ordinal} > 0`),
  check("message_citations_verifier_status_check", sql`${table.verifierStatus} in ('unverified','verified','rejected','manual_verified','manual_rejected')`)
]);

export const artifactCitations = pgTable("artifact_citations", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  artifactId: text("artifact_id").notNull().references(() => artifacts.id, { onDelete: "cascade" }),
  chunkId: uuid("chunk_id").references(() => chunks.id, { onDelete: "restrict" }),
  documentVersionId: uuid("document_version_id").references(() => documentVersions.id, { onDelete: "restrict" }),
  ordinal: integer("ordinal").notNull(),
  claim: text("claim").notNull(),
  quote: text("quote").notNull(),
  score: doublePrecision("score"),
  verifierStatus: text("verifier_status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  uniqueIndex("artifact_citations_artifact_id_ordinal_key").on(table.artifactId, table.ordinal),
  index("artifact_citations_chunk_idx").on(table.chunkId),
  index("artifact_citations_document_version_idx").on(table.documentVersionId),
  index("artifact_citations_user_artifact_idx").on(table.userId, table.artifactId, table.ordinal),
  check("artifact_citations_ordinal_check", sql`${table.ordinal} > 0`),
  check("artifact_citations_verifier_status_check", sql`${table.verifierStatus} in ('unverified','verified','rejected','manual_verified','manual_rejected')`)
]);

// ============================================================================
// 阶段 3：线性消息 + run 新 schema（0110_linear_messages.sql，_v2 后缀避免与旧表冲突）。
// 旧表镜像保留至阶段 6 统一删除。
// ============================================================================

export const conversationsV2 = pgTable("conversations_v2", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: "string" }).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" })
}, (table) => [
  index("conversations_v2_user_status_last_message_idx").on(table.userId, table.status, table.lastMessageAt, table.id),
  check("conversations_v2_status_check", sql`${table.status} in ('active','archived')`)
]);

export const messagesV2 = pgTable("messages_v2", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id").notNull().references(() => conversationsV2.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  runId: uuid("run_id"),
  role: text("role").notNull(),
  content: jsonb("content").notNull(),
  messageType: text("message_type").notNull().default("normal"),
  clientMessageId: text("client_message_id"),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  usage: jsonb("usage"),
  modelId: text("model_id"),
  stopReason: text("stop_reason"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  unique("messages_v2_conversation_sequence_uq").on(table.conversationId, table.sequence),
  uniqueIndex("messages_v2_conversation_client_message_uq").on(table.conversationId, table.clientMessageId),
  index("messages_v2_conversation_sequence_idx").on(table.conversationId, table.sequence),
  check("messages_v2_role_check", sql`${table.role} in ('user','assistant','toolResult')`),
  check("messages_v2_message_type_check", sql`${table.messageType} in ('normal','compaction')`)
]);

export const runsV2 = pgTable("runs_v2", {
  id: uuid("id").primaryKey(),
  requestId: text("request_id").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversationsV2.id, { onDelete: "cascade" }),
  userMessageId: uuid("user_message_id").notNull(),
  modelId: text("model_id").notNull(),
  mode: text("mode").notNull(),
  source: text("source").notNull(),
  status: text("status").notNull(),
  intent: text("intent"),
  workflowRunId: text("workflow_run_id"),
  error: jsonb("error"),
  lastEventSequence: bigint("last_event_sequence", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" })
}, (table) => [
  uniqueIndex("runs_v2_request_id_key").on(table.requestId),
  index("runs_v2_user_updated_idx").on(table.userId, table.updatedAt, table.id),
  index("runs_v2_conversation_idx").on(table.userId, table.conversationId, table.updatedAt, table.id),
  check("runs_v2_mode_check", sql`${table.mode} in ('auto','report')`),
  check("runs_v2_source_check", sql`${table.source} in ('composer','report_button')`),
  check("runs_v2_status_check", sql`${table.status} in ('queued','running','completed','failed','cancelled','interrupted')`)
]);

export const runEventsV2 = pgTable("run_events_v2", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runsV2.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversationsV2.id, { onDelete: "cascade" }),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  unique("run_events_v2_run_sequence_uq").on(table.runId, table.sequence),
  index("run_events_v2_user_run_sequence_idx").on(table.userId, table.runId, table.sequence),
  check("run_events_v2_sequence_check", sql`${table.sequence} > 0`),
  check("run_events_v2_event_type_check", sql`${table.eventType} in ('agent_start','agent_end','turn_start','turn_end','message_start','message_update','message_end','tool_execution_start','tool_execution_update','tool_execution_end','retrieval','workflow_node','pdf_export','mcp_tool_discovered','run_status','run_error')`)
]);
