# 03 Agent Loop：多轮 ReAct 循环改造

> 本文是改造方案的核心篇：把本项目「单轮意图路由 + 三分支流水线」的 agent 内核重写为对齐
> pi-agent（`badlogic/packages/agent`，包名 `@mariozechner/agent`）的多轮 ReAct loop。
> 引用符号均已对照真实代码核实（pi 仓库路径前缀 `https://github.com/badlogic/pi-mono`）。
> 与全套文档一致的决策：内部命名与 pi 保持一致（`agentLoop` / `agentLoopContinue` /
> `AgentTool` / `transformContext` / `convertToLlm` / `beforeToolCall` / `afterToolCall` /
> `prepareNextTurn` / `shouldStopAfterTurn`）；工具 schema 保留 zod；彻底删除
> approval/permission 体系；接受完全不兼容改造。LLM 层（`Message` / `stream` /
> `streamSimple` / `AssistantMessageEvent` / `EventStream`）的定义见 02 文档，本文不重复。

## 现状

本项目当前 agent 内核在 `packages/agent/src/agent-loop.ts`（867 行）：

- `runAgent()`（第 53 行）是唯一的运行入口，流程固定：
  1. `route_intent` 步调用 `createIntentRouter()`（`packages/agent/src/intent-router.ts:39`，
     关键词规则优先、模型结构化判断兜底），把消息分类为 `chat` / `tool` / `report_skill` 等意图；
  2. 按意图进入三个硬编码分支：`runReportSkillPath()`（第 179 行，report 激活 + planner）、
     `runToolPath()`（第 278 行，单工具单次调用）、`runChatPath()`（第 369 行，单次 LLM 问答）；
  3. 每个分支各自管理 `AgentStep` 预算（`ensureStepBudget`，第 536 行，`DEFAULT_MAX_STEPS = 6`），
     最后统一 `finish()`（第 602 行）写 `final_response` trace 并返回 `AgentResponse`。
- 工具调用走 `ToolRegistry.execute()`（`packages/tools/src/registry.ts:52` →
  `executor.ts`），executor 内保留 zod 参数校验、单次 timeout、总 `deadlineAtMs`、
  指数退避重试、AbortSignal 取消（`executor.ts:145–240`），并有 `allowedTools` 权限门
  （属于待删除的 approval 体系，见 05 文档）。
- LLM 调用只在 chat 分支出现一次（`chatWithReliability`，`reliability.ts:25`），
  RAG grounding 以 system/user 文本拼接的方式内联进 prompt（`agent-loop.ts:415–431`）。
- 无模型时 `mockChatAnswer()`（第 716 行）返回固定文案；工具结果由
  `formatToolAnswer()`（第 656 行）按工具名硬编码格式化成中文回答。

根本局限：模型不主导流程（工具选择由规则路由器预先决定，LLM 无法自主多轮调用工具）；
没有统一消息序列（步骤与 trace 事件代替了 `Message[]`）；上下文管理、压缩、续跑无从谈起。

## pi 参照

pi-agent 是纯函数式 loop + 可选的有状态 `Agent` 包装，全部代码在
`badlogic/packages/agent/src/`。

### agentLoop / agentLoopContinue（`agent-loop.ts`）

- `agentLoop(prompts, context, config, signal, streamFn)`（第 31 行）：把新 prompt 追加进
  `AgentContext.messages`，返回 `EventStream<AgentEvent, AgentMessage[]>`；最终结果通过
  `stream.result()` 取「本次 run 新产生的全部消息」。
- `agentLoopContinue(context, config, signal, streamFn)`（第 64 行）：不追加新消息，从当前
  上下文继续跑（用于重试/续跑）。前置校验：context 非空且最后一条消息不是 `assistant`
  （否则 provider 会拒绝请求）。
- 二者都只是外壳：创建 `EventStream`（`createAgentStream`，第 145 行，`agent_end` 为终止
  事件），异步运行 `runAgentLoop` / `runAgentLoopContinue`（第 95、120 行），核心逻辑共享
  `runLoop()`（第 155 行）。

### runLoop：双层循环（`agent-loop.ts:155–275`）

