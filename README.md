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
- `packages/workflow`：通用顺序 workflow runtime，负责节点 schema 校验、状态流转、max steps、结构化错误和节点 trace。
- `packages/report`：研报领域节点边界，负责 mock Data Collector、Analyzer、Risk Checker、Citation Verifier、Report Writer 和 PDF Exporter 占位。
- `packages/tools`：工具注册与工具调用边界，后续承载外部数据和函数工具。
- `packages/trace`：运行轨迹边界，后续承载事件记录、时间线和调试视图。

`packages/*` 作为独立 workspace package 构建和类型检查。`apps/web` 保持前端应用边界，不直接依赖 `agent`、`tools`、`trace` 这些核心运行时包；当前通过 `apps/api` 接入 Agent。

设计文档拆分为两层：根目录 `DESIGN.md` 是通用 Meridian 视觉系统，定义设计 token、组件视觉语言和 AI 前端生成约束；`system.css` 是对应的 CSS token / utility 参考实现；`docs/IMMERSIVE_PRODUCT_DESIGN.md` 承载 Immersive 金融研究 Agent 的产品体验、信息架构和页面模块。

## Immersive Playground

Immersive Playground 已从 Week 1 最小 Chat 形态演进到 Week 3 Report Skill Planner：

- 页面采用 Agent Chat 布局：左侧本地会话列表，中间对话流，底部 composer，顶部提供 Report Mode 开关和生成研报按钮。
- 每次提交调用 `POST /api/agent/run`，请求体为 `AgentRunRequestDto`：`message`、`reportMode`、可选 `reportTriggerSource` 和可选 `conversationId`。
- API 返回 `ApiResult<AgentRunResponseDto>`，包含 `answer`、`intent`、`steps`、`trace`、`requestId`、可选 `reportPlan` 和结构化错误。
- run state、工具调用和 trace 作为 assistant 消息内的可展开派生内容展示，不再使用独立右侧调试栏。
- `reportMode`、生成研报按钮和自然语言报告/PDF 请求会进入同一个 Report Skill activation 边界，生成结构化 `ReportPlanDto`。Agent Chat 当前只返回 plan；package 层已经提供可独立测试的 mock Report Workflow runtime。

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

Week 2 新增三个 RAG 相关 package，当前已具备 Markdown/TXT 公告 ingestion 入口、RAG 基础边界、纯函数 chunk 策略、deterministic mock embedding、内存向量库、hybrid retrieval 和 deterministic heuristic rerank；暂不接入真实 PDF 解析、真实 embedding provider、Qdrant/pgvector、cross-encoder、LLM rerank 或 Agent Chat：

- `@aiagent/filings`：保存公告/财报文件来源、document metadata、原始文本来源和 ingestion pipeline。`ingestFiling()` 支持 Markdown 与 TXT 解析，输出 `IngestedFilingDocument` 和带 `heading`、`lineStart`、`lineEnd` 的 blocks；PDF 当前返回 `pdf_parser_not_configured` 结构化错误，不静默生成文档。
- `@aiagent/rag`：保存 `RagDocument`、`RagChunk`、`EmbeddedChunk`、`Citation`、`RetrievalResult`、`RagAnswer`、embedding/vector store/retriever/reranker 抽象和结构化错误类型，并导出 `chunkText()`、`chunkDocumentBlocks()`、`chunkIngestedFilingDocument()`、`createDeterministicMockEmbeddingClient()`、`createInMemoryVectorStore()`、`createHybridRetriever()` 和 `createHeuristicReranker()` 等入口。
- `@aiagent/eval`：保存 `EvalCase`、`EvalMetric`、`EvalResult`、`RagEvalMetrics`、`RagEvalReport`，并导出 `runRagEval()` runner、`createRagEvalReport()` 报告生成、`computeRagMetrics()` 指标计算、`RAG_EVAL_CASES` 30 条评测用例、`DEMO_DOCUMENTS` demo 文档和 `createDemoRagRuntime()` 预加载 runtime。

跨 API 边界会复用的 DTO 放在 `packages/types`，包括 filing source/document、ingested filing document/block、RAG document/chunk/embedded chunk/vector search match/retrieval score breakdown/citation/retrieval/answer、retrieval trace event 和 eval case/metric/result。只属于运行时 package 的抽象，例如 ingestion options、chunking options、embedding client、vector store、retriever、reranker、package summary 和 runner input，保留在对应 package 内部导出。

RAG chunk 策略当前规则：

