# AI Coding Protocol

## Before Editing

1. Read `AGENTS.md`, `ARCHITECTURE.md`, the relevant implementation card, and affected public entrypoints.
2. Inspect callers and tests before changing a contract.
3. Record the intended behavior and narrow validation command.

## Change Rules

- Work on one bounded context or Web feature at a time.
- Keep runtime rules out of `apps/finance-web` and Fastify handlers.
- Validate every external input and return structured boundary errors.
- Do not introduce `any`, `@ts-ignore`, deep cross-package imports, hidden fallbacks, or unlabelled demo data.
- Do not expose system prompts, secrets, raw provider errors, or untrusted full documents through run details.
- Never execute remote installation scripts without explicit review.
- Treat code-graph/dead-code results as hints; verify references and tests before deletion.

## Completion Gate

- Run the narrowest relevant typecheck and test first, then root `pnpm typecheck`, `pnpm test`, and `pnpm build` for cross-package changes.
- Run dependency checks for package or directory changes.
- Verify light/dark, desktop/mobile, loading/error, and reduced-motion states for UI work.
- Update affected public docs, task cards, and learning notes in the same change. If no update is required, explain why.
