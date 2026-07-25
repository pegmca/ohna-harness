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
| `0010` | Conversation / Message |
| `0020` | Run / RunEvent |
| `0030` | Trace |
| `0040` | Approval |
| `0050` | RAG documents |
| `0060` | pgvector / retrieval |
| `0070` | Report / Artifact |
| `0080` | Citation |

PR-00 intentionally creates no business migration. `0010` (Conversation / Message), `0050`
(RAG documents) and `0070` (Report / Artifact) are implemented; the other reserved prefixes
remain unclaimed.

PR-06 implements the `0050` prefix (`0050_rag_documents.sql`): `documents` / `document_versions` /
`chunks` ingestion lineage with checksum idempotency, immutable versions, retryable failures and
`private/shared/demo` scope; the PostgreSQL adapter lives in `src/rag-documents.ts` and is exposed
as `DatabaseRuntime.ragDocumentRepository`.

Deletion and retention: soft delete (`deleted_at`) is only a 30-day recovery window; every read
excludes soft-deleted documents. Private documents are hard-deleted with their owner via FK
cascade. Expired soft-deleted documents are physically purged by
`purgeSoftDeletedDocuments(olderThan)` (versions, chunks and inline content cascade in the same
statement). Purge is triggered by an ops task or the later runtime-integration PR; no HTTP delete
endpoint is exposed in this slice.

`0070_report.sql` creates `workflow_runs`, auditable `workflow_node_runs`, and `artifacts`.
PostgreSQL stores only bounded Markdown/HTML previews and file metadata; PDF bytes stay in the
configured `ArtifactStorage`.

## Conversation adapters

`0010_conversation.sql` creates `conversations` and `messages`. The public
`createPostgresConversationRepositories(pool)` factory returns the two domain ports declared by
`@aiagent/conversation`. Ownership is part of every SQL predicate; conversation cursors use
`(last_message_at,id)`, message cursors use `(sequence,id)`, and message writes lock the owned
conversation row before idempotency checks and sequence allocation.

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
