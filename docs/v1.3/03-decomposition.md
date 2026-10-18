# 03 · 综合拆解方案（Decomposition）

> 本文是 `docs/v1.3` 的**权威拆解与目标架构**文档：综合 3 个资深评审 agent 的代码级结论 + 一轮架构决策问答，
> 把 `01-coding-cli.md`（CLI 编码 Agent）与 `02-local-web-runtime.md`（本地 Web 运行时）合并成一份可执行的目标状态。
> **本文取代 `02-local-web-runtime.md` 中「复用 `apps/api` 的 `createApiServer`」的假设**（见 §7 决策 D1）。
> 下游开发请以本文 + `04-development-plan.md` + `05-verify-cases.md` 为准。

---

## 1. 结论摘要（TL;DR）

1. **内核零改动成立**：`agentLoop` 是纯函数、运输层无关，三端（CLI / API / Local）可共用——但「治理」全部外包给调用方（无默认 maxTurns / LLM 超时 / deadline 强制、compaction 需注入 summarizer）。计划不变。
2. **M1（coding 工具闭环）已真实实现**：`packages/coding` 7 工具 + 策略 + 单测齐备，`apps/ohna-cli`（原 apps/cli）装配链路完整（非桩）。
3. **三个 P0 安全缺陷必须先修**（否则「接管本地目录」是假承诺）：bash 不受 workspaceRoot 约束、command-policy 多处可绕过、敏感文件可经软链绕过。详见 §4.2。
4. **成本护栏当前形同虚设**：`env-runtime.ts` cost 全 0 → `$cost` 恒 `$0.000000`，M2 预算/成本护栏必须先把模型元数据做对。
5. **架构方向（用户已拍板，D7/D8）**：`apps/finance-api`+`apps/finance-web`（原 `apps/api`/`apps/web` 机械改名）是「产品 A·金融 SaaS」，保持独立不动；编码 Agent 产品命名 **ohna**：`apps/ohna-cli`（原 `apps/cli`）+ `apps/ohna-api` + `apps/ohna-web`。Web 主路径是 **CLI 进程内托管**（`ohna --web`），服务端装配下沉 `packages/serve`，两产品线只共享 `packages/` 核心包，不共享应用层代码（不抽 `createApiServer`）。

---

## 2. 目标形态（总体架构）

```
packages/  ──────────────────────────── 共享核心（运输层无关的纯内核 + 可复用领域包）
  ai / agent / tools / coding / trace / security / mcp / conversation / memory / types
    （职责不变，见 §4.1；finance-api 与 ohna 两线共用）
  serve         ohna 服务端装配包：HTTP/SSE（run-v2 线协议）+ JSONL stores
                + 异步确认闸门 + 静态托管（ohna-cli --web / ohna-api / 未来 ohna-tui 共用）

apps/  ──────────────────────────────── 两条产品线（组合根）
  产品 A · 金融 SaaS（保持不动，独立演进）
    finance-api   生产 server（PG + Redis + 多租户 + QQ channel + 金融工具）〔原 apps/api〕
    finance-web   SaaS web（身份门 + 金融工作台 + 报告）〔原 apps/web〕

  产品 B · ohna（编码 Agent，本次新建/续建）
    ohna-cli      终端 Agent〔原 apps/cli 改名〕；M1 已实现；--web 进程内托管 serve 装配
    ohna-api      薄独立入口（headless / L0 最小验收单元；只做进程生命周期）
    ohna-web      Web 客户端（从 finance-web 复制后改造）
    （未来 ohna-tui：TUI 客户端，复用 serve 装配）
```

**核心命题**：`packages/agent` 的 `agentLoop` + `packages/ai` 的 provider + `packages/coding` 的工具集 + `packages/serve` 的服务端装配，是 ohna 的全部运行时底座；`ohna-cli` 与 `ohna-api` 只是同一装配的两个入口（终端进程内 / 独立守护），差异仅在运输层与进程生命周期。

---

## 3. 评审结论（3 个 agent 的合理性判断 → 采纳的修正）