- 默认 `DEFAULT_CHUNKING_OPTIONS` 使用 `heading_aware`，`maxChars: 1200`，`overlapChars: 150`。这个大小适合公告/财报段落检索，能保留足够上下文，同时避免后续 embedding 输入过长。
- `fixed_size` 按字符窗口切分长文本，使用 overlap 保留相邻 chunk 上下文；`overlapChars >= maxChars` 会返回 `invalid_chunking_options` 结构化错误，避免无限循环。
- `heading_aware` 优先沿用 ingestion block 的 `heading`、`lineStart`、`lineEnd`、`pageNumber` 和 block id；单个超长 block 会继续按 fixed-size 切分。
- `chunkIndex` 从 0 开始并在文档内连续；`chunkId` 稳定派生为 `${documentId}_chunk_0000` 这类形式。
- 每个 chunk 都保留 `documentId`、`source`、`page/pageNumber`、`heading`、`charStart`、`charEnd` 和 metadata，后续 citation 可以从 chunk 追溯到原始 block、行号或页码。

RAG embedding 和内存向量库当前规则：

- `EmbeddingClient` 抽象暴露 `embedTexts(texts)`，当前实现 `createDeterministicMockEmbeddingClient()` 使用规范化 token、稳定 hash 和 L2 normalize 生成固定维度向量。同一文本多次 embedding 结果完全一致，便于无网络、无 API key 的单测。
- `VectorStore` 抽象暴露 `upsertChunks(chunks)` 和 `search(queryVector, options)`。`createInMemoryVectorStore()` 用 `Map` 按 `chunkId` upsert，相同 `chunkId` 会替换旧 chunk。
- vector search 使用 cosine similarity，支持 `topK`、`documentId` 和 `source` filter。`topK` 默认 `5`，上限 `50`，避免一次返回过多结果。
- 向量维度必须一致；chunk embedding 或 query vector 维度不匹配会返回 `embedding_dimension_mismatch` 或 `vector_store_dimension_mismatch` 结构化错误，而不是向 UI 泄漏异常。
- 内存向量库只适合本地 demo 和测试，不持久化、不跨进程共享。后续接 Qdrant/pgvector 时应替换 `VectorStore` 实现；后续接 OpenAI/通义 embedding 时应替换 `EmbeddingClient` 实现。

RAG hybrid retrieval 和 rerank 当前规则：

- `Retriever` 抽象暴露 `retrieve(query, options)`，`createHybridRetriever()` 组合 `EmbeddingClient`、`VectorStore` 和调用方传入的 embedded chunks。向量召回仍走 `VectorStore`，关键词召回扫描本地 chunks，保持未来替换持久化索引的边界。
- 支持 `mode: "vector" | "keyword" | "hybrid"`。`topK` 复用向量检索默认值 `5` 和上限 `50`；`candidateLimit` 默认 `20`，并受同一上限保护。
- 第一版 keyword scoring 是轻量 BM25-like heuristic：中英文 token 匹配、query term coverage、term frequency 和 heading boost，不新增重型生产依赖。它适合小规模公告/财报 demo，后续可替换为真实 BM25 索引。
- hybrid 模式默认使用 `vectorWeight: 0.65`、`keywordWeight: 0.35`；vector-only 和 keyword-only 模式默认分别使用 1/0 与 0/1。返回结果会输出 `vectorScore`、`keywordScore`、`hybridScore`、`finalScore`、命中词、覆盖率和 heading match。
- `createHeuristicReranker()` 用 deterministic 规则重排：hybrid score、query term coverage 和 heading match；相同分数按 `chunkIndex` 和 `chunkId` 稳定排序。后续 cross-encoder 或 LLM rerank 只需实现 `Reranker` 接口。
- retrieval trace summary 只记录 `queryPreview`、mode、topK、candidateLimit、耗时、retrieved chunk ids 和 score summary，不记录完整敏感文档。`packages/trace` 也保留了 `retrieval` event 结构，方便后续 Agent timeline 写入。

可调用验证入口：

```bash
pnpm --filter @aiagent/filings test
pnpm --filter @aiagent/rag test
pnpm --filter @aiagent/eval test
pnpm typecheck
pnpm test
pnpm build
```

## Week 2 Citation Answer And Data Sources

Week 2-013 已把 RAG ingestion、chunk、retrieval 和 citation answer 接入 HTTP API 与 Web 页面，形成最小可演示的 Data Sources 工作区：

