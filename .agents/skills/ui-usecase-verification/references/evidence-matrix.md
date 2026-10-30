# Evidence Matrix

Use this matrix to decide what evidence a case needs before marking it `passed`.
Do not upgrade a result because unrelated tests are green.

| Use-case type | Required evidence | Common false positive |
| --- | --- | --- |
| Workspace / project switch | new URL or draft identity; old response text absent; new state persists | Only checking the workspace label changed |
| Model / setting selection | visible selection; run request/snapshot model; persisted settings or cost key | Only checking a dropdown label |
| Tool confirmation | `confirmation_requested` → decision → `tool_execution_end`; side effect + run terminal | Only checking a card appeared |
| Error visibility | failed/interrupted status; structured error; refresh still shows it | Completed status with an empty answer |
| Race / late response | deferred old response; new view unchanged; no `running` residue | One relaxed timing sample |
| Keyboard / focus | focus target before/after; key action result; no accidental submit | Source contains an event handler |
| Dense layout | viewport + rect + scrollWidth/scrollHeight + scroll owner | One screenshot at the widest size |
| Restart / recovery | same conversation/run after refresh; terminal snapshot; released lock | A reload that lands on another conversation |
| Settings effect | settings mode/value + run snapshot + provider/cost projection | A form showing a saved value only |

## Result Rules

- `passed`: all required observable evidence exists at the stated scope.
- `partial`: one evidence layer exists, but the real product condition is not exercised.
- `blocked`: a precondition cannot be established; state exactly what would unblock it.

Always include the command, exit status, and scope of the evidence. A fixture-level
pass is not product-level QA, and a unit-level pass is not a real-window layout proof.
