# 业务方向：Immersive + 研报 Workflow

更新时间：2026-06-20

## 1. 产品定位

产品名建议：

- `Immersive`
- `Equity Research Copilot`

一句话：

> Immersive 是一个面向股票研究和行业研究的金融研究 Chatbot。用户可以围绕公开公告、财务数据、行情数据、新闻事件和行业资料进行多轮问答；当用户开启 Report Mode、点击生成研报，或通过自然语言表达“帮我生成一份研报”时，系统切换到显式研报 Workflow，完成资料收集、分析建模、引用校验，并导出 PDF 研报。

重点：默认产品形态是 Chatbot，不是所有请求都走完整研报生成流程。研报 Workflow 是一个可显式开启、也可由自然语言意图激活的高级 skill，用于长链路、可追溯、可导出的正式报告任务。

## 2. 核心用户

- 券商/资管/基金的投研助理。
- 金融数据产品经理。
- 个人投资研究者。
- 希望展示 AI Agent 工程能力的求职者。

## 3. 业务边界

本项目用于学习、演示和，不提供真实投资建议。

必须避免：

- 不输出“买入/卖出/目标价”等强投资建议，除非明确标注为模拟。
- 不伪造数据来源。
- 不引用没有来源的数据。
- 不把模型推断包装成事实。
- 不使用付费研报或受版权限制的研报内容作为训练/生成依据。

默认 Chatbot 建议输出：

- 公司基本面分析。
- 财务表现总结。
- 业务驱动因素。
- 行业和竞品对比。
- 风险提示。
- 关键数据引用。
- 观点置信度和证据链。

Report Mode 建议输出：

- 结构化公司研究简报。
- Markdown / HTML 预览。
- 带引用编号和免责声明的 PDF 文件。
- Workflow trace 和引用校验结果。

## 4. 数据来源

优先使用公开、可追溯的数据。

可选数据：

- 公司公告和财报：巨潮资讯、交易所公告、SEC EDGAR。
- 财务指标和行情：AKShare、TuShare。
- 新闻和事件：公开新闻源、RSS、财经网站摘要。
- 行业资料：公开行业政策、公司官网、年报中的行业章节。
- 自建模拟数据：行业指标、竞品数据、用户自造样例。

建议第一版不要追求全量数据源，先选 A 股单公司研究问答 + 研报生成为主：

- 默认输入：用户自然语言问题，例如“这家公司近两年营收变化如何？”。
- Report Mode 输入：股票代码、研究区间、报告类型；可以来自表单，也可以从用户自然语言中抽取。
- 数据：年报/季报 PDF、财务指标、历史行情、相关新闻。
- 默认输出：带引用的对话回答。
- Report Mode 输出：一份结构化公司研究简报，并导出 PDF。

## 5. Chatbot 与 Report Mode

系统采用渐进式 skill 设计：默认停留在轻量 Chatbot 能力，当 Intent Router 识别到用户需要正式研报、PDF、完整分析框架或长文档交付时，再升级到 Report Workflow skill。

系统有两条路径：

```text
普通对话路径：

User Message
  -> Intent Router
  -> RAG Retriever / Tool Calling
  -> Grounded Answer
  -> Chat Response
```

```text
研报生成路径：

User enables Report Mode / clicks Generate Report / asks for a report
  -> Intent Router
  -> Report Skill Activation
  -> LLM Planner / Requirement Clarification
  -> Research Planner
  -> Data Collector
  -> Filing / Financial Data Retriever
  -> News / Event Retriever
  -> Financial Analyzer
  -> Thesis Generator
  -> Risk Checker
  -> Citation Verifier
  -> Report Writer
  -> PDF Exporter
```

为什么 Chatbot 和 Workflow 并存：

- 普通金融研究问题更关注响应速度和交互体验，使用 RAG + Tool Calling 即可。
- 研报生成属于长链路任务，需要章节结构、数据收集、财务计算、风险检查、引用校验和格式化导出。
- 不是所有用户问题都值得走完整 Workflow，只有开启 Report Mode、点击“生成研报”，或自然语言意图明确命中 report skill 时才进入固定流程。

Report Mode 激活方式：

- 显式开关：用户打开 `Report Mode`，后续输入按研报生成任务处理。
- 显式按钮：用户在 Chat 中点击“生成研报”。
- 自然语言：用户说“基于这些资料生成一份研报 PDF”“帮我写一份公司研究简报”等，Intent Router 触发 report skill。

自然语言触发后，不强制要求用户先填完固定表单。LLM Planner 负责根据上下文做需求澄清与任务规划：可以从历史对话中推断研究对象，可以使用系统默认报告类型，可以先基于已有资料生成初版，也可以在信息不足且会影响结果质量时向用户追问。追问是编排策略之一，不是硬性前置步骤。

## 6. Agent 工作流

Report Mode 推荐工作流：

