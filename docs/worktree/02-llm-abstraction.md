# 02 LLM 抽象层：packages/ai 移植方案

> 本文定义新建 `packages/ai`（对齐 pi-ai，`badlogic/packages/ai`，包名 `@earendil-works/pi-ai`）的移植范围、分层与接口设计。引用符号均已对照真实代码核实。与全套文档一致的决策：内部命名与 pi 保持一致（`Message`/`stream`/`streamSimple`/`AssistantMessageEvent`/`EventStream` 等）；工具 schema 仍用 zod（本层不涉及，`AgentTool` 见 03 文档）；接受完全不兼容改造，旧 LLM 栈整体删除。

## 现状

本项目当前没有独立的 LLM 抽象层，LLM 调用是一套手写的「OpenAI-compatible chat completions 客户端」，散落在两个包：

- `packages/types/src/llm.ts`：公共接口包。`LlmClient`（第 105 行）暴露四种调用形态：`chat` / `streamChat` / `jsonChat` / `toolChat`；消息模型是平铺的 `LlmMessage{role, content: string}`（第 3 行），`content` 只能是字符串，无 thinking/image/toolCall 块概念；流式事件 `LlmStreamEvent`（第 97 行）只有 `content_delta` / `tool_call_delta` / `done` 三种；`Usage` 仅有 prompt/completion/total 三个 token 字段。`LlmClient` 被 UI/API 直接依赖，LLM 类型泄漏在整个项目里。
- `packages/agent/src/llm-client.ts`：`createLlmClient()`（第 24 行），组装 `llm/` 子模块。
- `packages/agent/src/llm/` 子模块：`config.ts`（超时/默认 baseUrl/Kimi 常量）、`transport.ts`（`requestChatCompletion`，手写 fetch + AbortSignal 超时）、`parsing.ts`（`parseChatResponse` / `parseSseStream` / `parseJsonObject`，手写 SSE 解析）、`mapping.ts`（`mapMessage` 把 `LlmMessage` 映射为 OpenAI 形状）、`tracing.ts`（`traceModelCall` 埋点包装）、`env.ts`（按 profile 从环境变量构造 client）、`utils.ts`。
- `packages/agent/src/reliability.ts`：`chatWithReliability()`（第 25 行），在 `LlmClient` 之上做多模型 fallback + 指数退避重试，与单 provider 内的重试职责混在一起。
- `apps/api/src/application/model-registry.ts`：`createModelRuntimeRegistry()`（第 25 行），把 `ModelOptionDto` 与创建好的 `LlmClient` 绑定成 `Map`，向 HTTP 层提供 `catalog()` / `resolve(modelId)`。

现状的核心缺陷：只支持 OpenAI-compatible 一种协议；消息无内容块结构，thinking 无法表达与回传；流式协议太薄（无 text/thinking/toolcall 的 start/end 边界，UI 无法渲染思考过程）；重试、fallback、超时分散在 client、reliability、transport 三处；`LlmClient` 接口放在 `types` 包导致 UI 直接耦合 LLM 形状。

## pi 参照

pi-ai 是纯 LLM 层，不感知 agent，结构分两层（协议 adapter + provider/模型目录）加一套统一流式协议。

### 统一中间表示（`src/types.ts`）

- **Message 三元组**（第 393–432 行）：`UserMessage{role:"user", content: string | (TextContent|ImageContent)[]}`、`AssistantMessage{role:"assistant", content: (TextContent|ThinkingContent|ToolCall)[], api, provider, model, usage, stopReason, errorMessage?, timestamp}`、`ToolResultMessage{role:"toolResult", toolCallId, toolName, content, isError, details?, timestamp}`。
- **内容块**（第 338–366 行）：`TextContent`、`ThinkingContent`、`ImageContent`（base64）、`ToolCall{id, name, arguments}`。关键是**provider 签名字段透传**：`TextContent.textSignature`、`ThinkingContent.thinkingSignature`（+ `redacted` 标记安全过滤的加密块）、`ToolCall.thoughtSignature`（Google 专用）——历史消息回传时原样放回请求，保证多轮思考的 API 连续性。
- `Usage`（第 368 行）：`input/output/cacheRead/cacheWrite/reasoning?/totalTokens` + 分项 `cost`。
- `StopReason`（第 391 行）：`"pending" | "stop" | "length" | "toolUse" | "error" | "aborted"`。
- `Context`（第 486 行）：`{systemPrompt?, messages, tools?}`；`Tool<TParameters extends TSchema>`（第 479 行，typebox 参数——本项目改为 zod，差异在 03 文档处理）。
- `Model<TApi>`（第 758 行）：`{id, name, api, provider, baseUrl, reasoning, input: ("text"|"image")[], cost, contextWindow, maxTokens, headers?, compat?}`，`compat` 按 api 类型条件映射到对应的 compat 接口。

