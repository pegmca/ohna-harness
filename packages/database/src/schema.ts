import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
