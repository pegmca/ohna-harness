# AGENTS.md

## Project Context

This repository is an AI Agent learning workspace and product prototype for an immersive financial research agent.

Primary planning documents:

- `README.md`
- `docs/LEARNING_AND_EVOLUTION_ROADMAP.md`
- `docs/ROADMAP_1_MONTH.md`
- `docs/BUSINESS_DIRECTION_FINANCIAL_RESEARCH_AGENT.md`

Before implementing a task, read the relevant roadmap stage, architecture/design documents, and the files in the affected package or app.

## Repository Structure

- `apps/web`: Vite + React + TypeScript web app for the Immersive product UI.
- `packages/ai`: Unified LLM abstraction (`Message` types, `AssistantMessageEvent`, provider adapters, `stream` / `streamSimple`).
- `packages/agent`: ReAct loop boundary (`agentLoop` / `agentLoopContinue`), `AgentTool` contract, and tool execution.
- `packages/tools`: Built-in mock tool registry and execution boundary.
- `packages/trace`: Minimal run-event type contract and cross-boundary value redaction.
- `docs/LEARNING_AND_EVOLUTION_ROADMAP.md`: Ongoing learning stages, engineering outcomes, and acceptance evidence.

Keep package boundaries explicit. Do not move runtime behavior into `apps/web` when it belongs in a package.

## Coding Rules

- Use TypeScript strict typing.
- Prefer existing project patterns and package boundaries.
- Do not add production dependencies unless they are necessary for the task.
- Return structured errors from agent, tool, model, and trace boundaries instead of leaking raw exceptions to UI callers.
- Keep public interfaces small and stable. If an interface changes, update callers and related docs in the same task.
- 单文件职责单一，控制在约 500 行以内；超过时按内聚领域拆分为同目录模块（types / format / 子组件 / 路由域 / 节点实现等）。
- 拆分文件时保持公共 API 不变：原入口文件退化为 barrel re-export 或壳组件，导出符号一个不少、签名不动，导入方零修改。
- 包内模块引用使用带 `.js` 后缀的 ESM 相对导入；共享 helper 抽到低层模块，保持依赖单向，避免循环依赖（纯 `import type` 的循环除外）。
- React 组件文件只保留状态编排壳；纯展示子组件、纯函数工具、类型定义分别归入独立文件。
- This repository is for learning. Add concise explanatory comments in Chinese for important abstractions, package boundaries, agent/model/tool control flow, structured error handling, timeout/retry behavior, and any non-obvious implementation tradeoff. Every function and method should have standard Chinese JSDoc, including `@param`, `@returns`, and `@template` when they add useful context. Prefer comments that explain why the code exists or how the learning concept works; do not comment trivial assignments or repeat what the code already says.

## Database Rules

- 新建数据库表、修改表结构或新增字段时，必须在同一个 SQL migration 中使用 `COMMENT ON COLUMN` 为每个字段添加准确的中文注释；修改字段语义时必须同步更新注释，确保 DBeaver 等数据库工具可以直接展示字段含义。

## Design And Styling Rules

Read `DESIGN.md` in the project root before changing UI.

1. Use the design system stylesheet declared by `DESIGN.md` (`system.css`). This project uses Vite + React, so import it exactly once from the app's global CSS (`apps/web/src/styles.css`).
2. Use the tokens, utilities, component anatomy, spacing, typography, and states described in `DESIGN.md`; do not invent a separate visual style.
3. For Immersive UI work, also read `docs/IMMERSIVE_PRODUCT_DESIGN.md` and the relevant stage in `docs/LEARNING_AND_EVOLUTION_ROADMAP.md`.
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
- Agent loop, tool schema, run event, RAG, workflow, report, or eval behavior.
- Acceptance evidence or stage outcomes in `docs/LEARNING_AND_EVOLUTION_ROADMAP.md`.

If no documentation update is needed, state that explicitly in the final response with the reason.

For feature work, keep `notes/` usable as staged technical learning notes for understanding the Agent project. If the relevant roadmap stage names a `notes/*.md` deliverable, create or update that file in the same task. If the work changes core agent, tool, RAG, eval, workflow, report, trace, or public API behavior, also create or update the matching topic note in `notes/` and explain the technical focus, core concepts, implementation flow, tradeoffs, validation, and learning checkpoints.

## AI Coding Workflow

For implementation tasks:

1. Read the relevant roadmap stage and nearby code first.
2. Make a narrow, working change.
3. Run validation.
4. Check documentation impact.
5. Summarize changed files, validation, documentation updates, and remaining risks.

Do not rely on a later periodic scan to keep docs correct. Treat periodic or subagent review as a backstop only.