- **内层循环（turn 循环）**，每一轮：
  1. 注入 steering 消息（`config.getSteeringMessages()` 拉取的用户中途输入，
     第 182–190 行）；
  2. `streamAssistantResponse()`（第 281 行）调一次 LLM：先 `config.transformContext`
     （AgentMessage 级变换）再 `config.convertToLlm`（转成 LLM `Message[]`），组装
     `Context{systemPrompt, messages, tools}`，调 `streamFn(model, llmContext, options)`；
     逐事件把 partial message 写回 `context.messages` 尾部并转发为 `message_start` /
     `message_update` / `message_end`；
  3. `stopReason === "error" | "aborted"` 直接 `agent_end` 返回（第 196 行）；
  4. 从 `AssistantMessage.content` 滤出 `toolCall` 块，交给 `executeToolCalls()`
     （第 411 行）执行，产出的 `ToolResultMessage` 追加回上下文；
  5. 依次调 `config.prepareNextTurn()`（第 232 行，可替换下一轮的
     context/model/thinkingLevel）与 `config.shouldStopAfterTurn()`（第 247 行，
     返回 true 则 `agent_end` 退出）；
  6. 再拉一次 steering 消息，有 toolCall 或有 steering 则继续下一轮。
- **外层循环（follow-up 检查）**（第 262–271 行）：内层退出（无 toolCall 且无 steering）
  后调 `config.getFollowUpMessages()`，有排队消息则注入并继续跑，否则 `agent_end`。

### 工具执行（`agent-loop.ts:381–792`）

- **`stopReason: "length"` 整批拒执**（`failToolCallsFromTruncatedMessage`，第 381 行）：
  输出被 token 上限截断时，流式参数经 salvage 解析后可能「能 parse 但 silently 不完整」，
  整批 toolCall 一个都不执行，逐个回喂错误 ToolResultMessage 让模型重发。
- **并发默认 parallel，遇 sequential 工具降级**（`executeToolCalls`，第 411 行）：
  只要批次里有任一工具 `executionMode === "sequential"`（或 config 全局 sequential），
  整批走 `executeToolCallsSequential`；否则 `executeToolCallsParallel`——先按序 prepare
  （找工具 → `prepareArguments` 兼容 shim → `validateToolArguments` → `beforeToolCall`），
  再并发执行，最后按 assistant 源顺序回喂 ToolResultMessage（第 540–548 行）。
- **错误即数据**：工具未找到、参数校验失败、`beforeToolCall` block、执行抛异常，全部转成
  `isError: true` 的 ToolResultMessage 回喂模型（`createErrorToolResult`，第 756 行），
  loop 本身不抛错中断。
- `shouldTerminateToolBatch()`（第 582 行）：批次内**所有**工具结果 `terminate === true`
  才提前结束 run。

### config 钩子全清单（`types.ts:144–287`，`AgentLoopConfig`）

| 钩子 | 签名要点 | pi 语义 |
| --- | --- | --- |
| `convertToLlm`（必填） | `(AgentMessage[]) => Message[]` | AgentMessage → LLM Message，不可转换的自定义消息在此过滤 |
| `transformContext` | `(messages, signal?) => Promise<AgentMessage[]>` | LLM 调用前的上下文变换（裁剪/注入/compaction） |
| `getApiKey` | `(provider) => Promise<string \| undefined>` | 每次调用动态解析 key（短寿命 token） |
| `shouldStopAfterTurn` | `(ctx) => boolean \| Promise<boolean>` | turn 结束后优雅停止 |
| `prepareNextTurn` | `(ctx) => AgentLoopTurnUpdate \| undefined` | 替换下一轮 context/model/thinkingLevel |
| `getSteeringMessages` | `() => Promise<AgentMessage[]>` | 运行中注入用户消息 |
| `getFollowUpMessages` | `() => Promise<AgentMessage[]>` | run 将结束时注入排队消息 |
| `toolExecution` | `"sequential" \| "parallel"`，默认 parallel | 批内执行模式 |
| `beforeToolCall` | `(ctx, signal?) => {block?, reason?} \| undefined` | 校验后执行前；block 则回喂错误结果 |
| `afterToolCall` | `(ctx, signal?) => AfterToolCallResult \| undefined` | 执行后逐字段覆盖 content/details/isError/usage/terminate |

