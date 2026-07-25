import { sql } from "drizzle-orm";
import { bigint, check, customType, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
