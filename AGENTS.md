# AGENTS.md

## Project Context

This repository is a TypeScript Agent engineering monorepo (`ohna-harness`) for an immersive financial research agent, with a reusable Agent kernel (`packages/agent`) and two product lines.

Primary planning documents:

- `README.md`
- `docs/BUSINESS_DIRECTION_FINANCIAL_RESEARCH_AGENT.md`
- `ARCHITECTURE.md`

Before implementing a task, read the relevant architecture/design documents and the files in the affected package or app.

## Repository Structure

两条产品线只共享 `packages/` 核心包，应用层互不依赖：

**产品 A · 金融 SaaS（保持不动，独立演进）**
- `apps/finance-api`: Fastify 生产 server（PostgreSQL + Redis + 多租户 + QQ channel + 金融工具）。
- `apps/finance-web`: Vite + React + TypeScript 金融 SaaS Web UI。

**产品 B · ohna（编码 Agent）**
- `apps/ohna-cli`: 终端 Agent（`ohna` bin）。M1 编码工具闭环 + M2 长任务治理 + M3 体验对齐 + v1.3 B1-B3 交互/权限/能力扩展已实现。`src/` 按依赖方向分层，入口 `src/index.ts` 保持极薄（仅 parseArgs → runCli）：
  - `cli/`：进程入口与组合根（`args.ts` / `harness.ts` / `provider-error.ts` / `web-entry.ts` / `web-host.ts`）。`harness.ts` 只装配模型、工具、MCP、Team 与会话配置；`web-host.ts` 复用 `createOhnaServer` 起进程内 serve（失败 resolve `undefined`、降级不阻塞）。**单一形态（docs/v1.4/06 A2/A3）**：CLI 默认启动即「TUI / 非 TTY 终端」与「浏览器」双端订阅同一 serve 执行线（同一 `server.createRun` + `server.subscribeConversation` 事件流），`observeOnly` 恒为 false，`--web` / `--no-web` 已删除；`web-entry.ts` 仅保留可复用的 `renderFrame` 与 `TERMINAL_RUN_STATUSES` 常量。
  - `runtime/`：单轮 run 与内核接线（`turn.ts`，含 `RunSetup.streamFn` 测试注入）、策略常量（`mode.ts`）、外部能力装配（`mcp-config.ts` / `team-wiring.ts`，Team 子代理与主线程共用同一 traced streamFn）、观测装配（`observation.ts`：单 wrapper + 共享 callIndex counter，W3 链路采集）；单次模式在 `single-turn.ts`（经 `server.createRun` + 订阅终态）。
  - `session/`：持久化已收敛到 serve，CLI 只经 `serve-session.ts` 适配器读 serve 消息（`loadMessages` / `forkConversation` / `listConversations` / `getConversationMeta` / `isLegacySessionId` 等）与 `session-export.ts` 导出、`usage.ts` 用量累计；`session-store.ts` / `session-tail.ts` / `session-flow.ts` / `session-runtime.ts` 已删除，`runtime/summarizer.ts` 承接其压缩纯逻辑。
  - `permission/`：宿主侧权限（权限卡结构化协议 `askToolCall` 与 readline 降级路径在 `confirm.ts`、模式纯函数 `permission-mode.ts`、会话状态 `permission-session.ts`）。
  - `commands/`：斜杠命令单一注册表（`registry.ts`，`slash.ts` 仅剩薄壳）与会话命令实现（`session-commands.ts`）、`!` / `#` 直通（`direct-command.ts`）。
  - `workspace/`：工作区文件能力（`@` 文件引用 `file-reference.ts`、`#` 记忆写入 `memory-note.ts`）。
  - `input/`：交互循环（`repl.ts` 主循环 / `repl-tui.ts` TUI 装配 / `repl-actions.ts` UI 动作 / `repl-commands.ts` 命令接线 / `repl-context.ts`（含 `observation` / `traceUrl`）/ K2 排队 `follow-up.ts`）。
  - `ui/`：终端输出（`render.ts` 薄委托壳 / `theme.ts` / `spinner.ts` / `diff.ts` / `welcome.ts`）；语义条目与双 presenter 在 `ui/stream/`（`entries.ts` 唯一契约 / `reducer.ts` 单一归约器 / `print.ts` 非 TTY presenter / `print-format.ts` 折叠与 diff 纯函数）；整屏 TUI 在 `ui/tui/`（`tui-app.ts` / `frame.ts` / `tui-editor.ts` / `input-router.ts` / `input-assembler.ts` / `keymap.ts` / `grouping.ts` / `classifier.ts` / `rows.ts` / `mount.ts` / `transcript.ts` / `state.ts` / `panels.ts` / `composer.ts` / `permission-card.ts` / `toast.ts`）。
  - 依赖方向：`ui/theme`、`ui/diff`、`ui/spinner`、`session/usage` 是最底层原语，`ui/render` 只组合它们；`ui/stream` 位于 `ui/tui` 之下（投影消费 entry 契约），`runtime` / `session` / `permission` / `commands` / `input` / `cli` 逐层向上装配。命令目录的唯一来源是 `commands/registry.ts`（无会话状态），`ui/welcome` 与 `ui/tui` 只读取其命令表用于帮助/面板，不构成反向编排依赖。任何模块都不得反向 import `input/repl` 或 `cli/harness`；`ui/tui` 可依赖 `workspace/file-reference`，但不得引用 `input/repl`。
