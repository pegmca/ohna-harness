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
  check("workflow_runs_status_check", sql`${table.status} in ('pending','running','succeeded','failed')`),
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
  check("workflow_node_runs_status_check", sql`${table.status} in ('pending','running','succeeded','failed','skipped')`),
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

// 生产默认维度 1536（DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS），与 P1 真实模型约定一致。
const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "public.vector(1536)";
  }
});

// pgvector 表镜像 0060_rag_vectors.sql + 0070_rag_vector_dimensions.sql；HNSW operator class 由 migration 明确声明。
// 维度与模型 CHECK 已放宽：维度仅约束 0 < dimensions <= 1536，模型不再锁死 deterministic mock。
export const chunkEmbeddings = pgTable("chunk_embeddings", {
  id: uuid("id").primaryKey(),
  chunkId: uuid("chunk_id").notNull().references(() => chunks.id, { onDelete: "cascade" }),
  embeddingProvider: text("embedding_provider").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  dimensions: integer("dimensions").notNull(),
  embedding: vector1536("embedding").notNull(),
  chunkContentChecksum: text("chunk_content_checksum").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  uniqueIndex("chunk_embeddings_chunk_model_dimensions_uq").on(table.chunkId, table.embeddingModel, table.dimensions),
  index("chunk_embeddings_model_dimensions_idx").on(table.embeddingModel, table.dimensions),
  check("chunk_embeddings_dimensions_check", sql`${table.dimensions} > 0 and ${table.dimensions} <= 1536`)
]);

// ============================================================================
// 阶段 6：线性消息 + run 最终 schema（0160_drop_legacy_schema.sql 重命名后）。
// 旧 conversations / messages / agent_runs / run_events / traces / trace_events / tool_approvals 已删除。
// ============================================================================

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: "string" }).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" })
}, (table) => [
  index("conversations_user_status_last_message_idx").on(table.userId, table.status, table.lastMessageAt.desc(), table.id.desc()),
  check("conversations_status_check", sql`${table.status} in ('active','archived')`)
]);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // run_id 与 runs.user_message_id 构成循环外键，由 migration 的 ALTER TABLE 补齐；schema 镜像不声明引用。
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
  unique("messages_conversation_sequence_uq").on(table.conversationId, table.sequence),
  uniqueIndex("messages_conversation_client_message_uq")
    .on(table.conversationId, table.clientMessageId)
    .where(sql`${table.clientMessageId} is not null`),
  index("messages_conversation_sequence_idx").on(table.conversationId, table.sequence),
  check("messages_role_check", sql`${table.role} in ('user','assistant','toolResult')`),
  check("messages_message_type_check", sql`${table.messageType} in ('normal','compaction')`)
]);

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey(),
  requestId: text("request_id").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // conversation_id 仅作查询冗余，不建 FK：避免 appendEvent 更新 runs 与 persistMessage 锁 conversations 并发死锁。
  conversationId: uuid("conversation_id").notNull(),
  // user_message_id 与 messages.run_id 构成循环外键，由 migration 的 ALTER TABLE 补齐；schema 镜像不声明引用。
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
  uniqueIndex("runs_request_id_key").on(table.requestId),
  index("runs_user_updated_idx").on(table.userId, table.updatedAt.desc(), table.id.desc()),
  index("runs_conversation_idx").on(table.userId, table.conversationId, table.updatedAt.desc(), table.id.desc()),
  index("runs_active_idx").on(table.updatedAt, table.id).where(sql`${table.status} in ('queued','running')`),
  check("runs_mode_check", sql`${table.mode} in ('auto','report')`),
  check("runs_source_check", sql`${table.source} in ('composer','report_button')`),
  check("runs_status_check", sql`${table.status} in ('queued','running','completed','failed','cancelled','interrupted')`)
]);

export const runEvents = pgTable("run_events", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // conversation_id 仅作审计/调试冗余，不建 FK 与独立索引：避免 appendEvent 与 persistMessage 并发死锁。
  conversationId: uuid("conversation_id").notNull(),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  unique("run_events_run_sequence_uq").on(table.runId, table.sequence),
  index("run_events_user_run_sequence_idx").on(table.userId, table.runId, table.sequence),
  check("run_events_sequence_check", sql`${table.sequence} > 0`),
  check("run_events_event_type_check", sql`${table.eventType} in ('agent_start','agent_end','turn_start','turn_end','message_start','message_update','message_end','tool_execution_start','tool_execution_update','tool_execution_end','retrieval','workflow_node','pdf_export','mcp_tool_discovered','run_status','run_error')`)
]);

export const messageAttachments = pgTable("message_attachments", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "restrict" }),
  ordinal: integer("ordinal").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
}, (table) => [
  uniqueIndex("message_attachments_message_document_uq").on(table.messageId, table.documentId),
  uniqueIndex("message_attachments_message_ordinal_uq").on(table.messageId, table.ordinal),
  index("message_attachments_user_message_idx").on(table.userId, table.messageId, table.ordinal),
  check("message_attachments_ordinal_check", sql`${table.ordinal} >= 0`)
]);

export const chatAttachmentUploads = pgTable("chat_attachment_uploads", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  clientAttachmentId: text("client_attachment_id").notNull(),
  contentChecksum: text("content_checksum").notNull(),
  claimToken: uuid("claim_token").notNull(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "string" }).notNull(),
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "restrict" }),
  boundMessageId: uuid("bound_message_id").references(() => messages.id, { onDelete: "restrict" }),
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
  index("chat_attachment_uploads_orphan_idx").on(table.uploadedAt, table.id).where(sql`${table.status} = 'indexed' and ${table.boundMessageId} is null`),
  index("chat_attachment_uploads_lease_idx").on(table.leaseExpiresAt, table.id).where(sql`${table.status} = 'uploading'`),
  check("chat_attachment_uploads_size_check", sql`${table.sizeBytes} >= 0`)
]);

// Citation 表镜像 0080_citations.sql；被引用 chunk/version 默认保留（restrict），生成物删除级联。
export const messageCitations = pgTable("message_citations", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
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
