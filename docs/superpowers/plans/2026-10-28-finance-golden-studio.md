# Finance Golden Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single local Finance Golden Studio app with a shared core, one CLI entry, and a complete annotation Web UI for the finance golden dataset.

**Architecture:** `apps/finance-golden-studio` owns domain workflows in `src/core`, exposes them through one `golden-studio <subcommand>` CLI and one local HTTP server, and serves a React/Vite workbench. The authoring source remains `golden.jsonl`; generated eval data remains `rag-golden-v1.json`.

**Tech Stack:** TypeScript strict, Node 22, `tsx`, React 19, Vite, Vitest, local JSONL files, `@aiagent/parsing`, `@aiagent/rag`, `@aiagent/finance-api` eval loader.

**Spec:** `docs/superpowers/specs/2026-10-28-finance-golden-studio-design.md`

## Global Constraints

- Single-user local tool: no login, roles, collaboration, Postgres, or SQLite.
- Exactly one CLI command entry: `golden-studio <subcommand>`.
- CLI and Web share `src/core`; no duplicated validation, path, or write logic.
- `golden.jsonl` is the only authoring source of truth; generated eval data is an artifact.
- `expected_keywords` is human-authored, source-text-reachable, and required for every non-negative case.
- Corpus and workspace roots are explicit config (`FINANCE_CORPUS_ROOT`, `GOLDEN_WORKSPACE_ROOT`, `--workspace`); no private absolute defaults.
- All writes are scoped, containment-checked, and atomic; promote backs up `golden.jsonl` first.
- IDs, drafts, and batch names may not escape `_drafts/`; no path traversal from API or CLI.
- Web follows `DESIGN.md`; no second UI system and no in-page marketing copy.
- New source files stay under ~500 lines; split by domain when needed.
- Chinese JSDoc for non-trivial exported functions and boundary decisions.

## Review Focus

- A draft id or batch containing `..` or separators: must be rejected by both CLI and HTTP before any read or write.
- A keyword exists in gold prose but not parsed PDF text: must be rejected at annotation/promote time, not silently carried to eval.
- A valid draft is saved while a prior write fails halfway: the previous file must remain intact.
- Promote with one invalid approved draft: must fail the batch without partially writing `golden.jsonl`.
- A PDF page with table rows and long cells: evidence panel must expose block/page/table metadata without layout overlap.

---

### Task 1: App Scaffold and Workspace Contract

**Files:**
- Create: `apps/finance-golden-studio/package.json`
- Create: `apps/finance-golden-studio/tsconfig.json`
- Create: `apps/finance-golden-studio/tsconfig.web.json`
- Create: `apps/finance-golden-studio/vite.config.ts`
- Create: `apps/finance-golden-studio/index.html`
- Create: `apps/finance-golden-studio/src/core/workspace.ts`
- Create: `apps/finance-golden-studio/test/workspace.test.mjs`
- Modify: `pnpm-workspace.yaml` only if `apps/*` is not already sufficient.
- Modify: `package.json` scripts to delegate existing names to the new app.
- Modify: `AGENTS.md` app inventory.

**Interfaces:**
- Produces: `resolveWorkspaceConfig(input?: { workspaceRoot?: string; corpusRoot?: string }): WorkspaceConfig`
- Produces: `assertContainedPath(root: string, target: string): void`
- Produces: `validateBatchName(name: string): void`
- Produces: `validateDraftId(id: string): void`
- `WorkspaceConfig` contains `{ repoRoot, workspaceRoot, corpusRoot, manifestPath, draftRoot, goldenPath, generatedPath, backupRoot }`.

- [ ] **Step 1: Write failing workspace tests** covering env override, explicit override precedence, missing corpus/manifest errors, and rejection of `../escape`, absolute batch/id, and a resolved path outside root.
- [ ] **Step 2: Run the test and verify it fails** with `pnpm --filter @aiagent/finance-golden-studio test`.
- [ ] **Step 3: Implement the scaffold and workspace functions** with no private absolute path fallback; require config when the manifest is absent.
- [ ] **Step 4: Run tests and typecheck**; expect workspace tests pass and package scripts resolve.
- [ ] **Step 5: Commit**:

