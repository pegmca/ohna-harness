# Task 4 Report: Unified Validation and Authoring Schema

## Status

DONE_WITH_CONCERNS

Task 4 is implemented on detached HEAD. The unified validation layer is consumed by both draft and golden entry points, and a reviewed follow-up commit hardens batch error attribution and PDF reuse.

## Implemented

- Added `ValidationReport` with `{ ok, errors, warnings, keywordResults }`, stable issue codes, optional field paths, golden line numbers, and author IDs.
- Added pure schema validation for required fields, enums, evidence, distractors, resolutions, tables, forms, negatives, keyword shape, snapshot requirements, and sparse-row warnings.
- Added `validateDraft(config, draft)` for complete draft records and `validateGolden(config)` for authoring JSONL.
- Required `expected_keywords` for every non-negative case and rejected empty, whitespace-only, non-string, and source-unreachable keywords.
- Required every evidence `ticker/report_type/period` triple to match the manifest exactly. No same-ticker or latest-report fallback is used.
- Rejected unresolved evidence sections containing `（待补…）` or `（候选…）`.
- Validated negative cases against the manifest: evidence must be empty, resolution must be `ticker_absent`, scoped tickers must be absent, and scoped `expected_report` must be `（无）`.
- Made manifest parsing fail-closed: malformed lines, incomplete records, and duplicate triples are errors rather than silently skipped references.
- Added file-level golden validation for missing files, empty files, malformed JSON, non-object rows, and duplicate IDs while preserving other row diagnostics.
- Reused existing `readPdfEvidence` and `validateKeywordReachability`; manifest and PDF I/O goes through the shared workspace guards.
- Optimized `validateGolden` to execute schema checks once per line, parse each unique source PDF once, and retain per-line structured PDF errors without inventing unreachable-keyword diagnostics.
- Added `GoldenCase` as the published authoring shape without `_draft`.
- Updated `SCHEMA.md` and `TAXONOMY.md` for keyword authoring, exact manifest references, unresolved sections, negative conventions, table structure, and sparse-row warnings.

## Tests and Results

Final focused validation suite:

```text
Command: pnpm --filter @aiagent/finance-golden-studio exec node --import tsx --test test/validate.test.mjs
Result: PASS, 25 tests, 0 failures
```

Final package suite after the follow-up commit:

```text
Command: pnpm --filter @aiagent/finance-golden-studio test
Result: PASS, 68 tests, 0 failures
```

Final package typecheck:

```text
Command: pnpm --filter @aiagent/finance-golden-studio typecheck
Result: PASS (Node, Web, and strict test contracts)
```

`git diff --check` and staged/committed diff checks passed. The malformed-PDF tests still print `pdf-parse`'s upstream invalid-PDF diagnostic while the application returns structured errors; no test failure results from it.

## TDD RED/GREEN

### Initial RED

The focused test imported `src/core/validate.ts` before the production module existed:

```text
ERR_MODULE_NOT_FOUND: Cannot find module .../src/core/validate.ts
tests 1, pass 0, fail 1
```

### Initial GREEN

After adding schema, manifest, and orchestration layers:

```text
Command: pnpm --filter @aiagent/finance-golden-studio exec node --import tsx --test test/validate.test.mjs
Result: 15 tests, 15 pass
```

Later focused additions covered draft/golden ID differences, missing evidence, invalid keyword types, empty golden files, malformed and duplicate manifest records, and negative type consistency.

### Duplicate Diagnostic RED/GREEN

The duplicate-error regression first failed because the same empty `gold_answer` produced two errors:

```text
actual 2, expected 1
```

The final schema avoids the duplicate rather than suppressing distinct errors globally. The focused test now passes.

### Batch Pipeline RED/GREEN

The batch I/O hardening test initially returned a false unreachable-keyword result for a missing PDF:

```text
actual keywordResults length 1, expected 0
```

