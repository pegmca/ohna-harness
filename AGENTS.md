# AGENTS.md

## Project Context

This repository is a TypeScript Agent engineering monorepo (`ohna-harness`) for an immersive financial research agent, with a reusable Agent kernel (`packages/agent`) and two product lines.

Primary planning documents:

- `README.md`
- `docs/BUSINESS_DIRECTION_FINANCIAL_RESEARCH_AGENT.md`
- `ARCHITECTURE.md`

Before implementing a task, read the relevant architecture/design documents and the files in the affected package or app.

## Development Phase Rules

- 当前处于开发阶段，无需考虑老代码或旧接口的兼容性。所有功能和代码均可按当前需求修改、替换或删除，无需保留兼容层、废弃路径或迁移逻辑。
- 无需编写改动记录、变更日志或历史演进描述；文档只描述当前状态。

## Repository Structure

两条产品线只共享 `packages/` 核心包，应用层互不依赖：

**产品 A · 金融 SaaS（保持不动，独立演进）**
- `apps/finance-api`: Fastify 生产 server（PostgreSQL + Redis + 多租户 + QQ channel + 金融工具）。
- `apps/finance-web`: Vite + React + TypeScript 金融 SaaS Web UI。
- `apps/finance-golden-studio`: 单用户本地 golden 数据制作应用（`@aiagent/finance-golden-studio`），唯一 CLI 为 `golden-studio`，Web 与 CLI 共用 `src/core`。`src/core/workspace.ts` 解析 `workspaceRoot` / `corpusRoot` / `manifestPath` / `draftRoot` / `goldenPath` / `generatedPath` / `backupRoot` 并提供路径守卫；配置只来自 `--workspace` / `--corpus` 或 `GOLDEN_WORKSPACE_ROOT` / `FINANCE_CORPUS_ROOT`，无私有绝对路径兜底。`src/cli/{args,commands,dev,serve,main}.ts` 负责严格参数、一键盘点 dev 进程定义、命令分派、本地 server 生命周期与信号收尾；`src/server/` 只做 HTTP/SPA 边界；`src/web/` 是 React 标注工作台；作者集 `golden.jsonl` 是唯一事实源，非负例题的 `expected_keywords` 由人工在来源 PDF 中复核，`generate` 原样投射为评测集 `expectedKeywords`。

**产品 B · ohna（编码 Agent）**
- `apps/ohna-desktop`: Electron 桌面编码 Agent（`@aiagent/ohna-desktop`，v2.1），恒为个人编码助手，金融研究能力归属产品 A；工具固定走 `packages/coding`，作用域限定在当前已授权工作区。进程形态为 main + preload SDK + utilityProcess runtime + React renderer，**不使用 HTTP/SSE**：
  - `src/main/`：桌面组合根。`index.ts` 持单实例锁、应用生命周期与 IPC 路由；`windows.ts` 建窗口；`workspaces.ts` 负责原生工作区授权与归属；`runtime-host.ts` 管理 utilityProcess 生命周期与订阅缓冲；`utility-transport.ts` 定义 worker 入口与消息传输；`envelope.ts` / `ipc.ts` 做跨进程信封校验与路由。
  - `src/preload/`：`sdk.ts` 经 `contextBridge` 暴露 `window.ohna`，`contract.ts` 是主进程与渲染端共享的 SDK 契约。sandbox preload 只能 `require("electron")`，故 `build.externalizeDeps: false` 必须把 `@aiagent/types` 等运行时依赖内联，否则 SDK 不会注入。
  - `src/utility/`：`worker.ts` 在 utilityProcess 内调用 `createOhnaRuntime` 跑执行；`routing.ts` 分发 runtime 请求。当前工作目录经 `OHNA_WORKSPACE_ROOT` 传入，dev 默认仓库根。
  - `src/renderer/`：React 工作台。`app/` 持路由、主题与运行状态编排；`features/workbench/` 是会话时间线 + composer + 工作区栏；`features/trace/` 是右侧 Trace 抽屉（`llm_call` 一等公民，Team run 才有 `TraceTeamCards`）；`features/settings/` 是设置弹窗；`features/json-viewer/`、`features/animation/` 为纯展示能力。
  - 订阅语义：run-event 订阅必须在每一跳（preload、main IPC、worker）先登记 subscription id 再发订阅请求，因为 runtime replay 会先于请求 resolve 发射；`RuntimeHost` 必须把每个订阅缓冲排空到底并在 `finally` 重置 `draining`，避免终态帧滞留。
