# 01 目标架构与包边界

> 本文定义改造完成后的目标分层、包边界与公共 API 命名。改造参照 badlogic/pi-mono（本地浅克隆 `https://github.com/badlogic/pi-mono`，下称 pi）。引用符号均已对照真实代码核实：
> - pi-ai（`@earendil-works/pi-ai`）：`badlogic/packages/ai`
> - pi-agent-core（`@earendil-works/pi-agent-core`）：`badlogic/packages/agent`
>
> 已确认决策（全套文档口径一致）：LLM 层完全按 pi-ai 改造且内部命名与 pi 一致；会话存储推倒重来为「线性消息 + run」；彻底删除 approval/permission 体系；保留 RAG/report/workflow/MCP/eval，工具 schema 仍用 zod 但接口形状对齐 `AgentTool`；接受完全不兼容改造。

## 现状

本项目为 pnpm monorepo（`pnpm-workspace.yaml` 声明 `apps/*`、`packages/*`），当前共 14 个包 + 2 个 app：

- `packages/agent`：agent 编排与 LLM 客户端混在一起。`agent-loop.ts` 导出 `createAgent` / `runAgent`（一次性请求-响应式，非事件流）；`llm-client.ts` 导出 `createLlmClient`，内含 `chat` / `toolChat` / `streamChat` / `jsonChat` 四种调用形态；`llm/` 子目录（`transport.ts`、`parsing.ts`、`mapping.ts`、`tracing.ts`、`env.ts`、`config.ts`）是手写的 OpenAI-compatible 传输与解析。另有 `intent-router.ts`、`reliability.ts`（模型重试）、`security.ts`（注入防护）。
- `packages/types`：全项目共享类型包，`llm.ts` 中定义 `LlmClient` 接口（`packages/types/src/llm.ts:105`）、`LlmChatRequest/Response`、`LlmStreamEvent`（第 97 行）；另有 `agent-run.ts`、`conversation.ts`、`trace.ts` 等跨包类型。
- `packages/tools`：工具注册与执行。`registry.ts`（`ToolRegistry`）、`executor.ts`（`executeTool`，含权限门与超时/重试）、`approval-repository.ts`（内存审批仓储）、`default-registry.ts`、`tools/`（calculator、financial-metric、market-data、filing-search、sql-query 等 mock 工具）。
- `packages/trace`：运行观测。`TraceRecorder` / `TraceStore` / `TraceEvent` 联合类型（含 `TraceApprovalEvent`、`TraceModelCallEvent`、`TraceToolCallEvent` 等 20+ 种），基于「一次请求 = 一条 trace」的模型。
- `packages/conversation` + `packages/database`：会话领域类型（`Conversation`、`Message`（role: user/assistant/system/tool）、`CursorPage`）与 Postgres 持久化（drizzle，`packages/database/migrations/`，含 `conversation-repository.ts`、`run-repository.ts`、`trace-repository.ts`、`approval-repository.ts`、`approval-decision.ts`、`rag-vector-store.ts`、`rag-documents.ts` 等）。
- 保留域：`packages/rag`（grounding/引用）、`packages/report` + `packages/workflow`（报告工作流含 PDF，`report/pdf.ts`）、`packages/mcp`（MCP 客户端/工具适配，`tool-adapter.ts`）、`packages/eval`（评测 runner）、`packages/filings`（财报数据）。
- 其他：`packages/identity`（用户/QQ 绑定，含 HMAC challenge）、`packages/channels`（渠道适配占位，仅 `index.ts`）。
- `apps/api`：HTTP 服务（`application/run-service.ts`、`application/conversation-service.ts`、`adapters/in-memory-*-repository.ts`），`apps/web` 为前端。

现状的核心问题：LLM 调用与 agent 循环无分层（`LlmClient` 泄漏在 types 包里被 UI/API 直接依赖）、一次性 `runAgent` 无事件流模型、trace 与会话/run 生命周期割裂、approval 体系横切 tools/database/api/web 四层。