- `packages/rag` 新增 `createDataSourceRuntime()`，在一个 Node.js 进程内保存 documents、chunks 和 embedded chunks，并组合 `@aiagent/filings` ingestion、heading-aware chunking、deterministic mock embedding、内存 vector store、hybrid retriever 和 grounded answer policy。
- `apps/api` 新增 `POST /api/data-sources/ingest`、`GET /api/data-sources/documents`、`GET /api/data-sources/chunks`、`POST /api/rag/search`、`POST /api/rag/answer`。Route handler 只做 zod 校验、调用 RAG runtime、DTO 映射和 `ApiResult` 结构化响应。
- `packages/types` 新增 Data Sources/RAG API DTO，并扩展 `CitationDto`：每条 citation 包含 `chunkId`、`documentId`、`source`、`heading`、`chunkIndex`、`quote` 和 `confidence`，可以从 answer 追溯到原始文档、来源、章节和 chunk 顺序。
- `apps/web` 左侧工作区导航新增 Data Sources 页面。页面通过 HTTP API 展示粘贴/上传文本、document list、chunk list、retrieval results、answer 和 citations；前端不直接依赖 RAG runtime。
- unknown answer policy：answer synthesis 只使用召回结果中命中有信息量术语的 chunks。证据不足时仍返回 `ok: true`，但 answer 明确说明当前资料不足，不编造结论。

当前 runtime 限制：

- 只支持 Markdown/TXT demo 文档；PDF 仍返回结构化未配置错误。
- 内存状态只存在于当前 API 进程，不持久化、不跨进程共享、不做多用户隔离。
- answer synthesis 是 deterministic heuristic 摘要，不调用真实 LLM；后续可在同一 RAG 边界内替换为带 context packing 的模型生成。

API 验证：

```bash
curl -X POST http://localhost:3001/api/data-sources/ingest \
  -H "content-type: application/json" \
  -d '{"source":"demo","fileName":"annual-report.md","content":"# 资产质量\n公司不良率保持稳定。"}'

curl -X GET http://localhost:3001/api/data-sources/documents

curl -X GET http://localhost:3001/api/data-sources/chunks

curl -X POST http://localhost:3001/api/rag/search \
  -H "content-type: application/json" \
  -d '{"query":"资产质量","topK":5}'

curl -X POST http://localhost:3001/api/rag/answer \
  -H "content-type: application/json" \
  -d '{"question":"公司资产质量如何？","topK":5}'
```

## Week 2 RAG Eval And Report

Week 2-014 完成 RAG eval 闭环：30 条 QA case、eval runner、四个指标、报告输出和失败案例分析。

- **评测用例**：`packages/eval/src/cases.ts` 的 `RAG_EVAL_CASES` 包含 30 条 case，覆盖 4 份 demo 文档（平安银行年报、宁德时代三季报、招商银行资产质量公告、新能源汽车行业研究）。
- **评测入口**：`pnpm --filter @aiagent/eval test` 会自动 ingest demo 文档、运行 runner、输出报告。
- **四个指标**：
  - `retrievalHitRate`：期望 source 是否进入 topK。
  - `answerCorrectness`：答案是否覆盖 `expectedKeywords`。
  - `faithfulness`：答案词元是否被 citation quotes 支撑。
  - `citationCoverage`：citation 数量是否达到 `minCitations`，以及答案词元是否被 retrieval results 覆盖。
- **失败案例**：报告固定输出前 3 个失败 case，包含 question、answer、retrieved chunk ids、citation chunk ids、失败指标和分析。
- **当前结果示例**（实际以运行输出为准）：

```text
{
  totalCases: 30,
  passedCases: 16,
  failedCases: 14,
  passRate: 0.533,
  retrievalHitRate: 1,
  answerCorrectness: 0.583,
  faithfulness: 0.496,
  citationCoverage: 0.513
}
```

- **说明文档**：详细指标解释、失败案例分析和优化建议见 ``。

## Notes And Learning Logs

`notes/` 是阶段技术学习笔记目录，用来记录每个阶段的技术重点、核心概念、实现脉络、关键权衡和学习检查点。实现任务如果在 task card、weekly plan 或 roadmap 中列出 `notes/*.md`，需要在同一任务里创建或更新对应文件。涉及 agent、tools、RAG、eval、workflow、report、trace 或公共 API 的功能改动，需要同步维护对应周的 note，让后续复习时能从“为什么这样设计”理解 Agent 项目。

## Agent Loop

`packages/agent` 现在导出最小 Agent API：`createAgent(config)`、`runAgent(request, config)`、`createIntentRouter()`、`routeIntent()`、`createReportActivation()`、`createReportPlan()` 和 `isNaturalLanguageReportRequest()`。核心公开类型包括 `AgentRequest`、`AgentResponse`、`AgentIntent`、`AgentStep`、`AgentError` 和 `AgentRoute`。

