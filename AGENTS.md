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
- This repository is for learning. Add concise explanatory comments for important abstractions, package boundaries, agent/model/tool control flow, structured error handling, timeout/retry behavior, and any non-obvious implementation tradeoff. Prefer comments that explain why the code exists or how the learning concept works; do not comment trivial assignments or repeat what the code already says.

## Validation

Run the narrowest useful validation after code changes. Prefer these commands when relevant:

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm dev
```

If a command cannot be run, explain why in the final response.

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