### api/ 协议 adapter 层（`src/api/`）

每个 wire 协议一个模块，统一契约：导出 `stream` 和 `streamSimple` 两个 `StreamFunction`，模块本身满足 `ProviderStreams` 接口（`src/types.ts:236`）。错误不抛出，而是编码进事件流（`stopReason: "error" | "aborted"` + `errorMessage`，见 `StreamFunction` 契约注释，第 312–324 行）。

以 `src/api/anthropic-messages.ts`（1350 行）为例：

- `AnthropicOptions extends StreamOptions`（第 202 行）：协议特有选项（`thinkingEnabled`、`thinkingBudgetTokens`、`effort`、`interleavedThinking` 等）。
- `stream`（第 487 行）：创建 `AssistantMessageEventStream`，初始化一个 `stopReason: "pending"`、全零 usage 的 `AssistantMessage`，随后把 SDK 的 SSE 事件翻译成 `text_*` / `thinking_*` / `toolcall_*` 事件推入流，每个事件都携带当前累积的完整 partial message；流末尾校验 `sawMessageStart && !sawMessageEnd` 则补错误。
- `streamSimple`（第 800 行）：用 `buildBaseOptions()` 合并公共选项；无 reasoning 时直接调 `stream({thinkingEnabled: false})`；有 reasoning 时按 `model.compat?.forceAdaptiveThinking` 走 effort 或 budget 分支，经 `adjustMaxTokensForThinking()` 算出 `maxTokens` 与 `thinkingBudgetTokens` 再调 `stream`。

`streamSimple` 的公共 helper 在 `src/api/simple-options.ts`：`buildBaseOptions()`（第 21 行）、`clampMaxTokensToContext()`（第 15 行，预留 4096 安全 token）、`clampReasoning()`（第 48 行，xhigh/max 降到 high）、`adjustMaxTokensForThinking()`（第 52 行，默认 budget minimal=1024 / low=2048 / medium=8192 / high=16384）。

### provider/ 模型目录层与 compat 标志

- `Model.compat` 是**按协议类型条件化**的兼容覆盖集（`src/types.ts:518–645`）：`OpenAICompletionsCompat`（`supportsDeveloperRole`、`maxTokensField`、`requiresThinkingAsText`、`thinkingFormat: "openai"|"openrouter"|"deepseek"|...` 等约 20 个标志）、`AnthropicMessagesCompat`（`supportsEagerToolInputStreaming`、`forceAdaptiveThinking`、`allowEmptySignature` 等）、`OpenAIResponsesCompat`、`BedrockCompat`。默认值多数为「按 baseUrl 自动探测」，显式设置可覆盖。
- `src/models.ts`：`Provider<TApi>`（第 75 行）持有 `id/name/baseUrl/auth/getModels()/stream()/streamSimple()`；`Models`（第 127 行）是 provider 集合 + 凭据解析；`createProvider()`（第 556 行）、`calculateCost()`（第 639 行）、`getSupportedThinkingLevels()`（第 663 行）等工具函数。
- `src/compat.ts`：全局便捷入口 `stream()` / `streamSimple()`，按 `model.api` 分发到内置 adapter（本项目不采用其懒加载 `lazyApi()` 机制，见取舍）。

### 统一流式协议

- `AssistantMessageEvent`（`src/types.ts:500`）：`start` → `text_start/delta/end` → `thinking_start/delta/end` → `toolcall_start/delta/end` → `done{reason, message}` 或 `error{reason, error}`。**每个事件都携带完整 partial `AssistantMessage`**（`contentIndex` 定位当前块），消费者无需自己拼装增量。
- `EventStream<T, R>`（`src/utils/event-stream.ts:4`）：push 式异步迭代器，内部队列 + waiting 双模式，`result(): Promise<R>` 在 `done`/`error` 事件时 resolve 出最终 message；`AssistantMessageEventStream`（第 69 行）是其特化。
- `parseStreamingJson()`（`src/utils/json-parse.ts:104`）：流式 toolCall 参数的三级容错解析——直接 parse → `partialParse` → `repairJson` 后 `partialParse`，永不抛错，失败返回 `{}`。
- `retryProviderRequest()`（`src/utils/provider-retry.ts`）：复刻 OpenAI/Anthropic SDK 的重试策略——`x-should-retry` 头优先，否则 408/409/429/5xx 可重试；优先 `retry-after-ms` / `retry-after` 头，否则指数退避 `0.5*2^n` 秒封顶 8 秒、25% 负抖动；服务端要求超过 `maxRetryDelayMs`（默认 60s）立即失败交由上层；sleep 可被 AbortSignal 打断。SDK 需以 `maxRetries: 0` 调用，重试统一收在这一个函数里。