## pi 参照

pi 的分层是三个包：

- **pi-ai（`badlogic/packages/ai`）**：纯 LLM 层，不感知 agent。
  - `src/types.ts`：`Message = UserMessage | AssistantMessage | ToolResultMessage`（第 432 行）、`ToolCall`、`Usage`、`Context`（第 486 行）、`Tool<TParameters>`（第 479 行）、`AssistantMessageEvent`（第 500 行）、`ProviderStreams`（第 236 行）、`StreamOptions` / `SimpleStreamOptions`。
  - `src/compat.ts`：`stream()`（第 250 行）与 `streamSimple()`（第 275 行）——provider 无关的统一入口，按 `model.api` 分发到具体 provider 实现，返回 `EventStream`。
  - `src/api/`：每个 provider 一个文件（`anthropic-messages.ts`、`openai-completions.ts`、`openai-responses.ts` 等），配套 `.lazy.ts` 懒加载变体（`lazy.ts` 聚合）。
  - `src/utils/event-stream.ts`：`EventStream<T, R>`（第 4 行）——push 式异步事件流，agent loop 与 UI 都消费它。
  - `src/models.ts` / `src/models.generated.ts`：模型目录；`src/auth/`：OAuth/凭据。
- **pi-agent-core（`badlogic/packages/agent`）**：agent 循环层，依赖 pi-ai。
  - `src/agent-loop.ts`：`agentLoop()`（第 31 行）/ `agentLoopContinue()`（第 64 行）返回 `EventStream<AgentEvent, AgentMessage[]>`；`runAgentLoop()` / `runAgentLoopContinue()` 为回调式变体。
  - `src/types.ts`：`AgentTool`（第 380 行，扩展 pi-ai `Tool`，加 `label` 与 `execute(toolCallId, params, signal?, onUpdate?)`）、`AgentContext`（第 406 行）、`AgentLoopConfig`（第 144 行，含 `transformContext` / `convertToLlm` / `beforeToolCall` / `afterToolCall` / `prepareNextTurn` / `shouldStopAfterTurn` 钩子）、`AgentEvent`（第 422 行）。
  - `src/harness/`：会话存储（`session/jsonl-storage.ts`、`jsonl-repo.ts`）、工具集、skills——**本项目不采用**，会话存储走 Postgres 线性模型（见 05 文档）。
- **pi-coding-agent（`badlogic/packages/coding-agent`）**：产品层，对应本项目 `apps/*` 的角色。

依赖方向严格单向：`coding-agent → agent → ai`。ai 不知道 tools 如何执行，agent 不知道会话如何持久化（通过 `AgentContext` 注入）。

## 目标设计

### 四层分层

```
┌─────────────────────────────────────────────────┐
│ L4 产品层   apps/web · apps/api · packages/channels │
│   HTTP/WS/UI/渠道适配，消费事件流，不做 agent 决策      │
├─────────────────────────────────────────────────┤
│ L3 会话与运行层  packages/conversation + packages/database│
│   线性消息/run 持久化、事件流持久化、会话编排            │
├─────────────────────────────────────────────────┤
│ L2 agent 层   packages/agent（并入 tool 执行）           │
│   agentLoop/AgentTool/钩子/RAG 挂载/报告意图          │
├─────────────────────────────────────────────────┤
│ L1 LLM 层   packages/ai（对齐 pi-ai）                  │
│   Message/stream/compat/provider，不感知 agent        │
├─────────────────────────────────────────────────┤
│ L0 领域能力层  packages/rag · report · workflow · mcp ·  │
│   filings · eval —— 被 L2 以工具/钩子形式挂载          │
└─────────────────────────────────────────────────┘
```