- `apps/ohna-eval`: 独立评测包（`@aiagent/ohna-eval`，v2.0/v2.1），coding 与 team 双域；case / metric / runner 归应用域，不依赖桌面窗口、Electron 或 TUI。`src/` 中 `dataset.ts` / `metrics.ts` / `run.ts` / `adapter.ts` / `judge-rubrics.ts` 为 agent 域；`src/team/` 下 `dataset` / `metrics` / `run-l1` / `run-provider` / `report` / `trajectory` / `trend` 分别承担 tier 数据集、指标、L1 纯函数硬门禁、需 provider 的运行时用例、报告与趋势观测。入口 `src/index.ts` 按 `--dataset` / `--tier` / `--update-baseline` 分派，`--update-baseline` 在本档不可判定（0 条 case 执行）时必须拒绝并 exit 2，禁止写出空基线。

**共享核心**
- `packages/ai`: Unified LLM abstraction (`Message` types, `AssistantMessageEvent`, provider adapters, `stream` / `streamSimple`).
- `packages/agent`: ReAct loop boundary (`agentLoop` / `agentLoopContinue`), `AgentTool` contract, and tool execution；含会话级压缩的共享硬收敛 `compaction-enforce.ts`（桌面 runtime `packages/ohna-runtime` 与金融 `apps/finance-api` 两侧复用）；`src/permission/` 是**组合根装配的权限领域模块**（`AgentTool.effect` 单一事实源 + `createPresetPolicy` / `composePolicy` / `createPolicyState` / `createPermissionGate`；loop 内核不 import 它）；`src/team/` 支持 `TeamControllerOptions.beforeToolCall` 策略继承（子代理与 supervisor 共用同一权限闸门与 PolicyState）与 `TeamControllerOptions.onSubagentEvent` 子代理边界事件转发（四类 `agent_start`/`agent_end`/`turn_start`/`turn_end` 透传，`message_*`/`tool_*` 不转发，回调抛错被吞掉），并把编排机契约的**纯函数面**收在 `team/pure.ts`（`extractSummary` / `classifyAborted` / `assembleSubagentConfig` / `deriveSubagentIdentity`，docs/v2.0/03 §6.1：脱离 `agentLoop` 即可断言，是 L1 硬门禁的证据源；`createBudgetGuard` 的 token 上限与成本上限对称判定）；`llm-trace.ts` 提供 `createLlmTraceStreamFn(base, sink, counter, options)`（一次 stream 调用产出一条 `LlmCallRecordDto`，链式 onPayload/onResponse、事件原样透传；`options.window` 必填，在构造 wrapper 时注入；`options.observer.agentId` 于调用入口读取、错误记录同样可归因；`composition` 在 onPayload 现算、未到达时为 `undefined`）与 `estimateComposition`（system/tools/user/assistant/toolResult 五分类估算，docs/v2.0/04 §1.4 系数表）、`isTracedStreamFn` / `markTracedStreamFn`（防二次包装）。`agent-loop.ts` 相对 v1.x 唯一改动是 `AgentEvent` 边界事件补身份（`AgentLoopConfig.identity` + `SUPERVISOR_AGENT_ID` 兜底 + `turnIndex`），是 docs/v2.0/04 §1.3 的显式例外，不改控制流。
- `packages/coding`: 编码工具集（read/write/edit/bash/grep/find/ls）与路径、命令策略。
- `packages/tools`: `AgentTool` 契约（含 `effect?: "read" | "mutate"` 副作用声明，权限体系的单一事实源；缺省按 mutate 保守处理）+ 金融工具注册表与执行边界。
- `packages/trace`: Minimal run-event type contract and cross-boundary value redaction；v1.4 增 `RunEventType += "llm_call"` 与 `LlmCallTraceEvent`（payload 类型级引用 `@aiagent/types` 的 `LlmCallRecordDto`，`import type` 不引入运行时依赖）；v2.0 增 `RunEventType += "context_event"` 与 `ContextEvent`（payload 引用 `ContextEventPayloadDto`，当前仅 `kind:"compaction"`；`RunEventType` 与 `RunEventTypeDto` 必须同步增删）。
- `packages/types`: 跨边界线格式 / 持久化形状 DTO（api / conversation / run-v2 / local-fs / report / `llm-trace` 等）；`LlmCallRecordDto` 等 LLM 追踪 DTO 归此包，保持零 `@aiagent/*` 依赖。
- `packages/ohna-runtime`: ohna 桌面 runtime 共享内核（`@aiagent/ohna-runtime`，v2.1 Task 11 从旧 `packages/serve` 抽离）：JSONL stores（sessions / conversations / runs）+ `RunManager` + 组合根 `createOhnaRuntime`。负责单 `dataDir` 写者锁、run 原子创建、replay+live 订阅、异步确认闸门、工作区授权与归属（`src/workspace/`：registry / context / mcp）、成本与 compaction 投影。保持「无 Fastify / Electron / React」的纯 Node 依赖边界，桌面 main 与 `apps/ohna-eval` 复用同一内核。
  - `src/store/`：`jsonl` / `lock` / `session-store` / `run-store` / `message-store` / `reconcile` / `schema`，持久化落在 `~/.ohna/`。
  - `src/run/`：`team-session.ts` 是全仓 Team controller 的唯一装配点（按 `runId` 登记确认闸门与事件出口）；`team-runner.ts` 做 run 级 begin/release，`team` 关闭时零开销；`cost-summary.ts` 的 `RunCostTracker` 用 `snapshotTeamBaseline` 给团队用量打 run 起点快照，只报本 run 增量，team 段唯一真相源是 `@aiagent/agent` 的 `projectTeamCostSummary`；`context-event.ts` 在压缩**真的发生**（`compacted === true`）时发射 `context_event`（位置在 `user_message` 之后、`agent_start` 之前，可 replay）；`trace-stream.ts` 把主线程 `llm_call` 归因为 `SUPERVISOR_AGENT_ID`；`confirmations.ts` 持有确认闸门生命周期。
  - `src/events/`：`replay.ts` / `subscription.ts` 提供 replay+live 合并订阅，sequence 由 runtime 分配并落盘。
  - `src/config/settings-store.ts` 与 `src/model/config.ts`：用户级 `~/.ohna/settings.json`（明文 key、模式 0600，`OHNA_SETTINGS_PATH` 可重定向）是桌面 runtime 唯一模型配置来源；`src/workspace/mcp.ts` 管理 MCP 会话生命周期。绝对根目录不离开 runtime，渲染端只以 `workspaceId` 操作资源。
