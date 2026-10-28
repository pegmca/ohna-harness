# Task 10 Report: Batch, Golden, Settings, and Action Workflows

## Implemented

- Replaced the placeholder batch list with a dense operational table showing draft totals,
  approved progress, pending work, corrupt drafts, review links, and per-batch promotion.
- Added a reusable action bar for validate, promote, generate, and mine, with explicit
  confirmations, stable pending labels, disabled duplicate submission, authoritative
  success summaries, retryable errors, focus entry, Escape close, and focus restoration.
- Added read-only server endpoints for golden health and workspace settings.
- Added the missing confirmed `POST /api/actions/mine` path, delegating to the existing
  core `mineCandidates` workflow without duplicating business logic.
- Added a Golden page that separates authored `golden.jsonl` from the generated eval
  artifact. It shows real validation issues, artifact existence/version/time, and runs
  validate/generate against the server.
- Added a Settings page with read-only server workspace/corpus paths and local theme/font
  preferences. Long paths scroll inside their own row on mobile.
- Kept `/batch/:batch` and the existing evidence-aware draft editor unchanged.
- Added responsive workbench styling at 1440, 1280, and 390 px with no page overflow.

## TDD And Tests

RED was observed before implementation:

- Four new feature suites failed at missing `ActionBar`, `BatchesPage`, `GoldenPage`, and
  `SettingsPage` imports.
- The first server RED run passed the new status test but failed the mine action because
  the fixture PDF did not contain the required candidate anchor.
- Router tests and the client action calls were then added to cover route selection and
  the confirmed server request path.

GREEN evidence:

```bash
pnpm test
# test:types passed
# Node tests: 153 passed, 0 failed
# Vitest: 9 files, 46 tests passed, 0 failed

pnpm typecheck
# passed

pnpm build
# typecheck passed
# Vite: 1809 modules transformed, production build passed
```

The bundled `pdf-parse` invalid-PDF fixture prints expected dependency noise during the
Node suite; the containing tests pass and the command exits 0.

## Files

- `apps/finance-golden-studio/src/web/features/actions/ActionBar.tsx`
- `apps/finance-golden-studio/src/web/features/actions/action-messages.ts`
- `apps/finance-golden-studio/src/web/features/actions/ActionBar.test.tsx`
- `apps/finance-golden-studio/src/web/features/batches/BatchesPage.tsx`
- `apps/finance-golden-studio/src/web/features/batches/BatchesPage.test.tsx`
- `apps/finance-golden-studio/src/web/features/golden/GoldenPage.tsx`
- `apps/finance-golden-studio/src/web/features/golden/GoldenPage.test.tsx`
- `apps/finance-golden-studio/src/web/features/settings/SettingsPage.tsx`
- `apps/finance-golden-studio/src/web/features/settings/SettingsPage.test.tsx`
- `apps/finance-golden-studio/src/web/app/context.tsx`
- `apps/finance-golden-studio/src/web/app/theme.tsx`
- `apps/finance-golden-studio/src/web/app/router.tsx`
- `apps/finance-golden-studio/src/web/app/router.test.tsx`
- `apps/finance-golden-studio/src/web/app/styles.test.ts`
- `apps/finance-golden-studio/src/web/shared/api/client.ts`
- `apps/finance-golden-studio/src/web/shared/api/types.ts`
- `apps/finance-golden-studio/src/web/styles.css`
- `apps/finance-golden-studio/src/web/test/setup.ts`
- `apps/finance-golden-studio/src/core/types.ts`
- `apps/finance-golden-studio/src/server/http.ts`
- `apps/finance-golden-studio/src/server/paths.ts`
- `apps/finance-golden-studio/src/server/routes/actions.ts`
- `apps/finance-golden-studio/src/server/routes/status.ts`
- `apps/finance-golden-studio/test/server.test.mjs`

## Self-Review

- Server remains authoritative: all four actions require `confirm:true`, and the UI
  derives success copy only from returned server data.
- Generated artifact parsing fails closed on malformed files instead of presenting
  stale or invented health.
- No nested cards were introduced; dataset and settings content use flat bordered
  sections and dividers.
- New feature files remain under 500 lines (largest: `GoldenPage.tsx`, 274 lines).
- Icons come from `lucide-react`; controls preserve dimensions between idle and pending.
- Draft page behavior and package boundaries were not changed.
- No unrelated user changes were reverted; pre-existing untracked `docs/superpowers/`
  was left untouched.

## Visual Checks

Used a temporary root `test/` HTTP fixture and Vite dev server; both were stopped and
the fixture files were removed afterward.

