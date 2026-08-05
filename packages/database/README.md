# Database package

`@aiagent/database` owns PostgreSQL adapters, versioned SQL migrations, and shared adapter-only
helpers. Domain packages declare repository ports and do not depend on `pg`.

## Migration guarantees

- `runMigrations` applies files in lexical order.
- Each SQL file and its `__aiagent_migrations` record commit in the same transaction.
- A transaction-level advisory lock serializes the applied check and SQL execution across instances.
- A failure reports only the migration filename; the original cause remains server-side diagnostic data.
- Existing migration `0000_identity.sql` is historical and is not modified. From `0010` onward, every
  column created by a migration must have a Chinese `COMMENT ON COLUMN` in that same file.

Reserved prefixes for persistence work are:

| Prefix | Domain |
| --- | --- |
| `0050` | RAG documents |
| `0060` | pgvector / retrieval |
| `0070` | Report / Artifact |
| `0110` | 线性消息 + Run 新 schema（阶段 3） |
| `0120` | Run event 类型扩展：retrieval |
| `0140` | Run event 类型扩展：workflow_node / pdf_export |
| `0150` | Run event 类型扩展：mcp_tool_discovered |
| `0160` | 阶段 6：删除旧 schema 并把 `_v2` 新表收敛为最终表名 |
| `0170` | Citation（在 `_v2` 表收敛为最终名后创建；脚本幂等，兼容旧文件名 `0080` 的已应用库） |
| `0180` | Message attachments（在 `_v2` 表收敛为最终名后创建；脚本幂等，兼容旧文件名 `0100` 的已应用库） |
| `0190`–`0210` | 阶段 6 死锁修复：删除 `run_events` / `runs` 上的 `conversation_id` 外键 |
| `0220` | 阶段 6 后续：approval 删除后收紧 `workflow_runs` / `workflow_node_runs` 状态机 |

`0010`–`0040` 及 `0090` 为旧 schema，已在阶段 6 由 `0160_drop_legacy_schema.sql` 删除，旧数据不迁移。
`0110_linear_messages.sql` 创建 `conversations_v2` / `messages_v2` / `runs_v2` / `run_events_v2`，
通过 `0160_drop_legacy_schema.sql` 重命名为最终表名 `conversations` / `messages` / `runs` / `run_events`。
`0170`/`0180` 使用 `IF NOT EXISTS`，在已应用过旧名 migration 的库上可安全重跑。

PR-06 implements the `0050` prefix (`0050_rag_documents.sql`): `documents` / `document_versions` /
`chunks` ingestion lineage with checksum idempotency, immutable versions, retryable failures and
`private/shared/demo` scope; the PostgreSQL adapter lives in `src/rag-documents.ts` and is exposed
as `DatabaseRuntime.ragDocumentRepository`.

PR-07 implements `0060_rag_vectors.sql`: it enables pgvector and adds `chunk_embeddings` with a
fixed `vector(32)`, `(chunk_id, embedding_model, dimensions)` idempotency, cosine HNSW and
model/dimensions indexes. `createPostgresVectorStore(pool, { ownerUserId })` binds authorization at
construction; its search query materializes the authorized document/version/chunk candidate set
before cosine ordering. The 32-dimensional column is reserved for `deterministic-mock-embedding-v1`; a real
model with another dimension requires a new compatible migration/table or model-specific column.

Deletion and retention: soft delete (`deleted_at`) is only a 30-day recovery window; every read
excludes soft-deleted documents. Private documents are hard-deleted with their owner via FK
cascade. Expired soft-deleted documents are physically purged by
`purgeSoftDeletedDocuments(olderThan)` (versions, chunks and inline content cascade in the same
statement). Purge is triggered by an ops task or the later runtime-integration PR; no HTTP delete
endpoint is exposed in this slice.

`0070_report.sql` creates `workflow_runs`, auditable `workflow_node_runs`, and `artifacts`.
PostgreSQL stores only bounded Markdown/HTML previews and file metadata; PDF bytes stay in the
configured `ArtifactStorage`.

## Citation adapter

`0170_citations.sql` creates `message_citations` and `artifact_citations` after `0160` renames
`messages_v2` to `messages`. `0170` is idempotent so existing databases that applied the
file under its old name (`0080`) can safely re-run it. Each row carries
user/message-or-artifact ownership, a citation `ordinal` (unique per parent), `claim`, a
generation-time `quote` snapshot, an optional retrieval `score`, a `verifier_status`
(`unverified/verified/rejected/manual_verified/manual_rejected`) and nullable FKs to the exact
`chunks`/`document_versions` rows used at generation time. Referenced chunks/versions use
`ON DELETE RESTRICT` (retention policy owns deletion); parent messages/artifacts cascade.

The domain port `CitationRepository` is declared by `@aiagent/rag`
(`src/citation-repository.ts`); `createPostgresCitationRepository(pool)` is exposed as
`DatabaseRuntime.citationRepository`. Writes are not exposed on the port: message citations are
inserted inside the `RunRepository.append` terminal transaction, and artifact citations inside
`ArtifactRepository.save` (idempotent on `(artifact_id, ordinal)`; `softDelete` removes citation
rows in the same transaction). Reads verify parent ownership first, then project source
accessibility per current document scope: `accessible` (full linkage + quote), `inaccessible`
(ordinal/claim kept, no quote or source URI) or `unresolved` (quote snapshot only). Verifier
updates use an explicit state machine — automatic results cannot overwrite each other and manual
terminal states cannot be overwritten at all.

## Linear conversation / message / run adapters

`0110_linear_messages.sql` creates the `conversations_v2` / `messages_v2` / `runs_v2` /
`run_events_v2` schema; `0160_drop_legacy_schema.sql` renames them to the final
`conversations` / `messages` / `runs` / `run_events`.

- `conversations` carries user ownership, title, status (`active`/`archived`), and a
  `last_message_at` cursor for stable list ordering.
- `messages` is the linear timeline: `sequence` is monotonically increasing per conversation,
  `role` is one of `user`/`assistant`/`toolResult`, `content` is JSONB, and `client_message_id`
  provides idempotency. `message_type` supports compaction summaries.
- `runs` replaces the old `agent_runs` table with an append-only event stream model; `status` is
  `queued`/`running`/`completed`/`failed`/`cancelled`/`interrupted`, and `last_event_sequence` is
  the high-water mark for SSE replay and crash recovery.
- `run_events` is the append-only event stream consumed by the UI and trace details; event types
  are extended through `0120`–`0150`.

`createPostgresConversationRepository(pool)`, `createPostgresMessageStore(pool)`, and
`createPostgresRunRepository(pool)` expose these as `DatabaseRuntime.conversationRepository`,
`DatabaseRuntime.messageStore`, and `DatabaseRuntime.runRepository`.

## Integration tests

Set `TEST_DATABASE_URL` to an explicitly separate database, then run:

```bash
TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/aiagent_test \
DATABASE_URL=postgresql://user:password@127.0.0.1:5432/aiagent \
pnpm --filter @aiagent/database test
```

The helper rejects a missing test URL and rejects a test database whose database name equals
`DATABASE_URL`, even if hosts differ. Each run creates a unique `aiagent_test_*` schema and cleanup
drops only that schema. Without `TEST_DATABASE_URL`, unit/static tests run and the integration case is
reported as skipped.