```text
User Request
  -> Intent Router
  -> Report Skill Activation
  -> LLM Planner / Requirement Clarification
  -> Research Planner
  -> Data Collector
  -> Filing / Financial Data Retriever
  -> News / Event Retriever
  -> Financial Analyzer
  -> Thesis Generator
  -> Risk Checker
  -> Citation Verifier
  -> Report Writer
  -> PDF Exporter
  -> Final Report PDF
```

节点职责：

- `Research Planner`：判断报告类型、研究对象、时间范围、所需数据。
- `Data Collector`：调用行情、财务、公告、新闻等工具。
- `Filing Retriever`：检索年报、季报、公告中的关键段落。
- `Financial Analyzer`：计算收入、利润、毛利率、ROE、现金流、估值等指标变化。
- `Thesis Generator`：生成核心投资逻辑或经营判断。
- `Risk Checker`：补充风险因素，并检查观点是否过度。
- `Citation Verifier`：确保关键结论有来源或数据支撑。
- `Report Writer`：生成最终研报结构。
- `PDF Exporter`：把结构化报告渲染为 HTML/PDF，处理目录、引用编号和免责声明。

LLM 与程序边界：

- LLM 负责：意图识别、任务拆解、证据归纳、文本生成、风险表述润色。
- 程序负责：工具权限、参数校验、财务计算、引用绑定、max steps、timeout、retry、trace、eval、PDF 渲染。

## 7. 研报结构

第一版建议生成“公司研究简报”，不要一开始做完整几十页深度报告。

推荐结构：

```text
# 公司研究简报

## 1. 研究摘要

## 2. 公司概况

## 3. 财务表现

## 4. 业务与增长驱动

## 5. 行业与竞争格局

## 6. 估值观察

## 7. 关键风险

## 8. 数据来源与引用

## 9. 免责声明
```

PDF 生成链路：

```text
Workflow Result
  -> Structured Report JSON
  -> Markdown Report
  -> HTML Template
  -> PDF Renderer
  -> Downloadable PDF
```

PDF 不是直接让 LLM 生成。LLM 负责生成结构化内容，程序负责模板渲染、引用编号、目录、免责声明和 PDF 导出。

## 8. Web 产品页面

推荐放在当前 monorepo 的 `apps/web`：

```text
apps/web/
├── app/
│   ├── page.tsx
│   ├── immersive/
│   ├── data-sources/
│   ├── report-workflow/
│   ├── citation-checker/
│   ├── eval-report/
│   └── architecture/
└── components/

packages/
├── agent/
├── types/
├── rag/
├── tools/
├── workflow/
├── report/
├── eval/
├── trace/
├── financial-data/
├── parsing/
└── mcp/
```

核心 package 职责：

- `agent`：Intent Router、Agent Loop、模型调用编排。
- `types`：前后端共享 API contract、DTO、结构化错误和稳定枚举。
- `rag`：检索、重排、context packing、引用生成。
- `tools`：工具 schema、tool registry、参数校验、工具执行。
- `workflow`：Report Mode 的显式节点编排。
- `report`：结构化研报、Markdown/HTML/PDF 渲染。
- `eval`：评估集、指标计算、eval 报告。
- `trace`：request、model call、tool call、workflow node、成本和延迟记录。

页面说明：

- `immersive`：默认首页，支持金融研究多轮问答、工具调用和引用展示。
- `data-sources`：展示公告、财报、行情、新闻等数据来源。
- `report-workflow`：展示 Report Mode 的 Planner、Data Collector、Analyzer、Risk Checker、Citation Verifier、Report Writer、PDF Exporter 执行链路。
- `citation-checker`：展示每个关键结论对应的数据来源。
- `eval-report`：展示问答和研报质量评估、引用覆盖率、事实一致性。
- `architecture`：展示系统架构和技术取舍。

## 9. 评估指标

Immersive 的问答能力不能只看“答得像不像”，研报生成也不能只看“写得像不像”，都要评估事实和引用。

建议指标：

- `citation_coverage`：关键结论中有引用支撑的比例。
- `financial_accuracy`：财务指标计算是否正确。
- `source_groundedness`：结论是否能从来源中找到依据。
- `risk_completeness`：是否覆盖核心风险。
- `structure_completeness`：研报章节是否完整。
- `tool_success_rate`：工具调用成功率。
- `latency`：生成耗时。
- `token_cost`：生成成本。
- `pdf_export_success_rate`：Report Mode PDF 导出成功率。

## 10. 一个月落地范围

第一版不要做全市场研究助手，范围要收敛：

- 只支持 A 股或美股，优先 A 股。
- 默认只支持公司研究问答。
- Report Mode 只支持公司研究简报。
- 只支持 1-3 家样例公司。
- 只做公开数据和模拟数据。
- 普通问答输出 Chat Response。
- Report Mode 输出 Markdown / HTML / PDF 研报。
- 不做真实投资评级。

推荐 demo 问题：

```text
这家公司最近两年的营收和利润变化如何？请给出数据来源。

请基于最近两年的财报、公告和行情数据，为 000001.SZ 生成一份公司研究简报，重点分析收入、利润、资产质量、风险因素，并给出数据来源。
```