| # | 评审发现（file:line 证据） | 原文档假设 | 修正后结论 |
|---|---|---|---|
| R1 | `createApiServer` 定义在 `apps/api/src/index.ts:113`，深度耦合金融 run-service（写死金融系统提示词 `run-service.ts:56`、无条件装配 `generate_report` `index.ts:159`、必填 RAG/report/artifact 六端口） | 02 文档：「直接复用 createApiServer + JSONL 端口」 | **放弃复用**：`packages/serve` 自建装配，直接消费 `agentLoop`（同 CLI），`apps/ohna-api` 为薄入口。见 D1 |
| R2 | bash 工具只过 denylist，不受 workspaceRoot 约束（`packages/coding/src/tools/bash.ts:142` 无 `assertPathWithinRoot`） | 01/02 文档：「路径与命令作用域限定在 cwd」 | **P0 修复**：命令策略无法真正 jail，改为「denylist 加固 + 确认闸门」信任模型（D2） |
| R3 | command-policy 多处绕过：`rm -rf ./`/`../../`、`curl -o+;sh`、`/bin/sh`（`command-rules.ts:41,47`、`command-policy.ts:65`） | 01 文档：`rm -rf /`、`curl\|sh` 会被拒 | **P0 修复**：补规则 + 单测覆盖绕过向量（§4.2） |
| R4 | 敏感文件软链绕过：`isDeniedPath` 用 `toAbsolute`（非 realpath，`path-policy.ts:94`），与 `assertPathWithinRoot` 的 `canonicalizePath`（realpath，`:64`）不一致 | 02 文档：`.env`/密钥会被拒 | **P0 修复**：`isDeniedPath` 也走 realpath（§4.2） |
| R5 | cost 全 0（`env-runtime.ts:70`）+ tracker 单轮级（`cli/render.ts`）→ `$cost` 恒 `$0.000000` | 01 文档：M2「/cost 有累计值」 | **M2 前置**：先做模型元数据可配 + 会话级累计（D4） |
| R6 | web 身份门硬阻塞：`apps/web/src/app/identity.tsx:86` 渲染前 FingerprintJS bootstrap，无 local 桩则白屏；QQ 设置硬编码 `SettingsPage.tsx` | 02 文档：「web 零改动」 | **改判**：`apps/ohna-web` 复制后改造，剥离身份门与金融块（D3） |
| R7 | compaction 已实现但未挂载、无默认 summarizer（`compaction.ts:206` 要求注入） | 01 文档：M2「挂 createCompactionTransform」 | 维持 M2，但需在 CLI/Local 注入 summarizer（复用 `streamSimple` 做摘要） |
| R8 | `deadlineMs` 有字段但 `createConfig` 未传（`cli/harness.ts:119-137`）；无 wall-clock 上限 | 01 文档：M2「加 deadlineMs」 | 维持 M2，`shouldStopAfterTurn` 内查时钟（对齐 team/budget.ts 的做法） |

---

## 4. 现状基线

### 4.1 已具备（直接复用，不重写）

| 能力 | 位置 | 复用点 |
|---|---|---|
| 纯函数 ReAct 双循环 + 6 挂载点 + AbortController | `packages/agent/src/agent-loop.ts`、`types.ts:127` | CLI 已用；Local 直接用 |
| `AgentTool` 契约 + executor（timeout/retry/parallel/sequential、`isError` 回喂） | `packages/tools/src/types.ts`、`executor.ts` | coding 工具已接入 |
| 编码工具集 + 策略 + 项目上下文 | `packages/coding/src/`（7 工具 + policy + context） | CLI 已用；Local 注入 `workspaceRoot` |
| compaction 原语 | `packages/agent/src/compaction.ts`（`createCompactionTransform`） | M2 挂载 |
| MCP 适配 | `packages/mcp/src/tool-adapter.ts`（`discoverMcpAgentTools`） | M3 接入 |
| 子代理 team controller | `packages/agent/src/team/`（`TeamController`） | M3 可选 |
| prompt-injection 封装 | `packages/security/src/security.ts` | M3 外部工具输出封装 |
| JSONL 落盘先例 | `packages/memory`（`JsonlMemoryStore`） | Local 存储心智 |
| CLI M0 会话外壳 + M1 编码闭环 | `apps/ohna-cli/src/`（原 apps/cli：welcome/harness/mode/render/confirm） | M2/M3 续建 |