```bash
git add apps/finance-golden-studio package.json AGENTS.md pnpm-workspace.yaml
git commit -m "feat(golden-studio): scaffold shared workspace"
```

---

### Task 2: Draft Store, Atomic Writes, and Batch State

**Files:**
- Create: `apps/finance-golden-studio/src/core/types.ts`
- Create: `apps/finance-golden-studio/src/core/fs-atomic.ts`
- Create: `apps/finance-golden-studio/src/core/drafts.ts`
- Create: `apps/finance-golden-studio/src/core/backups.ts`
- Create: `apps/finance-golden-studio/test/drafts.test.mjs`

**Interfaces:**
- Consumes: `WorkspaceConfig`, path guards from Task 1.
- Produces: `listBatches(config): Promise<BatchSummary[]>`
- Produces: `listDrafts(config, batch): Promise<DraftSummary[]>`
- Produces: `readDraft(config, batch, id): Promise<GoldenDraft>`
- Produces: `saveDraft(config, batch, id, draft): Promise<SaveDraftResult>`
- Produces: `writeFileAtomic(path: string, content: string): Promise<void>`
- Produces: `backupFile(config, sourcePath, label): Promise<string>`
- `GoldenDraft` wraps authoring fields plus `_draft` state; `_draft` must remain local-only.

- [ ] **Step 1: Write failing tests** for list/read/save, atomic replacement preserving the original on write failure, corrupt JSON reporting without deleting the file, batch summary counts, and backup filename uniqueness.
- [ ] **Step 2: Run failing tests**.
- [ ] **Step 3: Implement minimal store** with containment checks on every path and temp-file + rename writes.
- [ ] **Step 4: Run tests and typecheck**.
- [ ] **Step 5: Commit**:

```bash
git add apps/finance-golden-studio/src/core apps/finance-golden-studio/test/drafts.test.mjs
git commit -m "feat(golden-studio): add safe draft workspace"
```

---

### Task 3: PDF Evidence Projection and Keyword Reachability

**Files:**
- Create: `apps/finance-golden-studio/src/core/evidence.ts`
- Create: `apps/finance-golden-studio/src/core/keywords.ts`
- Create: `apps/finance-golden-studio/test/evidence.test.mjs`
- Create: `apps/finance-golden-studio/test/keywords.test.mjs`
- Create: `apps/finance-golden-studio/src/core/types.ts` extension if needed.

**Interfaces:**
- Consumes: `@aiagent/parsing` exports `parsePdfBlocks`, `ingestDocument`; draft evidence fields.
- Produces: `readPdfEvidence(config, relativeFilePath): Promise<PdfEvidenceDocument>`
- Produces: `findKeywordMatches(parsedText: string, keywords: readonly string[]): KeywordMatch[]`
- Produces: `validateKeywordReachability(evidence: readonly PdfEvidenceDocument[], keywords: readonly string[]): KeywordValidationResult`
- `PdfEvidenceDocument` contains `{ filePath, pages, blocks }`; each block carries `pageNumber`, `lineStart`, `lineEnd`, `text`, `metadata`.

- [ ] **Step 1: Write failing tests** from real fixture blocks, including char-spaced rows, table rows, full-width gaps, and a keyword with PDF whitespace differences.
- [ ] **Step 2: Run failing tests**.
- [ ] **Step 3: Implement projection and normalization**; keyword matching strips whitespace but preserves content.
- [ ] **Step 4: Run tests and typecheck**.
- [ ] **Step 5: Commit**:

```bash
git add apps/finance-golden-studio/src/core/evidence.ts apps/finance-golden-studio/src/core/keywords.ts apps/finance-golden-studio/test
git commit -m "feat(golden-studio): add evidence and keyword checks"
```

---

### Task 4: Unified Validation and Authoring Schema

**Files:**
- Create: `apps/finance-golden-studio/src/core/validate.ts`
- Create: `apps/finance-golden-studio/src/core/schema.ts`
- Create: `apps/finance-golden-studio/test/validate.test.mjs`
- Modify: `datasets/finance/rag-golden/SCHEMA.md`
- Modify: `datasets/finance/rag-golden/TAXONOMY.md`

