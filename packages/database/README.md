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

PR-00 intentionally creates no business migration.

`0070_report.sql` creates `workflow_runs`, auditable `workflow_node_runs`, and `artifacts`.
PostgreSQL stores only bounded Markdown/HTML previews and file metadata; PDF bytes stay in the
configured `ArtifactStorage`.

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
