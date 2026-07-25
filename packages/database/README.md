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

PR-00 intentionally creates no business migration. `0010` (Conversation / Message), `0020`
(Run / RunEvent), `0040` (Approval), `0050` (RAG documents), `0060` (pgvector retrieval), `0070`
(Report / Artifact) and `0080` (Citation) are implemented; no reserved prefixes remain unclaimed.

PR-05 implements the `0040` prefix (`0040_approval.sql`): see "Approval adapters" below.

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

`0080_citations.sql` creates `message_citations` and `artifact_citations`. Each row carries
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

## Approval adapters

`0040_approval.sql` creates `tool_approvals` (text approval id PK, FK to `agent_runs` and `users`,
status `pending/approved/rejected/expired`, indexes on `(user_id,status,requested_at)` and
`run_id`). The domain port `ApprovalRepository` is declared by `@aiagent/tools`;
`createPostgresApprovalRepository(pool)` is exposed as `DatabaseRuntime.approvalRepository`.
Registration is idempotent on approval id + input digest (`ON CONFLICT DO NOTHING` then re-read;
a different digest/run/user is a structured conflict). Decisions use a single-row CAS predicate
covering reviewer ownership, run, input digest, `status='pending'` and expiry, so concurrent
approve/reject has exactly one winner; expired pending rows are atomically transitioned to
`expired` by both `decide` and the export gate read path.

## Conversation adapters

`0010_conversation.sql` creates `conversations` and `messages`. The public
`createPostgresConversationRepositories(pool)` factory returns the two domain ports declared by
`@aiagent/conversation`. Ownership is part of every SQL predicate; conversation cursors use
`(last_message_at,id)`, message cursors use `(sequence,id)`, and message writes lock the owned
conversation row before idempotency checks and sequence allocation.

## Run adapters

`0020_runs.sql` creates `agent_runs` and canonical `run_events`, connects `messages.run_id`, and
adds the partial one-assistant-message-per-Run constraint. `createPostgresRunRepository(pool)`
validates Conversation ownership and reserves both messages in the creation transaction. Event
append locks the Run, allocates `version + 1`, persists the event and projection together, and
rejects all transitions after the first terminal event.

## Trace adapter

`0030_trace.sql` creates request/run-unique `traces` summaries and sequenced `trace_events`.
`createPostgresTraceStore(pool)` requires user ownership on every operation. Its append transaction
locks the Run and Trace, writes the already-redacted canonical event once, derives the Run
`trace_event` projection from that object, and commits both before live fan-out.

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
