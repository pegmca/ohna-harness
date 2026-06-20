# AI Agent Learning Workspace

这个仓库用于快速学习 AI Agent 开发，并沉淀一个可展示的金融研究 Chatbot 项目、Report Mode 研报生成 Workflow、PDF 导出能力、文档和复盘。

## 推荐仓库结构

```text
.
├── docs/
│   ├── ROADMAP_1_MONTH.md
│   ├── WEEK_1_AGENT_FOUNDATION.md
│   ├── WEEK_2_RAG_KNOWLEDGE_BASE.md
│   ├── WEEK_3_AGENTIC_RAG_WORKFLOW_MCP.md
│   └── WEEK_4_PRODUCTION_AND_INTERVIEW.md
├── apps/
│   └── web/
│       ├── app/
│       └── components/
├── packages/
│   ├── agent/
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

## 学习路线

你当前是全栈工程师，前端和 TypeScript 能力强，且已经熟练使用 AI Coding，因此主路线采用压缩版：

- 主路线：[1 个月 AI Agent 冲刺路线](docs/ROADMAP_1_MONTH.md)

这条路线默认主要使用 AI Coding 完成代码实现。你的训练重点是架构设计、任务拆解、Prompt/Tool schema、代码审查、测试验收、评估指标、trace 分析和表达，而不是手写所有代码。

最终交付物是当前仓库内的一个完整 monorepo 产品，而不是按学习阶段拆成多个项目。Web 产品放在 `apps/web`，Agent/RAG/Tool/Workflow/Report/Eval/Trace 等能力沉淀到 `packages/*`。每周的页面会渐进累积：Research Chat、Data Sources、Report Workflow、Citation Checker、Eval Report，最后在 Week 4 统一包装。

产品主路径是金融研究 Chatbot：用户围绕公告、财报、行情和行业资料进行多轮问答。高级路径是 Report Mode：用户可以通过开关、按钮或自然语言请求触发 report skill，系统从普通对话升级到显式 Workflow，完成资料收集、分析、引用校验和 PDF 研报导出。

建议每周至少保留：

- 15-20 小时编码实现。
- 4-6 小时阅读官方文档、源码和优秀项目。
- 3-4 小时题整理、项目复盘和表达训练。

每个核心 package 都要保留清晰的职责边界、核心代码、测试或验收方式。最终产品 README 要保留架构图、运行方式、评估结果和失败案例。
