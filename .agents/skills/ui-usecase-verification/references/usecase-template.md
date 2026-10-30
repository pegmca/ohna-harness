# UI Experience Use-Case Template

Copy this shape into the relevant `docs/usecase/` document. Remove fields that do
not apply; do not replace a missing signal with “looks correct”.

```markdown
### UX-XXX <short user-visible outcome>

**Alignment**: Codex / Claude / WorkBuddy / current product rule
**Preconditions**: data, provider, workspace, selected conversation

**Steps**
1. ...
2. ...
3. ...

**Expected**
- Visible outcome:
- State/persistence outcome:
- Failure/cancel/keyboard outcome:

**Observable signals**
- DOM/role/text:
- Focus/key event:
- Geometry (`viewport`, rect, scroll owner):
- Run/message/disk:
- Console/network:

**Automated evidence**
- Test:
- Geometry/script:
- Artifact path:

**Result**: passed / partial / blocked
**Observed evidence**:
**Remaining risk**:
```

## Judging a Case

- `passed`: the visible outcome and the stated state/geometry evidence both match.
- `partial`: the implementation or one layer is verified, but the stated real-world
  condition has not yet been exercised (for example, long streaming answer under a
  real provider).
- `blocked`: a required precondition cannot be safely established; state exactly what
  was attempted and what evidence is missing.

Screenshots are supporting evidence only. For layout, include the viewport and key
geometry values; for behavior, include the terminal state and authoritative source.