依赖方向只允许向下（L4→L3→L2→L1，L2→L0）。L1/L0 互不感知；L0 各包之间不互相依赖（rag 需要向量存储时依赖 database 的 `rag-vector-store`，见下）。

### 现有包映射表

| 现状 | 去向 | 说明 |
| --- | --- | --- |
| `packages/agent`（llm-client.ts、llm/） | **拆出到 `packages/ai`** | LLM 客户端整体按 pi-ai 重写，原手写 transport/parsing 删除 |
| `packages/agent`（agent-loop.ts、intent-router.ts、report-planner.ts、reliability.ts） | **留在 `packages/agent`** | `runAgent` 替换为 `agentLoop`/`agentLoopContinue` 事件流模型；reliability 改为 pi-ai `utils/retry` + 钩子 |
| `packages/agent`（security.ts） | **独立为 `packages/security`** | 注入防护不属 loop 内核，grounding hook 与 MCP 工具输出封装复用它，仅依赖 trace 接口（见 06 文档） |
| `packages/tools` | **并入 `packages/agent` 的 tool 层** | `registry.ts`、`executor.ts`（去掉权限门）、`tools/` 迁移为 `packages/agent/src/tools/`；`approval-repository.ts` 删除 |
| `packages/trace` | **改造为 loop 事件流持久化** | `TraceEvent` 联合类型替换为 pi 的 `AgentEvent` + 领域扩展事件；`TraceStore` 变为「run 事件追加存储」，落 `packages/database` 的新事件表；包名建议保留 `packages/trace` 但职责收窄为事件类型 + 记录器，或并入 database（见「取舍论证」） |
| `packages/conversation` | **推倒重建（线性模型）** | `Message` 改为 pi 风格（`UserMessage/AssistantMessage/ToolResultMessage` + 本会话特有的 compaction message），详见 05 文档 |
| `packages/database` | **schema 推倒重来** | 会话消息线性表 + run 表 + 事件表 + compaction 以特殊 message 落线性表；删除 `approval-repository.ts`、`approval-decision.ts`；保留 `rag-vector-store.ts`、`rag-documents.ts`、`citation-repository.ts`、`report.ts` |
| `packages/rag` | **保留，改挂载方式** | 不再由 intent-router 直接编排，改为向 `transformContext`/`prepareNextTurn` 钩子或 grounding 工具提供能力 |
| `packages/report` + `packages/workflow` | **保留，改挂载方式** | 报告触发从 intent 路由改为 agent 工具/技能调用；PDF 导出（`report/pdf.ts`）不动 |
| `packages/mcp` | **保留，改挂载方式** | `tool-adapter.ts` 输出从内部 Tool 类型改为 pi 风格 `AgentTool`（zod schema 桥接，见 06 文档） |
| `packages/eval` | **保留** | runner 改消费 `agentLoop` 事件流而不是 `runAgent` 返回值 |
| `packages/filings` | **保留** | 仅作为工具数据源，接口不变 |
| `packages/types` | **收缩后逐步消亡** | LLM 类型移入 `packages/ai`，agent 类型移入 `packages/agent`，trace 类型移入 `packages/trace`；仅保留纯跨域 DTO（identity、filings）。过渡期允许存在，改造完成后评估删除 |
| `packages/identity` | **原样保留** | 与 agent 改造正交；仍由 apps/api 依赖，不进入 agent 层 |
| `packages/channels` | **原样保留** | 渠道适配属 L4，消费 conversation 服务 |

### 新包 `packages/ai` 目录结构草案

对齐 `badlogic/packages/ai/src` 的实际布局，但**大幅裁剪**（本项目只需 OpenAI-compatible 一类 provider，不做 OAuth/图片/models.generated 目录）：