Intent Router 第一版采用可审查规则优先：

- 自然语言 report skill 触发不只看单一关键词，必须同时具备报告交付诉求和数据需求信号，例如 ticker、公告、财务数据、年报或风险等。
- 显式 `reportMode` 开关会以 `toggle` 来源进入 `report_skill`；Web 生成研报按钮会以 `button` 来源进入同一 activation 边界；自然语言触发来源为 `natural_language`。
- 年报、公告、披露、检索、资产质量等公告文本诉求路由到 `filing_search_mock`。
- 营收、净利润、ROE、毛利率、现金流、最近一期、同比等财务指标查询路由到 `financial_metric_mock`。
- “解释 ROE 是什么”这类概念问题保留在 `chat` 路径，不调用工具。
- report 和 tool 同时命中时，优先进入 report skill planner，因为用户表达的是研报交付，而不是一次性数据查询。

Report Planner 第一版是 deterministic planner，不调用真实 Workflow。公共 DTO 包括 `ReportTriggerSourceDto`、`ReportPlanStatusDto`、`ReportTypeDto`、`ReportPlannerInputDto`、`ReportPlanStepDto` 和 `ReportPlanDto`。Planner 会识别报告类型、研究对象、时间范围和数据需求；信息不足时返回 `needs_clarification` 或 `partial`，信息足够时返回 `ready`，并把默认时间范围等选择写入 `assumptions`。

Agent Loop 每一步都会返回结构化 `AgentStep`：`route_intent`、`model_answer`、`select_tool`、`call_tool`、`report_skill_activation`、`report_skill_plan`、`final_response` 或 `max_steps_exceeded`。`maxSteps` 在每个步骤前检查，达到上限时返回用户可理解的 `max_steps_exceeded`，不会无限等待或抛出原始异常。

工具路径只通过 `ToolRegistry.execute()` 调用工具，不直接依赖工具实现。工具参数错误、工具不存在、工具执行错误会以 `validation_error`、`tool_not_found`、`execution_error` 等结构化 `AgentError` 返回，同时保留底层 `toolError` details。

`@aiagent/trace` 的事件类型扩展为 `request_received`、`intent_routed`、`agent_step`、`retrieval`、`report_skill_activation`、`report_plan`、`workflow_node`、`model_call`、`tool_call` 和 `final_response`。Report trace 会记录 trigger source、planner input、planner output 和 assumptions；workflow trace 会记录 workflow run id、node id、node type、状态、输入摘要、输出摘要、耗时和结构化错误；事件不记录 API key 或完整环境变量。

可调用验证入口：

```bash
pnpm --filter @aiagent/agent test
pnpm --filter @aiagent/tools test
```

## Report Workflow Runtime

Week 3-016 新增两个 package：

- `@aiagent/workflow`：通用顺序节点执行器。每个节点必须声明 `inputSchema` 和 `outputSchema`，runtime 在节点执行前后用 zod 校验，节点异常、输入错误、输出错误和 max steps 超限都会转换成 `WorkflowErrorDto`。
- `@aiagent/report`：研报领域 workflow 节点实现。`runReportWorkflow(plan, options)` 从 `ReportPlanDto` 创建 workflow run，依次执行 mock Data Collector、Analyzer、Risk Checker、Citation Verifier、Report Writer 和 PDF Exporter 占位节点。

Workflow DTO 放在 `packages/types`：`WorkflowRunDto`、`WorkflowNodeDto`、`WorkflowNodeStatusDto`、`WorkflowEdgeDto`、`WorkflowEventDto` 和 `WorkflowErrorDto`。第一版只实现线性节点链路，不做复杂 DAG、持久化 store、真实 PDF 生成或 MCP 工具调用。

Report Workflow 当前 mock 节点输出：

- Data Collector：生成 mock filings、financial metrics 和 evidence。
- Analyzer：生成 thesis、findings 和 evidence ids。
- Risk Checker：输出 risk level、risk items 和 passed 状态。
- Citation Verifier：把 findings 映射到 mock evidence，输出 citations 和 missing citation findings。
- Report Writer：生成 Markdown 和最小 HTML 草稿。
- PDF Exporter：返回 `placeholder` 导出结构，不生成真实 PDF。

可调用验证入口：

```bash
pnpm --filter @aiagent/workflow test
pnpm --filter @aiagent/report test
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
pnpm --filter @aiagent/workflow test
pnpm --filter @aiagent/report test
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
