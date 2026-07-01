# AI Agent Learning Workspace

这个仓库用于快速学习 AI Agent 开发，并沉淀一个可展示的 Immersive 项目、Report Mode 研报生成 Workflow、PDF 导出能力、文档和复盘。

## 推荐仓库结构

```text
.
├── docs/
│   ├── ROADMAP_1_MONTH.md
│   ├── BUSINESS_DIRECTION_FINANCIAL_RESEARCH_AGENT.md
│   ├── IMMERSIVE_PRODUCT_DESIGN.md
│   ├── implementation/
│   │   └── WEEK_1_IMPLEMENTATION.md
│   └── weeks/
│       ├── WEEK_1_AGENT_FOUNDATION.md
│       ├── WEEK_2_RAG_KNOWLEDGE_BASE.md
│       ├── WEEK_3_AGENTIC_RAG_WORKFLOW_MCP.md
│       └── WEEK_4_PRODUCTION_AND_INTERVIEW.md
├── apps/
│   ├── web/
│   │   └── src/
│   └── api/
├── packages/
│   ├── agent/
│   ├── types/
│   ├── filings/
│   ├── rag/
│   ├── tools/
│   ├── workflow/
│   ├── report/
│   ├── eval/
│   └── trace/
├── datasets/
├── notes/
│   ├── function-calling-vs-react.md
│   ├── rag-eval.md
│   ├── mcp-notes.md
│   ├── system-design.md
│   └── interview-qa.md
├── package.json
├── pnpm-workspace.yaml
├── DESIGN.md
├── system.css
└── README.md
```

## 当前工程底座

本仓库已经初始化为 pnpm workspace monorepo：

- `apps/web`：Vite + React + TypeScript Web 应用入口，负责承载 Immersive 产品界面，只通过 HTTP API 调用 Agent。
- `apps/api`：Fastify HTTP adapter，当前暴露 `POST /api/agent/run` 和 `/health`，负责请求校验、DTO 映射和结构化响应。
- `packages/agent`：Agent 能力边界，后续承载意图识别、循环调度和模型交互。
- `packages/types`：前后端共享类型边界，承载 API contract、DTO、结构化错误和稳定枚举。
- `packages/filings`：公告/财报 ingestion 边界，负责文件来源、document metadata 和原始文本来源信息。
- `packages/rag`：RAG 运行时边界，负责 chunking、embedding 抽象、检索、引用和 grounded answer 的稳定类型入口。
- `packages/eval`：RAG 评测边界，负责 eval case、metrics、runner 输入和报告输出结构。
- `packages/tools`：工具注册与工具调用边界，后续承载外部数据和函数工具。
- `packages/trace`：运行轨迹边界，后续承载事件记录、时间线和调试视图。

`packages/*` 作为独立 workspace package 构建和类型检查。`apps/web` 保持前端应用边界，不直接依赖 `agent`、`tools`、`trace` 这些核心运行时包；当前通过 `apps/api` 接入 Agent。

设计文档拆分为两层：根目录 `DESIGN.md` 是通用 Meridian 视觉系统，定义设计 token、组件视觉语言和 AI 前端生成约束；`system.css` 是对应的 CSS token / utility 参考实现；`docs/IMMERSIVE_PRODUCT_DESIGN.md` 承载 Immersive 金融研究 Agent 的产品体验、信息架构和页面模块。

## Immersive Playground

Week 1 已实现最小可演示的 Immersive Playground：

- 页面采用 Agent Chat 布局：左侧本地会话列表，中间对话流，底部 composer 和 Report Mode 占位开关。
- 每次提交调用 `POST /api/agent/run`，请求体为 `AgentRunRequestDto`：`message`、`reportMode`、可选 `conversationId`。
- API 返回 `ApiResult<AgentRunResponseDto>`，包含 `answer`、`intent`、`steps`、`trace`、`requestId` 和结构化错误。
- run state、工具调用和 trace 作为 assistant 消息内的可展开派生内容展示，不再使用独立右侧调试栏。
- `reportMode` 在 Week 1 只作为 UI 和 API 占位信号；自然语言报告/PDF 请求会被 Intent Router 识别为 `report_skill` 并返回占位结果，不启动完整 Workflow。