```
packages/ai/
├── package.json            # name: @aiagent/ai，无生产依赖外的新增依赖（zod 除外见 03）
├── src/
│   ├── index.ts            # barrel：types + compat + utils/event-stream
│   ├── types.ts            # Message/UserMessage/AssistantMessage/ToolResultMessage、
│   │                       # ToolCall、Usage、Context、Tool、AssistantMessageEvent、
│   │                       # StreamOptions/SimpleStreamOptions、Model、ProviderStreams
│   ├── compat.ts           # stream()/streamSimple()，按 model.api 分发 provider
│   ├── providers/
│   │   └── openai.ts       # OpenAI-compatible 实现（对齐 badlogic/packages/ai/src/providers/openai.ts；
│   │                       # 如需 responses API 再参照 src/api/openai-responses.ts 增补）
│   ├── utils/
│   │   ├── event-stream.ts # EventStream<T, R>（对齐 src/utils/event-stream.ts）
│   │   ├── retry.ts        # 超时/重试（对齐 src/utils/retry.ts）
│   │   └── validation.ts   # 工具参数校验辅助（对齐 src/utils/validation.ts）
│   └── models.ts           # 模型目录（手写小表，不引入 models.generated.ts 生成管线）
└── test/
```

与 pi-ai 的裁剪差异（需在 02 文档展开论证）：不搬 `src/auth/`（OAuth）、`src/images*`、`src/models-store.ts`、`src/api/*.lazy.ts` 懒加载机制；`compat.ts` 保留同名同签名，但内部分发表只有 `openai` 一类。

### 公共 API 命名对齐清单

| 本项目现名（路径） | pi 风格新名 | 备注 |
| --- | --- | --- |
| `LlmClient`（`packages/types/src/llm.ts:105`） | 无接口，直接用 `stream(model, context, options)` / `streamSimple(model, context, options)`（pi `packages/ai/src/compat.ts:250,275`） | 类实例 + 方法形态改为函数 + 显式参数 |
| `LlmClient.chat` | `streamSimple()` 收集最终结果 | pi 无单独 chat 入口 |
| `LlmClient.toolChat`（`packages/agent/src/llm-client.ts:167`） | `stream()`，`Context.tools` 传工具列表 | tools 是 Context 字段而非独立调用形态 |
| `LlmClient.streamChat` | `stream()` 返回的 `EventStream<AssistantMessageEvent, AssistantMessage>` | 事件类型对齐 `AssistantMessageEvent`（pi `types.ts:500`） |
| `LlmClient.jsonChat` | 删除；JSON 模式作为 `StreamOptions` 扩展字段 | eval/report 调用方改造 |
| `LlmChatRequest/Response`（`packages/types/src/llm.ts`） | `Context`（pi `types.ts:486`）/ `AssistantMessage` | 请求即上下文 |
| `LlmStreamEvent`（`packages/types/src/llm.ts:97`） | `AssistantMessageEvent` | |
| `LlmResult<T>` 结构化错误包裹 | 抛出结构化 `Error` 子类（pi 风格）+ EventStream `error` 事件 | 与「删除 LlmResult」决策一致 |
| `createLlmClient` / `createLlmClientFromEnv`（`packages/agent/src/llm-client.ts:24`、`llm/env.ts`） | `models.ts` 中的 `Model` 定义 + env 解析 helper | 配置对象化 |
| `createAgent` / `runAgent`（`packages/agent/src/agent-loop.ts:28,53`） | `agentLoop(prompts, context, config, signal, streamFn)` / `agentLoopContinue(...)`（pi `agent/src/agent-loop.ts:31,64`） | 返回值从 `Promise<AgentResponse>` 改为 `EventStream<AgentEvent, AgentMessage[]>` |
| `AgentRequest/AgentResponse`（`packages/agent/src/types.ts:54,67`） | `AgentMessage` / `AgentEvent` + 最终 `AgentMessage[]` | |
| `ToolRegistry` / `executeTool`（`packages/tools/src/registry.ts`、`executor.ts`） | `AgentTool[]` 数组由 config 注入；执行内嵌于 loop，钩子 `beforeToolCall`/`afterToolCall`（pi `agent/src/types.ts:61,79`） | 注册表降级为组装 helper；zod 校验保留在 `AgentTool.execute` 内 |
| `ToolDefinition`（`packages/tools/src/types.ts`） | `AgentTool<TParameters, TDetails>` 接口形状（pi `agent/src/types.ts:380`），schema 字段仍持 zod | 泛型参数用 zod 而非 typebox（与 pi 唯一刻意差异） |
| `TraceEvent` 联合（`packages/trace/src/index.ts:311`） | `AgentEvent`（pi `agent/src/types.ts:422`）+ `DomainEvent` 扩展（rag/report/workflow/mcp） | 持久化模型见 05 文档 |
| `TraceRecorder` / `TraceStore` | `AgentEventSink`（pi `agent/src/agent-loop.ts:25`）订阅者 + run 事件表 writer | |
| `intent-router` / `routeIntent`（`packages/agent/src/intent-router.ts`） | 删除路由概念；报告触发用 `shouldStopAfterTurn`/`prepareNextTurn` 钩子 + 工具 | 见 06 文档 |
| `chatWithReliability`（`packages/agent/src/reliability.ts`） | pi-ai `utils/retry` + `SimpleStreamOptions` 配置 | |