### 4.2 已确认缺陷（按优先级，P0 必须在本轮开发先修）

| # | 缺陷 | 证据 | 影响 |
|---|---|---|---|
| P0-1 | bash 不受 workspaceRoot 约束，可读写删工作区外任意文件 | `bash.ts:142` 无路径断言 | 本地「接管目录」是假承诺 |
| P0-2 | `rm -rf ./`、`rm -rf ../../`、`rm -rf ~/Documents`、`rm -rf /tmp/x` 绕过 denylist | `command-rules.ts:41` `RM_DANGEROUS_TARGETS` 缺 `./`/`../`/`../../`；`checkDestructiveRm:344-355` 只拦「工作区自身/祖先」与固定目标集，**相对与绝对路径的工作区外目标均放行** | 越界删除 |
| P0-3 | `curl x -o /tmp/s.sh; sh /tmp/s.sh`（`;` 切分）与 `curl x \| /bin/sh`（绝对解释器）绕过 | `command-policy.ts:65` 只认 `null`/`\|` 相邻对；`command-rules.ts:47` `SHELL_INTERPRETERS` 缺 `/bin/sh` | 一键脚本执行 |
| P0-4 | 敏感文件软链绕过（`foo -> .env`） | `path-policy.ts:94` `isDeniedPath` 用 `toAbsolute`（非 realpath） | `.env`/密钥被读/覆盖 |
| P1-1 | `$cost` 恒 0 | `env-runtime.ts:70` cost 全 0；`cli/render.ts` tracker 单轮级 | 预算/成本护栏失效 |
| P1-2 | 长会话无 compaction、无 deadline | `cli/harness.ts:119-137` 未传 `transformContext`/`deadlineMs` | 128k 超窗 / 失控 |
| P1-3 | 会话不落盘 | `cli/harness.ts:237` REPL 仅内存 `history` | 退出即丢 |
| P2-1 | `ls.ts` 不消费 `signal`；`find.ts` 遍历时即按 limit 截断、事后排序（结果非字典序前 N）；`read.ts:219` 二进制嗅探仅 4KB | `packages/coding/src/tools/` | 取消不可见 / 结果排序瑕疵 |

---

## 5. 目标目录结构（新增 / 改造 / 已有）

```
packages/
  coding/                          [已有，P0 改造]
    src/policy/path-policy.ts      改：isDeniedPath 走 realpath
    src/policy/command-rules.ts    改：补 RM_DANGEROUS_TARGETS、SHELL_INTERPRETERS 绝对路径
    src/policy/command-policy.ts   改：checkFetchPipedToShell 覆盖 ; 切分
    src/prompt.ts                  新：buildCodingSystemPrompt(cwd)（从 apps/ohna-cli/src/mode.ts 下沉）
    src/tools/ls.ts                改：消费 signal
    src/tools/find.ts              改：全量收集→排序→截断
  ai/
    src/providers/env-runtime.ts   改：模型元数据可配（contextWindow/maxTokens/reasoning/cost）
    src/model-selection.ts         新：resolveActiveModelFromEnv（从 apps/ohna-cli/src/harness.ts 下沉，CLI 改薄封装）
    src/providers/anthropic.ts     改：实现直连（M3 可选，可走 OpenRouter 兼容层）
  serve/                           [新] ohna 服务端装配包（@aiagent/serve）
    src/index.ts                   createOhnaServer(options)：组装 routes + 进程内事件 fan-out
    src/routes/                    预拆路由域（避免单文件超 500 行）：
      health.ts identity.ts conversations.ts runs.ts events.ts fs.ts confirmations.ts
    src/store/                     新：JSONL 端口实现
      session-store.ts             会话元数据 + 恢复
      run-store.ts                 RunEvent append-only 落盘（复用 @aiagent/trace 契约，只落关键事件）
      message-store.ts             Message 线性落盘（复用 @aiagent/ai Message 形状）
    src/confirm-gate.ts            异步确认闸门（web 下写/执行 → 待确认卡片）
    src/static.ts                  serve apps/ohna-web/dist + SPA fallback
    test/                          单元 + 集成 + e2e

apps/
  finance-api/                     [改名自 apps/api] 金融 SaaS 生产 server（保持不动）
  finance-web/                     [改名自 apps/web] 金融 SaaS web（保持不动）
  ohna-cli/                        [改名自 apps/cli，续建 M2/M3]
    src/harness.ts                 改：挂 compaction + deadline + 会话级 cost；模型解析改消费 packages/ai
    src/session-store.ts           新：JSONL 会话持久化（~/.ohna/sessions/）
    src/slash.ts                   新：slash 命令体系（/model /cost /compact /tools /resume）
    src/render.ts                  改：diff 渲染 + 输出折叠 + 累计 cost
    src/index.ts                   改：--resume/--max-turns/--deadline-ms/--max-cost/--mcp/--web
    src/web-entry.ts               新（Phase 5）：--web 进程内托管 @aiagent/serve 装配 + 自动开浏览器
  ohna-api/                        [新] 薄独立入口（headless / L0 验收单元）
    src/index.ts                   进程生命周期：解析 [dir]/--port/--data-dir/--auto-approve
                                    → createOhnaServer + listen 127.0.0.1 + open browser + 优雅关闭
  ohna-web/                        [新] Web 客户端（从 finance-web 复制后改造）
    src/                           Vite + React + TS
    src/shared/api/                保留 run-stream / http client（复用 @aiagent/types DTO）
    src/app/                       改造：剥离 FingerprintJS 身份门、QQ、多租户
    src/features/chat/             保留：左会话列表 / 中时间线 / 底 composer / 展开式工具详情
    src/features/files/            新：文件树面板（读 /api/local/fs；Agent 写操作后联动刷新）
    src/shared/mode.ts             新：mode=local 开关（隐藏 SaaS 块 + 本地标识）
    vite.config.ts                 改：本地代理指向 serve 装配端口
```