另：`AgentTool`（`types.ts:380`）= pi-ai `Tool` + `label` + `prepareArguments?` +
`execute(toolCallId, params, signal?, onUpdate?)` + `executionMode?`；
`AgentEvent`（`types.ts:422`）= `agent_start/end` + `turn_start/end` +
`message_start/update/end` + `tool_execution_start/update/end`。

### 有状态 Agent 包装（`agent.ts`）

`Agent` 类持有 `AgentState{systemPrompt, model, thinkingLevel, tools, messages, isStreaming,
streamingMessage, pendingToolCalls, errorMessage}`，内部维护 steering/follow-up 两个队列
（`QueueMode: "all" | "one-at-a-time"`），`prompt()` / `continue()` 调用上面的纯函数并把
事件桥接给订阅者。本项目只需要纯函数层 + 自有的 run/事件持久化（见取舍）。

### compaction 参照（`coding-agent/src/core/compaction/compaction.ts`）

- token 估算：`estimateContextTokens()`（第 202 行）优先取最后一条 assistant 消息的真实
  `usage`（`calculateContextTokens`，第 146 行），usage 之后的尾部消息用
  `estimateTokens()`（chars/4 启发式，第 266 行）补齐；`shouldCompact()`（第 235 行）按
  `contextWindow - reserveTokens` 阈值触发（默认 `reserveTokens: 16384,
  keepRecentTokens: 20000`，第 132 行）。
- `prepareCompaction()`（第 710 行）找切点（保留最近 `keepRecentTokens`），
  `compact()`（第 817 行）用结构化摘要 prompt（`SUMMARIZATION_SYSTEM_PROMPT`，
  分 Original Request / Early Progress / Context 等小节）让模型总结被裁掉的历史，
  支持基于 `previousSummary` 迭代更新。
- overflow 重试在 session 层（`coding-agent/src/core/agent-session.ts:1947`）：LLM 返回
  context overflow 错误时移除错误消息 → compact → 自动重试一次
  （`_overflowRecoveryAttempted` 防循环）。

## 目标设计

在 `packages/agent/src/` 下重写，文件拆分：

```
packages/agent/src/
├── types.ts            # AgentTool/AgentContext/AgentLoopConfig/AgentEvent/钩子上下文类型
├── agent-loop.ts       # agentLoop/agentLoopContinue/runLoop/streamAssistantResponse/executeToolCalls
├── compaction.ts       # estimateTokens/estimateContextTokens/shouldCompact/prepareCompaction/compact
├── convert.ts          # zod → JSON Schema 桥 + 默认 convertToLlm
└── index.ts            # barrel re-export
```

### 关键类型（对齐 pi，唯一刻意差异：zod 参数）

```ts
import type { z } from "zod";
import type {
  AssistantMessage, Context, Message, Model, TextContent, ImageContent,
  ToolResultMessage, Usage,
} from "@aiagent/ai"; // 见 02 文档

/** 工具结果：content 回喂模型，details 仅供 trace/UI，不进 LLM 上下文 */
export interface AgentToolResult<TDetails = unknown> {
  content: (TextContent | ImageContent)[];
  details: TDetails;
  usage?: Usage;
  /** 批次内全部结果为 true 才提前结束 run */
  terminate?: boolean;
}

/**
 * 工具定义。与 pi 的唯一差异：parameters 持 zod schema 而非 typebox。
 * 序列化为 JSON Schema 发生在 LLM 调用边界（见 convert.ts），
 * execute 内部用 zod 校验参数（保留现有 executor 的校验错误体系）。
 */
export interface AgentTool<TSchema extends z.ZodType = z.ZodType, TDetails = unknown> {
  name: string;
  description: string;
  label: string;
  parameters: TSchema;
  /** 原始参数兼容 shim，zod 校验前调用（对齐 pi prepareArguments） */
  prepareArguments?: (args: unknown) => z.infer<TSchema>;
  execute: (
    toolCallId: string,
    params: z.infer<TSchema>,
    signal?: AbortSignal,
    onUpdate?: (partialResult: AgentToolResult<TDetails>) => void,
  ) => Promise<AgentToolResult<TDetails>>;
  /** 默认 parallel；任一为 sequential 则整批降级为串行 */
  executionMode?: "sequential" | "parallel";
}

export type AgentMessage = Message; // 一期不扩展自定义消息类型，compaction 走独立 message_type

export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool<any>[];
}
```