After preserving read failures separately from parsed documents, the focused suite passed 25/25. Tests now cover missing PDF, malformed PDF, invalid evidence shape, invalid keyword type, duplicate manifest triples, and duplicate-ID diagnostics.

## Files

- `apps/finance-golden-studio/src/core/schema.ts`
- `apps/finance-golden-studio/src/core/schema-fields.ts`
- `apps/finance-golden-studio/src/core/schema-special.ts`
- `apps/finance-golden-studio/src/core/schema-report.ts`
- `apps/finance-golden-studio/src/core/manifest.ts`
- `apps/finance-golden-studio/src/core/validate.ts`
- `apps/finance-golden-studio/src/core/validation-pipeline.ts`
- `apps/finance-golden-studio/src/core/types.ts`
- `apps/finance-golden-studio/test/validate.test.mjs`
- `datasets/finance/rag-golden/SCHEMA.md`
- `datasets/finance/rag-golden/TAXONOMY.md`

## Self-Review

- Confirmed one shared report contract and no duplicated manifest, evidence, or keyword implementations.
- Confirmed schema validation is pure; filesystem and corpus reads remain in `validate.ts`/`validation-pipeline.ts`.
- Confirmed relative source imports use `.js` suffixes and point inward within `src/core`.
- Confirmed all new implementation files are below 500 lines; the focused test file is intentionally larger for cohesive end-to-end coverage.
- Confirmed manifest ambiguity is fail-closed and exact evidence triples never fall back to another report.
- Confirmed keyword `evidenceIndexes` refer to this case's unique successful evidence documents in source order.
- Confirmed PDF/schema work is not silently repeated for every duplicate source in a golden file.
- Confirmed `fin-009` produces the expected one sparse-row warning from the actual repository row, not a synthetic approximation.
- Confirmed no authoring source or generated eval artifact was modified.
- Confirmed documentation impact was handled by updating `SCHEMA.md` and `TAXONOMY.md`.
- Confirmed unrelated pre-existing untracked `docs/superpowers/` was not staged or committed.

## Real Corpus Checks

Direct `validateGolden` against the current corpus manifest stops on a genuine ambiguity:

```text
manifest_triple_duplicate: 600011.SH/annual/2024
lines 44 and 45 point to the A-share and H-share annual reports
```

Using a temporary manifest copy with the H-share occurrence removed and the real corpus PDFs, validation reached the intended 14-case diagnostics:

```text
expected_keywords_required: 13 non-negative cases
section_unresolved: 9 current sections
table_sparse_row: fin-009 row[1], WARN only
```

These are data migration/authoring findings, not Task 4 implementation failures. The current golden source was not rewritten outside this task.

Only the task report was written after the code commits.

## Issues / Concerns

- The current corpus manifest contains an ambiguous `600011.SH/annual/2024` triple. Validation correctly blocks it.
- Existing cache/manifest duplicate triples for unrelated tickers would block validation fail-closed even when no golden case references them. This is intentional under the current uniqueness rule; the alternative is to reject duplicates only when referenced, which can delay corpus integrity diagnosis until annotation.
- Current authoring records intentionally fail Task 4's new `expected_keywords` and unresolved-section gates; they require annotation/import work in later tasks.
- The annotated table case `fin-009` has a sparse row without a dedicated recorded acknowledgement flag; Task 4 reports the warning and leaves acceptance to the author/review workflow.

## Commits

- `1813b6b` `feat(golden-studio): unify golden validation`
- `9aaee3e` `fix(golden-studio): harden validation pipeline`
- `HEAD` `fix(golden-studio): enforce review validation rules`

## Review Fix Round: Ticker Resolution and Multi-Doc Contract

### Fixed findings