### 包间禁止依赖规则

依赖方向：`apps/* → conversation/database → agent → ai`，`agent → {rag, report, workflow, mcp, filings}`。禁止规则：

1. **`packages/ai` 不得依赖任何本项目包**（包括 types/trace/tools）。它是可独立发布的 LLM 层。
2. **`packages/agent` 不得依赖 `packages/database` / `packages/conversation` / `apps/*`**。持久化通过 `AgentLoopConfig` 钩子与事件订阅在 L3 接线（对齐 pi：agent 包不 import 存储，存储在 harness/产品层）。
3. **`apps/web` 不得直接依赖 `packages/ai`、`packages/agent`、`packages/database`**。前端只消费 `apps/api` 的事件流 DTO（trace/事件类型可经 `@aiagent/types` 或 api 包 re-export）。
4. **L0 包（rag/report/workflow/mcp/filings/eval）不得依赖 `packages/agent`**。依赖方向只能是 agent 挂载它们；它们需要的 LLM 能力直接依赖 `packages/ai`。
5. **`packages/database` 不得依赖 `packages/agent` / `packages/ai`**。消息表 schema 与 pi 类型同构但独立定义（存储模型不随 LLM 层类型变动），映射层在 conversation 包。
6. **`packages/identity` 只被 `apps/api` / `packages/channels` 依赖**，agent/ai 层不感知用户身份。
7. **禁止环**：`conversation ↔ database` 单向为 `conversation`（领域类型+服务接口）不依赖 `database`（实现），`database` 依赖 `conversation` 的类型——与现状一致。
8. 以上规则纳入 `.dependency-cruiser.cjs` 静态约束，CI 强制。

关键类型草案（各文档详述，此处仅锚定边界）：

```ts
// packages/ai：与 pi-ai 同名同形状（badlogic/packages/ai/src/types.ts）
export type Message = UserMessage | AssistantMessage | ToolResultMessage;
export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
// compat.ts：ProviderStreams 注册表 + 统一入口
export function stream(model: Model, context: Context, options?: StreamOptions): EventStream<AssistantMessageEvent, AssistantMessage>;

// packages/agent：与 pi-agent-core 同名同形状（badlogic/packages/agent/src/types.ts）
export interface AgentTool<TSchema extends z.ZodType = z.ZodType, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;          // 刻意保留 zod（与 pi 的 typebox 不同）
  execute: (toolCallId: string, params: z.infer<TSchema>, signal?: AbortSignal, onUpdate?: ...) => Promise<AgentToolResult<TDetails>>;
}
export interface AgentLoopConfig {
  transformContext?: ...; convertToLlm?: ...;
  beforeToolCall?: ...; afterToolCall?: ...;   // 仅观测/block 挂载点，无 approval
  prepareNextTurn?: ...; shouldStopAfterTurn?: ...;
}
export function agentLoop(prompts: AgentMessage[], context: AgentContext, config: AgentLoopConfig, signal: AbortSignal | undefined, streamFn: StreamFn): EventStream<AgentEvent, AgentMessage[]>;
```