> 依赖方向（须过 `pnpm architecture:check`）：
> - `packages/serve` 依赖 `packages/agent`、`packages/ai`、`packages/coding`、`packages/tools`、`packages/trace`、`packages/types`（run-v2 线协议 DTO 必需）、`packages/security`、`packages/mcp`（M3）、`packages/conversation`（import type）。
> - `apps/ohna-api`、`apps/ohna-cli` 只依赖 `packages/serve` 与核心包，**不得**依赖 `apps/finance-api`、`apps/finance-web`、彼此也不得互依。
> - `apps/ohna-web` 依赖 `@aiagent/types`（DTO）与浏览器库，**不得**依赖任何 `apps/*`。
> - `packages/coding` 依赖 `packages/tools`（`defineAgentTool`）与 `packages/ai`（import type），保持单向。
> - 下沉说明：`resolveActiveModelFromEnv` 进 `packages/ai`、`buildCodingSystemPrompt` 进 `packages/coding`、服务端装配进 `packages/serve`，属**核心包复用**（ohna 多入口共用），不违背「应用层不共享」（D1/D3 针对的是 apps 之间）。

> **历史路径说明**：§3 评审证据（R1–R8）与 §4.2 缺陷表中的 `apps/web` / `apps/api` / `apps/cli` 均为**改名前**的路径，对应现在的 `finance-web` / `finance-api` / `ohna-cli`；实现时按改名后的路径定位。

---

## 6. 模块职责拆解（关键新模块的公共形状）

### 6.1 `packages/serve` —— 线协议：实现 run-v2（复用 `@aiagent/types` DTO）

**关键约束（评审 Gate 1）**：`apps/ohna-web` 复制的 `run-stream-client.ts` / `conversation-client.ts`（`apps/finance-web/src/shared/api/`，即原 `apps/web`）按 **run-v2 线协议**工作：
`POST /api/runs` 须返回 `AgentRunAcceptedDto{runId,requestId,conversationId,modelId,status,eventsUrl,snapshotUrl}`（`packages/types/src/run-v2.ts:115`）；
SSE 帧为 `event: run_event` + `RunStreamEventDtoV2{eventId,runId,requestId,conversationId,sequence,type,payload,createdAt}`（`run-v2.ts:44`）；
断线续传用 `afterSequence` 查询参数 + `Last-Event-ID` 头（`run-stream-client.ts:92-101`）；
取消是 `DELETE /api/runs/:id`（`run-stream-client.ts:74`）；
终态由 `agent_end / run_error / run_status` 判定（`run-stream-client.ts:164`）。
**`packages/serve` 装配必须实现同一线协议**（而非自造 API），ohna-web 的 client 才能最小改动复用（D3）。`apps/ohna-api`（独立守护）与 `ohna-cli --web`（进程内托管）均为该装配的入口，线协议实现只写一处。