**Interfaces:**
- Consumes: draft types, manifest reader, evidence/keyword checks.
- Produces: `validateDraft(config, draft): ValidationReport`
- Produces: `validateGolden(config): Promise<ValidationReport>`
- Produces: `ValidationReport` with `{ ok, errors, warnings, keywordResults }`.
- `expected_keywords` is required for non-negative cases; no unresolved section markers; every evidence triple must exist in manifest.

- [ ] **Step 1: Write failing tests** for each rule and the known `fin-009` sparse-row warning.
- [ ] **Step 2: Run failing tests**.
- [ ] **Step 3: Implement schema validation and update docs** with `expected_keywords` rules.
- [ ] **Step 4: Run tests and typecheck**.
- [ ] **Step 5: Commit**:

```bash
git add apps/finance-golden-studio/src/core apps/finance-golden-studio/test/validate.test.mjs datasets/finance/rag-golden
git commit -m "feat(golden-studio): unify golden validation"
```

---

### Task 5: Mine, Promote, Generate Core Workflows

**Files:**
- Create: `apps/finance-golden-studio/src/core/mine.ts`
- Create: `apps/finance-golden-studio/src/core/promote.ts`
- Create: `apps/finance-golden-studio/src/core/generate.ts`
- Create: `apps/finance-golden-studio/test/mine.test.mjs`
- Create: `apps/finance-golden-studio/test/promote.test.mjs`
- Create: `apps/finance-golden-studio/test/generate.test.mjs`
- Modify: `apps/finance-golden-studio/src/core/types.ts` if needed.

**Interfaces:**
- Consumes: workspace, drafts, validation, evidence/keywords.
- Produces: `mineCandidates(config, input): Promise<MineReport>`
- Produces: `promoteBatch(config, batch): Promise<PromoteReport>`
- Produces: `generateEvalDataset(config): Promise<GenerateReport>`
- `promoteBatch` validates all approved drafts before any authoring write and backs up `golden.jsonl`.
- `generateEvalDataset` reads human `expected_keywords`; it never derives keywords from gold prose.
- Exact evidence tuple lookup must fail rather than fall back to another filing.

- [ ] **Step 1: Write failing tests** for mine candidate output, no exact-source fallback, all-or-nothing promote, backup creation, generated bytes envelope, and expected keyword propagation.
- [ ] **Step 2: Run failing tests**.
- [ ] **Step 3: Implement core workflows**; reuse parsing and existing eval loader contracts.
- [ ] **Step 4: Run tests and typecheck**.
- [ ] **Step 5: Commit**:

```bash
git add apps/finance-golden-studio/src/core apps/finance-golden-studio/test
git commit -m "feat(golden-studio): add mine promote generate workflows"
```

---

### Task 6: Single CLI Entry

**Files:**
- Create: `apps/finance-golden-studio/src/cli/main.ts`
- Create: `apps/finance-golden-studio/test/cli.test.mjs`
- Modify: `apps/finance-golden-studio/package.json`
- Modify: `package.json` script wiring.

**Interfaces:**
- Consumes: all core APIs from Tasks 1-5.
- Produces: `runCli(argv: string[]): Promise<number>`
- Subcommands: `mine`, `validate`, `promote`, `generate`, `serve`, `doctor`.
- Flags: `--json`, `--workspace`, `--corpus`, `--batch`, `--golden`.

- [ ] **Step 1: Write failing CLI tests** for argument parsing, JSON output, non-zero exit, no-positional rejection, and error-code stability.
- [ ] **Step 2: Run failing tests**.
- [ ] **Step 3: Implement single dispatcher and package bin**.
- [ ] **Step 4: Run tests and smoke `doctor` / `validate --golden`**.
- [ ] **Step 5: Commit**:

```bash
git add apps/finance-golden-studio package.json
git commit -m "feat(golden-studio): add single cli entry"
```

---

### Task 7: Local HTTP Server and API Contract