### zod → JSON Schema 转换点

pi 在 provider adapter 内直接序列化 typebox schema。我们保留 zod（v4，现有依赖
`zod@^4.4.3`，`packages/tools/package.json:22`），转换点收敛在 `convert.ts` 一处：

```ts
/**
 * 在 streamAssistantResponse 组装 llmContext 时调用：
 * AgentTool[] → pi-ai Tool[]（parameters 变为 JSON Schema 对象）。
 * 这是唯一的转换点；loop 内部与落库始终持 zod。
 */
export function toLlmTools(tools: AgentTool<any>[]): Tool[];
// 实现即 z.toJSONSchema(tool.parameters) + name/description 透传
```

### AgentLoopConfig（钩子签名与 pi 一致，挂载点标注本项目能力）

```ts
export interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model<any>;
  /** 必填：AgentMessage → LLM Message；默认实现透传三元组（对齐 pi agent.ts:32） */
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  /** 挂载点①：RAG 附件 grounding（把检索证据注入/替换为 user 消息内容）
   *  挂载点②：compaction 检查与触发（shouldCompact → compact → 返回压缩后序列） */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  /** 挂载点③：deadlineMs 到期检查 + maxTurns 预算（替代旧 ensureStepBudget/ensureRunActive） */
  shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
  prepareNextTurn?: (context: PrepareNextTurnContext) => AgentLoopTurnUpdate | undefined;
  /** 挂载点④：从 run 的 steering 队列表读用户中途消息（Postgres，见 05 文档） */
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  toolExecution?: "sequential" | "parallel"; // 默认 parallel
  /** 挂载点⑤：仅观测与 block（dangerous 工具 denylist、限流）；不接任何审批逻辑 */
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal)
    => Promise<{ block?: boolean; reason?: string } | undefined>;
  /** 挂载点⑥：citation 提取、trace 补充 details（citation 持久化见对应篇章） */
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal)
    => Promise<AfterToolCallResult | undefined>;
  /** 本项目新增（pi 无）：总 deadline 毫秒数，由 run 层换算成截止时刻 */
  deadlineMs?: number;
}
```

钩子上下文类型（`ShouldStopAfterTurnContext` / `PrepareNextTurnContext` /
`BeforeToolCallContext` / `AfterToolCallContext` / `AfterToolCallResult` /
`AgentLoopTurnUpdate`）字段级照抄 pi `types.ts:61–142`，不重复列出。

### runLoop 行为（照抄 pi 语义）

- 纯函数 `agentLoop` / `agentLoopContinue` 返回 `EventStream<AgentEvent, AgentMessage[]>`，
  事件契约同 pi `types.ts:422`；run 层（05 文档）消费事件流做 SSE 转发与 Postgres 落库。
- 内层 turn：steering 注入 → `streamAssistantResponse` → 收集 toolCall →
  `executeToolCalls` → ToolResultMessage 回喂 → `prepareNextTurn` / `shouldStopAfterTurn`。
- 外层：内层退出后查 `getFollowUpMessages`。
- 工具批执行规则照抄 pi：默认 parallel；批内任一工具 `executionMode: "sequential"`
  整批串行；`stopReason === "length"` 整批拒执并回喂「参数可能被截断，请重发」错误；
  一切失败（工具不存在/校验失败/block/抛异常）转 `isError: true` 的 ToolResultMessage，
  loop 不抛错。
- 现有 executor 的超时/重试/deadline 语义（`packages/tools/src/executor.ts:145–240`）
  下沉为 `AgentTool.execute` 的内部包装（每个工具适配器在 execute 内套同一
  `withTimeoutAndRetry` helper），loop 层无感知。

### compaction 设计（线性 Postgres 落地）

- **触发与估算**：照抄 pi 的 `estimateTokens`（chars/4）、`estimateContextTokens`
  （末条 assistant usage + 尾部估算）、`shouldCompact`（`contextWindow - reserveTokens`）
  与 `prepareCompaction` / `compact` 结构化摘要 prompt；默认
  `reserveTokens: 16384, keepRecentTokens: 20000`。
- **挂载**：自动阈值压缩挂在 `transformContext`（每次 LLM 调用前检查）；手动压缩由
  run 层命令触发。
