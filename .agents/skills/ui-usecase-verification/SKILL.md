---
name: ui-usecase-verification
description: Use when UI experience reports are subjective or intermittent, when comparing an app workflow with Codex or Claude, or when a use-case must be reproduced, fixed, and preserved with evidence.
---

# UI Usecase Verification

Turn a vague experience complaint into a repeatable use case, then drive it through
evidence, a failing test, a root-cause fix, and a verification matrix.

**Core rule:** a screenshot discovers a symptom; it does not prove the behavior.
Every completed use case must carry an observable trigger, a deterministic signal,
and a fresh validation result. Read `AGENTS.md` and `DESIGN.md` first.

## Workflow

1. **Capture the workflow.** Write the user goal, precondition, exact steps, expected
   outcome, failure signal, and affected files. Compare against Codex / Claude when
   the request is about alignment.
2. **Make the signal decidable.** Convert words such as crowded, laggy, overflowing,
   unfocused, or stays on the old record into DOM, event, disk, or geometry checks.
   Use [the acceptance template](references/usecase-template.md) as the minimum shape.
3. **Reproduce before fixing.** Use a real authenticated path when available. Record
   the visible failure, viewport, console error, request/run id, or persisted state.
   For layout, record `viewport`, `getBoundingClientRect()`, `scrollWidth`,
   `scrollHeight`, and the owning scroll container.
4. **Classify the failure.** Separate product behavior, state orchestration, layout,
   accessibility, error handling, and environment. Do not turn an environment lock or
   missing provider into a product bug.
5. **Write one failing test.** Use the narrowest real seam that would catch the wrong
   branch or state transition. Run it and read the failure reason. If it passes, fix
   the test or the hypothesis before touching production code.
6. **Fix one root cause.** Prefer the owning state or contract over a UI-only guard.
   Re-run the failing test, then related tests. Keep unrelated refactors out.
7. **Verify beyond the happy path.** Exercise the other side of the branch: cancel /
   confirm, allow / deny, refresh / return, slow / failed, narrow / wide. Run the
   package test, typecheck, build, and dependency check required by the repo.
8. **Update the matrix.** Mark passed only when the stated evidence exists. Leave
   partial or blocked cases explicitly partial; never imply “all passed” from a subset.
   Link scripts, fixtures, screenshots, and remaining risks in the use-case document.

## Evidence Ladder

Use the strongest evidence the claim needs:

| Claim | Minimum evidence |
| --- | --- |
| Real conversation / run works | Visible terminal state + matching persisted run/message |
| Error is diagnosable | Failed status + provider/structured error + no fake completed answer |
| Layout is usable | Screenshot + geometry metrics + no page overflow + correct scroll owner |
| Race is resolved | Deferred stale response + unchanged new view + old text absent |
| Keyboard workflow works | Focus path + key event result + no accidental submit |
| State survives restart | Same conversation id after refresh + terminal snapshot + released lock |
| Setting takes effect | Settings file/mode + run snapshot + request payload/cost key |

## Hard Rules

- Start with the failing behavior, not the proposed CSS or component refactor.
- Never claim a visual requirement passed from source inspection alone.
- Screenshots are discovery and review artifacts; geometry, DOM, events, and disk
  records are the regression oracle.
- When jsdom cannot measure layout, extract a pure state machine and keep the real
  browser geometry check separate. Do not mock a browser measurement and call it UI proof.
- A one-off screenshot must not become a production dependency. Put generated output
  under `test/artifacts/` and keep reusable scripts under `test/`.
- Preserve unrelated workspace changes and user data; use isolated data/settings for
  destructive or config-mutating checks.
- After every code change, perform the AGENTS.md documentation impact check and state
  whether related docs were updated.

## Stop Conditions

Stop and report a blocker instead of guessing when:

- the real provider/precondition cannot be safely established;
- the only evidence is a flaky or non-reproducible screenshot;
- the test fails for a fixture/typo reason rather than the behavior under test;
- a destructive action or unknown external side effect would be required.

Before completion, use `superpowers:verification-before-completion` and report exact
commands plus pass/fail counts. Re-read the original use case and check every stated
expected outcome; “tests pass” is not a substitute for requirement-by-requirement review.

## Common Mistakes

| Mistake | Correction |
| --- | --- |
| “Looks fine” / “looks crowded” | Add a measurable threshold and a concrete screenshot/viewport |
| Fixing before reproducing | First record the failing path and the exact observed state |
| Testing a mock only | Keep the real component/state path; mock only slow externals |
| Marking a partial case passed | Use `partial` or `blocked` with the missing evidence |
| Treating lock/host failure as app logic | Separate lifecycle/environment from product behavior |
| Adding a generic future TODO | Record the next observable verification step |

## Resources

- [Use-case acceptance template](references/usecase-template.md) — fields to add to
  each new experience case.
- [Geometry signal checklist](references/geometry-signals.md) — layout evidence to
  capture without relying on subjective screenshots.
- [Evidence matrix](references/evidence-matrix.md) — minimum evidence and common
  false positives for workspace, selection, permission, error, race, keyboard,
  layout, recovery, and settings cases.