**Files:**
- Create: `apps/finance-golden-studio/src/server/http.ts`
- Create: `apps/finance-golden-studio/src/server/routes/batches.ts`
- Create: `apps/finance-golden-studio/src/server/routes/drafts.ts`
- Create: `apps/finance-golden-studio/src/server/routes/evidence.ts`
- Create: `apps/finance-golden-studio/src/server/routes/actions.ts`
- Create: `apps/finance-golden-studio/test/server.test.mjs`

**Interfaces:**
- Consumes: core APIs only; no filesystem logic in routes.
- Produces: `createGoldenStudioServer(config): ServerHandle`
- Routes: list batches/drafts, read/save draft, read evidence, validate, promote, generate, PDF stream.
- Every route rejects invalid batch/id before core call; request bodies are size-limited.

- [ ] **Step 1: Write failing API tests** for path traversal, oversized body, malformed JSON, unknown route, save/read round trip, PDF range/read, promote confirmation, and structured errors.
- [ ] **Step 2: Run failing tests**.
- [ ] **Step 3: Implement server and handlers** using `node:http`, no new production dependency.
- [ ] **Step 4: Run tests and typecheck**.
- [ ] **Step 5: Commit**:

```bash
git add apps/finance-golden-studio/src/server apps/finance-golden-studio/test/server.test.mjs
git commit -m "feat(golden-studio): add local api server"
```

---

### Task 8: Web Workbench Shell, Navigation, and Data Client

**Files:**
- Create: `apps/finance-golden-studio/src/web/main.tsx`
- Create: `apps/finance-golden-studio/src/web/App.tsx`
- Create: `apps/finance-golden-studio/src/web/app/router.tsx`
- Create: `apps/finance-golden-studio/src/web/app/theme.tsx`
- Create: `apps/finance-golden-studio/src/web/shared/api/client.ts`
- Create: `apps/finance-golden-studio/src/web/shared/api/types.ts`
- Create: `apps/finance-golden-studio/src/web/styles.css`
- Create: `apps/finance-golden-studio/src/web/test/setup.ts`
- Create: `apps/finance-golden-studio/src/web/app/router.test.tsx`
- Create: `apps/finance-golden-studio/src/web/shared/api/client.test.ts`

**Interfaces:**
- Consumes: HTTP contract from Task 7.
- Produces: `createGoldenStudioClient(baseUrl): GoldenStudioClient`
- Routes: `/` batches, `/batch/:batch`, `/draft/:batch/:id`, `/golden`, `/settings`.
- Uses `lucide-react`, stable layout dimensions, and `DESIGN.md` token values.

- [ ] **Step 1: Write failing component/client tests** for route selection, API error surfacing, loading/empty/error states, and long batch/id wrapping.
- [ ] **Step 2: Run failing tests**.
- [ ] **Step 3: Implement shell, navigation, theme, client, and CSS foundation**.
- [ ] **Step 4: Run tests, typecheck, and build**.
- [ ] **Step 5: Commit**:

```bash
git add apps/finance-golden-studio/src/web apps/finance-golden-studio/test
git commit -m "feat(golden-studio): add web workbench shell"
```

---

### Task 9: Evidence Pane and Draft Editor

**Files:**
- Create: `apps/finance-golden-studio/src/web/features/draft/DraftPage.tsx`
- Create: `apps/finance-golden-studio/src/web/features/draft/BasicFields.tsx`
- Create: `apps/finance-golden-studio/src/web/features/draft/EvidencePane.tsx`
- Create: `apps/finance-golden-studio/src/web/features/draft/TableEditor.tsx`
- Create: `apps/finance-golden-studio/src/web/features/draft/FormEditor.tsx`
- Create: `apps/finance-golden-studio/src/web/features/draft/KeywordEditor.tsx`
- Create: `apps/finance-golden-studio/src/web/features/draft/ValidationPanel.tsx`
- Create: `apps/finance-golden-studio/src/web/features/draft/DraftPage.test.tsx`
- Create: `apps/finance-golden-studio/src/web/features/draft/evidencing.ts`
- Create: `apps/finance-golden-studio/src/web/features/draft/evidencing.test.ts`