- `apps/ohna-web`: 本地 Web UI（Phase 4 已实现）：会话/时间线/composer + 待确认卡片（从 run 事件推导，SSE 重放恢复）；v1.4 布局对齐（docs/v1.4/03）后：侧栏会话按 `workspaceRoot` 分组、跨工作区会话可直接续写（前端不设只读守卫；服务端 `RunManagerOptions.resolveWorkspace` 按会话 workspaceRoot 装配编码工具与系统提示词，解析失败回退实例工作区，见 docs/v1.4/04 BUG-002）、JSON 以 `features/json-viewer/*`（`JsonViewer` 节点级折叠/展开、语法高亮、长字符串截断与批量展开预算，零新增依赖）统一渲染（docs/v1.4/04 BUG-003）、Trace 为 chat 页右侧抽屉（`features/trace/{use-trace-stream,TraceDrawer,TraceStream,LlmCallBlock,trace-projection,trace-client}`，`llm_call` 一等公民，replay 用 `replayRunEvents`、live 用 `followRunEvents` 按 sequence 续传，与 `RunDetailPanel` 右侧位互斥，独立 `/trace` 路由已删除）、设置为主区**左下角入口 + 就地弹窗**（docs/v1.4/05 FR-001：`features/settings/SettingsDialog.tsx`，`role="dialog"` + 遮罩/ESC/关闭按钮，打开时焦点移入、关闭归还触发按钮，`isOpen=false` 时整体不渲染从而中止 health 探针；五分区=连接状态/外观/模型/权限/关于，只读信息 + 主题与字号本地偏好；入口在 `features/workbench/chat-main.tsx` 的 `ChatMain` 底行，与 composer 同处一行）；路由只剩 `*` → Workbench（`app/{router,workbench-nav,theme}.tsx`，`workbench-nav.tsx` 只提供「对话」tab 片段 + `TraceToggle`，`theme.tsx` 兼管主题与字号 localStorage 偏好）；只依赖 `@aiagent/types`。
  - **视觉（Glass Depths，见 docs/v1.4/07）**：中性近黑画布 `#18191A`（亮档 `#FBFAF9`）+ 青绿统一强调 `#89D7B7`；浮层（侧栏/Trace 抽屉/设置弹窗/toast）用克制的 glass blur 分层、控件保留描边；语法色双档（暗档亮彩、亮档深彩）。`apps/ohna-web/src/styles.css` 不再 `@import system.css`，`--md-*` token 自持（颜色/玻璃浮层/语法色逐字抄 `docs/design/glass-tokens.md`），`system.css` 与 `finance-web` 不受影响。