本地 API 验证：

```bash
curl -X POST http://localhost:3001/api/agent/run \
  -H "content-type: application/json" \
  -d '{"message":"帮我查询 000001.SZ 最近一期净利润和 ROE。","reportMode":false}'
```

## LLM Client

`packages/agent` 导出统一 LLM Client，当前支持 OpenAI compatible `/chat/completions`。公开 contract 放在 `packages/types/src/llm.ts`，实现放在 `packages/agent/src/llm-client.ts`，`packages/agent/src/index.ts` 只保留 package 入口导出。

- `createLlmClient(config)`：通过显式配置创建 client。
- `createLlmClientFromEnv(env)`：从环境变量创建 client。
- `chat()`：普通聊天调用。
- `streamChat()`：SSE streaming chat 初版，返回 `AsyncIterable` 事件。
- `jsonChat()`：解析模型 JSON 输出，解析失败返回结构化 `json_parse_error`。
- `toolChat()`：发送 function tool schema，并返回规范化后的工具名和参数。

环境变量：

```bash
AIAGENT_LLM_API_KEY=...
AIAGENT_LLM_BASE_URL=https://api.openai.com/v1
AIAGENT_LLM_MODEL=...
AIAGENT_LLM_TIMEOUT_MS=30000
```

兼容 fallback：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`。调用方只依赖 `LlmResult<T>` 结构化结果，不需要处理底层 HTTP 异常。

可调用验证入口：

```bash
pnpm --filter @aiagent/agent test
```

测试使用 mock provider 覆盖普通 chat、JSON 输出和 tool call，不需要真实 API key。

## Tools Infrastructure

`packages/tools` 导出统一工具基础设施，当前实现 Week 1 的稳定 mock tools：`calculator`、`market_data_mock`、`filing_search_mock`、`financial_metric_mock`。

- `Tool<TInput, TOutput>`：每个工具必须声明 `inputSchema`、`outputSchema` 和 `execute()`。
- `ToolRegistry`：支持按名称注册、查找、列出和执行工具。
- `createDefaultToolRegistry()`：返回已注册首批四个 mock tools 的 registry。
- `executeTool()` / `registry.execute()`：执行前用 zod 校验参数，执行后校验输出，并把异常转换为 `ToolExecutionResult` 结构化失败。

源码按职责拆分在 `packages/tools/src`：`types.ts` 保存公共 contract，`registry.ts` 保存注册表，`executor.ts` 保存执行与 trace 写入，`default-registry.ts` 组合默认 mock tools，`tools/*.ts` 按工具名分别保存 schema 和实现。`index.ts` 只作为 package 入口导出公共 API。

工具执行可注入 `@aiagent/trace` 的 `TraceRecorder`。每次调用会写入 `tool_call` 事件，包含工具名、参数、结果、耗时和结构化错误；trace 写入失败不会打断工具主流程。

可调用验证入口：

```bash
pnpm --filter @aiagent/tools test
```

该测试覆盖四个 mock tools、缺失 `ticker` 的 zod 参数错误、非法 calculator 表达式和 trace 写入。

## Week 2 RAG Package Foundation

Week 2 新增三个 RAG 相关 package，当前已具备 Markdown/TXT 公告 ingestion 入口、RAG 基础边界和纯函数 chunk 策略；暂不接入真实 PDF 解析、embedding provider、向量库或 Agent Chat：

- `@aiagent/filings`：保存公告/财报文件来源、document metadata、原始文本来源和 ingestion pipeline。`ingestFiling()` 支持 Markdown 与 TXT 解析，输出 `IngestedFilingDocument` 和带 `heading`、`lineStart`、`lineEnd` 的 blocks；PDF 当前返回 `pdf_parser_not_configured` 结构化错误，不静默生成文档。
- `@aiagent/rag`：保存 `RagDocument`、`RagChunk`、`Citation`、`RetrievalResult`、`RagAnswer`、embedding 输入输出和结构化错误类型，并导出 `chunkText()`、`chunkDocumentBlocks()`、`chunkIngestedFilingDocument()` 三个纯函数 chunk 入口。
- `@aiagent/eval`：保存 `EvalCase`、`EvalMetric`、`EvalResult`、runner 输入和评测结构化错误类型。

跨 API 边界会复用的 DTO 放在 `packages/types`，包括 filing source/document、ingested filing document/block、RAG document/chunk/citation/retrieval/answer 和 eval case/metric/result。只属于运行时 package 的抽象，例如 ingestion options、chunking options、embedding result、package summary 和 runner input，保留在对应 package 内部导出。

RAG chunk 策略当前规则：

- 默认 `DEFAULT_CHUNKING_OPTIONS` 使用 `heading_aware`，`maxChars: 1200`，`overlapChars: 150`。这个大小适合公告/财报段落检索，能保留足够上下文，同时避免后续 embedding 输入过长。
- `fixed_size` 按字符窗口切分长文本，使用 overlap 保留相邻 chunk 上下文；`overlapChars >= maxChars` 会返回 `invalid_chunking_options` 结构化错误，避免无限循环。
- `heading_aware` 优先沿用 ingestion block 的 `heading`、`lineStart`、`lineEnd`、`pageNumber` 和 block id；单个超长 block 会继续按 fixed-size 切分。
- `chunkIndex` 从 0 开始并在文档内连续；`chunkId` 稳定派生为 `${documentId}_chunk_0000` 这类形式。
- 每个 chunk 都保留 `documentId`、`source`、`page/pageNumber`、`heading`、`charStart`、`charEnd` 和 metadata，后续 citation 可以从 chunk 追溯到原始 block、行号或页码。

可调用验证入口：

```bash
pnpm --filter @aiagent/filings test
pnpm --filter @aiagent/rag test
pnpm --filter @aiagent/eval test
pnpm typecheck
pnpm test
pnpm build
```

## Notes And Learning Logs

`notes/` 是阶段技术学习笔记目录，用来记录每个阶段的技术重点、核心概念、实现脉络、关键权衡和学习检查点。实现任务如果在 task card、weekly plan 或 roadmap 中列出 `notes/*.md`，需要在同一任务里创建或更新对应文件。涉及 agent、tools、RAG、eval、workflow、report、trace 或公共 API 的功能改动，需要同步维护对应周的 note，让后续复习时能从“为什么这样设计”理解 Agent 项目。

## Agent Loop

`packages/agent` 现在导出 Week 1 最小 Agent API：`createAgent(config)`、`runAgent(request, config)`、`createIntentRouter()` 和 `routeIntent()`。核心公开类型包括 `AgentRequest`、`AgentResponse`、`AgentIntent`、`AgentStep`、`AgentError` 和 `AgentRoute`。

Intent Router 第一版采用可审查规则优先：

- 报告、研报、研究报告、PDF、导出、生成一份等正式交付诉求路由到 `report_skill`。
- 年报、公告、披露、检索、资产质量等公告文本诉求路由到 `filing_search_mock`。
- 营收、净利润、ROE、毛利率、现金流、最近一期、同比等财务指标查询路由到 `financial_metric_mock`。
- “解释 ROE 是什么”这类概念问题保留在 `chat` 路径，不调用工具。
- report 和 tool 同时命中时，Week 1 优先返回 report skill 占位结果，并说明完整 Report Workflow 在 Week 3 接入。

Agent Loop 每一步都会返回结构化 `AgentStep`：`route_intent`、`model_answer`、`select_tool`、`call_tool`、`report_skill_placeholder`、`final_response` 或 `max_steps_exceeded`。`maxSteps` 在每个步骤前检查，达到上限时返回用户可理解的 `max_steps_exceeded`，不会无限等待或抛出原始异常。

工具路径只通过 `ToolRegistry.execute()` 调用工具，不直接依赖工具实现。工具参数错误、工具不存在、工具执行错误会以 `validation_error`、`tool_not_found`、`execution_error` 等结构化 `AgentError` 返回，同时保留底层 `toolError` details。

`@aiagent/trace` 的事件类型扩展为 `request_received`、`intent_routed`、`agent_step`、`model_call`、`tool_call` 和 `final_response`。事件只记录输入/输出摘要、工具参数、结构化错误、耗时和 token usage，不记录 API key 或完整环境变量。

可调用验证入口：

```bash
pnpm --filter @aiagent/agent test
pnpm --filter @aiagent/tools test
```

## 技术栈约束

前端固定采用 Vite + React + TypeScript + Tailwind CSS + shadcn/ui + Radix UI，图标统一使用 lucide-react。基础 UI 组件放在 `apps/web/src/components/ui`，业务组件组合基础组件实现，避免同时引入 Ant Design、MUI、Chakra 等第二套组件体系。

后端在需要 HTTP 服务时使用 `apps/api` + Fastify。Fastify route handler 只作为 HTTP adapter：完成请求校验、调用 `packages/agent` / `packages/tools` / `packages/trace`、返回结构化响应。Agent 编排、工具执行、trace 构造等运行时逻辑不得放进 `apps/api` 或 `apps/web`。

前后端共享的请求、响应、DTO、错误码和稳定枚举统一放在 `packages/types`，由 `apps/web`、`apps/api` 和 runtime packages 通过 `@aiagent/types` 引用。不要在前端或 API route 中重复声明协议类型；包内也不要放 UI-only props、数据库私有模型或只属于单个 runtime package 的内部状态。

## 安装和启动

```bash
pnpm install
pnpm dev
```

常用验证命令：

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm --filter @aiagent/agent test
pnpm --filter @aiagent/tools test
pnpm --filter @aiagent/api test
pnpm --filter @aiagent/filings test
pnpm --filter @aiagent/rag test
pnpm --filter @aiagent/eval test
```

根目录脚本会通过 workspace 执行各应用和 package 的对应命令。`pnpm dev` 会同时启动 `apps/api` 和 `apps/web`；web 的 Vite dev server 会把 `/api` 代理到 `http://localhost:3001`。如果 `5173` 被占用，Vite 会自动选择下一个可用端口。

## 学习路线

你当前是全栈工程师，前端和 TypeScript 能力强，且已经熟练使用 AI Coding，因此主路线采用压缩版：

- 主路线：[1 个月 AI Agent 冲刺路线](docs/ROADMAP_1_MONTH.md)

这条路线默认主要使用 AI Coding 完成代码实现。你的训练重点是架构设计、任务拆解、Prompt/Tool schema、代码审查、测试验收、评估指标、trace 分析和表达，而不是手写所有代码。

最终交付物是当前仓库内的一个完整 monorepo 产品，而不是按学习阶段拆成多个项目。Web 产品放在 `apps/web`，Agent/RAG/Tool/Workflow/Report/Eval/Trace 等能力沉淀到 `packages/*`。每周的页面会渐进累积：Immersive、Data Sources、Report Workflow、Citation Checker、Eval Report，最后在 Week 4 统一包装。

Immersive 的主路径是金融研究 Chatbot：用户围绕公告、财报、行情和行业资料进行多轮问答。高级路径是 Report Mode：用户可以通过开关、按钮或自然语言请求触发 report skill，系统从普通对话升级到显式 Workflow，完成资料收集、分析、引用校验和 PDF 研报导出。

建议每周至少保留：

- 15-20 小时编码实现。
- 4-6 小时阅读官方文档、源码和优秀项目。
- 3-4 小时题整理、项目复盘和表达训练。

每个核心 package 都要保留清晰的职责边界、核心代码、测试或验收方式。最终产品 README 要保留架构图、运行方式、评估结果和失败案例。