- **overflow 重试**：`streamAssistantResponse` 返回 `stopReason: "error"` 且错误为
  context overflow 时，run 层执行一次「compact → `agentLoopContinue` 重试」，
  单次防循环标志对齐 pi `_overflowRecoveryAttempted`（`agent-session.ts:327`）。
- **落库（与 pi 的核心差异）**：pi 把 compaction 存为 session 树的 `CompactionEntry`
  节点；我们在线性 `messages` 表插入一行 `message_type = 'compaction'` 的特殊消息
  （列：`summary` 文本、`tokens_before`、`first_kept_message_id`、`usage`）。
  重建上下文时从**最后一条** compaction 消息开始，取 `first_kept_message_id` 起的
  原始消息 + 该 summary 拼成 `AgentMessage[]`；summary 在 `convertToLlm` 中转为一条
  user 消息（对齐 pi `buildSessionContext` 的做法）。历史原始消息物理保留（审计/trace），
  只是不再进入 LLM 上下文。

### 取消与超时

- **单一 `AbortSignal`**：run 层持有一个 `AbortController`，signal 贯穿
  `agentLoop(..., signal, streamFn)` → streamFn → 每个 `tool.execute` 与全部钩子。
  pi 语义照抄：signal abort 后 stream 以 `stopReason: "aborted"` 收尾，工具批在
  下一个边界停止（`agent-loop.ts:478, 535`）。
- **保留现有 `deadlineMs`**：`AgentLoopConfig.deadlineMs` 由 run 层换算为 `deadlineAtMs`；
  两处生效——(a) `shouldStopAfterTurn` 检查到期则优雅停（已产生的 assistant 答复正常
  返回，区别于 abort 的硬中断）；(b) 工具执行包装继续用现有「min(单次 timeout,
  剩余 deadline)」预算（`executor.ts:215–227` 的语义迁移）。

### intent-router 处置：彻底移除规则路由

`packages/agent/src/intent-router.ts`（355 行）整文件删除，不再设任何前置意图分类：

- **工具选择交给模型 function calling**：所有工具（金融数据、filing 检索、MCP 工具、
  SQL 查询、report/workflow 触发器）以 `AgentTool[]` 注入 `AgentContext`，模型通过
  toolCall 自主选择，多轮调用由 loop 原生支持。这正是改造的核心动机——规则路由器
  是「模型不主导流程」的根源。
- **report 路径降级为一个工具**：`runReportSkillPath` 的 activation/planner 能力保留，
  包装成 `plan_report` AgentTool（或挂在 `beforeToolCall`/`afterToolCall` 观测链上），
  由模型在用户要求研报时自行调用；Report Mode 按钮/开关由 run 层注入一条引导性
  system/user 消息实现，不再走 `route_intent` 分支。
- **理由**：(1) 关键词列表（`intent-router.ts:10–18`）维护成本高、召回差、与工具
  description 双份真相；(2) 单工具单次的 `runToolPath` 无法表达「查指标 → 再查 filing →
  综合回答」这类多步研究流，而 loop 原生可以；(3) pi 与所有主流 coding/research agent
  均已验证模型自主选工具的可行性。
- **风险与缓解**：(1) 无 API key 的本地开发路径不再有 `mockChatAnswer` 兜底——保留一个
  `MockModel`（实现 `streamSimple` 形状返回固定 AssistantMessage）注入 loop，行为可预测
  且走同一条代码路径；(2) 模型选错工具的回归风险由 eval（`packages/eval`，保留）覆盖，
  在 eval 数据集中补充「应调用工具 X」类断言；(3) 成本上升（每次问答都带工具 schema），
  通过 `transformContext` 在短对话裁剪工具集缓解，一期不做。

## 取舍论证

- **纯函数 loop + 不移植 pi 的有状态 `Agent` 类**：pi 的 `agent.ts`（577 行）主要管理
  内存态与 UI 订阅，而本项目的会话状态以 Postgres 线性消息为准（01 决策），steering/
  follow-up 队列由 run 层从数据库读。移植 `Agent` 类会制造第二份状态真相。代价是
  `QueueMode`（one-at-a-time）等策略要在 run 层自行实现——一期只要 `all`。
