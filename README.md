# AI Agent Learning Workspace

这个仓库用于快速学习 AI Agent 开发，并沉淀一个可展示的 Immersive 项目、Report Mode 研报生成 Workflow、PDF 导出能力、文档和复盘。

## 推荐仓库结构

```text
.
├── docs/
│   ├── ROADMAP_1_MONTH.md
│   ├── LEARNING_AND_EVOLUTION_ROADMAP.md
│   ├── BUSINESS_DIRECTION_FINANCIAL_RESEARCH_AGENT.md
│   └── IMMERSIVE_PRODUCT_DESIGN.md
├── apps/
│   ├── web/
│   │   └── src/
│   └── api/
├── packages/
│   ├── ai/
│   ├── agent/
│   ├── identity/
│   ├── database/
│   ├── channels/
│   ├── conversation/
│   ├── types/
│   ├── parsing/
│   ├── rag/
│   ├── tools/
│   ├── workflow/
│   ├── report/
│   ├── eval/
│   ├── mcp/
│   ├── security/
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
- `apps/api`：Fastify HTTP adapter，负责请求校验、异步 Run 生命周期、SSE 事件投影和结构化响应。
- `packages/ai`：统一 LLM 抽象边界，对齐 pi-ai：`Message` 类型族、`AssistantMessageEvent`、provider 适配与 `stream` / `streamSimple`。
- `packages/agent`：ReAct Agent 循环边界，提供 `agentLoop` / `agentLoopContinue`、`AgentTool` 契约与工具执行；不再有独立的意图路由器或 LLM Client。
- `packages/identity`：浏览器指纹、稳定 `userId`、session 与 QQ 绑定规则的领域边界。
- `packages/database`：PostgreSQL 连接池、migration runner，以及 Identity、Conversation/Message、Run/RunEvent、RAG、Citation、Workflow、Artifact repository adapter（原生 `pg`，不使用 ORM）。
- `packages/conversation`：pi `Message` 与线性消息存储之间的映射层，提供 `MessageStore` port 与上下文投影。
- `packages/channels`：QQ Bot WebSocket 消息适配、命令处理和 Agent 私聊入口。
- `packages/types`：前后端共享类型边界，承载 API contract、DTO、结构化错误和稳定枚举。
- `packages/parsing`：文档解析边界，负责文件来源、document metadata 和原始文本来源信息。
- `packages/rag`：RAG 运行时边界，负责 chunking、embedding 抽象、检索、引用和 grounded answer 的稳定类型入口。
- `packages/eval`：RAG/Agent 评测边界，负责 eval case、metrics、runner 输入和报告输出结构。
- `packages/workflow`：通用顺序 workflow runtime，负责节点 schema 校验、状态流转、max steps、结构化错误和节点事件 sink。
- `packages/report`：研报领域边界，`generate_report` 工具实现、真实 PDF renderer、Workflow/Artifact repository port 与本地 ArtifactStorage port。
- `packages/tools`：内置 mock 工具注册与执行边界（calculator、financial_metric_mock、filing_search_mock 等）。
- `packages/mcp`：独立 MCP stdio server 与 client adapter，把 MCP tools 包装为 `AgentTool` 并入 loop。
- `packages/security`：prompt-injection 评估与不可信上下文封装边界。
- `packages/trace`：最小运行事件类型契约与跨边界值脱敏工具。

`packages/*` 作为独立 workspace package 构建和类型检查。`apps/web` 保持前端应用边界，不直接依赖 `agent`、`tools`、`trace` 这些核心运行时包；当前通过 `apps/api` 接入 Agent。

设计文档拆分为两层：根目录 `DESIGN.md` 是 Kimi 风格、支持明暗主题的 Workbench 视觉系统，定义 design token、组件视觉语言和 AI 前端生成约束；`system.css` 是唯一 token / utility 参考实现；`docs/IMMERSIVE_PRODUCT_DESIGN.md` 承载金融研究 Agent 的产品体验、信息架构和页面模块。代码边界和 AI Coding 约束分别见 `ARCHITECTURE.md` 与 `docs/AI_CODING.md`。

PostgreSQL 的本地连接、身份、Conversation/Message、Run/RunEvent、migration 规则、备份恢复
和 pgvector 持久化规划见 [``]()。

## Immersive Playground

Immersive Playground 已演进为带实时执行过程的研究 Workbench：

- 页面采用 Agent Chat 布局：左侧持久化会话列表，中间历史时间线与 live Run，底部 composer，顶部提供 Report Mode 开关和生成研报按钮。当前会话写入 `?conversation=<id>`，刷新后恢复选择。
- 会话 API 提供创建、稳定游标分页、终态消息读取、改标题与归档。所有 route 从 HttpOnly session 取得 `userId`，不存在与越权统一返回 `not_found`。
- 每次提交先调用 `POST /api/runs` 获得 `runId`，请求字段为 `message`、`conversationId`、稳定的 `clientMessageId`、`mode: auto | report` 和 `source: composer | report_button`；Report Mode 开关/研报按钮额外带 `metadata: { hint: "report" }`（只做 system prompt 约束，不落库），研报由模型自主调用 `generate_report` 工具完成；网络重试复用同一个 client ID，再订阅 `GET /api/runs/:runId/events`。
- `GET /api/runs/:runId` 提供 PostgreSQL 可恢复快照，`DELETE /api/runs/:runId` 取消尚未结束的运行。SSE 支持 `Last-Event-ID` 或 `afterSequence` 持久回放；最终回答作为终态事件一次提交。
- run state、工具调用和 trace 以“分类过程入口 → 最终答案”的顺序归属于对应 assistant 消息；Summary、Steps、Tools、Trace 与 Report 分别打开右侧对应类型，不混排全部详情。历史消息通过 `runId` 恢复 PostgreSQL Run 快照，刷新后仍可查看。桌面端压缩主区，移动端覆盖显示，不设置常驻调试侧栏。
- 行情工具返回稳定的 60 根 mock OHLCV，详情面板使用 A 股红涨绿跌 K 线；图表按 lightweight-charts 要求保留 TradingView attribution。
- `/`、`/data-sources`、`/workflow`、`/citations`、`/eval`、`/architecture`、`/settings` 均为可刷新路由；设置页支持浅色、深色和跟随系统。

本地 API 验证：

```bash
curl -c /tmp/aiagent-cookie.txt -X POST http://localhost:3001/api/identity/bootstrap \
  -H "content-type: application/json" \
  -d '{"visitorId":"local-readme-visitor","fingerprintVersion":"manual-test"}'

curl -X POST http://localhost:3001/api/conversations \
  -b /tmp/aiagent-cookie.txt \
  -H "content-type: application/json" \
  -d '{"title":"平安银行研究"}'

curl -X POST http://localhost:3001/api/runs \
  -b /tmp/aiagent-cookie.txt \
  -H "content-type: application/json" \
  -d '{"message":"查询 000001.SZ 的行情。","conversationId":"<上一步创建的 conversationId>","clientMessageId":"11111111-1111-4111-8111-111111111111","mode":"auto","source":"composer"}'

# 使用上一步返回的 runId
curl -N -b /tmp/aiagent-cookie.txt http://localhost:3001/api/runs/<runId>/events
```

分页查询、读取消息或归档会话：

```bash
curl -b /tmp/aiagent-cookie.txt \
  'http://localhost:3001/api/conversations?limit=30'

curl -b /tmp/aiagent-cookie.txt \
  'http://localhost:3001/api/conversations/<conversationId>/messages?limit=50'

curl -X PATCH http://localhost:3001/api/conversations/<conversationId> \
  -b /tmp/aiagent-cookie.txt \
  -H "content-type: application/json" \
  -d '{"archive":true}'
```

## Docker Compose 一键 Demo

只需 Docker Engine 与 Docker Compose v2；默认 mock 模式不需要 Node、pnpm 或真实 API key：

```bash
git clone <repository-url>
cd aiagent
cp .env.example .env
docker compose up -d --build
docker compose ps
```

打开 `http://localhost:8080`。Web 仅对宿主机暴露 `8080`（可用 `AIAGENT_WEB_PORT` 修改），API 的 `3001` 只在 Compose 网络内暴露，由 Nginx 将浏览器 `/api/*` 请求代理到 `api:3001`。PostgreSQL 只绑定宿主机 `127.0.0.1:5432`；身份、session、Conversation/Message、Run/RunEvent、Citation、Workflow、Artifact metadata 与 RAG 文档 lineage 保存在 `postgres_data` volume，PDF bytes 保存在独立 `artifact_data` volume。

本地热更新与断点调试使用“数据库在 Docker、Web/API 在宿主机”的组合：

```bash
cp .env.example .env
pnpm db:up
pnpm db:migrate
pnpm dev
```

首次进入时 Web 使用 FingerprintJS 识别或创建 `userId`，API 签发 HttpOnly session。设置页可展示统一 QQ Bot 二维码并生成六位绑定码；QQ 私聊发送 `/bind 123456` 后即可通过同一 `userId` 调用 Agent。配置真实 QQ Bot 需要设置 `QQBOT_ENABLED=true`、`QQBOT_APP_ID`、`QQBOT_APP_SECRET` 和 `QQBOT_PUBLIC_QR_URL`。

验证 Web/API 探针和核心流程：

```bash
curl --fail http://localhost:8080/health
curl --fail http://localhost:8080/ready
pnpm smoke:compose
```

`/health` 只表示对应进程存活；Web 暴露的 `/ready` 会代理 API readiness。mock 模式检查本地 runtime，real 模式还会验证 provider 配置是否完整；API readiness 同时验证 PostgreSQL 连通性与 artifact storage 根目录，依赖未就绪时返回 HTTP 503，Compose 不会把 API 标为 healthy。`pnpm smoke:compose` 验证页面入口、普通 Chat、自然语言触发 Report Mode 和 workflow；该命令需要宿主机 Node，产品启动本身不需要。

更深的持久化全链路验证（需要先 `pnpm build` 与 `pnpm db:up`）：

```bash
node test/verify-runtime-integration.mjs
```

该脚本在独立测试库上依次验证：bootstrap 身份、创建会话并提交 Run、SSE 断线按 sequence 重连、Message/Run/Trace/Approval/Workflow/Artifact/Citation 读取、文档 ingest 与 hybrid 检索、API 重启后终态与文件仍存在、双用户越权拒绝、并发重复提交幂等与取消竞争单一终态、`pg_dump` 备份恢复到独立空库、PostgreSQL 停止时 readiness 503 且错误不泄漏内部异常、SIGTERM graceful shutdown 把未完成任务标记为 interrupted。

接入真实 OpenAI-compatible provider 时，在 `.env` 中设置：

```dotenv
AIAGENT_PROVIDER_MODE=real
# 每个具名 profile 必须同时配齐 API key 与 model 才会启用；至少配置一个即可。
AIAGENT_LLM_API_KEY_DEEPSEEK=replace-with-deepseek-key
AIAGENT_LLM_BASE_URL_DEEPSEEK=https://api.deepseek.com/v1
AIAGENT_LLM_MODEL_DEEPSEEK=deepseek-chat
# OpenRouter（可选）
AIAGENT_LLM_API_KEY_OPENROUTER=replace-with-openrouter-key
AIAGENT_LLM_BASE_URL_OPENROUTER=https://openrouter.ai/api/v1
AIAGENT_LLM_MODEL_OPENROUTER=replace-with-model-name
```

切换 `AIAGENT_PROVIDER_MODE=real` 后，run-service 复用同一条 `agentLoop` 控制流，只是把确定性 `MockModel` 的 `streamFn` 换成 `@aiagent/ai` 的 `streamSimple`（真实 OpenAI 兼容链路）。真实 provider 产出的 token 增量（`text_delta`）经 `message_update` 事件落 `run_events` 并由 SSE 原样广播到浏览器，逐字流式渲染——loop 控制流一行未改，证明 `StreamFn` 运行时边界抽象正确。

然后重新执行 `docker compose up -d --build`。密钥只作为运行时环境变量注入 API，不进入 build context 或镜像层。镜像使用 lockfile 固定依赖；API 以 Node `node` 用户运行，Web 使用 unprivileged Nginx 用户运行。

排错与停止：

```bash
docker compose logs --tail=200 api web postgres migrate
docker compose ps
docker compose down
```

如果 real 模式的 API 长期 `unhealthy`，先查看 `/ready`、migration 或 API 日志，并核对数据库与 provider 配置；端口冲突时修改 `.env` 中的 `AIAGENT_WEB_PORT` 或 `AIAGENT_POSTGRES_PORT`。普通 `docker compose down` 会保留身份数据；只有显式执行 `docker compose down -v` 才会删除 PostgreSQL volume。

## LLM Abstraction

`packages/ai` 导出统一 LLM 抽象，对齐 pi-ai：

- `Message` 类型族：`UserMessage`、`AssistantMessage`、`ToolResultMessage`。
- `AssistantMessageEvent`：流式增量事件（`start` / `text_start` / `text_delta` / `text_end` / `toolcall_start` / `toolcall_delta` / `toolcall_end` / `done` / `error`）。
- `stream` / `streamSimple`：统一 LLM 流式入口；当前实现 OpenAI-compatible `/chat/completions` adapter（含 tool_call 增量拼接、usage/finish 处理、429 指数退避）。
- `createAssistantMessageEventStream()`：用于测试的同步事件流构造器。

环境变量（`apps/api` 的 real 模式读取）：

```dotenv
AIAGENT_PROVIDER_MODE=real
# 下列具名 profile 至少配齐一个即可（deepseek / openrouter）；缺 API key 或 model 的 profile 不启用。
AIAGENT_LLM_API_KEY_DEEPSEEK=...
AIAGENT_LLM_BASE_URL_DEEPSEEK=https://api.deepseek.com/v1
AIAGENT_LLM_MODEL_DEEPSEEK=...
AIAGENT_LLM_API_KEY_OPENROUTER=...
AIAGENT_LLM_BASE_URL_OPENROUTER=https://openrouter.ai/api/v1
AIAGENT_LLM_MODEL_OPENROUTER=...
```

调用方只依赖 `packages/ai` 的 `Message` / `AssistantMessageEvent` 结构化结果，不需要处理底层 HTTP 异常。

可调用验证入口：

```bash
pnpm --filter @aiagent/ai test
```

测试使用 mock `fetch` 覆盖纯文本流、单/多 tool_call 增量拼接、4xx/5xx error event、AbortSignal 中断与 usage 透传，不需要真实 API key。

## Tools Infrastructure

`packages/tools` 导出统一工具基础设施，当前实现稳定 mock tools：`calculator`、`market_data_mock`、`filing_search_mock`、`financial_metric_mock`、`sql_query_mock`。

- `Tool<TInput, TOutput>`：每个工具必须声明 `inputSchema`、`outputSchema` 和 `execute()`，可选声明 `permissionLevel` 和 `evaluatePermission()`。
- `ToolRegistry`：支持按名称注册、查找、列出和执行工具。
- `createDefaultToolRegistry()`：返回已注册默认 mock tools 的 registry。
- `executeTool()` / `registry.execute()`：执行前用 zod 校验参数和 permission policy，执行后校验输出，并把异常转换为 `ToolExecutionResult` 结构化失败。

默认权限：

- `safe`：`calculator`、`market_data_mock`、`filing_search_mock`、`financial_metric_mock` 可直接执行。
- `blocked`：`sql_query_mock` 发现写 SQL 或 schema 变更关键词时直接阻断，返回 `permission_denied`。

SQL readonly 第一版是启发式白名单：只允许 `SELECT` / `WITH` 开头的单条查询，并禁止 `insert`、`update`、`delete`、`drop`、`alter`、`truncate`、`create` 等写操作关键词。它适合学习阶段保护工具边界，但不能替代真实数据库只读账号、SQL parser 或服务端权限隔离。pi 化改造已删除人工审批门，`beforeToolCall` 仅作观测/block 挂载点。

源码按职责拆分在 `packages/tools/src`：`types.ts` 保存公共 contract，`registry.ts` 保存注册表，`executor.ts` 保存执行与 trace 写入，`default-registry.ts` 组合默认 mock tools，`tools/*.ts` 按工具名分别保存 schema 和实现。`index.ts` 只作为 package 入口导出公共 API。

工具执行在 `beforeToolCall`/`afterToolCall` 钩子中可观测，事件经 `run-service` 脱敏后落入 `run_events`；trace 写入失败不会打断工具主流程。

## Security Hardening

Week 4 的基础安全边界已加入不可信 context 隔离、组合式 prompt injection policy、请求级 tool allowlist、严格 SQL readonly gate 和统一 PII redactor。安全决策以 `security` trace event 记录 `decision` 与稳定 `reasonCode`；UI 只展示可理解状态，不展示检测规则正文。

SQL gate 只允许单条 `SELECT/WITH` 并拒绝注释、危险关键词和常见绕过。部署时仍必须使用真正的数据库只读账号，移除写入、DDL、文件、扩展和跨库权限；代码校验不能替代数据库授权。完整信任边界、PII 保留策略和残余风险见 `docs/SECURITY_THREAT_MODEL.md`。

可调用验证入口：

```bash
pnpm --filter @aiagent/tools test
```

该测试覆盖默认 mock tools、safe 工具直跑、只读 SQL 审批、写 SQL 阻断、缺失 `ticker` 的 zod 参数错误、非法 calculator 表达式和 trace 写入。

## MCP Financial Research Server

`packages/mcp` 提供独立的 `@aiagent/mcp` stdio server，使用官方 MCP TypeScript SDK 暴露三个可发现、带输入/输出 schema 的金融研究工具：

- `search_filings`：复用 `@aiagent/rag` 内存 runtime 检索 mock 公告，返回 snippets、citations 和 scores。
- `get_financial_metrics`：复用 `@aiagent/tools` 的 `financial_metric_mock`，返回 metric、value、period、unit 和 source。
- `get_market_data`：复用 `market_data_mock`，按 fields 返回 prices、returns、volume 或 summary。

启动 stdio server：

```bash
pnpm --filter @aiagent/mcp start
```

stdio 的 stdout 专用于 MCP 协议帧，通常应由 MCP client 作为子进程启动，而不是在终端中手工输入。可运行真实 client/server smoke test：

```bash
pnpm --filter @aiagent/mcp test
```

### MCP Client 接入 Agent

`packages/mcp` 提供 client adapter 与 discovery 装配：MCP tools 被包装为 pi 形状的 `AgentTool`（zod schema 保留），discovery 产出直接并入 `agentLoop` 的 `config.tools`，模型按 description 自主选择：

```bash
# 直接体验 MCP client 发现、调用和 fallback
pnpm --filter @aiagent/mcp test
```

API server 侧通过环境变量开启启动期 discovery（`apps/api/src/server.ts`）：

```bash
AIAGENT_MCP_ENABLED=true pnpm dev  # 可选 AIAGENT_MCP_COMMAND / AIAGENT_MCP_ARGS 指定外部 server
```

关键接口：

- `createMcpStdioClient()`：stdio MCP client，暴露 `listTools()` / `callTool()` / `close()`。
- `discoverMcpAgentTools(client, { sink })`：发现 MCP tools 并包装为 `AgentTool[]`，`mcp_tool_discovered` 事件经 sink 写入 run_events。
- `createCombinedAgentTools()`：内置 tools 与 MCP tools 在装配期合并为一个数组；MCP server 不可用时 fallback 到内置 tools。
- MCP 工具输出回喂模型前经 `packages/security` 的 `<untrusted_context>` 二次封装。

当前公告、指标和行情数据均为本地 mock；RAG 检索与 citation 生成会真实执行，但不持久化，也不包含远程部署、鉴权、多租户或长连接生产化治理。工具失败同时使用 MCP `isError` 和结构化 error envelope，不向 client 泄漏 raw exception。实现取舍与 MCP/REST 对比见 ``。

## Week 2 RAG Package Foundation

Week 2 新增三个 RAG 相关 package，当前已具备 Markdown/TXT 公告 ingestion 入口、RAG 基础边界、纯函数 chunk 策略、deterministic mock embedding、内存测试 adapter、PostgreSQL pgvector adapter、hybrid retrieval 和 deterministic heuristic rerank；暂不接入真实 PDF 解析、真实 embedding provider、Qdrant、cross-encoder、LLM rerank 或 Agent Chat：

- `@aiagent/parsing`：保存文档来源、document metadata、原始文本来源和 document parsing pipeline。`ingestDocument()` 支持 Markdown、TXT 与 PDF 解析，输出 `IngestedDocument` 和带 `heading`、`lineStart`、`lineEnd` 的 blocks；解析失败返回 `parse_failed` 结构化错误，不静默生成文档。
- `@aiagent/rag`：保存 `RagDocument`、`RagChunk`、`EmbeddedChunk`、`Citation`、`RetrievalResult`、`RagAnswer`、embedding/vector store/retriever/reranker 抽象和结构化错误类型，并导出 `chunkText()`、`chunkDocumentBlocks()`、`chunkIngestedDocument()`、`createDeterministicMockEmbeddingClient()`、`createInMemoryVectorStore()`、`createHybridRetriever()` 和 `createHeuristicReranker()` 等入口。
- `@aiagent/eval`：保存 `EvalCase`、`EvalMetric`、`EvalResult`、`RagEvalMetrics`、`RagEvalReport`，并导出 `runRagEval()` runner、`createRagEvalReport()` 报告生成、`computeRagMetrics()` 指标计算、`RAG_EVAL_CASES` 30 条评测用例、`DEMO_DOCUMENTS` demo 文档和 `createDemoRagRuntime()` 预加载 runtime。

跨 API 边界会复用的 DTO 放在 `packages/types`，包括 document source/document、ingested document/block、RAG document/chunk/embedded chunk/vector search match/retrieval score breakdown/citation/retrieval/answer、retrieval trace event 和 eval case/metric/result。只属于运行时 package 的抽象，例如 ingestion options、chunking options、embedding client、vector store、retriever、reranker、package summary 和 runner input，保留在对应 package 内部导出。

RAG chunk 策略当前规则：

- 默认 `DEFAULT_CHUNKING_OPTIONS` 使用 `heading_aware`，`maxChars: 1200`，`overlapChars: 150`。这个大小适合公告/财报段落检索，能保留足够上下文，同时避免后续 embedding 输入过长。
- `fixed_size` 按字符窗口切分长文本，使用 overlap 保留相邻 chunk 上下文；`overlapChars >= maxChars` 会返回 `invalid_chunking_options` 结构化错误，避免无限循环。
- `heading_aware` 优先沿用 ingestion block 的 `heading`、`lineStart`、`lineEnd`、`pageNumber` 和 block id；单个超长 block 会继续按 fixed-size 切分。
- `chunkIndex` 从 0 开始并在文档内连续；`chunkId` 稳定派生为 `${documentId}_chunk_0000` 这类形式。
- 每个 chunk 都保留 `documentId`、`source`、`page/pageNumber`、`heading`、`charStart`、`charEnd` 和 metadata，后续 citation 可以从 chunk 追溯到原始 block、行号或页码。

RAG embedding 和向量库当前规则：

- `EmbeddingClient` 抽象暴露 `embedTexts(texts)`，当前实现 `createDeterministicMockEmbeddingClient()` 使用规范化 token、稳定 hash 和 L2 normalize 生成固定维度向量。同一文本多次 embedding 结果完全一致，便于无网络、无 API key 的单测。
- `VectorStore` 抽象暴露 `upsertChunks(chunks)` 和 `search(queryVector, options)`。`createInMemoryVectorStore()` 用 `Map` 按 `chunkId` upsert，相同 `chunkId` 会替换旧 chunk。
- vector search 使用 cosine similarity，支持 `topK`、`documentId` 和 `source` filter。`topK` 默认 `5`，上限 `50`，避免一次返回过多结果。
- 向量维度必须一致；chunk embedding 或 query vector 维度不匹配会返回 `embedding_dimension_mismatch` 或 `vector_store_dimension_mismatch` 结构化错误，而不是向 UI 泄漏异常。
- 内存向量库只适合单测、MCP demo 和 deterministic eval，并由这些调用方显式注入。生产 API 的 Data Sources runtime 注入固定 32 维 PostgreSQL pgvector `VectorStore`，支持跨进程检索、owner/scope 授权优先过滤和 checksum 感知幂等 upsert；真实模型采用其他维度时必须新增兼容 schema。

RAG hybrid retrieval 和 rerank 当前规则：

- `Retriever` 抽象暴露 `retrieve(query, options)`，`createHybridRetriever()` 组合 `EmbeddingClient`、`VectorStore` 和调用方传入的 embedded chunks。生产 runtime 的向量召回走 pgvector，关键词候选在每次检索时从授权后的持久化 repository 分页重建，进程重启后不依赖旧内存 Map。
- 支持 `mode: "vector" | "keyword" | "hybrid"`。`topK` 复用向量检索默认值 `5` 和上限 `50`；`candidateLimit` 默认 `20`，并受同一上限保护。
- 第一版 keyword scoring 是轻量 BM25-like heuristic：中英文 token 匹配、query term coverage、term frequency 和 heading boost，不新增重型生产依赖。它适合小规模公告/财报 demo，后续可替换为真实 BM25 索引。
- hybrid 模式默认使用 `vectorWeight: 0.65`、`keywordWeight: 0.35`；vector-only 和 keyword-only 模式默认分别使用 1/0 与 0/1。返回结果会输出 `vectorScore`、`keywordScore`、`hybridScore`、`finalScore`、命中词、覆盖率和 heading match。
- `createHeuristicReranker()` 用 deterministic 规则重排：hybrid score、query term coverage 和 heading match；相同分数按 `chunkIndex` 和 `chunkId` 稳定排序。后续 cross-encoder 或 LLM rerank 只需实现 `Reranker` 接口。
- retrieval trace summary 只记录 `queryPreview`、mode、topK、candidateLimit、耗时、retrieved chunk ids 和 score summary，不记录完整敏感文档。`packages/trace` 也保留了 `retrieval` event 结构，方便后续 Agent timeline 写入。

可调用验证入口：

```bash
pnpm --filter @aiagent/parsing test
pnpm --filter @aiagent/rag test
pnpm --filter @aiagent/eval test
pnpm typecheck
pnpm test
pnpm build
```

GitHub PR 会运行 `.github/workflows/ci.yml`，在独立 PostgreSQL service 上执行根级
typecheck、test、build 与依赖架构检查；数据库集成测试不会连接开发数据库。

## Week 2 Citation Answer And Data Sources

Week 2-013 已把 RAG ingestion、chunk、retrieval 和 citation answer 接入 HTTP API 与 Web 页面，形成最小可演示的 Data Sources 工作区：

- `packages/rag` 的 `createDataSourceRuntime()` 组合 `@aiagent/parsing` ingestion、heading-aware chunking、embedding、可注入 VectorStore、hybrid retriever 和 grounded answer policy；生产 composition 使用 PostgreSQL document repository 与 pgvector store，测试/eval 显式使用内存 adapter。
- `apps/api` 新增 `POST /api/data-sources/ingest`、`GET /api/data-sources/documents`、`GET /api/data-sources/chunks`、`POST /api/rag/search`、`POST /api/rag/answer`。Route handler 只做 zod 校验、调用 RAG runtime、DTO 映射和 `ApiResult` 结构化响应。
- `packages/types` 新增 Data Sources/RAG API DTO，并扩展 `CitationDto`：每条 citation 包含 `chunkId`、`documentId`、`source`、`heading`、`chunkIndex`、`quote` 和 `confidence`，可以从 answer 追溯到原始文档、来源、章节和 chunk 顺序。
- `apps/web` 左侧工作区导航新增 Data Sources 页面。页面通过 HTTP API 展示粘贴/上传文本、document list、chunk list、retrieval results、answer 和 citations；前端不直接依赖 RAG runtime。
- unknown answer policy：answer synthesis 只使用召回结果中命中有信息量术语的 chunks。证据不足时仍返回 `ok: true`，但 answer 明确说明当前资料不足，不编造结论。

当前 runtime 限制：

- 只支持 Markdown/TXT demo 文档；PDF 仍返回结构化未配置错误。
- Document/chunk/vector、Run、Trace 与 Approval 已持久化并按当前 session owner 隔离；keyword candidates 在检索时从可见 chunks 重建。
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

`packages/agent` 导出 pi 形态的 `agentLoop` / `agentLoopContinue` 与 hook 体系（详见 ``）。早期版本的 `createAgent()`、Intent Router 与 report planner 特例路径已在 pi 化改造中删除，report 由 `generate_report` 工具承接（见 ``）。

多轮 ReAct 循环：

- 每一轮调用一次 LLM；模型返回的 `AssistantMessage` 若含 `toolCall` 内容块，loop 就并行执行对应 `AgentTool`，把 `ToolResultMessage` 追加进上下文，然后开始下一轮；直到模型不再发起工具调用（或 `shouldStopAfterTurn` 判定停止）。
- 意图选择、工具选择、回答时机全部由模型在多轮中自主完成，没有预定义的意图分支。
- 上层通过 `transformContext` / `convertToLlm` / `beforeToolCall` / `afterToolCall` / `prepareNextTurn` / `shouldStopAfterTurn` 等 hook 定制行为，而不是改 loop 本体。
- `maxTurns` 在每个 turn 后检查，达到上限时返回用户可理解的终态，不会无限等待或抛出原始异常。

工具路径只通过 `AgentTool.execute()` 调用工具，不直接依赖工具实现。工具参数错误、工具不存在、工具执行错误会以结构化错误返回，同时保留底层 `toolError` details。

`@aiagent/trace` 现在只保留最小运行事件类型契约与跨边界值脱敏工具。loop 事件（`agent_start` / `turn_start` / `message_*` / `tool_execution_*` / `agent_end`）与能力事件（`retrieval`、`workflow_node`、`pdf_export`、`mcp_tool_discovered`、`run_status`、`run_error`）直接由 `run_events` 表持久化，SSE 重放与运行详情同源。`packages/trace` 的 `redactSensitiveValue` 在 `run-service` 落库前递归脱敏密钥、authorization、password、secret、认证 token 与常见 PII，并把长字符串截断到 500 字符。

可调用验证入口：

```bash
pnpm --filter @aiagent/agent test
pnpm --filter @aiagent/tools test
```

## Report Workflow Runtime

Week 3-016 新增两个 package：

- `@aiagent/workflow`：通用节点执行器。每个节点必须声明 `inputSchema` 和 `outputSchema`，runtime 在节点执行前后用 zod 校验，节点异常、输入错误、输出错误和 max steps 超限都会转换成 `WorkflowErrorDto`。Week 3-017 为其增加 `decideNext` 能力，支持节点执行成功后跳转到指定节点，从而实现 verifier loop 等有限循环。
- `@aiagent/report`：研报领域 workflow 节点实现。`runReportWorkflow(plan, options)` 从 `ReportPlanDto` 创建 workflow run，依次执行 Data Collector、Analyzer、Risk Checker、Citation Verifier、Report Writer 和 PDF Exporter；`renderResearchReportPdf()` 生成合法 PDF 二进制。pi 化阶段 5 起 report 降级为 loop 工具 `generate_report`（`createReportTool()`），模型自主触发，节点事件经 sink 写入 run_events（`workflow_node`/`pdf_export` 事件名不变）；PDF 由工具内 `publishArtifactPdf` saga 直接发布，不再有人工审批门。

Workflow DTO 放在 `packages/types`：`WorkflowRunDto`、`WorkflowNodeDto`、`WorkflowNodeStatusDto`、`WorkflowEdgeDto`、`WorkflowEventDto`、`WorkflowErrorDto`。Workflow、节点 attempt 与 Artifact metadata/预览由 PostgreSQL 持久化；PDF bytes 经 `ArtifactStorage` 原子写入专用目录。

Report Workflow 当前节点输出：

- Data Collector：调用 `@aiagent/rag` 的 `DataSourceRuntime.search()`，基于 plan 生成 RAG queries，返回带 citation 的 evidence、financial metrics 和 retrieval traces。支持通过 `options.documents` 传入 demo 文档。
- Analyzer：从 evidence 生成 thesis、findings、结构化 claims 和 metric requirements。每个 claim 都记录 `evidenceIds` 和 `citationIds`。
- Risk Checker：输出 risk level、risk items 和 passed 状态；当 `reportType` 为 `risk_review` 且风险披露不足时，输出 `needsMoreEvidence` 和 follow-up queries。
- Citation Verifier：检查每个 claim 是否有 citation 支撑、required metric 是否齐全。决策类型为 `pass | needs_more_evidence | needs_metric | retry_tool | fail`；缺证据时生成 follow-up queries，并通过 `decideNext` 跳回 Data Collector 做补充检索，受 `maxRetries` 限制。
- Runtime reliability：模型仅对 timeout/network/429/5xx 做最多 3 次指数退避重试，并按 structured output/tool calling 能力选择 fallback；工具默认 10 秒单次 timeout，有副作用工具只有声明幂等且传入 idempotency key 才会重试；Workflow 同时受节点 timeout、总 deadline 与 `maxSteps` 约束，非关键来源失败可生成带 `partial`/`sourceErrors` 的降级报告。
- Report Writer：生成 Markdown 和最小 HTML 草稿；证据不足时保留“资料不足说明”，不编造结论。
- PDF Exporter：由 `publishArtifactPdf` 生成真实 `application/pdf`，失败标为 `pdf_failed` 且可安全重试。

### Week 3 Demo

运行 `pnpm dev`，打开 Web 后开启 Report Mode、点击“生成研报”，或输入 `基于最近两年公告和财务数据，为 000001.SZ 生成研究简报 PDF`。

在 assistant 消息中展开 `Run details`，可检查 Data Collector、Analyzer、Risk Checker、Citation Verifier、Report Writer、PDF Exporter 的状态、耗时、输入/输出摘要和 workflow run id。下方提供 Markdown/HTML 预览，引用显示 source、documentId、chunkId 与所支持的 finding。

Report Workflow 由 canonical Run application service 内部启动，不再暴露浏览器手动编排入口。artifact 使用 `GET /api/report-artifacts/:artifactId`、下载接口和 `DELETE /api/report-artifacts/:artifactId` 软删除。

上述 workflow/artifact 路由都先使用服务端 session 的 `userId` 查询 repository；不存在与越权统一返回 404。PDF 下载不接受文件路径，数据库只保存服务端随机 storage key、大小和 SHA-256，软删除不会在数据库事务内同步删除物理文件。

可调用验证入口：

```bash
pnpm --filter @aiagent/workflow test
pnpm --filter @aiagent/report test
```

## 技术栈约束

前端固定采用 Vite + React + TypeScript + Tailwind CSS + shadcn/ui + Radix UI，图标统一使用 lucide-react。基础 UI 组件放在 `apps/web/src/components/ui`，业务组件组合基础组件实现，避免同时引入 Ant Design、MUI、Chakra 等第二套组件体系。

后端在需要 HTTP 服务时使用 `apps/api` + Fastify。Fastify route handler 只作为 HTTP adapter：完成请求校验、调用 `packages/agent` / `packages/tools` / `packages/trace`、返回结构化响应。Agent 编排、工具执行、trace 构造等运行时逻辑不得放进 `apps/api` 或 `apps/web`。

`sql_query_mock` 的 permission gate 在工具执行前完成：写 SQL 或 schema 变更关键词直接返回 `permission_denied`，不再有人工确认门。Web 的 `Run details` 不再渲染任何审批入口。

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
pnpm --filter @aiagent/parsing test
pnpm --filter @aiagent/rag test
pnpm --filter @aiagent/eval test
pnpm --filter @aiagent/workflow test
pnpm --filter @aiagent/report test
```

## 自动化 Eval 基线

`datasets/eval-financial-v1.json` 是版本 `financial-research-v1.0.0` 的固定评测集，共 31 条：18 条 RAG、5 条 Chat、5 条 Report Mode、3 条失败路径。runner（`packages/eval/src/loop-runner.ts` 的 `runLoopEval`）用 fixture 作为确定性种子推导 mock streamFn 与 mock 工具，跑真 `agentLoop`，从 run_events（loop 事件 + retrieval / workflow_node / pdf_export）投影证据后用既有确定性指标打分；预算按 mode 走 `shouldStopAfterTurn`（maxTurns + token）与 runner 硬上限双层。不读取 API key，也未使用 LLM-as-judge。

```bash
# 运行回归，生成 docs/eval/latest-report.json 和 latest-report.md
pnpm eval

# 只有此显式命令会更新 docs/eval/baseline-v1.json
pnpm eval:update-baseline
```

当前 baseline：citation coverage `0.935`、financial accuracy `0.968`、source groundedness `0.968`、成功率 `0.903`、workflow 完成度 `0.984`、平均延迟 `22.839ms`、P95 `45ms`。成功率、引用覆盖、财务准确性、来源 groundedness、workflow 完成度分别不得低于 `0.80/0.85/0.80/0.85/0.90`；任一质量指标低于 baseline，或 P95 比 baseline 增加超过 `50ms`，命令以非零状态退出。

三个固定失败案例用于展示诊断而不是伪造满分：

- `fail-001`：答案缺少人民币币种且无来源，财务数值、单位、币种、期间、来源的联合校验失败；改进方向是结构化事实校验和证据不足拒答。
- `fail-002`：citation quote 与 retrieved chunk 不一致，无法 grounded 回溯；改进方向是 claim-to-chunk 映射和 Citation Verifier。
- `fail-003`：证据不足导致 Report workflow 在 Verifier 后终止，缺少 writer/export 前置节点；改进方向是有限重试和结构化终止原因。

机器报告、Markdown 逐条结果和 baseline diff 位于 `docs/eval/`。确定性检查适合 CI 和教学，但不能识别所有语义等价表达；真实模型或人工校准应作为后续补充，不能替代这些硬约束。

根目录脚本会通过 workspace 执行各应用和 package 的对应命令。`pnpm dev` 会同时启动 `apps/api` 和 `apps/web`；web 的 Vite dev server 会把 `/api` 代理到 `http://localhost:3001`。如果 `5173` 被占用，Vite 会自动选择下一个可用端口。

## 学习路线

原四周从零搭建路线已经完成。后续主路线改为边学习、边改造、边验证：

- 当前路线：[Immersive 持续学习与演进路线](docs/LEARNING_AND_EVOLUTION_ROADMAP.md)
- 历史路线：[1 个月 AI Agent 冲刺路线](docs/ROADMAP_1_MONTH.md)

当前路线默认主要使用 AI Coding 完成代码实现。训练重点是从真实架构债务、产品摩擦和 eval 失败中选择问题，用官方资料补足原理，再通过窄范围端到端改造、测试、trace 和指标证明优化有效。

最终交付物是当前仓库内的一个完整 monorepo 产品，而不是按学习阶段拆成多个项目。Web 产品放在 `apps/web`，Agent/RAG/Tool/Workflow/Report/Eval/Trace 等能力沉淀到 `packages/*`。每周的页面会渐进累积：Immersive、Data Sources、Report Workflow、Citation Checker、Eval Report，最后在 Week 4 统一包装。

Immersive 的主路径是金融研究 Chatbot：用户围绕公告、财报、行情和行业资料进行多轮问答。高级路径是 Report Mode：用户可以通过开关、按钮或自然语言请求触发 report skill，系统从普通对话升级到显式 Workflow，完成资料收集、分析、引用校验和 PDF 研报导出。

建议每周至少保留：

- 15-20 小时编码实现。
- 4-6 小时阅读官方文档、源码和优秀项目。
- 3-4 小时题整理、项目复盘和表达训练。

每个核心 package 都要保留清晰的职责边界、核心代码、测试或验收方式。最终产品 README 要保留架构图、运行方式、评估结果和失败案例。