| 方法/路径 | 说明 |
|---|---|
| `GET /api/health` | `{ mode:"local", workspaceRoot, model:{id,provider}, pid, dataDir }`；供 ohna-web 判断模式 |
| `GET /api/models` | 本地可用 profile 目录 |
| `GET /api/identity/me` | 固定返回 `local-user` 身份（**保险端点**：ohna-web 残留的身份调用不 404 白屏） |
| `POST /api/conversations` | 建会话（`CreateConversationRequestDto` → `ConversationDto`） |
| `GET /api/conversations` | 会话列表（`CursorPageDto<ConversationDto>` 游标页） |
| `PATCH /api/conversations/:id` | 改标题 / 归档 |
| `GET /api/conversations/:id/messages` | 线性消息游标页（`CursorPageDto<LinearMessageDto>`，`conversation-client.ts:34`） |
| `POST /api/runs` | 建 run：`AgentRunCreateRequestDto` → `AgentRunAcceptedDto`（`mode/source` 接受并归一，`attachmentDocumentIds` 忽略）；异步执行 `agentLoop` |
| `GET /api/runs/:runId/events` | SSE：`event: run_event` 帧 + `RunStreamEventDtoV2`；支持 `afterSequence`/`Last-Event-ID` 续传；重放 JSONL 已落盘事件再接进程内 fan-out（finance-api replay+subscribe 心智的单进程简化版） |
| `GET /api/runs/:runId` | Run 快照（`RunSnapshotDtoV2`，重连耗尽后兜底） |
| `DELETE /api/runs/:runId` | 取消：abort 进程内 AbortController → 追发 `run_status{status:"interrupted"}` 终态事件 → 返回快照 |
| `GET /api/local/fs?path=` | 只读 list/tree/read（**写只走 Agent 工具**，绕过沙箱的唯一入口被禁止） |
| `POST /api/runs/:runId/confirmations/:toolCallId` | 待确认卡片：`{ decision:"allow"|"deny" }`（见 §6.3） |

**取消终态语义（评审 Gate 3）**：abort 后 `agentLoop` 发的是**无 error 的 `agent_end`**（`agent-loop.ts:262-265`），客户端 `terminalOf` 会判为 completed（`run-stream-client.ts:173-181`）。因此 serve 装配在 abort 后必须**追加 `run_status{status:"interrupted"}` 终态事件**，否则「取消显示为完成」。

### 6.2 JSONL 存储端口（`packages/serve/src/store/`）

数据目录默认 `~/.ohna/`（`--data-dir` 可覆盖），布局：

```
~/.ohna/
  sessions/index.jsonl              # { id, title, createdAt, lastActiveAt, workspaceRoot }
  conversations/<convId>.jsonl      # append-only Message（复用 @aiagent/ai Message 形状）
  runs/<runId>.jsonl                # append-only RunEvent（复用 @aiagent/trace 契约）
```

接口形状（供开发对齐，`RunEvent` 从 `@aiagent/trace` import type）：

```ts
interface LocalSessionStore {
  create(input: { title?: string; workspaceRoot: string }): Promise<SessionMeta>;
  list(): Promise<SessionMeta[]>;
  get(id: string): Promise<SessionMeta | null>;
  touch(id: string): Promise<void>;
}
interface LocalRunStore {
  appendEvent(runId: string, event: RunEvent): Promise<void>;
  listEvents(runId: string): Promise<RunEvent[]>;   // 启动重放 / SSE catch-up
  markEnded(runId: string, status: "completed" | "interrupted" | "error"): Promise<void>;
}
interface LocalMessageStore {
  append(conversationId: string, message: Message): Promise<void>;
  list(conversationId: string): Promise<Message[]>;
}
```