- **zod 而非 typebox**：已在 01/02 论证（不重写现有工具 schema 与校验错误体系），
  代价是 `AgentTool` 泛型与 pi 不同源、`toLlmTools` 转换点为我们独有；转换点收敛在
  单一文件，风险可控。
- **错误即数据**：工具失败回喂 `isError` 结果而非中断 run，牺牲「快速失败」换取
  模型自我修正能力（重发参数、换工具），与 pi 及主流 agent 一致；trace 层仍完整记录
  失败详情，观测不受影响。
- **`stopReason: "length"` 整批拒执**：宁可误伤合法调用也不执行参数可能被截断的调用，
  金融数据场景下错误参数（如错误的期间、代码）的代价高于一次重试。
- **compaction 落线性表而非树**：会话模型已定为线性（01 决策），pi 的 entry 树 +
  `firstKeptEntryId` 在 SQL 上用一行特殊消息即可等价表达；物理保留原始消息使
  trace/审计/导出不受影响，代价是重建上下文逻辑略复杂（需在 `convertToLlm` 前定位
  最后一条 compaction）。
- **移除 intent-router 而非降级保留**：保留双路由（规则 + function calling）意味着
  两套工具描述、两条执行路径长期并存，违背「窄而可用的改造」；用户已接受不兼容改造，
  eval 可兜底回归风险。

## 删除清单

以下文件/符号在改造中删除（均已核实存在）：

- `packages/agent/src/agent-loop.ts` 整体重写，删除其中：
  - `runAgent()`（第 53 行）及 `createAgent()`（第 28 行）的三分支编排；
  - `runReportSkillPath()`（第 179 行）——能力迁移为 `plan_report` 工具；
  - `runToolPath()`（第 278 行）——由 loop 工具批执行取代；
  - `runChatPath()`（第 369 行）——由 loop + transformContext(RAG) 取代；
  - `formatToolAnswer()`（第 656 行）——工具结果不再由 agent 层按工具名硬编码格式化，
    回喂模型的 `content` 由各工具自身产出，面向用户的总结由模型生成；
  - `mockChatAnswer()`（第 716 行）——由注入 loop 的 `MockModel` 取代；
  - `ensureStepBudget()` / `DEFAULT_MAX_STEPS`（第 20、536 行）——由
    `shouldStopAfterTurn` 的 maxTurns 检查取代；
  - `ensureRunActive()`（第 471 行）——由单一 signal + `shouldStopAfterTurn` deadline
    检查取代。
- `packages/agent/src/intent-router.ts` 整文件（355 行）及 `types.ts` 中
  `AgentRouter` / `AgentRoute` / `AgentIntent` / `AgentToolSelection` 等路由类型；
  调用方（`apps/finance-api` 中传 `enableModelRouter` / `preferMcpTools` 的组装代码）同步删除。
- `packages/agent/src/reliability.ts` 的 `chatWithReliability()`：多模型 fallback 与重试
  职责移交 `packages/ai` 的 `retryProviderRequest` 与 run 层模型选择（见 02 文档）。
- `packages/tools/src/executor.ts` 中 `allowedTools` 权限门与
  `approval-repository.ts`（approval 体系删除详见 05 文档）；executor 的
  超时/重试/deadline/zod 校验语义迁移为 `AgentTool.execute` 的内部包装后，原文件删除。
- trace 事件类型 `intent_routed`、`request_received`（路由专属）随路由删除；
  `agent_step` 系列事件由 `AgentEvent`（`turn_*` / `tool_execution_*`）取代，
  trace 持久化落库见 05 文档，旧事件→新事件映射表见 06 文档。

## 验证

- `pnpm typecheck && pnpm build`。
- 新增 loop 单测（对齐 pi 行为）：无 toolCall 单轮结束；toolCall → ToolResult 回喂 →
  二轮停止；parallel 批执行顺序与 sequential 降级；`length` 整批拒执；`isError` 回喂；
  `shouldStopAfterTurn` 停；steering/follow-up 注入；abort 传播。
- compaction 单测：usage 优先估算、阈值触发、线性表重建上下文（最后一条 compaction
  + first_kept 之后的消息）。
- eval（`packages/eval`）回归：典型金融问答与研究流在无规则路由下仍命中预期工具。
