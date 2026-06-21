# AI Agent Learning Workspace

这个仓库用于快速学习 AI Agent 开发，并沉淀一个可展示的 Immersive 项目、Report Mode 研报生成 Workflow、PDF 导出能力、文档和复盘。

## 推荐仓库结构

```text
.
├── docs/
│   ├── ROADMAP_1_MONTH.md
│   ├── BUSINESS_DIRECTION_FINANCIAL_RESEARCH_AGENT.md
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
│   └── api/                 # 需要 HTTP 服务时再引入
├── packages/
│   ├── agent/
│   ├── types/
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
└── README.md
```

## 当前工程底座

本仓库已经初始化为 pnpm workspace monorepo：

- `apps/web`：Vite + React + TypeScript Web 应用入口，负责承载 Immersive 产品界面。
- `apps/api`：后续需要前后端 HTTP 联调时引入，使用 Fastify 作为 HTTP adapter。
- `packages/agent`：Agent 能力边界，后续承载意图识别、循环调度和模型交互。
- `packages/types`：前后端共享类型边界，承载 API contract、DTO、结构化错误和稳定枚举。
- `packages/tools`：工具注册与工具调用边界，后续承载外部数据和函数工具。
- `packages/trace`：运行轨迹边界，后续承载事件记录、时间线和调试视图。

`packages/*` 作为独立 workspace package 构建和类型检查。`apps/web` 保持前端应用边界，不直接依赖 `agent`、`tools`、`trace` 这些核心运行时包；后续通过 `apps/api` 或专门的 client package 接入。

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
pnpm --filter @aiagent/agent verify:llm
```

默认使用 mock provider 覆盖普通 chat、JSON 输出和 tool call。配置真实环境变量后可追加 `-- --real` 调用真实 OpenAI-compatible provider。

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
pnpm --filter @aiagent/agent verify:llm
```

根目录脚本会通过 workspace 执行各应用和 package 的对应命令。`pnpm dev` 默认启动 `apps/web`。

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
