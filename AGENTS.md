# AGENTS.md

## Project Context

This repository is an AI Agent learning workspace and product prototype for an immersive financial research agent.

Primary planning documents:

- `README.md`
- `docs/ROADMAP_1_MONTH.md`
- `docs/BUSINESS_DIRECTION_FINANCIAL_RESEARCH_AGENT.md`
- `docs/weeks/*.md`
- `docs/implementation/*.md`

Before implementing a task, read the relevant implementation document under `docs/implementation/` and the files in the affected package or app.

## Repository Structure

- `apps/web`: Vite + React + TypeScript web app for the Immersive product UI.
- `packages/agent`: Agent orchestration boundary, intent routing, loops, and model-facing logic.
- `packages/tools`: Tool schema, registry, execution, and external data/tool integration boundary.
- `packages/trace`: Runtime observability events and trace data structures.
- `docs/implementation`: Small AI Coding task cards with scope, constraints, validation, and completion notes.

Keep package boundaries explicit. Do not move runtime behavior into `apps/web` when it belongs in a package.

## Coding Rules

- Use TypeScript strict typing.
- Prefer existing project patterns and package boundaries.
- Do not add production dependencies unless they are necessary for the task.
- Return structured errors from agent, tool, model, and trace boundaries instead of leaking raw exceptions to UI callers.
- Keep public interfaces small and stable. If an interface changes, update callers and related docs in the same task.
- This repository is for learning. Add concise explanatory comments in Chinese for important abstractions, package boundaries, agent/model/tool control flow, structured error handling, timeout/retry behavior, and any non-obvious implementation tradeoff. Every function and method should have standard Chinese JSDoc, including `@param`, `@returns`, and `@template` when they add useful context. Prefer comments that explain why the code exists or how the learning concept works; do not comment trivial assignments or repeat what the code already says.

## Design And Styling Rules

Read `DESIGN.md` in the project root before changing UI.

1. Use the design system stylesheet declared by `DESIGN.md` (`system.css`). This project uses Vite + React, so import it exactly once from the app's global CSS (`apps/web/src/styles.css`).
2. Use the tokens, utilities, component anatomy, spacing, typography, and states described in `DESIGN.md`; do not invent a separate visual style.
3. For Immersive UI work, also read `docs/IMMERSIVE_PRODUCT_DESIGN.md` and the relevant `docs/implementation/*.md` task card.
4. The current product direction is Agent Chat: left conversation list, centered conversation timeline, bottom composer. `Run State`, tool calls, and trace details should be assistant-message-derived expandable content, not a permanent right sidebar.
5. If existing components or styles conflict with `DESIGN.md`, explain the conflict and choose the option that keeps the interface most consistent with the design system.
6. If `html/preview.html` exists, read it as a visual reference and match its structure, spacing, and component styling where it does not conflict with `DESIGN.md`.

## Validation

Run the narrowest useful validation after code changes. Prefer these commands when relevant:

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm dev
```

If a command cannot be run, explain why in the final response.

Put future manual debugging and verification scripts under the repository root `test/` directory. Do not add ad hoc debug scripts under package-specific `scripts/` directories unless they are package build/test infrastructure rather than human debugging entrypoints.

## Documentation Sync

Every code change must include a documentation impact check before finishing.

Update related docs in the same task when the change affects any of these:

- Public package API or exported types.
- App behavior, user-visible workflow, or demo input/output.
- Directory structure or package responsibility.
- Setup, scripts, environment variables, or validation commands.
- Agent loop, intent routing, tool schema, trace event, RAG, workflow, report, or eval behavior.
- Acceptance criteria in `docs/implementation/*.md`.

If no documentation update is needed, state that explicitly in the final response with the reason.

For feature work, also consider whether a review note belongs in `notes/ai-coding-review-*.md` when that notes directory exists.

## AI Coding Workflow

For implementation tasks:

1. Read the relevant task card and nearby code first.
2. Make a narrow, working change.
3. Run validation.
4. Check documentation impact.
5. Summarize changed files, validation, documentation updates, and remaining risks.

Do not rely on a later periodic scan to keep docs correct. Treat periodic or subagent review as a backstop only.