- 单用户单机 → 无并发/事务/租约/幂等语义（与 `apps/finance-api` 的 `RunStore` 完全不同，是**有意简化**，不是缺陷）。
- 启动时从 `sessions/index.jsonl` + 各 `*.jsonl` 重建内存读模型（列表/恢复/成本汇总）。
- **delta 体积治理**：SSE 实时推 `message_update` 增量，但 JSONL **只持久化关键事件**（`message_end` / `tool_execution_*` / `turn_end` / `agent_end` / `run_status` / `confirmation_requested` 等），`message_update` 不落盘——断线重连后由已落盘事件 + `GET /api/conversations/:id/messages` 恢复终态，避免逐 delta 全量落盘导致 JSONL 无界膨胀。sequence 由内存计数器对**所有**帧（含瞬态）单调分配，保证 `Last-Event-ID` 语义正确。
- 明确升级触发条件：仅当「全文检索历史 run / 本地 RAG 向量需持久化 / 会话量数千级重建变慢」时再引入 `better-sqlite3` 读模型（写仍 JSONL）。**本次不做**。

### 6.3 异步确认闸门（`packages/serve/src/confirm-gate.ts`）

CLI 的确认是 readline 同步；Web 下必须是**异步**：`beforeToolCall` 对 write/edit/bash 挂起，
向 SSE 广播 `confirmation_requested`，用户点允许/拒绝后 resolve。

```ts
interface AsyncConfirmGate {
  hook: (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined>;
  pending: Map<string, { resolve: (r: BeforeToolCallResult) => void; toolCall: AgentToolCall }>;
  resolve(runId: string, toolCallId: string, decision: "allow" | "deny"): void;
}
```

- `--yes`（ohna-api 的 `--auto-approve`）时 `hook` 直接放行，不产生待确认。
- run 取消/中断时须清理 `pending`，避免挂起泄漏；确认等待超时自动 deny。
- **契约归宿（评审 Gate 2）**：`confirmation_requested` 不在现有 `RunEventTypeDto`（`packages/types/src/run-v2.ts:20-37`）。Phase 3 在 `RunEventTypeDto` 增加 `"confirmation_requested"`（编码 Agent 本地扩展；App A 不消费，枚举扩展无害），payload 定为 `{ toolCallId, toolName, args, summary }`。
- **落盘/重放语义**：该事件照常追加进 runs JSONL（页面刷新后 SSE 重放可恢复待确认卡片）；「已决」不需要新事件——pending 态由「有 `confirmation_requested` 而无后续同 `toolCallId` 的 `tool_execution_start/end`」推导：allow 后自然接 `tool_execution_start`，deny 后接 `isError` 的 `tool_execution_end`。

### 6.4 `apps/ohna-web` —— 复制改造清单

| finance-web 源（原 apps/web） | 处理 |
|---|---|
| `src/shared/api/*`（http-client / run-stream-client） | **保留**（只依赖 `@aiagent/types`，`apps/finance-web/src/shared/api/http-client.ts:1` 已证实） |
| `src/app/identity.tsx`（FingerprintJS bootstrap + 渲染 gate） | **删除**，替换为 `createLocalIdentity`（无鉴权、`local-user`） |
| `src/features/settings`（QQ 绑定、data-sources、workflow/eval 导航） | **删除/隐藏** |
| `src/features/chat`（时间线 / composer / 展开式 tool-call 详情） | **保留**（核心复用价值） |
| `src/features/market-data` 等金融块 | **删除/隐藏** |
| 文件树面板 | **新增** `src/features/files`（读 `/api/local/fs`） |
| 本地标识 | **新增** mode 开关：`/api/health` 返回 `mode:"local"` 时显示「本地运行 · 工作目录」 |

---

## 7. 关键设计决策记录（ADR 风格，已拍板）