- `packages/eval-core`: 评测薄内核（`@aiagent/eval-core`，docs/v2.0/02）：只放跨产品线不变的纯函数 `gate` / `report` / `judge` / `calibration` / `trajectory`。除 `import type` 引用 `@aiagent/types` 外无任何 `@aiagent/*` 运行时依赖，不装任何产品的 case / metric / runner；金融 RAG 评测在 `apps/finance-api/src/eval/`，ohna 的 agent/team 评测在 `apps/ohna-eval/src/`。

Keep package boundaries explicit. Do not move runtime behavior into an app when it belongs in a package. `apps/ohna-desktop` / `apps/ohna-eval` must not depend on `apps/finance-api` / `apps/finance-web`, nor on each other. `apps/finance-golden-studio` is a local golden-data authoring app: it may compose shared parsing packages through declared dependencies, but must not depend on `finance-api`, `finance-web`, or ohna app layers.

## Local Development Ports

各应用使用固定端口，避免 Vite 静默顺延到相邻端口后被误认为另一个应用：

| 应用 / 服务 | Web / Vite | API | 说明 |
| --- | ---: | ---: | --- |
| `finance-api` | — | `3001` | `PORT` 可覆盖 |
| `finance-web` | `5180` | — | `strictPort`；`/api`、`/health`、`/ready` 代理到 `3001` |
| `finance-golden-studio` | `5181` | `4318` | Vite `strictPort`；`/api` 代理到 `4318`；API 端口由 `GOLDEN_STUDIO_PORT` 覆盖 |
| `ohna-desktop` | `5173` | — | electron-vite dev server 默认端口 |
| `ohna-eval` | — | — | 纯评测入口，不监听端口 |

- 启动 `finance-golden-studio` 后必须使用终端打印的 `Local:` 地址（`http://localhost:5181/`），不要打开 `5173`，那是 `ohna-desktop`。
- 新增或调整 Web 应用端口时，同时设置 `server.strictPort: true`，让端口冲突显式失败，不得依赖 Vite 自动顺延。

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
