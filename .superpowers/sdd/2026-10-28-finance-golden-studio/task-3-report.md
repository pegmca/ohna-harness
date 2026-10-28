# Task 3 Report: PDF Evidence Projection and Keyword Reachability

## Implemented

- Added `readPdfEvidence(config, relativeFilePath)` and the pure `projectPdfEvidence(...)` boundary.
- Added `PdfEvidenceDocument`, `PdfEvidenceBlock`, and metadata types. A document contains `filePath`, ordered unique `pages`, and source-order `blocks`; every block carries `pageNumber`, `lineStart`, `lineEnd`, `text`, and copied `metadata`.
- Preserved parser metadata needed by the editor and downstream validation, including `sourceLayer`, `isTableRow`, and `tableColumnCount`.
- Enforced corpus-root containment, including relative traversal, symlink escape, and absolute-path rejection.
- Added stable `evidence_not_found` and `evidence_parse_failed` error codes.
- Added `findKeywordMatches(...)` with Unicode-whitespace removal, case folding, original-content preservation, duplicate keyword preservation, and occurrence counts.
- Added `validateKeywordReachability(...)` with per-keyword results, all matching evidence indexes, and an overall `ok`.
- Declared and locked `@aiagent/parsing` for the app.

## Tested / Results

- Focused tests: **13 passed, 0 failed**.
- Full package suite after commit: **42 passed, 0 failed**.
- Package typecheck after commit: **passed** for Node, Web, and strict test contracts.
- Frozen offline lockfile validation: **passed**.
- `git diff --check`: **passed**.
- Tests exercise generated real PDFs through the actual `@aiagent/parsing` PDF worker, rather than mocking parser output.

## TDD RED / GREEN Evidence

### RED

Command:

```bash
pnpm --filter @aiagent/finance-golden-studio exec node --import tsx --test test/evidence.test.mjs test/evidence-projection.test.mjs test/keywords.test.mjs
```

Result: **0 passed, 3 failed**. All three failed with `ERR_MODULE_NOT_FOUND` because `src/core/evidence.ts` and `src/core/keywords.ts` did not exist. This was the expected missing-API failure.

### First GREEN Attempt

Result: **10 passed, 2 failed**. The two failures were fixture setup mistakes: PDFs were written into nonexistent parent directories. Production behavior was not implicated. After adding `mkdirSync`, the focused suite passed.

### GREEN

Command:

```bash
pnpm --filter @aiagent/finance-golden-studio exec node --import tsx --test test/evidence.test.mjs test/evidence-projection.test.mjs test/keywords.test.mjs
```

Result after self-review additions: **13 passed, 0 failed**.

Command:

```bash
pnpm --filter @aiagent/finance-golden-studio test
```

Result: **42 passed, 0 failed**.

Command:

```bash
pnpm --filter @aiagent/finance-golden-studio typecheck
```

Result: **passed**.

## Files Changed

- `apps/finance-golden-studio/src/core/evidence.ts` (new)
- `apps/finance-golden-studio/src/core/keywords.ts` (new)
- `apps/finance-golden-studio/src/core/types.ts` (evidence error codes)
- `apps/finance-golden-studio/test/evidence.test.mjs` (new)
- `apps/finance-golden-studio/test/evidence-projection.test.mjs` (new)
- `apps/finance-golden-studio/test/keywords.test.mjs` (new)
- `apps/finance-golden-studio/package.json` (parsing dependency)
- `pnpm-lock.yaml` (dependency lock entry)

Commit: `ac25a79 feat(golden-studio): add evidence and keyword checks`

## Self-Review

- Confirmed evidence projection is pure from filesystem reads; only `readPdfEvidence` performs IO.
- Confirmed page lists are sorted and unique while block order remains unchanged.
- Confirmed metadata is shallow-copied and parser table/source-layer fields survive end to end.
- Confirmed matching removes only whitespace and case differences; punctuation, number separators, and remaining content are preserved.
- Confirmed character-spaced text, normal PDF spaces, full-width gaps, and real table rows are covered.
- Confirmed empty keywords are ignored, duplicate authored keywords remain separate, and evidence indexes are complete.
- Confirmed absolute paths, traversal, and symlink escape are rejected.
- Confirmed public contracts have Chinese JSDoc and files remain well under 500 lines.
- Confirmed unrelated user-owned `docs/superpowers/` remains untracked and was not committed.
- Documentation impact check: no user workflow, setup command, package responsibility, run-event contract, or architecture document changed. Task 3 consumes the already-documented parsing package, so no extra documentation update was needed.

## Issues

- The malformed-PDF test intentionally triggers `pdf-parse`'s invalid-PDF diagnostic on stderr. The app still converts that failure to `evidence_parse_failed`, and the test passes; the diagnostic originates in the third-party parser.
- `docs/superpowers/` was already untracked in this checkout and remains untouched.

## Review Fix Round 1

### Addressed

- `keywords.ts`: empty keyword arrays now return `{ ok: false, reason: "missing" }`; whitespace-only entries return a per-keyword `reason: "empty"`; genuinely absent source matches return `reason: "unreachable"`; all-reachable input returns `{ ok: true, reason: "reachable" }`. Per-keyword results now also retain `normalizedKeyword`. This diagnostic layer does not enforce Task 4's draft-level requiredness rule.
- `evidence-projection.test.mjs`: added a controlled char-spaced fixture through the real `buildPdfBlocks` parser boundary, then passed its blocks through `projectPdfEvidence` and asserted `sourceLayer: "char_spaced"` plus table metadata.
- `evidence.test.mjs`: renamed the real-PDF table test to describe only the metadata it actually asserts; evidence projection behavior was unchanged.
- Deferred findings were not changed: absolute-path specific error code and repeated evidence text scans.

### RED

Command:

```bash
pnpm --filter @aiagent/finance-golden-studio exec node --import tsx --test test/evidence.test.mjs test/evidence-projection.test.mjs test/keywords.test.mjs
```

Result: **13 passed, 1 failed**. The new char-spaced projection test passed because projection already copied parser metadata. The new keyword diagnostic test failed at the expected assertion:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected

  {
    keywordResults: [],
+   ok: true
-   ok: false,
-   reason: 'missing'
  }
```

### GREEN

Command:

```bash
pnpm --filter @aiagent/finance-golden-studio exec node --import tsx --test test/evidence.test.mjs test/evidence-projection.test.mjs test/keywords.test.mjs
```

Result:

```text
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

The known malformed-PDF fixture still emits `pdf-parse`'s invalid-PDF stack trace on stderr; the structured-error test passes.

### Package Tests

Command:

```bash
pnpm --filter @aiagent/finance-golden-studio test
```

Result:

```text
ℹ tests 43
ℹ pass 43
ℹ fail 0
```

### Typecheck

Command:

```bash
pnpm --filter @aiagent/finance-golden-studio typecheck
```

Result: **passed** for Node, Web, and strict test contracts.

`git diff --check`: **passed**.

Covering test files:

- `apps/finance-golden-studio/test/keywords.test.mjs`
- `apps/finance-golden-studio/test/evidence-projection.test.mjs`
- `apps/finance-golden-studio/test/evidence.test.mjs`
