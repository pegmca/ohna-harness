import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
  index("documents_owner_scope_idx").on(table.ownerUserId, table.scope)
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