**共享核心**
- `packages/ai`: Unified LLM abstraction (`Message` types, `AssistantMessageEvent`, provider adapters, `stream` / `streamSimple`).
- `packages/agent`: ReAct loop boundary (`agentLoop` / `agentLoopContinue`), `AgentTool` contract, and tool execution；含会话级压缩的共享硬收敛 `compaction-enforce.ts`（CLI 与 serve 两侧复用）；`src/permission/` 是**组合根装配的权限领域模块**（`AgentTool.effect` 单一事实源 + `createPresetPolicy` / `composePolicy` / `createPolicyState` / `createPermissionGate`；loop 内核不 import 它）；`src/team/` 支持 `TeamControllerOptions.beforeToolCall` 策略继承（子代理与 supervisor 共用同一权限闸门与 PolicyState）；`llm-trace.ts` 提供 `createLlmTraceStreamFn(base, sink, counter?)`（一次 stream 调用产出一条 `LlmCallRecordDto`，链式 onPayload/onResponse、事件原样透传）与 `isTracedStreamFn` / `markTracedStreamFn`（防二次包装），`agent-loop.ts` 零改动。
- `packages/coding`: 编码工具集（read/write/edit/bash/grep/find/ls）与路径、命令策略。
- `packages/tools`: `AgentTool` 契约（含 `effect?: "read" | "mutate"` 副作用声明，权限体系的单一事实源；缺省按 mutate 保守处理）+ 金融工具注册表与执行边界。
- `packages/trace`: Minimal run-event type contract and cross-boundary value redaction；v1.4 增 `RunEventType += "llm_call"` 与 `LlmCallTraceEvent`（payload 类型级引用 `@aiagent/types` 的 `LlmCallRecordDto`，`import type` 不引入运行时依赖）。
- `packages/types`: 跨边界线格式 / 持久化形状 DTO（api / conversation / run-v2 / local-fs / report / `llm-trace` 等）；`LlmCallRecordDto` 等 LLM 追踪 DTO 归此包，保持零 `@aiagent/*` 依赖。
- `packages/serve`: ohna 服务端装配包（`createOhnaServer`）：JSONL stores（sessions / conversations / runs）+ run-v2 HTTP/SSE + 异步确认闸门（`confirm-gate.ts` / `routes/confirmations.ts`，K1 后复用 `@aiagent/agent` 的 permission 策略，自身只保留 SSE AskAdapter 与 Promise 挂起生命周期）+ 只读 `routes/fs.ts`（复用 `@aiagent/coding` 路径策略）+ 静态 fallback + 进程内句柄（`createConversation` / `listConversations` / `createRun` / `subscribeRun` / `subscribeConversation` / `cancelRun` / `listRunsByConversation` / `isAutoApprove` / `listenWithRetry`）；run 事件 kind 增 `llm_call`（托管 run 自动发射）；`observeOnly` 只读模式为**可选**能力（仅外部只读观测实例可能传 `true`：不注册 `POST/DELETE /api/runs`、强制 `autoApprove:false`）；CLI 单一形态下 `observeOnly` 恒为 `false`，始终经同一 `server.createRun` 驱动执行。`runs/index.jsonl` 索引与 legacy 差集回填；`run 前会话级 compaction`（L3-3，摘要持久化为 `messageType:"compaction"`）在 `RunManager.createRun` 内生效；`ohna-cli` 与 `ohna-web` 共用此服务端进程。

  > **镜像通道已退役（06 A3-B）**：`observeRun` / `ObserveRunInput` / `ObservedRun` / `run/observe.ts`（`startObservedRun`）已从 serve 删除；单一形态下执行权唯一归属 serve，不再有「CLI 本地执行 + serve 只承接事件」的观测型 run。CLI 侧的 `createServerTurnObserver` / `createFileTurnObserver` 与 `observe-run.test.mjs` 由 CLI/A3 工作项同步清理。
- `packages/term`: ohna CLI 的整屏 TUI 渲染基础包（零外部依赖）：`RawTerminal`（raw mode / bracketed paste / resize 监听 / 光标定位与清屏原语）+ `Screen`（节流 + 行差分重绘：首帧与 resize 走 `clearScreen()` 全量、其余帧只重写变化行并清除尾部多余行，`RenderFn` 仍返回整帧最终行，调用方零感知）+ `box` 边框组件、`visibleWidth` 显示宽工具与 `truncateToWidth` 按可见列截断（ANSI 不占列、CJK 计 2）。颜色只提供 ANSI 原语，语义调色板由 `apps/ohna-cli/src/ui/theme.ts` 负责（包边界：term 不内置业务色板、不反向依赖 app）。

Keep package boundaries explicit. Do not move runtime behavior into an app when it belongs in a package. `apps/ohna-cli` / `apps/ohna-web` must not depend on `apps/finance-api` / `apps/finance-web`, nor on each other.

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
- Add concise explanatory comments in Chinese for important abstractions, package boundaries, agent/model/tool control flow, structured error handling, timeout/retry behavior, and any non-obvious implementation tradeoff. Every function and method should have standard Chinese JSDoc, including `@param`, `@returns`, and `@template` when they add useful context. Prefer comments that explain why the code exists or how the learning concept works; do not comment trivial assignments or repeat what the code already says.

## Database Rules

- 新建数据库表、修改表结构或新增字段时，必须在同一个 SQL migration 中使用 `COMMENT ON COLUMN` 为每个字段添加准确的中文注释；修改字段语义时必须同步更新注释，确保 DBeaver 等数据库工具可以直接展示字段含义。

## Design And Styling Rules

Read `DESIGN.md` in the project root before changing UI.

1. Use the design system stylesheet declared by `DESIGN.md` (`system.css`). This project uses Vite + React, so import it exactly once from the app's global CSS (`apps/finance-web/src/styles.css`).
2. Use the tokens, utilities, component anatomy, spacing, typography, and states described in `DESIGN.md`; do not invent a separate visual style.
3. For Immersive UI work, also read `docs/IMMERSIVE_PRODUCT_DESIGN.md`.
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

If no documentation update is needed, state that explicitly in the final response with the reason.

## AI Coding Workflow

For implementation tasks:

1. Read the relevant roadmap stage and nearby code first.
2. Make a narrow, working change.
3. Run validation.
4. Check documentation impact.
5. Summarize changed files, validation, documentation updates, and remaining risks.

Do not rely on a later periodic scan to keep docs correct. Treat periodic or subagent review as a backstop only.
