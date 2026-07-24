import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