1. `schema-special` / `validation-pipeline`: `ticker_absent` now resolves one authoritative target through `core/ticker-absent.ts`. Only a non-empty trimmed `ticker` is a direct ticker. `ticker:""` falls back to the scoped form. Matching direct/scoped tickers are accepted; conflicting tickers produce one deterministic `negative_ticker_conflict` at `resolution`, and no manifest-presence error when neither side is authoritative. Scoped form validation and manifest absence checks use the same resolver.
2. `schema-fields`: `type:"multi_doc"` now requires `requires_multi_doc:true`, and both `type:"multi_doc"` and `requires_multi_doc:true` require at least two distinct evidence triples. Distinctness uses exact `ticker/report_type/period`; duplicate rows for one PDF do not satisfy the contract.

Deferred minors were not changed.

### RED

Added focused regressions for a valid two-source `multi_doc`, false/non-distinct `multi_doc`, empty ticker fallback, conflicting direct/scoped tickers, and matching direct/scoped tickers.

```text
Command: pnpm --filter @aiagent/finance-golden-studio exec node --import tsx --test test/validate.test.mjs
Result: 27 passed, 3 failed, 30 tests

✖ multi_doc 拒绝 false 标记或少于两个 distinct 来源
  AssertionError: Missing expected multi_doc diagnostics
✖ ticker_absent 的空 ticker 使用 scope 作为实际缺席检查目标
  actual errors: [required_string_invalid resolution.ticker]
  expected negative_ticker_present resolution.scope
✖ ticker_absent 对冲突的 ticker 与 scope 返回确定性诊断
  actual negative_ticker_conflict count: 0
  expected: 1
```

Self-review then added the non-string ticker regression, which failed as expected before the shape guard:

```text
Command: pnpm --filter @aiagent/finance-golden-studio exec node --import tsx --test --test-name-pattern='非字符串 ticker' test/validate.test.mjs
Result: 0 passed, 1 failed

AssertionError: [] — expected required_string_invalid at resolution.ticker
```

### GREEN

```text
Command: pnpm --filter @aiagent/finance-golden-studio exec node --import tsx --test test/validate.test.mjs
Result: PASS, 31 tests, 0 failures

✔ multi_doc 接受两个 distinct 来源且 requires_multi_doc=true
✔ multi_doc 拒绝 false 标记或少于两个 distinct 来源
✔ ticker_absent 的空 ticker 使用 scope 作为实际缺席检查目标
✔ ticker_absent 的非字符串 ticker 不会被静默忽略
✔ ticker_absent 对冲突的 ticker 与 scope 只报确定性冲突
✔ ticker_absent 的相同 ticker 与 scope 不产生冲突
```

### Final verification

```text
Command: pnpm --filter @aiagent/finance-golden-studio typecheck
Result: PASS (Node, Web, and strict test contracts)

Command: pnpm --filter @aiagent/finance-golden-studio test
Result: PASS, 74 tests, 0 failures
```

The existing malformed-PDF fixtures still emit the upstream `pdf-parse` invalid-PDF diagnostic on stderr; all structured-error assertions pass.

### Review-fix files

- `apps/finance-golden-studio/src/core/ticker-absent.ts` (new)
- `apps/finance-golden-studio/src/core/schema.ts`
- `apps/finance-golden-studio/src/core/schema-fields.ts`
- `apps/finance-golden-studio/src/core/schema-special.ts`
- `apps/finance-golden-studio/src/core/validation-pipeline.ts`
- `apps/finance-golden-studio/test/validate.test.mjs`

### Review-fix self-review

- Confirmed one shared ticker resolver is used by schema shape validation, negative consistency validation, and manifest absence checks.
- Confirmed empty ticker never overrides a valid scoped target.
- Confirmed conflict emits one deterministic diagnostic and does not incorrectly claim a particular ticker is present.
- Confirmed matching direct/scoped forms remain valid.
- Confirmed non-string ticker remains a schema error rather than being silently ignored.
- Confirmed `multi_doc` distinguishes exact source triples, not evidence-row count.
- Confirmed the reverse flag contract rejects `requires_multi_doc:true` with fewer than two sources.
- No deferred minor was changed.