## 取舍论证

- **为什么新建 `packages/ai` 而不是在 `packages/agent/llm/` 原地改造**：pi 的核心架构收益来自「LLM 层零 agent 感知」，`stream()` 可被 eval、report 工作流节点直接复用而不拖入 agent 循环。原地改造无法切断 types 包对 `LlmClient` 的泄漏（当前 `apps/api` 经 types 包直接构造 LLM 请求）。
- **为什么 `packages/tools` 并入 agent 而不是保留独立包**：pi 中 `AgentTool` 类型定义在 agent 包内，工具与 loop 的 `beforeToolCall`/`afterToolCall` 钩子强耦合；独立 tools 包要么反向依赖 agent（违反规则 4），要么复制类型。保留 zod schema 意味着 `AgentTool` 泛型参数与 pi 不同（typebox→zod），这是与 pi 唯一的刻意偏离，换取不重写现有 5 个工具 + mcp 适配器的 schema 及 zod 校验错误消息体系。
- **为什么 trace 收窄为事件流持久化而非沿用 TraceRecorder**：现有 `TraceEvent` 20+ 种事件与「一次请求一条 trace」模型无法表达多 turn loop 与 compaction。pi 的 `AgentEvent`（`agent/src/types.ts:422`）天然覆盖 turn/message/toolExecution 生命周期；rag/report/workflow 领域事件作为扩展联合成员追加，持久化走 run 事件表（05 文档）。`packages/trace` 包去留建议：**并入 `packages/database`（事件表 + writer）+ `packages/agent`（事件类型 re-export）后删除独立包**，减少一个边界；若团队希望前端直接 import 事件类型而不经 api，则保留包仅放类型。
- **为什么 types 包收缩而非直接删除**：identity/filings 等纯 DTO 仍有跨包共享价值；但 LLM/agent/trace 类型必须随层归位，否则 types 包会成为绕过依赖规则的公共垃圾桶。改造完成后再评估是否整体删除。
- **为什么依赖规则要落到 dependency-cruiser**：本仓库已有 `.dependency-cruiser.cjs` 基础设施，口头约束在 14 包重构中必然失效。
- **identity/channels 不动的理由**：与本次改造正交，纳入会扩大爆炸半径；identity 的 session/challenge 逻辑与 approval 无关，不属于删除范围。

## 删除清单

随本次架构调整直接删除（审批体系细节见 05 文档）：

- `packages/tools/src/approval-repository.ts`
- `packages/database/src/approval-repository.ts`、`packages/database/src/approval-decision.ts` 及对应 migrations 中的审批表
- `packages/trace/src/index.ts` 中 `TraceApprovalEvent`（第 90 行）及 `TraceEventType` 相关成员
- `apps/api/src/adapters/in-memory-approval-repository.ts`、审批相关 HTTP 路由（`apps/api/src/http/routes` 下）与前端审批 UI
- `packages/tools/src/executor.ts` 中的权限门逻辑（`executeTool` 本身并入 agent 后重写）
- `packages/agent/src/llm/` 整个目录（transport/parsing/mapping/tracing/env/config）与 `llm-client.ts`，由 `packages/ai` 取代
- `packages/agent/src/intent-router.ts` 的意图路由概念（报告触发改造见 06 文档；`report-planner.ts` 中纯计划生成部分保留）
- `packages/types/src/llm.ts`、`agent-run.ts`、`trace.ts`（类型归位到 ai/agent/trace）
