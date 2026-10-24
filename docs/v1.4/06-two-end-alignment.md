# 06 · 双端对齐改造：统一执行线 + 单事件总线（对标 CodeBuddy / ACP）

> **口径**：以 CodeBuddy Code（[Web UI](https://www.codebuddy.cn/docs/cli/web-ui)、[Remote Control](https://www.workbuddy.ai/docs/zh/cli/remote-control)、[v2.160.0 Release](https://www.codebuddy.ai/docs/cli/release-notes/v2.160.0)）为参照，收敛 ohna 当前「双执行线 + 只读镜像」的设计，达成 **单执行引擎 + 单条事件总线 + 多端订阅**。
>
> **触发问题**：`pnpm --filter @aiagent/ohna-cli dev`（默认 `ohna`）打开本地 Web，composer 可输入但发送即失败，提示「请求失败，错误详情见下方消息。」，气泡正文 `not_found: 接口不存在。`——LLM 全程正常，根因是默认模式的 serve 为只读观测台（`observeOnly: true`），未注册 `POST /api/runs`。已登记为 `tmp/dsh-repo-bug.json` 的 BUG-005。
>
> **前置文档**：`02-web-llm-trace.md`（D1 观测不接管执行 / W2 观测面）、`03-web-layout-alignment.md`（§0.3 后端形态结论 / D2 跨工作区续写）。本文在二者之上推进，**D1 由本文 supersede**（见 §1 D-A1）。
>
> 范围：`packages/serve`、`apps/ohna-cli`、`apps/ohna-web`、`packages/types`。不含 TUI 视觉改造（属 01 的 C 系列）。

---

## 0. 需求与现状锚点

### 0.1 需求判定

用户诉求（本轮原话归纳）：

1. 「ohna-web 本质需要完全依赖底层服务，我不启动 CLI，ohna-web 应该也没有意义才对」——即 **CLI 进程是 Web 的唯一宿主**，不存在独立后端。
2. 「这个 ohna-web 就和 CodeBuddy cli 启动时，本地也会运行一个 web 端」——即 **启动 CLI 即得到一个完整可用的 Web 端**，而非只读观测台。
3. 「在 web 上发送了消息，CLI 也会同步输出这条吗」——即 **双端双向实时同步**。

### 0.2 CodeBuddy 参照事实（已调研，非推断）

| 事实 | 来源 |
|---|---|
| 启动方式 `codebuddy --serve --port 7890`，Web UI 自动可用 | Web UI 文档 |
| 「在终端和 Web 端同时工作，对话保持同步」 | Remote Control 文档 |
| 「实时收到其他端（含命令行）发到该会话的消息」——**双向** | v2.160.0 Release Notes |
| 「Web UI 的会话与目录数据改由**单条总线**统一承载，订阅支持**断点续传**」 | v2.160.0 Release Notes |
| 「Web UI 基于 **ACP**（Agent Client Protocol）与本地 Agent 通信，保证与终端交互**完全一致**的体验」 | Remote Control 文档 |

**关键推论**：CodeBuddy 的「完全一致」来自**单执行引擎 + 单总线 + 用户消息也是总线事件**。ohna 缺的正是第三点（见 §0.3 锚点 4）。

### 0.3 现状锚点（本轮读码确认，实施时按此验证）

| # | 事实 | 位置 | 含义 |
|---|---|---|---|
| 1 | 默认 `ohna` = TUI repl 本地执行 + 进程内 serve 观测（`observeOnly: true`） | `harness.ts:260-271` | 执行权在 CLI，serve 只做镜像 |
| 2 | `observeOnly` 时**不注册** `POST /api/runs` / `DELETE /api/runs/:id` / 确认写路由 | `routes/runs.ts:40` | 浏览器发起 run → 404 → `not_found: 接口不存在。`（`static.ts:137`） |
| 3 | `--web` 托管模式 `observeOnly: false`，执行权在 serve，双端共享会话 | `web-entry.ts:92-101` | **本文要推广为唯一形态的目标形态**（D-A1） |
| 4 | **协议无用户消息事件**：`RunEventTypeDto` 只有 agent 侧事件，无 `user_message` | `packages/types/src/run-v2.ts:29-53` | web 发的消息**不会**推给终端（§0.2 推论的直接缺口） |
| 5 | `createRun` 时用户消息只 `messageStore.append` 落盘，**未 `emitFrame` 广播** | `run-manager.ts:201-217` | 与锚点 4 共同导致终端看不到「web 发了什么」 |
| 6 | 助手回复流式事件**已能**实时到终端（`subscribeConversation` + `renderFrame`） | `web-entry.ts:137-144`、`renderFrame:476-491` | 双向中「助手侧」已通，只缺用户侧 |
| 7 | **两套持久化并存**：CLI `session/` 写 `~/.ohna/sessions/<id>.jsonl`（首行 meta + 每行 message）；serve `store/` 写 `~/.ohna/sessions/index.jsonl`（追加索引）+ `conversations/` | `apps/ohna-cli/src/session/session-store.ts:402`、`packages/serve/src/index.ts:156-160` | 已实测 `~/.ohna/sessions/` 下两种文件并存（行数快照为调研时点实测值，非固定事实） |
| 8 | 观测型 run **刻意不写会话消息**（避免与 CLI 落盘双份） | `run/observe.ts` 注释第 10 行、`persist.ts` 过滤 | 默认模式 web 时间线为空，只能看 Trace。此为 D1 的必然代价 |
| 9 | `--web` 缺失默认模式的能力：`--max-turns` / `--deadline-ms` / `--max-cost` 预算、steering / follow-up、Team | `web-entry.ts` 全文件 grep 为空；`repl.ts:95` 有 followUp；`web-entry.ts:298` 明示不接 Team | **统一执行线的真实代价**，必须先补齐（D-A3） |
| 10 | `apps/ohna-api` 已退役（commit `3d22fb5`），serve 唯一消费者是 `apps/ohna-cli` | `packages/serve/package.json` 反查 | 保留 serve 独立包的合理性见 §1 D-A5 |

---

## 1. 架构决策（本轮拍板，实现时不再逐项讨论）

- **D-A1 · 单一形态：TUI 与 Web 同时启动、共享同一条执行线（supersede 02 的 D1）**。
  原 D1「观测不接管执行」是为了保住终端的 steering / follow-up / 本地权限卡 / 预算钩子（`02-web-llm-trace.md:31`）。该取舍**当时正确，但与「启动 CLI 即得到完整 Web 端」的需求冲突**，且留下了「Web 能打开、composer 能输入、发送必失败」的半吊子状态（BUG-005）。
  现改为：**只有一种运行形态**——进程启动即同时拉起整屏 TUI 与进程内 Web，两者**都是同一条 serve 执行线的订阅者**：

  ```
  serve（唯一执行引擎，agentLoop + RunManager）
        │  单条事件总线（subscribeConversation + SSE）
        ├── 整屏 TUI  （终端侧，保留 01 的 C 系列全部能力）
        └── Web 端    （浏览器侧，完整可收发）
  ```

  **不再存在「只启动一项」的模式**，因此 `--web` 与 `--no-web` 两个参数**一并删除**（D-A8）。TUI 保住意味着 steering / follow-up / 权限卡 / Team 等终端能力**不回归**，而非像早期设想那样退化为 readline。

- **D-A2 · 单总线补齐用户消息事件（协议级）**。
  给 `RunEventTypeDto` 增加 `user_message`，`createRun` 落盘后**立即广播**该事件（payload 含 `messageId` / `content` / `runId` / `source`，`source` 取值 `"web" | "cli"`——**不用 UI 组件名「composer」**，协议层只区分来源端）。终端 `renderFrame` 增加该帧的渲染分支，Web 侧时间线用它做「用户气泡的权威来源」（不再依赖本地乐观插入，见 §Ph-U2）。
  这是对齐 CodeBuddy「与终端交互完全一致」的**必要条件**——缺它则 web 发起的轮次在终端没有起点。

- **D-A3 · 先补 serve 执行线的能力缺口，再切单一形态**。
  TUI 侧现有能力必须在 serve 执行线上补齐，否则切换即能力回归。缺口来自锚点 9：
  - 预算：`--max-turns` / `--deadline-ms` / `--max-cost` 透传给 `RunManager.createRun`；
  - **权限卡**：TUI 的三选项结构化确认（`repl.ts:193-206` 的 `createReplToolGate`，含 diff 预览与 Toast）需改为经 serve 的 confirm-gate 通道，使**终端审批与 Web 审批落在同一闸门**。**通道按端区分**：TUI 是进程内订阅者，直接消费 `subscribeConversation` 事件并调用 `OhnaServer` 进程内句柄的决议方法（不打 HTTP 回环）；Web 走现有 SSE `confirmation_requested` + `POST .../confirmations/:toolCallId`。两端共用 `confirm-gate.ts` 的挂起/决议生命周期，仅传输层不同；
  - 中断：终端 Ctrl-C 走 `cancelRun`（已有）；
  - Team：子代理 `beforeToolCall` 通过 `onGateReady` 回填（已有机制，`repl.ts:204`），需在 serve 侧确认策略继承可用；
  - **`--prompt` 单次模式**：现由 `harness.ts:286 runSingleTurn` 承担（本地执行），需改为走 serve `createRun` 后等待终态再退出。
  **顺序不可颠倒**：先补能力（A1），再切形态（A2）。

- **D-A4 · 观测链三分法：采集层与文件 sink 保留，镜像通道退役**。
  「观测链」实为三样独立组件，命运不同（纠正早期"保留为降级"的笼统表述）：

  | 组件 | A2 后决策 | 理由 |
  |---|---|---|
  | ① 采集层 `createLlmTraceStreamFn` + `llm_call` DTO | **保留** | 托管模式自身就在用（`run-manager.ts:552`），是 `llm_call` 帧的唯一来源 |
  | ② 文件 sink `createFileTurnObserver` / `llm-trace-file.ts` | **退役** | 其唯一用途是 `--no-web` 降级；`--no-web` 删除后无运行时消费者 |
  | ③ 镜像通道 `observeRun` / `startObservedRun` / `createServerTurnObserver` | **退役** | 前提是「CLI 本地执行 + serve 只承接事件」；单一形态下该前提消失。A2 后仅剩 `packages/serve/test/observe-run.test.mjs` 8 个测试在调用，无生产调用方 |

  **注意**：原文档曾称「托管模式 host 失败 → 退回本地执行 + 镜像观测」为降级——**该说法不成立**。`web-entry.ts:102-107` 实测为 `process.exitCode = 1` 直接退出，从未降级。故 ③ 不承担降级职责，可安全退役。

- **D-A5 · `packages/serve` 保持独立包，不并入 CLI**。评估结论：
  | 维度 | 判断 |
  |---|---|
  | 体量 | serve 5236 行，占 CLI（13578 行）39%，并入会让 `apps/ohna-cli` 成为 18k 行巨物，违反「单文件 ≤500 行 / 职责单一」 |
  | 边界 | AGENTS.md：`packages/` 是可复用内核，`apps/` 是应用。serve 依赖 fastify + agent + coding，是「agent 内核的 HTTP 化」，非 CLI 专属 |
  | 测试 | serve 有 8 个独立测试文件（confirm-gate / compaction / observe-run 等），不依赖 TUI / readline；并入会被 TUI 依赖污染 |
  | 消费者 | 虽当前唯一消费者是 `ohna-cli`，但它是**内聚的「HTTP 化 + 持久化」内核**，保留包边界与 03 §0.3「CLI 内嵌 serve 是正确路线」一致 |
  **但执行 §Ph-A3 的持久化收敛**（消灭两套格式，见下）。

- **D-A6 · 持久化收敛到 serve 的 store（消灭双写）**。CLI 的 `session/session-store.ts`（500 行，写 `~/.ohna/sessions/<id>.jsonl`）在单一形态下**不再需要**：会话与消息的唯一真源变为 serve 的 `LocalSessionStore` + `LocalMessageStore`。
  - 保留 `session/` 中被其它能力依赖的部分，但**输入源必须切换到 serve**：`session-tail.ts`（现为按 JSONL 文件尾部倒读）改为经 serve 句柄读消息列表；`session-export.ts`（注释明示与 session-store 的路径/白名单约定耦合）改为读 serve 消息列表后渲染 Markdown；`usage.ts`（纯计算，仅依赖 `@aiagent/ai` 的 `Usage` 类型）原样保留。
  - `session-store.ts` / `session-flow.ts` / `session-runtime.ts` 在切换完成后退役。
  - **`--resume` 语义**：resume 走 serve 的会话列表（`LocalSessionStore`），即**只能 resume 新格式会话**；对旧 `<uuid>.jsonl` 会话 id 报「会话不存在或格式已退役」的结构化错误，不静默开新会话。
  - **不做**历史数据迁移与兼容性改造（当前无用户使用，本地开发态数据重开即可）。

- **D-A7 · `/api/health` 透出 `observeOnly`**。保留该字段用于**诊断与防御**，而非常规路径：
  - `OhnaServerOptions.observeOnly` **参数保留**（供未来外部进程挂只读观测实例），但 CLI 在单一形态下恒传 `false`；A2 不删除该参数，只删除 CLI 侧的分支（`web-host.ts` 固定 `observeOnly: false`）；
  - 若未来 reintroduce 只读实例（如外部进程仅挂 serve 观测），Web 需能区分；
  - Web 在 `observeOnly === true` 时把 composer 置为**禁用 + 明确提示**，而不是让用户输入后再 404（BUG-005 的止血）；
  - 该字段同时供 03 D4 的设置页「权限模式」分区展示——该区改为两行：「执行形态：可交互 / 只读观测（observeOnly）」+「权限模式：autoApprove 实际值」，不再使用「由宿主决定」占位。

- **D-A8 · 删除 `--web` 与 `--no-web` 两个参数**。
  单一形态下二者均无意义：`--web` 因「默认即带 Web」而冗余，`--no-web` 因「不能只启动一项」而无效。删除面：

  | 位置 | 改动 |
  |---|---|
  | `args.ts:31-35,163,186-199,255,301` | 移除 `noWeb` 字段、解析分支、`--no-web=` 取值写法与 help 行 |
  | `args.ts:22-25,178-181,233-239` | 移除 `web` 字段、`--web` 解析与位置参数 `webDir` 逻辑 |
  | `harness.ts:170-176` | 移除 `--web` 分发与 `--no-web` 互斥提示，直接走单一形态 |
  | `web-entry.ts` | 成为唯一入口（不再以 "--web 托管" 命名），终端侧改用 **TUI** 而非 readline（见 A2） |
  | `CliOptions` | 保留 `webPort`（端口仍可配）、`open`（是否自动开浏览器） |

  **不做**兼容性别名或废弃告警（当前无用户使用）。

- **D-A9 · 斜杠命令体系归属：纯 UI 命令留 TUI 本地，会话命令改走 serve 句柄，Web 不解释斜杠**。
  现状 `commands/session-commands.ts` 直接依赖 `session/session-store.ts`（`createSessionStore`），D-A6 删除该文件后命令体系必须同步迁移，否则 A3 会编译断裂。归属规则：
  - **纯 UI / 本地偏好命令**（`/help`、面板开关、主题字号等）：留在 TUI 本地执行，不触达 serve；
  - **会话命令**（`/new` / `/resume` / `/export` / 会话信息等）：改为调用 `OhnaServer` 进程内句柄（`createConversation` / 消息列表 / 导出数据来自 serve store），与 D-A6 的 session-tail/export 输入源切换同步落地；
  - **`!` 直通（`direct-command.ts`）**：执行 shell，是终端本地能力，留在 CLI 侧，不进 serve；
  - **`#` 记忆写入 / `@` 文件引用（`workspace/`）**：作用域为**会话工作区**（03 D2 跨工作区续写下以会话的 `workspaceRoot` 为准），不是 CLI 进程 cwd；Web 端 composer 同样支持 `@` 引用（经 serve 的只读 fs 路由已有能力），`#` 记忆写入本期仅 TUI 支持，Web 侧列为开放项；
  - **Web 不解释斜杠命令**：Web composer 输入的 `/xxx` 一律作为普通用户消息发给模型（与 CodeBuddy 行为一致）；命令帮助文案中注明「斜杠命令仅终端可用」。

- **D-A10 · 非 TTY 降级是 A2 的验收项，不是开放项**。
  单一形态删除本地执行体后，无 TTY 环境（CI / 管道 / ssh 无终端）若无法渲染 TUI 则 `ohna` 直接不可用，属阻断性回归。A2 必须包含：
  - `process.stdout.isTTY === false` 时自动退到 `ui/stream/print.ts` 非 TTY presenter（该 presenter 在单一形态下**保留**，作为非 TTY 渲染路径），终端输出流式文本；serve 照常进程内启动，Web 可用；
  - `stdin` 非 TTY 时按现有 `--prompt` 单次语义处理（读完全部 stdin 作为一次 prompt，走 serve `createRun`，等终态退出）；
  - 验收：``echo "hi" | ohna`` 与 `ohna --prompt "hi"` 在无 TTY 下均正常产出并退出码 0。

---

## Phase A1 · 补齐 serve 执行线的能力缺口（前置，阻塞 A2）

> 目标：把 TUI 侧现有能力搬到 serve 执行线，使切换单一形态后**零能力回归**。

### 交付清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/serve/src/run/types.ts` | `CreateRunInput` 增加 `maxTurns?` / `deadlineMs?` / `maxCost?` |
| 2 | `packages/serve/src/run-manager.ts` | `createRun` 透传预算参数给 `agentLoop` 配置；预算耗尽按现有 CLI 语义收尾（`run_status` interrupted + 提示） |
| 3 | `packages/serve/src/index.ts` | `OhnaServer.createRun` 入参增加同三项 |
| 4 | `packages/serve/src/confirm-gate.ts` | 确认闸门暴露**进程内决议方法**（供 TUI 复用，不打 HTTP 回环）与现有 SSE + POST 通道（供 Web）；两端共用同一挂起/决议生命周期 |
| 5 | `apps/ohna-cli/src/cli/web-entry.ts` | `createRun` 传入预算参数；`/status` 展示预算 |
| 6 | `packages/serve/test/` | 预算透传单测；终端侧确认决议单测 |

### 验收判据

- `--max-turns 2` 在第 2 轮后干净收尾，事件流出现终态 `run_status`，不悬挂。
- `--max-cost 0` 时不调用模型，run 直接终态。
- 写工具触发 `confirmation_requested`；终端与 Web **任一处**决议后 run 继续，两处状态一致。

---

## Phase A2 · 单一形态：TUI + Web 双端共享执行线

> 目标：进程启动即同时拉起整屏 TUI 与 Web，二者都是 serve 执行线的订阅者。

### 交付清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `apps/ohna-cli/src/cli/harness.ts` | 移除 `--web` / `--no-web` 分发（D-A8）；单一路径：装配 serve → 起 TUI → 订阅会话事件 |
| 2 | `apps/ohna-cli/src/cli/web-entry.ts` | 终端侧由 **readline 改为整屏 TUI**（`createReplTui`，复用 `repl.ts:114` 的装配）；输入提交改调 `server.createRun`；事件经 `subscribeConversation` 回流给 TUI 渲染 |
| 3 | `apps/ohna-cli/src/input/repl.ts` | 输入循环与 TUI 装配保留；**执行体**由本地 `runTurn` 改为 `server.createRun`（保留 steering / follow-up / 权限卡 / Team 的钩子接线） |
| 4 | `apps/ohna-cli/src/cli/web-host.ts` | `observeOnly: false`（单一形态恒为托管） |
| 5 | `apps/ohna-cli/src/cli/args.ts` | help 改为单一形态说明；保留 `--web-port` / `--no-open` / `--resume` / `--max-*` |
| 6 | `apps/ohna-cli/src/cli/harness.ts:286` | `runSingleTurn`（`--prompt`）改为走 serve `createRun` 后等终态退出 |
| 7 | `apps/ohna-cli/src/ui/stream/print.ts` | **保留**为非 TTY 渲染路径（D-A10）；`stdout` 非 TTY 时自动选用，`stdin` 非 TTY 时按 `--prompt` 单次语义处理 |
| 8 | `apps/ohna-cli/src/commands/` + `input/repl-commands.ts` | 命令体系按 D-A9 迁移：会话命令改调 serve 句柄；纯 UI 命令留本地；Web 不解释斜杠 |
| 9 | 手工验证 | `ohna` 启动 → TUI 正常渲染 + 浏览器可收发；TUI 输入 → Web 实时可见；Web 输入 → TUI 实时可见；`echo "hi" \| ohna` 与无 TTY 下 `ohna --prompt` 正常退出 |

### 风险与缓解

| 风险 | 缓解 |
|---|---|
| TUI 渲染依赖 `setOutputSink` + `renderEvent` 直出，改为消费 run-v2 帧需映射层 | `web-entry.ts` 已有 `AGENT_EVENT_FRAME_TYPES` 白名单 + `renderFrame` 映射，复用即可（`web-entry.ts:41-52,476-491`） |
| steering / follow-up 需真注入（非「run 后串行」） | 本期按「run 后串行新开」保留（`web-entry.ts:413-416` 已论证语义等价）；真注入另立项给 `RunManager` 加钩子（开放项 1） |
| TUI 权限卡改接 serve confirm-gate 后交互退化 | A1 第 4 项先验终端决议链路；保留 `createReplToolGate` 的 UI 层，只换后端通道（进程内句柄，非 HTTP 回环） |
| 切换后 `runRepl` 本地执行路径成为死代码 | A3 一并清理（本地执行体不再需要）；**TUI 本体与 `packages/term` 保留**；`ui/stream/print.ts` 非 TTY presenter 也**保留**（D-A10） |
| 命令体系随 session-store 删除而编译断裂 | D-A9 与 A2/A3 同步落地：先改 `session-commands.ts` 的依赖为 serve 句柄，再删 `session-store.ts` |

---

## Phase A3 · 持久化收敛（消灭两套格式）

> 依赖 A2（单一形态已走 serve 持久化）。

### 交付清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `apps/ohna-cli/src/session/` | `session-store.ts` / `session-flow.ts` / `session-runtime.ts` 退役删除；`session-tail.ts` / `session-export.ts` **改为经 serve 句柄读消息列表**（输入源切换，非原样保留）；`usage.ts` 原样保留 |
| 2 | `apps/ohna-cli/src/runtime/turn.ts` | 会话读写改为经 serve 句柄（`server.createConversation` / 消息列表） |
| 3 | `~/.ohna/sessions/` | 不再出现 `<uuid>.jsonl`；仅 `index.jsonl` + `conversations/` + `runs/` |
| 4 | `apps/ohna-cli/src/commands/session-commands.ts` | 会话命令改为调用 serve 句柄（D-A9），删除对 `createSessionStore` 的依赖 |
| 5 | `packages/serve/test/store.test.mjs` | 补会话 append / touch / 归档的既有覆盖不回归 |

### 验收判据

- 新启动一个实例并发消息后，`~/.ohna/sessions/` 下**只有** `index.jsonl`（无新增 `<uuid>.jsonl`）。
- 会话可在 TUI 与 Web 间无缝续写（同一 conversationId）。
- `--resume` 一个旧格式 `<uuid>.jsonl` 会话 id 时给出结构化错误提示（不静默开新会话，D-A6）。

### A3-B · 退役镜像通道与文件 sink（D-A4 ②③）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/serve/src/run/observe.ts` | 删除（`startObservedRun`） |
| 2 | `packages/serve/src/run-manager.ts` | 删除 `observeRun` 方法与 `ObserveRunInput` / `ObservedRun` 相关导出 |
| 3 | `packages/serve/src/index.ts` | 删除 `observeRun` 句柄 |
| 4 | `apps/ohna-cli/src/runtime/observation.ts` | 删除 `createServerTurnObserver` / `createFileTurnObserver`；保留 `createTracedStreamFn` 与 `ObservationRef`（① 采集层） |
| 5 | `apps/ohna-cli/src/runtime/llm-trace-file.ts` | 删除（连同 `flushTraceWrites` 调用点 `harness.ts:306`） |
| 6 | `packages/serve/test/observe-run.test.mjs` | 删除；其中有价值的断言（sequence 续传、瞬态不落盘）**迁移**到 `server.test.mjs` 的托管 run 用例 |
| 7 | `packages/agent/src/llm-trace.ts` | **保留**（① 采集层，托管模式在用） |

---

## Phase U1 · 协议补齐 `user_message` 事件

> 目标：让「Web 发的消息」成为总线上的一等事件，对齐 CodeBuddy 的完全一致体验。**可独立于 A 系列先行**（改动小、见效快）。

### 交付清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/types/src/run-v2.ts` | `RunEventTypeDto` 增加 `user_message`（注释说明 payload 形状） |
| 2 | `packages/types/src/run-v2.ts` | 新增 `UserMessagePayloadDto`：`{ messageId, content, runId, source: "web" \| "cli" }` |
| 3 | `packages/serve/src/run-manager.ts` | `createRun` 落盘用户消息后 `emitFrame(run, "user_message", {...})`（在 `agent_start` 之前）；**`--prompt` 单次模式（runSingleTurn 改道 serve 后）同样广播**，source 为 `"cli"` |
| 4 | `apps/ohna-cli/src/cli/web-entry.ts` | `renderFrame` 增加 `user_message` 分支：终端打印用户消息（区分 source，避免终端自己输入的消息重复打印）；非 TTY presenter（`print.ts`）同规则 |
| 5 | `packages/serve/test/`（**新建独立测试文件**，不挂 `observe-run.test.mjs`——后者在 A3-B 删除） | 断言 `user_message` 帧出现在事件流且 sequence 早于 `agent_start` |

### 关键取舍

- **终端去重**：终端自己发起的 run 也会收到 `user_message` 帧。终端应**只渲染 `source === "web"`** 的帧，本地发起的由 REPL 自己回显，避免双打印。single-turn（`--prompt`）场景无 TUI 渲染方，无需去重处理。
- **不删本地乐观插入**：Web 侧仍保留 pending 用户气泡（体验即时），但终态刷新时可被 `user_message` 校正。

---

## Phase U2 · Web 侧时间线以服务端为准

> 依赖 U1。

| # | 文件 | 改动 |
|---|---|---|
| 1 | `apps/ohna-web/src/features/workbench/live-run-projection.ts` | 识别 `user_message` 帧，投影为时间线用户气泡 |
| 2 | `apps/ohna-web/src/features/workbench/Workbench.tsx` | `refreshTerminalMessages` 后按服务端消息列表校正本地 pending 气泡（现有逻辑扩展，非重写） |
| 3 | `apps/ohna-web/src/**/*.test.tsx` | 补 `user_message` 投影与校正用例 |

---

## Phase A4 · `/api/health` 透出 `observeOnly` + Web 只读态

> 目标：消灭「能输入但发送必 404」的半吊子状态（BUG-005 的直接止血）。**建议与 U1 同期先行**。

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/serve/src/routes/health.ts` | 返回体增加 `observeOnly: boolean` |
| 2 | `apps/ohna-web/src/shared/mode.ts` | `LocalModeInfo` 增加 `observeOnly`；`fetchLocalMode` 收窄该字段 |
| 3 | `apps/ohna-web/src/features/settings/settings-health.ts` | 同步字段，供 03 D4 设置页「权限模式」分区显示真实值（现为「由宿主决定」占位） |
| 4 | `apps/ohna-web/src/features/workbench/chat.tsx` / `composer-controls.tsx` | `observeOnly === true` 时 composer 禁用 + 提示文案 |
| 5 | `apps/ohna-web/src/features/settings/PermissionSection.tsx` | 分区改为两行展示：「执行形态」= 真实 `observeOnly`（可交互 / 只读观测）+「权限模式」= autoApprove 实际值 |
| 6 | 测试 | `mode.test.ts` 补字段解析；新增「只读态 composer 禁用」组件用例 |

---

## 2. 测试用例清单（编号可逐条验收）

命名规则沿用 02：`TC-<阶段>-<序号>`。

| TC-ID | 场景 | 关键断言 |
|---|---|---|
| TC-A1-01 | 预算参数透传 | `createRun` 带 `maxTurns=2`，第 2 轮后 `run_status` 为 `interrupted`，不悬挂 |
| TC-A1-02 | 零预算 | `maxCost=0` 时不发 `llm_call`，run 直接终态 |
| TC-A2-01 | 单一形态可交互 | `ohna` 启动后浏览器 `POST /api/runs` 返回 202（不再 404） |
| TC-A2-02 | 终端→Web | TUI 输入产生 `user_message`(source=cli) + 流式事件；Web 时间线实时更新 |
| TC-A2-03 | TUI 已拉起 | `ohna` 启动后整屏 TUI 渲染（非 readline）；`--web` / `--no-web` 均报未知参数 |
| TC-A2-04 | 非 TTY 降级 | `echo "hi" \| ohna` 走 print presenter 输出并退出码 0；无 TTY 下 `ohna --prompt "hi"` 走 serve `createRun` 正常终态 |
| TC-A2-05 | 命令归属 | TUI 下 `/new` 经 serve 句柄建会话（无 `session-store` 依赖）；Web composer 输入 `/new` 作为普通消息发送 |
| TC-A3-01 | 单套持久化 | 新实例发消息后 `~/.ohna/sessions/` 下无新增 `<uuid>.jsonl` |
| TC-A3-02 | 镜像通道退役 | `grep -rE "observeRun|ObserveRun|ObservedRun|startObservedRun" apps packages test` 无残留调用方；根 `test/verify-ohna-web-trace.mjs` 已删除 observe run 段并全绿；`pnpm build` / `pnpm --filter @aiagent/serve test` 通过 |
| TC-A3-03 | resume 旧格式 | `--resume` 旧 `<uuid>.jsonl` 会话 id 报结构化错误，不静默开新会话 |
| TC-A3-04 | 导出/尾读仍可用 | `/export` 与 `session-tail` 读取的是 serve store 数据，输出正确 |
| TC-U1-01 | `user_message` 帧产出 | `createRun` 后事件流含 `type:"user_message"`，`sequence` < `agent_start` 的 sequence；`--prompt` 路径同样产出（source=cli） |
| TC-U1-02 | 终端只渲染 web 来源 | 终端收到 `source:"web"` 的 `user_message` 打印一次；`source:"cli"` 不重复打印 |
| TC-U2-01 | Web 投影用户气泡 | `user_message` 帧投影为时间线用户气泡 |
| TC-A4-01 | health 透出 | `GET /api/health` 含 `observeOnly` 布尔字段 |
| TC-A4-02 | 只读态禁用 composer | `observeOnly=true` 时 textarea `disabled` + 提示可见；`false` 时可发送 |

---

## 3. 参考对照表（调研结论 → 本方案取舍）

| 参考（CodeBuddy） | 能力 | 本方案取舍 |
|---|---|---|
| `codebuddy --serve` 启动即完整 Web | 单入口托管 | **采纳**：默认 `ohna` 即「TUI + Web」双端（D-A1） |
| CodeBuddy 终端是完整 TUI + Web 为同一会话窗口 | 双端同形态 | **采纳**：TUI 保留并成为唯一终端形态（D-A1 / A2） |
| ACP 单总线承载会话与目录 | 端到端统一协议 | **部分采纳**：复用现有 run-v2 SSE，补齐 `user_message`（D-A2）；不引入 ACP |
| 断点续传（上次位置继续不丢消息） | SSE `afterSequence` | **已具备**（02 W2 / `followRunEvents`），保留 |
| 终端与 Web 双向同步 | 多端订阅 | **已具备助手侧**，补齐用户侧（U1/U2） |
| Web UI 内置终端面板 | 浏览器内 shell | **不做**（03 §5-4 开放项） |
| 多实例注册表 + 切换 | 实例发现 | **不做**（03 §5-1 开放项，共享 dataDir 隐式聚合足够） |
| 公网 Tunnel + token 鉴权 | 远程访问 | **不做**（本地单用户，威胁模型不同） |

---

## 4. 不做清单（明确排除，防止范围膨胀）

- **不引入 ACP 协议**：复用现有 run-v2 SSE + `user_message` 扩展即可达成体验对齐，引入新协议成本远大于收益。
- **不拆 / 不并 `packages/serve`**（D-A5 已论证保留）。
- **不做历史数据迁移与兼容层**：当前无用户使用；A3 收敛后旧 `<uuid>.jsonl` 不再读取（如需保留，一次性脚本，非运行时代码）。
- **不做 `--web` / `--no-web` 的兼容别名或废弃告警**：直接删除（D-A8）。
- **不做公网访问 / 鉴权**：与 CodeBuddy Remote Control 的威胁模型不同。
- **不做 Web 内终端面板、多实例注册中心**：03 §5 已列为开放项。
- **不动 TUI 视觉与主题**：属 01 的 C 系列（**TUI 本体保留**，只换执行体）。
- **不删除 ① 采集层**（`createLlmTraceStreamFn` / `llm_call`）：托管模式自身在用（D-A4 ①）。

---

## 5. 开放项（本期不实施，留档案）

1. **真 steering / follow-up 注入**：托管下目前是「run 后串行新开 run」（语义等价但非真注入）。若要「运行中插话」，需给 `RunManager` 加 follow-up 钩子（内核级改动，另立项）。
2. **Team 在 serve 执行线的策略继承**：子代理 `beforeToolCall` 通过 `onGateReady` 回填的机制（`repl.ts:204`）需在 serve 侧验证可用；A1 第 4 项只覆盖单工具确认。
3. **多端冲突处理**：TUI 与 Web 同时发消息时的串行 / 拒绝策略（当前「一次一个 run」天然串行，但未显式定义冲突语义）。
4. **ACP 兼容性评估**：若未来要接入 CodeBuddy 生态客户端，再评估协议层对齐。
5. **Web 侧 `#` 记忆写入**：TUI 已支持，Web composer 本期不支持（D-A9）；`@` 文件引用 Web 侧可经 serve 只读 fs 路由实现，是否纳入本期实施时定。

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| A2 切换导致终端能力回归（steering / 权限卡 / Team / 斜杠命令） | 高 | **先做 A1**（预算 + 确认通道 + Team 继承）；命令体系随 D-A9 同步迁移；A2 后逐项回归 `test/verify-ohna-*.mjs`；非 TTY 降级纳入 A2 验收（D-A10），不作为事后补丁 |
| TUI 改为消费 run-v2 帧引入渲染差异 | 中 | 复用 `web-entry.ts:41-52` 的类型白名单与 `renderFrame` 映射；保留 `ui/stream` 的语义条目模型 |
| A3 删除 CLI `session/` 影响导出 / 用量 / 会话命令 | 中 | `session-tail/export` 输入源切到 serve 句柄（D-A6）；`usage.ts` 纯计算不受影响；`session-commands.ts` 先改依赖再删 session-store |
| `user_message` 广播增加事件流体积 | 低 | payload 只含必要字段；瞬态事件不落盘（沿用 `run-store.ts` 的落盘白名单策略） |
| 双端同时输入造成 run 并发 | 中 | 托管下 `createRun` 串行（`web-entry.ts` 已有 `activeRun` 守卫）；显式冲突语义列入开放项 3 |
| BUG-005 在 A2 完成前仍会出现 | 中 | **A4 先行**：health 透出 + composer 禁用，先消灭「能输入必失败」 |
| 无 TTY 环境（CI / 管道）无法渲染 TUI | 中 | D-A10：print presenter 保留并自动降级，纳入 TC-A2-04 验收 |

---

## 7. 实施顺序与验收总闸

建议交付顺序（**按此顺序，每步可独立验证、可回滚**）：

```
A4（止血，小）  →  U1（协议补齐，小）  →  U2（Web 投影）
                                              ↓
                    A1（补 serve 能力） → A2（TUI+Web 单一形态） → A3（持久化收敛 + 退役镜像通道）
```

| 阶段 | 依赖 | 验收命令（示意） |
|---|---|---|
| A4 | 无 | `pnpm --filter @aiagent/ohna-web test` + 手工：只读实例下 composer 禁用 |
| U1 | 无 | `pnpm --filter @aiagent/serve test` |
| U2 | U1 | `pnpm --filter @aiagent/ohna-web test` |
| A1 | 无 | `pnpm --filter @aiagent/serve test` + 手工 `--max-turns 2`、终端确认决议 |
| A2 | A1 | 手工：`ohna` 启动 → TUI 渲染 + Web 可收发；双向实时可见 |
| A3 | A2 | 手工：`~/.ohna/sessions/` 无新增 `<uuid>.jsonl`；`pnpm build` 通过 |

全量：`pnpm typecheck && pnpm build && pnpm test`。

---

## 8. 状态表（随阶段完成更新）

| 阶段 | 内容 | 状态 |
|---|---|---|
| A1 | 补齐 serve 执行线能力（预算 / 确认通道 / Team） | ✅ 已完成（预算透传 + 确认通道 + 终端决议打通；Team 继承经 `onGateReady` 回填在 serve 侧验证可用） |
| A2 | TUI + Web 单一形态（含删除 `--web` / `--no-web`、非 TTY 降级、命令体系迁移） | ✅ 已完成 |
| A3 | 持久化收敛 + 退役镜像通道与文件 sink | ✅ 已完成（CLI 侧 `session-store` / `observation.ts` / `llm-trace-file.ts` 退役；serve 侧镜像通道退役；Web 时间线改读 serve store） |
| U1 | `user_message` 协议补齐 | ✅ 已完成（协议 + serve 广播 + 单测） |
| U2 | Web 时间线以服务端为准 | ✅ 已完成（Web 投影 user_message + 终态校正乐观气泡） |
| A4 | health 透出 `observeOnly` + 只读态 | ✅ 已完成（health 透出 + composer 禁用 + 设置页真实值） |

---

## 9. 文档同步清单

实施时同步更新（每项随对应 Phase 落地，不依赖定期扫描）：

| 文档 | 触发阶段 | 更新点 |
|---|---|---|
| `docs/v1.4/README.md` | A2 | 配套实施计划增列 06；架构表「多端」行改为单总线双端 |
| `docs/v1.4/02-web-llm-trace.md` | A2 | D1 标注「已被 06 D-A1 supersede」；D10 降级链删除（无 `--no-web`）；`observeRun` 相关段落标注退役 |
| `docs/v1.4/03-web-layout-alignment.md` | A4 | D4 设置页「权限模式」分区改为真实 `observeOnly` 值 |
| `docs/v1.4/04-bug-tracking.md` | A4 | 登记 BUG-005 修复记录（对应本仓库 `tmp/dsh-repo-bug.json` 的 BUG-005） |
| `docs/v1.4/01-cli-optimization-plan.md` | A2 | 确认 C 系列（TUI）**不受影响**——TUI 保留，仅换执行体 |
| `AGENTS.md` | A2 / A3 | `apps/ohna-cli` 单一形态描述；删除 `--web` / `--no-web` 说明；`session/` 目录职责变更（tail/export 改读 serve store）；`commands/` 归属规则（D-A9）；`packages/serve` 段移除 `observeRun`；非 TTY 降级说明（D-A10） |
| `README.md` | A2 | 启动方式：`ohna` = TUI + Web 双端；移除 `--web` / `--no-web` 用法 |
| `apps/ohna-cli/src/cli/args.ts` help | A2 | 重写模式说明与参数表 |
| `packages/types/src/run-v2.ts` | U1 | `RunEventTypeDto` 新增类型（公共 API 变更） |