- **D1 · 不复用 `createApiServer`**：`apps/finance-api`（原 apps/api）是金融专用生产根，其 run-service 与 transport 深度耦合金融语义；抽包成本高于自建轻量装配。`packages/serve` 自建，直接消费 `agentLoop`（同 CLI）；`apps/ohna-api` 只是该装配的薄入口。原 02 文档的「复用 createApiServer」假设作废。
- **D2 · bash 信任模型 = denylist 加固 + 确认闸门**：对齐 Claude Code / CodeBuddy，不追求强 jail（成本高、易误伤）；bash 默认需用户确认，明确「bash 非强安全边界，靠确认兜底」。同时修复 P0-1~P0-4 的绕过。
- **D3 · ohna-web 独立复制改造**：不共享 `apps/finance-web` 应用层代码，避免身份门/金融块互相干扰；后续再抽前端组件库（本次仅复制+改造）。
- **D4 · 模型元数据先做对，再做预算**：`env-runtime.ts` 补 `AIAGENT_LLM_CONTEXT_WINDOW_<P>` / `AIAGENT_LLM_MAX_TOKENS_<P>` / `AIAGENT_LLM_REASONING_<P>` / `AIAGENT_LLM_COST_IN_<P>` 等 env 覆盖；否则 cost/预算/compaction 阈值全是空中楼阁。
- **D5 · JSONL 优先，SQLite 按需**：本地零基础设施，JSONL 与 `RunEvent` append-only 同构；SQLite 仅在明确触发条件下引入（§6.2）。
- **D6 · 金融 SaaS（产品 A）保持不动**：`apps/finance-api`/`apps/finance-web` 不随本次改造，回归验证只做「不被误伤」检查。
- **D7 · 产品命名**：两条产品线对称命名——金融线 `finance-api` / `finance-web`（原 `apps/api` / `apps/web` 机械改名）；编码 Agent 产品命名 **ohna**：`ohna-cli`（原 `apps/cli`）/ `ohna-api` / `ohna-web`（未来 `ohna-tui`）。CLI bin 名 `immersive` → `ohna`（改名属 04 Phase R 机械步骤）。
- **D8 · Web 托管主路径 = CLI 进程内**：ohna-web 依托 CLI 启动（CodeBuddy 式：终端与浏览器同一会话），**独立守护不是产品必需**。为此服务端装配下沉 `packages/serve`（apps 不得互依，装配须可被 ohna-cli / ohna-api / 未来 ohna-tui 复用）；`apps/ohna-api` 保留为薄独立入口，仅用于 headless 与 L0 最小验收。
- **D9 · 无向后兼容约束**：当前处于**开发验证阶段**，所有改动（目录/包名改名、bin `immersive`→`ohna`、CLI 参数面、模式默认值等）**不需要兼容原代码**，可直接重构，不为旧行为保留别名；金融产品线仅需自身构建/测试通过。

---

## 8. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| bash 沙箱仍是「可绕过」的（denylist 非 whitelist） | 高 | D2 确认闸门兜底 + 文档明示信任边界；P0 修复消除已知绕过 |
| **线协议漂移**：serve 装配自造 API 导致 ohna-web client 不可用 | 高 | §6.1 明确实现 run-v2 线协议（评审 Gate 1），DTO 全部复用 `@aiagent/types` |
| **compaction 跨 run 丢失**：`agentLoop` 复制上下文（`agent-loop.ts:126`），`transformContext` 产物只存在于 loop 内副本，`agent_end.messages` 只含增量 → 调用方持久化的永远是未压缩全量 | 高 | Phase 1 交付「会话级 compaction」：run 结束/保存时由调用方对全量 history 跑 `shouldCompact/compact` 并把 `CompactionMessage` + 未压缩尾部写回 session JSONL（内核零改动方案） |
| 异步确认闸门挂起泄漏 / 死锁 | 中 | run 取消时清理 `pending`；确认超时自动 deny |
| SSE 慢客户端背压 | 中 | 复用 `apps/finance-api`（原 apps/api）`ordered-run-event-stream` 的「write false → 暂停 drain → drain 事件恢复」心智 |
| cost 元数据缺失导致预算失准 | 中 | D4 先做；OpenRouter 等网关有 pricing，可静态表 + env 覆盖 |
| ohna-web 复制后与 finance-web 漂移 | 低 | 明确「本次不共享」，漂移可接受；组件库抽取留待后续 |

---

## 9. 下游文档

- 开发计划：`04-development-plan.md`（分阶段、依赖有序、文件级交付清单）
- 验收用例：`05-verify-cases.md`（安全 P0 用例 + 各阶段 Given/When/Then）
- 索引与状态：`README.md`（本文档）