## 目标设计

新建 `packages/ai`，目录：

```
packages/ai/src/
├── types.ts                    # Message/Content/Usage/Context/Model/Event 等全部公共类型
├── api/
│   ├── anthropic-messages.ts   # Anthropic Messages 协议
│   ├── openai-completions.ts   # OpenAI chat completions 协议（覆盖 OpenAI/Kimi/DeepSeek 等兼容服务）
│   ├── google-generative-ai.ts # Google Gemini 协议
│   └── simple-options.ts       # buildBaseOptions/clampMaxTokensToContext/adjustMaxTokensForThinking
├── providers/
│   ├── registry.ts             # Provider 接口、Models 注册表、按 api 分发
│   └── catalog.ts              # 内置模型目录（首批少量手写，不生成）
├── utils/
│   ├── event-stream.ts         # EventStream / AssistantMessageEventStream
│   ├── json-parse.ts           # parseStreamingJson
│   └── provider-retry.ts       # retryProviderRequest
└── index.ts                    # barrel re-export
```

### 关键类型（移植 `src/types.ts`，字段级一致）

```ts
/** 统一中间表示的消息三元组；AssistantMessage 携带 api/provider/model/usage/stopReason，可独立落库 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface TextContent {
  type: "text";
  text: string;
  /** provider 签名字段透传：历史回放时原样放回（如 OpenAI responses 的消息元数据） */
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  /** 被安全过滤的加密思考块，签名透传保证多轮连续性 */
  redacted?: boolean;
}

export interface ImageContent { type: "image"; data: string; mimeType: string; }

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Google 专用思考签名，回放时透传 */
  thoughtSignature?: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: ProviderId;
  model: string;
  usage: Usage;
  stopReason: StopReason; // "pending" | "stop" | "length" | "toolUse" | "error" | "aborted"
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage<TDetails = unknown> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails; // 工具侧结构化结果（引用、行数等），不进 LLM 上下文
  isError: boolean;
  timestamp: number;
}
```

裁剪说明：pi 的 `KnownProvider`（40+ 个）、images API（`ImagesModel`/`ProviderImages`）、`OpenRouterRouting`/`VercelGatewayRouting`、OAuth 相关不移植；`KnownApi` 只保留 `"anthropic-messages" | "openai-completions" | "google-generative-ai"`。`Usage.cost` 保留但由 `providers/catalog.ts` 的静态费率计算，首期可全 0。

### 两层设计：api/ adapter + provider/ 目录

```ts
/** 协议 adapter 的统一契约：api/ 下每个模块导出这两个函数即满足本接口 */
export interface ProviderStreams {
  stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/** provider 无关的统一入口（对应 pi 的 compat.ts），按 model.api 查表分发 */
export function stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
export function streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;

/** 模型目录条目；compat 按 api 条件化，承接各 provider 的协议怪癖 */
export interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: ProviderId;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap; // pi thinking 档位 → 该模型实际参数值；null 表示不支持
  input: ("text" | "image")[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: TApi extends "openai-completions" ? OpenAICompletionsCompat
    : TApi extends "anthropic-messages" ? AnthropicMessagesCompat
    : never; // google-generative-ai 首期无 compat
}
```

首批 compat 只移植用得上的子集：`OpenAICompletionsCompat` 保留 `supportsDeveloperRole` / `supportsReasoningEffort` / `supportsUsageInStreaming` / `maxTokensField` / `requiresThinkingAsText` / `thinkingFormat`（保留 `"openai" | "deepseek" | "qwen"` 三档即可）；`AnthropicMessagesCompat` 保留 `forceAdaptiveThinking` / `supportsTemperature` / `supportsLongCacheRetention`。其余标志等接入真实 provider 再补。不做 baseUrl 自动探测——模型目录显式声明，少一类隐性行为。

### 流式协议与重试

