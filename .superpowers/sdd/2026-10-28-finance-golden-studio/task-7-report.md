# Task 7 Report: Local HTTP Server and API Contract

## Status

DONE_WITH_CONCERNS

## Implemented

- Added `createGoldenStudioServer(config, options)` in
  `apps/finance-golden-studio/src/server/http.ts`, backed only by `node:http`
  and no production dependency.
- Added a loopback-only `listen`, explicit `close`, and a `ServerHandle`
  exposing the underlying Node server.
- Added `GET /api/batches`, `GET /api/batches/:batch/drafts`,
  `GET/PUT /api/batches/:batch/drafts/:id`,
  `GET /api/evidence?path=...`, and
  `GET /api/evidence/content?path=...`.
- Added `POST /api/actions/validate`, `POST /api/actions/promote`, and
  `POST /api/actions/generate`.
- Successful JSON responses use `{ok:true,data}`. Failures use the stable
  envelope `{ok:false,error:{status,code,message,details}}`.
- Batch names and draft IDs are validated with the core workspace guards
  before any core read/write. Evidence bytes require both corpus containment
  and a manifest-declared file path.
- JSON request bodies are limited to 1 MiB by default; malformed JSON,
  oversized bodies, invalid routes, invalid methods, contradictory action
  scope, and missing confirmation return structured errors.
- Promote and generate require `confirm:true`. Validate accepts either
  `{confirm:true,batch}` or `{confirm:true,scope:"golden"}`.
- PDF responses support full reads, single byte ranges, suffix ranges, and
  `416` for unsatisfiable ranges.
- PDF byte streaming resolves its path through the core `resolvePdfPath`
  boundary; routes do not contain corpus path or manifest policy.
- Generate responses summarize the dataset case count instead of returning
  the full embedded PDF/base64 payload.

## Contract ruling

The brief named route capabilities but not URL strings or response envelopes,
and Task 8 consumes this contract. I selected the REST surface above, with
`/api/batches/...` nesting and `/api/actions/{validate|promote|generate}`.
Cost if wrong: Task 8 must adapt path strings/envelopes, but no domain behavior
or security boundary changes.

## TDD Evidence

### Initial RED

Created the server integration tests before production code:

```text
Command: pnpm --filter @aiagent/finance-golden-studio exec node --import tsx \
  --test test/server.test.mjs
Result: FAIL, 1 file failed
Error: ERR_MODULE_NOT_FOUND src/server/http.ts
```

Log: `.superpowers/sdd/2026-10-28-finance-golden-studio/task-7-red.log`

### Intermediate RED / GREEN

- Initial routing exposed 11 passes and 2 failures; corrected natural path
  segment matching and aligned unknown-route errors to `not_found`.
- URL traversal fixture was corrected to a representable backslash segment,
  then all initial cases passed.
- Hardening RED proved non-loopback binding was accepted and contradictory
  validate scope/batch was not rejected:

```text
tests 2
pass 0
fail 2
```

Log: `.superpowers/sdd/2026-10-28-finance-golden-studio/task-7-hardening-red.log`

The focused hardening cases then passed:

```text
tests 2
pass 2
fail 0
```

Log: `.superpowers/sdd/2026-10-28-finance-golden-studio/task-7-hardening-green.log`

### Debugging evidence

An integration test initially timed out after writing a draft. Boundary
instrumentation showed body parsing, draft save, and handler dispatch all
completed; `request.destroyed` became true after the request body ended, and
the response guard incorrectly suppressed the JSON response. Removed that
guard, removed all diagnostics, and reran the full suite.

### Final GREEN

Focused server suite:

```text
Command: pnpm --filter @aiagent/finance-golden-studio exec node --import tsx \
  --test --test-timeout=30000 test/server.test.mjs
Result: 15 passed, 0 failed
```

Log: `.superpowers/sdd/2026-10-28-finance-golden-studio/task-7-focused-after-refactor.log`

Full package suite:

```text
Command: pnpm --filter @aiagent/finance-golden-studio test
Result: 137 passed, 0 failed
```

Log: `.superpowers/sdd/2026-10-28-finance-golden-studio/task-7-package-suite-after-refactor.log`

Repeated on committed implementation HEAD `c6de2b8`: 137 passed, 0 failed.
Log: `.superpowers/sdd/2026-10-28-finance-golden-studio/task-7-package-suite-committed.log`

Typecheck:

```text
Command: pnpm --filter @aiagent/finance-golden-studio typecheck
Result: PASS (Node, Web, and strict test contracts)
```

Log: `.superpowers/sdd/2026-10-28-finance-golden-studio/task-7-typecheck-final.log`

## Files

Created:

- `apps/finance-golden-studio/src/server/http.ts`
- `apps/finance-golden-studio/src/server/types.ts`
- `apps/finance-golden-studio/src/server/errors.ts`
- `apps/finance-golden-studio/src/server/body.ts`
- `apps/finance-golden-studio/src/server/paths.ts`
- `apps/finance-golden-studio/src/server/routes/batches.ts`
- `apps/finance-golden-studio/src/server/routes/drafts.ts`
- `apps/finance-golden-studio/src/server/routes/evidence.ts`
- `apps/finance-golden-studio/src/server/routes/actions.ts`
- `apps/finance-golden-studio/test/server.test.mjs`

Modified:

- `apps/finance-golden-studio/src/core/evidence.ts` — manifest/corpus PDF path
  resolution for the byte-stream boundary.

All production files are below 500 lines. The server test file is 384 lines.

## Self-Review

- Completeness: all brief-required routes and negative cases are covered.
- Thin routes: core owns listing, draft I/O, validation, promotion, generation,
  path containment, and manifest membership. Server code owns transport,
  body limits, HTTP status mapping, and Range handling only.
- Security: server binds only to loopback; draft/batch traversal is rejected
  before core calls; PDF bytes must be manifest-declared corpus files;
  absolute evidence paths are rejected.
- Error stability: core and workspace errors map to one envelope; unknown
  routes are `404 not_found`; unsupported methods are `405` with `Allow`.
- Body handling: declared and streamed sizes are bounded; malformed/empty JSON
  and non-object payloads are rejected.
- Actions: promote/generate require explicit `confirm:true`; validate rejects
  `scope:"golden"` plus `batch`; generate omits full case bytes.
- Mutation review: removing path guards fails traversal tests; removing
  confirmation fails action tests; removing manifest filtering fails the
  outside-file PDF test; removing size limit fails oversized-body test;
  inverted Range logic fails byte content/status tests.
- Documentation impact: no current-state docs need updating for this slice.
  The approved spec/plan already assign server API documentation to Task 8+
  and user-facing README/migration work to Task 11. The report records the
  previously unspecified route names/envelopes for Task 8.

## Concerns

- Serve CLI wiring is still intentionally out of scope for Task 7. The CLI
  continues to return `serve_not_implemented` until a later integration task
  starts the server.
- Evidence JSON (`GET /api/evidence`) intentionally keeps the existing core
  containment-only parsing policy; the manifest whitelist applies to raw PDF
  byte streaming.
- The package suite emits the pre-existing `pdf-parse` invalid-PDF stderr
  diagnostic from intentional malformed-PDF tests; all tests pass.
- `docs/superpowers/` remains untracked from before this task and was left
  untouched.

## Review Fixes

### Scope

- Draft PUT now passes through the core save-shape boundary. The boundary
  rejects missing authoring fields, malformed evidence entries, and non-string
  `expected_keywords` before directory creation or atomic replacement.
- Promotion now records a content hash and assigned golden ID in the local
  `_publications.json` ledger. Repeating the same approved draft is a no-op;
  changed content receives a new ID.
- Golden and ledger writes use `_publications.pending.json` for crash recovery.
  Recovery promotes only records whose content hash matches committed golden.
- Server action tests use a fresh workspace per test and assert both HTTP
  status and `data.ok` response envelopes.

### RED Evidence

Core regression tests were added before implementation:

```text
Command: pnpm --filter @aiagent/finance-golden-studio exec node --import tsx \
  --test --test-timeout=30000 test/drafts.test.mjs test/promote.test.mjs
Result: FAIL, 28 tests, 3 failures
Causes:
  - malformed save with only id was accepted
  - malformed expected_keywords/evidence was accepted
  - repeated promote added a second publication
```

The server route shape correction was also caught by the independent fixture
run after the prior test order no longer masked draft GET/PUT routing.

### GREEN Evidence

Focused regression suite:

```text
Command: pnpm --filter @aiagent/finance-golden-studio exec node --import tsx \
  --test --test-timeout=30000 \
  test/promote.test.mjs test/drafts.test.mjs test/server.test.mjs
Result: PASS, 50 tests, 0 failures
```

Full package suite:

```text
Command: pnpm --filter @aiagent/finance-golden-studio test
Result: PASS, 146 tests, 0 failures
Note: The existing pdf-parse invalid-PDF stderr diagnostics from intentional
malformed-PDF tests remain; the process exits 0.
```

Typecheck:

```text
Command: pnpm --filter @aiagent/finance-golden-studio typecheck
Result: PASS (Node, Web, and strict test contracts)
```

Build:

```text
Command: pnpm --filter @aiagent/finance-golden-studio build
Result: FAIL at Vite build
Cause: index.html references absent Task 8 file src/web/main.tsx
```

### Documentation Impact

- `.gitignore` now excludes the two local publication-ledger files.
- No public API or user workflow document needs updating in this Task 7 fix.
  The app README and command migration are explicitly Task 11; the existing
  approved spec already names Task 8 as the Web entrypoint owner.