**Interfaces:**
- Consumes: client types and evidence API.
- Produces: draft page with `save`, `saveAndValidate`, `approve` actions and a `quote`/`expected_keywords` insertion path.
- Text selection from an evidence block must fill `quote`; manual keyword editing must show source reachability.

- [ ] **Step 1: Write failing tests** for selection-to-quote, keyword add/remove, validation blocking approval, table/row editing, and long-cell overflow.
- [ ] **Step 2: Run failing tests**.
- [ ] **Step 3: Implement editor components** and split pure helpers from components.
- [ ] **Step 4: Run tests, typecheck, and build**.
- [ ] **Step 5: Commit**:

```bash
git add apps/finance-golden-studio/src/web/features/draft
git commit -m "feat(golden-studio): add evidence-aware draft editor"
```

---

### Task 10: Batch, Golden, Settings, and Action Workflows

**Files:**
- Create: `apps/finance-golden-studio/src/web/features/batches/BatchesPage.tsx`
- Create: `apps/finance-golden-studio/src/web/features/golden/GoldenPage.tsx`
- Create: `apps/finance-golden-studio/src/web/features/settings/SettingsPage.tsx`
- Create: `apps/finance-golden-studio/src/web/features/actions/ActionBar.tsx`
- Create: `apps/finance-golden-studio/src/web/features/actions/action-messages.ts`
- Create: `apps/finance-golden-studio/src/web/features/actions/ActionBar.test.tsx`
- Create: `apps/finance-golden-studio/src/web/features/batches/BatchesPage.test.tsx`
- Create: `apps/finance-golden-studio/src/web/features/golden/GoldenPage.test.tsx`

**Interfaces:**
- Consumes: server actions.
- Produces: validate, promote, generate, and mine actions with confirmations, progress, results, and errors.
- Golden page separates authored data from generated eval artifacts and exposes validate/generate health.

- [ ] **Step 1: Write failing tests** for confirmation gates, success/error feedback, batch progress, and golden/generated status.
- [ ] **Step 2: Run failing tests**.
- [ ] **Step 3: Implement pages and action bar**.
- [ ] **Step 4: Run tests, typecheck, and build**.
- [ ] **Step 5: Commit**:

```bash
git add apps/finance-golden-studio/src/web/features
git commit -m "feat(golden-studio): add publish and batch workflows"
```

---

### Task 11: Migration, Documentation, and End-to-End Verification

**Files:**
- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `datasets/finance/rag-golden/SCHEMA.md`
- Modify: `datasets/finance/rag-golden/TAXONOMY.md`
- Modify: `docs/v2.0/02-eval-system-v2.md`
- Modify: `docs/v2.1/02-finance-rag-table-recall.md`
- Delete after replacement: `test/mine-finance-golden.mjs`, `test/validate-finance-golden.mjs`, `test/promote-finance-golden.mjs`, `test/generate-finance-golden-v1.mjs`, `test/annotate-finance-golden.mjs`, `test/annotate-finance-golden.html`
- Create: `apps/finance-golden-studio/README.md`
- Create: `apps/finance-golden-studio/test/e2e-workflow.test.mjs`

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: working migration with no old tool paths in active docs/scripts.
- Existing 14 golden cases import and validate; generated dataset contains `expected_keywords`.

- [ ] **Step 1: Write failing migration/e2e test** for old entrypoint removal, documented command set, import of existing golden, and generated artifact keyword propagation.
- [ ] **Step 2: Run failing tests**.
- [ ] **Step 3: Move remaining docs/scripts to new app and update root scripts**.
- [ ] **Step 4: Run clean checkout-equivalent verification**:
  - `pnpm --filter @aiagent/finance-golden-studio typecheck`
  - `pnpm --filter @aiagent/finance-golden-studio test`
  - `pnpm --filter @aiagent/finance-golden-studio build`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm golden-studio doctor --json`
  - `pnpm golden-studio validate --golden --json`
  - `pnpm golden-studio generate --json`
- [ ] **Step 5: Commit**:

```bash
git add apps/finance-golden-studio package.json AGENTS.md datasets/finance/rag-golden docs test
git commit -m "chore(golden-studio): migrate golden tooling"
```
