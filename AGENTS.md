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

两条产品线只共享 `packages/` 核心包，应用层互不依赖：

**产品 A · 金融 SaaS（保持不动，独立演进）**
- `apps/finance-api`: Fastify 生产 server（PostgreSQL + Redis + 多租户 + QQ channel + 金融工具）。
- `apps/finance-web`: Vite + React + TypeScript 金融 SaaS Web UI。

**产品 B · ohna（编码 Agent）**
- `apps/ohna-cli`: 终端 Agent（`ohna` bin），M1 编码工具闭环 + M2 长任务治理 + M3 体验对齐（slash 命令 `src/slash.ts`、零依赖 unified diff `src/diff.ts`、输出折叠、`--mcp` 接线 `src/mcp-config.ts`）+ `--web` 进程内托管（`src/web-entry.ts`：同一进程 `createOhnaServer`，终端与浏览器共享同一会话）已实现。
- `apps/ohna-api`: L0 本地服务薄入口（`ohna-api` bin）：`[dir]` / `--port` / `--data-dir` / `--auto-approve` / `--no-open`，只做进程生命周期。
- `apps/ohna-web`: 本地 Web UI（Phase 4 已实现）：会话/时间线/composer + 待确认卡片（从 run 事件推导，SSE 重放恢复）+ 文件树面板（`/api/local/fs` 只读，write/edit/bash 事件联动刷新）；只依赖 `@aiagent/types`。

**共享核心**
- `packages/ai`: Unified LLM abstraction (`Message` types, `AssistantMessageEvent`, provider adapters, `stream` / `streamSimple`).
- `packages/agent`: ReAct loop boundary (`agentLoop` / `agentLoopContinue`), `AgentTool` contract, and tool execution；含会话级压缩的共享硬收敛 `compaction-enforce.ts`（CLI 与 serve 两侧复用）。
- `packages/coding`: 编码工具集（read/write/edit/bash/grep/find/ls）与路径、命令策略。
- `packages/tools`: 金融工具注册表与执行边界。
- `packages/trace`: Minimal run-event type contract and cross-boundary value redaction.
- `packages/serve`: ohna 服务端装配包（`createOhnaServer`）：JSONL stores（sessions / conversations / runs）+ run-v2 HTTP/SSE + 异步确认闸门（`confirm-gate.ts` / `routes/confirmations.ts`）+ 只读 `routes/fs.ts`（复用 `@aiagent/coding` 路径策略）+ 静态 fallback + 进程内句柄（`createConversation` / `listConversations` / `createRun` / `subscribeRun` / `subscribeConversation` / `cancelRun` / `listenWithRetry`）；`run 前会话级 compaction`（L3-3，摘要持久化为 `messageType:"compaction"`）在 `RunManager.createRun` 内生效；`ohna-api` 与 `ohna-cli --web` 共用。
- `packages/term`: ohna CLI 的整屏 TUI 渲染基础包（零外部依赖）：`RawTerminal`（raw mode / bracketed paste / resize 监听 / 光标与清屏原语）+ `Screen`（节流 + 幂等全量整屏重绘：先 `clearScreen()` 再写当前帧，resize 只触发一次节流重绘，因此永不出现重绘风暴）+ `box` 边框组件、`visibleWidth` 显示宽工具与 `truncateToWidth` 按可见列截断（ANSI 不占列、CJK 计 2）。颜色只提供 ANSI 原语，语义调色板由 `apps/ohna-cli/src/theme.ts` 负责（包边界：term 不内置业务色板、不反向依赖 app）。
- `docs/LEARNING_AND_EVOLUTION_ROADMAP.md`: Ongoing learning stages, engineering outcomes, and acceptance evidence.

Keep package boundaries explicit. Do not move runtime behavior into an app when it belongs in a package. `apps/ohna-api` / `apps/ohna-cli` / `apps/ohna-web` must not depend on `apps/finance-api` / `apps/finance-web`, nor on each other.

## Type Organization Rules

参考 pi-monorepo 范式，明确类型归属，避免"既抽了中央 types 包、各包又自行写类型"的半统一状态：

- **领域类型归属拥有包**：`Message` / `AssistantMessageEvent`、`AgentTool`、`RunEvent`、`Conversation` 等领域类型定义在其拥有包（owning package），并从该包的公共 `index.ts` 导出；不要在 `@aiagent/types` 重复定义。
- **跨包类型共享一律用 `import type`**：从拥有包的公共入口引入（如 `import type { Message } from "@aiagent/ai"`）。`import type` 在编译期擦除，不产生运行时模块边，因此类型级循环依赖无害。
- **`@aiagent/types` 只收跨边界 DTO**：仅保留 api、conversation DTO、`run-v2` 信封、report DTO 等线格式 / 持久化形状，不收纳领域类型。
- **值依赖必须单向**：值 / 运行时符号只能向下游消费（下游依赖上游），不可回指，以避免运行时循环依赖；`import type` 不受此限（纯类型循环除外）。
- **依赖声明必须与实际引用一致**：每个包必须在 `package.json` 的 `dependencies` 中声明它引用的每一个 `@aiagent/*`（含仅 `import type` 的包）。不得存在"未声明却引用"的反向违规，也不得保留"已无任何源码引用却仍声明"的死依赖。

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

1. Use the design system stylesheet declared by `DESIGN.md` (`system.css`). This project uses Vite + React, so import it exactly once from the app's global CSS (`apps/finance-web/src/styles.css`).
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