- `1440x900`: Batches, Golden, Settings, promotion confirmation, and promotion success.
- `1280x800`: all three pages, including long paths and table columns.
- `390x844`: stacked batch rows, stacked dataset panels, scroll-contained settings
  paths, and action confirmation.
- Measured `documentElement.scrollWidth <= innerWidth` on mobile and confirmed key
  action buttons stayed inside their containers.
- Refined the batch action column after visual inspection to keep row rhythm stable,
  then shortened the mobile promote label and stacked row content for readability.

## Concerns

- This worktree still has the pre-existing Task 6 limitation where the CLI `serve`
  command is not yet wired to `createGoldenStudioServer`; Task 11 owns final CLI/docs
  integration. The web/client/server contracts for Task 10 are implemented and tested.
- `apps/finance-golden-studio/src/web/styles.css` is now above the general ~500-line
  guideline inherited from existing draft styles. Task 10 additions are isolated,
  but a later CSS ownership split would improve maintainability.
- The Node suite retains the known `pdf-parse` invalid-PDF noise and intermittent
  promote stability concern recorded in earlier tasks; the final full run passed
  153/153.

## Documentation Impact

No documentation update was required in this task: the behavior is already described
by the Finance Golden Studio design/plan, and Task 11 owns the app README, migration,
and final workflow documentation.

## Review Fixes

### Contract

HTTP action success data is now consistently `{ action, result }` under the existing
`{ ok: true, data }` envelope. `runAction` preserves that shape. `validateBatch` and
`validateDraft` explicitly unwrap `result` after verifying that `action === "validate"`.
The live-server client integration invokes promote, mine, and generate and asserts
authoritative counts of 1 promoted draft, 1 mined draft, 0 skipped candidates, and 1
generated case.

### Mine UI

The Batches page now loads the CLI-compatible JSON candidate array from a browser file,
requires a batch name and explicit confirmation, displays real drafted/skipped counts
and skipped reasons, and refreshes the batch list after success. Candidate objects are
validated server-side exactly as before; no arbitrary server path input was added.

### Generated Freshness

`src/core/generated-freshness.ts` compares the authored golden and generated artifact
using nanosecond mtimes when available, with milliseconds as fallback. `/api/golden`
returns `freshness: "fresh" | "stale" | "missing"`, and the Golden page shows the
corresponding status and stale regeneration guidance. Tests cover equal, newer, older,
and missing files.

### Global Font Preference

Font preference moved into the global `ThemeProvider` and shared storage helpers. It is
applied on App boot before visiting Settings, so a persisted preference survives reload.

### Styles

`src/web/styles.css` is now a one-line entrypoint importing ordered feature chunks:
`tokens`, `base`, `shell`, `shared`, `actions`, `batches`, `golden`, `settings`,
`draft-shell`, `draft-editor`, `draft-table`, `draft-validation`, and `responsive`.
Every feature chunk is under 500 lines, and a structural test guards the import order
and file inventory.

### Fix Commands And Output

```bash
pnpm test
# @aiagent/finance-golden-studio
# Node: 158 passed, 0 failed
# Vitest: 10 files, 54 tests passed
# exit 0
# Known pdf-parse invalid-fixture stack noise remains expected.
```

```bash
pnpm typecheck && pnpm build
# finance-golden-studio typecheck passed
# Vite: 1812 modules transformed, build passed
# exit 0
```

```bash
pnpm typecheck
# repository typecheck: 24 workspace projects passed
# exit 0
```

```bash
pnpm build
# repository build passed, including finance-golden-studio dist/web
# exit 0
```

```bash
pnpm test
# repository recursive test run: 5 pre-existing CLI subprocess cases failed
# because documented `pnpm golden-studio ... --json` emitted empty stdout when
# nested under `pnpm -r test`; all finance-golden-studio package tests pass directly.
# exit 1
```

```bash
node --import tsx test/verify-finance-golden-studio-visual.mjs
# 1440x900: font=large, scrollWidth=1440, consoleErrors=[]
# 1280x800: font=large, scrollWidth=1280, consoleErrors=[]
# 390x844:  font=large, scrollWidth=390,  consoleErrors=[]
# Batches, Golden, Settings reload, mine confirmation, and mine result all passed.
# exit 0
```

Screenshots and metrics are under `test/output/finance-golden-studio-visual/`.
The temporary API fixture and Vite dev server were stopped after verification.

### Residual Concern

The only remaining validation failure is the repository-recursive CLI subprocess
issue above. The same package test command and CLI smoke command pass outside that
nested `pnpm -r test` context. The deferred focus-trap and truncation minors remain
deferred.