- `AssistantMessageEvent` / `EventStream` / `AssistantMessageEventStream` 原样移植（`src/types.ts:500`、`src/utils/event-stream.ts`），包括 `result()` 语义。
- `parseStreamingJson` 原样移植（`src/utils/json-parse.ts:104`），`partialParse`/`repairJson` 一并带上。
- `streamSimple` 的 thinking 档位：`ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`；`SimpleStreamOptions extends StreamOptions { reasoning?: ThinkingLevel; thinkingBudgets?: ThinkingBudgets }`；`simple-options.ts` 四个 helper 原样移植。
- `retryProviderRequest` 原样移植（`src/utils/provider-retry.ts`），三个 adapter 内部统一用它包裹 HTTP 请求；**跨模型 fallback 不进本层**，agent 层需要时在其 `prepareNextTurn` 钩子里自行换 model 重跑（见 03 文档）。
- 超时：`StreamOptions.timeoutMs` 由 adapter 内 fetch 实现，默认 10 分钟对齐 pi；agent 层 deadline 通过 `signal` 传入。

### 本项目映射

| 现状 | 去向 |
| --- | --- |
| `packages/types/src/llm.ts`（`LlmClient` 及全部请求/响应类型） | 删除，由 `packages/ai` 的 `Message`/`Context`/`stream` 取代；types 包不再含 LLM 形状 |
| `packages/agent/src/llm-client.ts` + `llm/`（config/transport/parsing/mapping/tracing/env/utils） | 删除。tracing 职责由 agent 层消费 `AssistantMessageEvent` 后写 trace 事件取代；env/profile 解析收敛到 apps/api 组装处 |
| `packages/agent/src/reliability.ts` | 删除。provider 内重试由 `retryProviderRequest` 承担；多模型 fallback 若保留，重写为 agent 层逻辑 |
| `apps/api/src/application/model-registry.ts` | 迁移重写：`ModelRuntimeRegistry` 改为持有 `Model<Api>` 目录 + apiKey 解析（`resolve(modelId): Model \| undefined`），catalog DTO 从 `Model` 派生；client 创建概念消失（stream 是无状态函数，apiKey 走 `StreamOptions.apiKey`） |

## 取舍论证

- **为什么不保留 `LlmClient` 外观做渐进迁移**：`LlmClient` 的四种调用形态（chat/jsonChat/toolChat/streamChat）本质上是在弥补消息模型太薄的问题（无内容块、无工具结果消息）。pi 模型下这些全部归约为 `stream(model, context)` 一次调用 + `Context` 组装。接受不兼容改造已确认，直接切换比分阶段适配省一层翻译代码。
- **api/ 与 provider/ 分两层而非按 provider 一个文件**：同一协议（openai-completions）覆盖多个服务（OpenAI/Kimi/DeepSeek），差异收敛为 `Model.compat` 数据而非分支代码。新增一个 OpenAI 兼容服务 = 目录加一行，不写新代码。
- **不移植 lazy/生成目录/OAuth**：`.lazy.ts` 懒加载是为 CLI 启动速度，本项目是长驻 server 无收益；`models.generated.ts` 生成管线首期用手写小目录即可；OAuth 只服务 pi 的订阅登录场景，本项目走服务端 apiKey。
- **fallback 不放 LLM 层**：pi 把单请求重试放在 provider 内（`retryProviderRequest`），跨模型选择留给上层——这与本项目「删除 reliability.ts 混合职责」的目标一致，且让 run 级 trace 能看清每次换模型的决策。
- **签名字段透传值得保留**：`textSignature`/`thinkingSignature`/`thoughtSignature` 看起来是 provider 细节泄漏，实际是「多轮思考连续性」的唯一可靠载体（Anthropic/Google 都要求回放签名），丢掉会导致切换 provider 或重放历史时思考链断裂。

## 删除清单

- `packages/types/src/llm.ts` 整文件（`LlmClient`、`LlmMessage`、`LlmChatRequest/Response`、`LlmStreamEvent`、`LlmError/LlmResult` 中的 LLM 部分；`LlmResult` 若被其他域复用则保留并改名去 LLM 化）。
- `packages/agent/src/llm-client.ts`（227 行）整文件。
- `packages/agent/src/llm/` 整目录：`config.ts`、`transport.ts`、`parsing.ts`、`mapping.ts`、`tracing.ts`、`env.ts`、`utils.ts`、`index.ts`。
- `packages/agent/src/reliability.ts`（86 行）整文件（多模型 fallback 若保留则在 agent 层重写，见 03 文档）。
- `apps/api/src/application/model-registry.ts`：现有实现推翻重写（保留「目录 + resolve」职责，数据模型换成 `Model<Api>`）。
- 引用方同步清理：`apps/api/src/http/routes/models.ts`、`apps/api/src/server.ts` 中对 `LlmClient` 的依赖；`packages/agent/src/index.ts` 的旧导出。
