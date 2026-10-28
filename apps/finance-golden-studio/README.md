# Finance Golden Studio

Finance Golden Studio is the local authoring workbench and single CLI for the
finance RAG golden dataset. CLI and Web both use the same `src/core` workflows,
so validation, path handling, backups, and publication rules have one source of
truth.

## One-command development

Install dependencies from the repository root, then start the HTTP API and Vite
workbench together:

```bash
pnpm install
pnpm --filter @aiagent/finance-golden-studio dev
```

The command starts both processes. Open the Vite workbench at
`http://127.0.0.1:5173/`; Vite proxies `/api` to the local API at
`http://127.0.0.1:4318`. The API process watches TypeScript changes; restart
the command if you change Vite configuration. Set `GOLDEN_STUDIO_PORT` only
when running `serve` directly because the dev proxy remains fixed at `4318`.

To run the production workbench, build it once and start the single local
server:

```bash
pnpm --filter @aiagent/finance-golden-studio build
pnpm golden-studio serve
```

`serve` hosts the built SPA and `/api` on `127.0.0.1:4318`, then shuts down
cleanly on `SIGINT` or `SIGTERM`.

## Configuration

The default workspace is the repository root, and the default corpus is
`datasets/finance`. A real corpus must contain
`<corpus>/manifest/manifest.jsonl` and every PDF path referenced by that
manifest.

- `FINANCE_CORPUS_ROOT`: corpus root containing `manifest/manifest.jsonl`.
- `GOLDEN_WORKSPACE_ROOT`: workspace containing
  `datasets/finance/rag-golden/golden.jsonl` and the generated artifact.
- `GOLDEN_STUDIO_PORT`: server port, default `4318`; `0` selects an ephemeral port.
- `GOLDEN_STUDIO_HOST`: loopback listener, default `127.0.0.1`.

CLI options override environment variables:

```bash
pnpm golden-studio doctor \
  --workspace /path/to/workspace \
  --corpus /path/to/finance-corpus \
  --json
```

The corpus manifest is intentionally stored outside tracked fixtures. If it is
absent, commands fail with a structured configuration error instead of falling
back to a developer-specific absolute path.

`manifest.jsonl` uses each record's `file_path` as its stable document identity.
`ticker`, `report_type`, and `period` remain semantic fields, so one semantic
triple may legitimately point at separate A-share and H-share disclosures. A
unique triple remains compatible with evidence that has no document selector;
when the triple maps to multiple files, validation returns a structured
ambiguity listing every candidate `file_path`, and the author must set
`evidence.document_file_path`. No path is chosen by manifest line order, and
the loader never infers A/H from a title.

## CLI

Use one command entry for every workflow:

```bash
pnpm golden-studio doctor [--workspace <dir>] [--corpus <dir>] [--json]
pnpm golden-studio mine --candidates <file> [--batch <name>] [--workspace <dir>] [--corpus <dir>] [--json]
pnpm golden-studio validate --batch <name> [--workspace <dir>] [--corpus <dir>] [--json]
pnpm golden-studio validate --golden [--workspace <dir>] [--corpus <dir>] [--json]
pnpm golden-studio promote --batch <name> [--workspace <dir>] [--corpus <dir>] [--json]
pnpm golden-studio generate [--workspace <dir>] [--corpus <dir>] [--json]
pnpm golden-studio serve [--workspace <dir>] [--corpus <dir>] [--json]
```

`--json` writes exactly one structured document. Failures use a non-zero exit
code and stable `error` plus `details`. Compatibility script names delegate to
`pnpm golden-studio <subcommand>` and are not pass-through wrappers:

```bash
pnpm eval:finance-golden:mine
pnpm eval:finance-golden:annotate
pnpm eval:finance-golden:validate
pnpm eval:finance-golden:promote
pnpm eval:finance-golden:generate
```

Use `pnpm --silent <script>` when a caller needs only the CLI JSON document;
pnpm otherwise prints its own script banner.

## Workflow

The authoring loop is:

`mine → annotate → validate → promote → generate → eval`

1. **Mine** candidates from exact manifest triples into
   `datasets/finance/rag-golden/_drafts/<batch>/`:

   ```bash
   pnpm golden-studio mine --candidates candidates-batch-01.json --batch batch-01
   ```
   If a candidate triple maps to multiple A/H files, include
   `document_file_path` in the candidate record; otherwise mining returns an
   ambiguity skip with the available paths.

2. **Annotate** in the workbench. Select evidence text, complete the answer,
   and add source-reachable `expected_keywords` for every positive case. For
   A/H variants sharing a ticker/report type/period, pin the source with
   `evidence.document_file_path`; for `latest_by`, use `resolution.variant`.
   Replace unresolved `evidence.section` placeholders, then mark the draft
   approved.

3. **Validate** the draft batch and fix every error:

   ```bash
   pnpm golden-studio validate --batch batch-01 --json
   ```

4. **Promote** approved drafts into `golden.jsonl`. The command creates a
   timestamped backup before changing the authoring source:

   ```bash
   pnpm golden-studio promote --batch batch-01 --json
   ```

5. **Validate the whole authoring set**, then **generate** the evaluation
   artifact with the same manually authored keywords:

   ```bash
   pnpm golden-studio validate --golden --json
   pnpm golden-studio generate --json
   ```

6. Run the finance evaluation gate:

   ```bash
   pnpm eval:finance-golden
   ```

`golden.jsonl` is the only authoring source of truth.
`datasets/finance/rag-golden-v1.json` is a generated, reviewable artifact whose
positive cases carry `expectedKeywords` copied from `expected_keywords`; it is
never hand-edited.

The generator embeds the resolved manifest `file_path` as each document's
`source`, `fileName`, and `expectedSources` entry. `latest_by` defaults to the
unique latest `disclosure_date` inside the same ticker/report type/period; tied
variants fail with structured ambiguity unless `resolution.variant` selects one.
There is no manifest-order fallback.

## Validation

```bash
pnpm --filter @aiagent/finance-golden-studio typecheck
pnpm --filter @aiagent/finance-golden-studio test
pnpm --filter @aiagent/finance-golden-studio build
```

The test suite includes a real process-level `serve` check, isolated mine →
validate → promote → generate workflows, the current 14-case authoring contract,
and a generation test that uses real PDF bytes.
