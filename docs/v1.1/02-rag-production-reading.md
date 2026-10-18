# 带读路线：RAG 生产化（P1–P5，v1.1）

> 配套文档：`docs/v1.1/02-rag-production.md`（需求：P1 真实 Embedding / P2 Cross-Encoder Reranker / P3 pgvector / P4 PDF+Contextual Retrieval / P5 Agentic 检索+RAGAS 校准）
> 实现仓库：`.`（pnpm monorepo，strict TS，ESM）
> 本路线按"接口已就绪 → 只换实现 → 装配进组合根"的顺序，把代码位置、设计思想、业界对应物、学习检查点串起来。
> 读法建议：先通读一节的理论，再打开对应 `file_path:line` 读源码，最后回看该节的「学习检查点」。
> 状态：P1–P5 已实现，reviewer 复核 **GO**（1 个阻塞项 B-1 与全部 minor 已修复，仅 parsing `index.ts` ~545 行作为软 follow-up）。
> B-1 的影响面：`createDataSourceRuntime()` 不再自带 embedding 默认值，调用方必须显式注入——
> 测试注入 `packages/rag/src/testing.ts` 的测试替身，生产注入 `createEmbeddingClientFromEnv()` 的真实 client。
> `packages/report` 的两个生产入口（`runReportWorkflow` / `createReportTool`）已把 `dataSourceRuntime` 改为必填。

---

## 0. 全局心智模型（先看这张图）

```
                        真实 provider 统一收口（依赖倒置）
   ┌──────────────────────────────────────────────────────────────┐
   │  packages/rag/src/provider-config.ts  (PROVIDER_ENV / readLlmProviderConfig / readEmbedding/Rerank/JudgeProviderConfig) │
   │  → 四组独立 provider（LLM / Embedding / Rerank / Judge）各自只读自己的环境变量         │
   │  → 缺 key 时 enabled=false，fromEnv 工厂返回 null，由组合根显式决定降级（不再静默回退）            │
   └───────────────┬──────────────────────────────────────────────┘
                    │ 注入
   ┌────────────────┼───────────────────────────────────────────────┐
   │  RAG 四件套（均接口已就绪，本工作只换实现）                          │
   │   EmbeddingClient        (P1)  embedding-providers.ts            │
   │   Reranker               (P2)  reranking-providers.ts           │
   │   ContextEnricher        (P4)  contextual-retrieval.ts          │
   │   QueryRewriter          (P5)  query-rewrite.ts                 │
   └────────────────┼───────────────────────────────────────────────┘
                    │ 装配进
   ┌────────────────┼───────────────────────────────────────────────┐
   │  DataSourceRuntime（rag/src/data-source-runtime.ts）             │
   │   ingest → contextEnricher 注入 doc 前缀 → embedding             │
   │   search/answer → queryRewriter 改写 → retrieve → reranker 重排  │
   └────────────────┼───────────────────────────────────────────────┘
                    │ 持久化 / 评测
   ┌────────────────┼───────────────────────────────────────────────┐
   │  VectorStore        (P3)  database: pgvector 或 内存回退          │
   │  Parsing            (P4)  parsing: PDF/表格解析（parsers/pdf.ts）  │
   │  Eval/Judge         (P5)  eval: LLM-as-judge + RAGAS 指标        │
   └─────────────────────────────────────────────────────────────────┘
                        组合根：apps/finance-api/src/server.ts（env 驱动装配）
```

**一句话**：`rag` 包的 `EmbeddingClient` / `VectorStore` / `Reranker` / `Retriever` 接口在 foundation 阶段就已稳定（`types.ts`），本次 P1–P5 是"**接口已就绪、只换实现**"——真实 OpenAI 兼容客户端、pgvector、cross-encoder rerank、contextual retrieval、agentic rewrite 全部通过依赖倒置 + env 工厂注入。
v1.1 起配置侧拆为 **LLM / Embedding / Rerank / Judge 四个独立 provider**：`fromEnv` 工厂在 provider 未启用时返回 `null`，
**不再静默回退 mock**——可复现的 mock 行为只由测试显式注入 `testing.ts` 的测试替身提供。

---

## 1. P1 真实 EmbeddingClient（★ 最值钱的一换）

**读什么**
- `packages/rag/src/provider-config.ts`（v1.1 取代原 `bridge-config.ts`）
  - `PROVIDER_ENV`（`:23`）：四组 provider 的环境变量名集中在此——LLM（`AIAGENT_LLM_BASE_URL` / `AIAGENT_LLM_API_KEY` / `AIAGENT_LLM_MODEL`）、
    Embedding（`AIAGENT_EMBEDDING_*`，含 `AIAGENT_EMBEDDING_DIMENSIONS`）、Rerank（`AIAGENT_RERANK_*`）、Judge（`AIAGENT_JUDGE_*`）。
  - `readEmbeddingProviderConfig`（`provider-config.ts:117`）：**维度默认 1536**（`DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS`，`:17`），可由 `AIAGENT_EMBEDDING_DIMENSIONS` 覆盖。
  - `readLlmProviderConfig`（`:96`）/ `readRerankProviderConfig`（`:138`）/ `readJudgeProviderConfig`（`:158`）：其余三组；
    `enabled = baseUrl && apiKey && model`，四组**互不继承 model**。
- `packages/rag/src/embedding-providers.ts`
  - `createOpenAiCompatibleEmbeddingClient`（`:36`）：POST `${baseUrl}/embeddings`，把文本批变成向量；非 2xx / 网络异常 → 结构化错误，**不抛原始异常**。
  - `createEmbeddingClientFromEnv`（`:227`）：`enabled` 为假时 **返回 `null`**（不再回退 `createDeterministicMockEmbeddingClient`）。
    需要可复现 32 维向量时，由测试显式注入 `packages/rag/src/testing.ts` 的 `createDeterministicMockEmbeddingClient()`。

**参考实现·业界对应物**：LangChain `OpenAIEmbeddings` / Haystack `SentenceTransformersDocumentEmbedder` 同构思路；但本仓库把"真实/测试替身切换"收敛到单个 `fromEnv` 工厂 + 中央 `provider-config`，比散落各处的 `if (apiKey)` 更利于审计与热插拔；且**工厂只报告可用性（null），不替调用方决定降级策略**。

**学习检查点**
- 为什么维度必须全局一致？P1 真实 embedding 是 1536 维，`database` 的 pgvector 列（`0070` 迁移固定 `vector(1536)`）也必须 1536——这是一处跨包**维度契约**，由 `DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS` 单一真相源约束（见 P3）。
- 为什么 v1.1 要改成"未启用即 `null`"而不是"回退 mock"？静默回退会让生产在 provider 未配置时**看起来正常**——embedding 用无语义的 deterministic 向量、judge 给中性分，指标与答案质量悄悄劣化却无人察觉。改成 `null` 后，缺失必须由组合根显式处理（或结构化报错、或明确注入测试替身），这是"可观测性优先于便利性"的取舍。

---

## 2. P2 Cross-Encoder Reranker（★ 检索排序升级）

**读什么**
- `packages/rag/src/reranking-providers.ts`
  - `createOpenAiCompatibleReranker`（`reranking-providers.ts:67`）：先尝试 `/rerank` 端点；**404 或失败自动回退 LLM-as-judge**（`/chat/completions` 让模型给相关性分）；两层都失败 → 安全回退为原 `hybridScore` 顺序，**绝不让整条检索链路崩**。
  - 分数合并（`reranking-providers.ts:135`）：`finalScore = clampScore(hybridScore*0.7 + rerankScore*0.3)`，clamp 到 0..1，避免不同尺度污染加权。
  - `createRerankerFromEnv`（`:366`）：rerank provider 未启用 → **返回 `null`**（不再回退 `HeuristicReranker`）；
    `HeuristicReranker` 仍作为 `HybridRetriever` 的内置保底存在——那是检索器自身行为，不是 provider 级静默兜底。
- `packages/rag/src/types.ts`：`Reranker` 接口（`:156`）——`rerank(results)` 返回带 `scoreBreakdown.rerankScore`/`finalScore` 的结果，纯函数式、可测试。

**参考实现·业界对应物**：Cohere `rerank` / Jina `rerank` 的"两阶段检索"（BM25+向量召回 → cross-encoder 精排）是 2024–2025 RAG 标配；本仓库用"优先 `/rerank`，否则 LLM-judge 兜底"对齐该思想，且不绑定单一厂商。

**学习检查点**
- 为什么 rerank 必须"失败即降级"而不是抛错？rerank 是检索链路的**增强**而非必须；一旦外部 rerank 服务抖动就拖垮问答，是典型生产事故。分层兜底（rerank→judge→hybridScore）是把"增强"与"必需"解耦的工程纪律。
- `finalScore` 加权为什么是 0.7/0.3？hybrid 召回分是召回阶段已稳定的信号，rerank 是精排修正，给召回更高权重避免精排过拟合；这是个可调超参，注释里写清楚 why。

---

## 3. P3 pgvector 生产化（★★ 持久化升级）

**读什么**
- `packages/database/src/vector-store-factory.ts`
  - `createVectorStoreFromEnv`（`:32`）：**有 `DATABASE_URL` → 生产走 PostgreSQL pgvector**；否则退化为内存 `VectorStore`（仅单测/eval/本地 demo）。这是组合根的注入边界。
  - `allowedDimensions: [dimensions]`（`:47`）：pgvector 分支显式声明允许维度集合（而非宽松 `"any"`），让维度不匹配在入库前就以**结构化错误**暴露，而不是在 SQL 层炸出难懂的报错。
  - `normalizeEmbeddingModel()`（`:60`）：组合根在 embedding provider 关闭时读到的是**空串**，`??` 只兜 `undefined` 兜不住 `""`，
    这里把空串/纯空白显式归一为"未配置"再回退 fixture 默认模型，避免 pgvector 侧把 `embedding_model` 记成 `""`。
- `packages/database/src/rag-vector-store.ts`
  - `validateChunks`（`:333`）：按 `allowedDimensions` 判定——`"any"` 接受任意有限向量；数组则要求成员；否则等于 `options.dimensions`。**`databaseFailure()`（`:509`）保证 DB 异常不泄漏 SQL**，统一转成 `RagStructuredError`。
  - 列维度固定 1536：与 P1 的真实 embedding 维度契约一致。
- `packages/database/migrations/0070_rag_vector_dimensions.sql`
  - `vector(1536)`（`:40`）、`TRUNCATE chunk_embeddings`（`:37`，**一次性、潜在数据丢失**，已写 release note 注释 `:23-25`）。
  - `COMMENT ON COLUMN`（`:57-59`）：按本仓库数据库硬规则，每个受改字段都有准确中文注释（含"非 1536 维度需新增迁移重建列"的限制说明）。

**参考实现·业界对应物**：pgvector 是 Postgres RAG 生产落地的主流选择（对标 Pinecone/Qdrant 的自托管替代）；HNSW 索引 + cosine 距离检索是标准做法。本仓库把"维度契约"用迁移 + 运行时校验双重守住。

**学习检查点**
- 为什么 `DATABASE_URL` 缺失就退内存？内存实现来自 `@aiagent/rag`，`database` 只消费其类型与工厂——**database 不反向依赖 rag 的运行时细节**，仅通过 `VectorStore` 接口消费（值依赖单向）。
- 阻塞项复盘（已修复）：早期 `validateChunks` 忽略 `allowedDimensions` 且 pgvector 硬编码 1536，而 mock embedding 是 32 维 → 真实 1536 列与 32 维向量不匹配。修复后 `allowedDimensions:[dimensions]` 让该 misconfiguration 在入库前以清晰结构化错误暴露（提示"配置 provider 环境变量 `AIAGENT_EMBEDDING_*` 与 `AIAGENT_EMBEDDING_DIMENSIONS` 或去掉 DATABASE_URL"），而非 SQL 层崩溃。
- 迁移为什么带"数据丢失"注释？`TRUNCATE` 遗留 32 维向量不可原地 resize；诚实标注一次性、可重摄取恢复，是生产迁移的基本操守。

---

## 4. P4 PDF/表格解析 + Contextual Retrieval（★★★  ingestion 升级）

> 注：`packages/parsing` 的 `parsers/` 目录与 Facade 结构是 P0 前置改造引入的（见 `docs/v1.1/06-chat-attachments.md` §4），本节路径已按当前代码同步。

**读什么**
- `packages/parsing/src/parsers/pdf.ts`（PDF 格式 adapter，registry 里一个可替换 parser；子进程源码拆到 `pdf-worker.ts`）
  - `ParsedBlock`（`types.ts:20`）：带 `pageNumber` / `metadata.isTableRow` / `metadata.tableColumnCount` 的解析草稿，保留"第几页/第几行/是否表格"位置线索，供 chunk / citation 溯源。
  - `PDF_WORKER_SOURCE`（`pdf-worker.ts:16` 常量）：子进程源码——**为什么用子进程？** `ingestDocument` 边界是同步契约（rag runtime 同步调用），但 pdf.js 解析是异步重 CPU；把解析放进独立 Node 子进程、用 `execFileSync` 同步回收，既不改调用约定也把失败收敛为结构化错误。
  - `parsePdfBlocks`（`parsers/pdf.ts:22`）：写临时 PDF → 子进程 `pdfParse` → 逐页按 `y` 坐标聚行 → 回传 `{ pages }`。**已知坑（已修）**：Node 26 下 `readFileSync` 返回 buffer-pool `Buffer`（`byteOffset≠0`），pdf.js 直接读底层 `ArrayBuffer` 会读错内存 → 已用 `new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)` 包成独立切片。
  - `buildPdfBlocks`（`parsers/pdf.ts:62`）/`isTableRow`（`parsers/pdf.ts:108`）/`countTableColumns`（`parsers/pdf.ts:129`）：表格行单独成块打标（多列空格 / 制表符 / `|`），便于上层区分"叙述"与"表格行"。
- `packages/parsing/src/parse-document.ts`：`ingestDocument`（Facade 公共入口，委托 `parseDocument()` 做 detect → resolve → parse → assemble），PDF 走 `parsePdfBlocks`，解析失败返回 `parse_failed` 结构化错误（不再有 `pdf_parser_not_configured` 缺口）；`packages/parsing/src/index.ts` 现为纯 re-export barrel。
- `packages/rag/src/contextual-retrieval.ts`
  - `createContextualChunkEnricher`（`:29`）：给每个 chunk 前拼接一段 **LLM 生成的 doc 级上下文前缀**（Anthropic 2024 "Contextual Retrieval"），提升检索命中率。
  - `createNoopContextualEnricher`（`packages/rag/src/testing.ts`，由 `contextual-retrieval.ts:60` re-export 保留历史导入路径）：恒等测试替身。
  - `createLlmContextPrefixGenerator`（`:81`）/ `createContextEnricherFromEnv`（`:148`，**LLM provider 未启用时返回 `null`**，不再回退 noop）。

**参考实现·业界对应物**：Anthropic "Contextual Retrieval"（先给 chunk 补一段文档上下文再 embed）显著降检索漏召；PDF 表格抽取对齐 unstructured.io / LlamaParse 的"保留版面结构"思路。本仓库用 `pdf-parse` + 坐标聚合行，零新增重依赖。

**学习检查点**
- 为什么 ingestion 边界保持同步、把重解析丢给子进程？保持 rag runtime 调用约定不变（不强制全链路 async），同时把不可控的第三方解析失败收敛为结构化错误——边界清晰、可测试。
- 为什么把 PDF 解析独立成 `parsers/pdf.ts`？P0-2 把解析层收敛为 Facade + Registry + 每格式 adapter：`parse-document.ts` 只做 detect → resolve → parse → assemble，PDF 的实现细节（子进程 + 坐标聚行）隔离在 `parsers/pdf.ts` + `pdf-worker.ts`；公共 API 仍从 `index.ts`（纯 re-export）原样透出，导入方零修改。

---

## 5. P5 Agentic 检索改写 + RAGAS/LLM-Judge 校准（★★★ 检索与评测升级）

**读什么**
- `packages/rag/src/query-rewrite.ts`
  - `createQueryRewriter`（`:50`）：改写接口与"可选增强"装配壳。
  - `createNoopQueryRewriter`（`packages/rag/src/testing.ts`，由 `query-rewrite.ts:66` re-export）：恒等测试替身（默认不改写，保持链路稳定）。
  - `createLlmQueryRewriter`（`:131`）：用 LLM 把用户口语/多轮上下文改写成更利于检索的 query（agentic retrieval）。
  - `createQueryRewriterFromEnv`（`:189`）：**LLM provider 未启用时返回 `null`**，不再回退 noop。
- `packages/eval/src/judge.ts`
  - `createLlmJudge`（`:133`）：judge provider 启用时返回 `LlmJudge`（`judgeFaithfulness` / `judgeContextRecall`，接口定义 `:48` / `:57`）做 RAGAS 对齐判定（忠实度 / 上下文召回）；**未启用时返回 `null`**。
  - 容错兜底：`NEUTRAL_SCORE = 0.5`（`:68`）；已启用 judge 的真实调用解析失败仍降级为中性分，不抛异常。
  - 中性分测试替身：`packages/eval/src/testing.ts` 的 `createNeutralLlmJudge()`，供测试显式注入"judge 已禁用"的基线。
- `packages/eval/src/runner.ts`
  - `runRagEvalWithJudge`（`:70`）：把 judge 结果接入 `computeRagMetrics`（`packages/eval/src/metrics.ts:120`，4 个确定性指标不变 + 可选 judge 分数），保证历史回归基线不被破坏。
- `packages/rag/src/types.ts`：`DataSourceRuntimeOptions`（`:258`）已扩展可选 `reranker` / `contextEnricher` / `queryRewriter`。

**参考实现·业界对应物**：RAGAS（faithfulness / context_recall / context_precision）是 RAG 评测事实标准；"agentic query rewrite" 对齐 2025 主流（用 LLM 改写 query 提升召回）。本仓库把 judge 分数作为"可选增强"叠加在确定性指标之上，避免评测本身变成不可复现的 LLM 黑盒。

**学习检查点**
- 为什么 query rewrite / judge 在 provider 未启用时返回 `null` 而不是"恒等 / 中性"？恒等改写与中性分都**看起来正常却毫无信息量**，会把"provider 没配"伪装成"增强已运行、结果一般"。返回 `null` 让调用方（组合根 / 测试）明确知道能力缺席；需要可复现的恒等/中性行为时，显式注入 `testing.ts` 的测试替身。
- 为什么 judge **已启用但调用失败**仍降级中性分而不是报错？评测不应因 judge 抖动而整体失败；此时给中性分并附 reason，让确定性指标继续说话——这是"能力缺席（null）"与"能力运行中失败（降级）"两种不同语义的区分。

---

## 6. 组合根：P1–P5 如何被装配（最该动手读的一节）

**读什么**
- `packages/rag/src/data-source-runtime.ts`
  - 构造期保存三个可选增强（`:112-114`）：`this.reranker` / `this.contextEnricher` / `this.queryRewriter`。
  - `ingest`（`:130`）在 chunk 与 embed 之间调用 `contextEnricher`（`:252-253`）注入 doc 前缀；
    **构造期未注入 `embeddingClient` 时直接返回 `embedding_provider_disabled` 结构化错误**（`:134-144`，绝不生成 mock 向量）。
  - `createRetriever`（`:427`）把 `reranker` 透传给 `createHybridRetriever`（`:459`）；同样要求 `embeddingClient` 已注入。
  - `search`（`:336`）/ `answer`（`:371`）在 retrieve 前调用 `queryRewriter`（`:344` / `:379`）改写 query。
- `apps/finance-api/src/server.ts`（唯一生产组合根）
  - `readLlmProviderConfig()`（`server.ts:47`）→ 模型目录 profile（id 沿用 `bridge_ai`，配置来源已切到统一 `AIAGENT_LLM_*`）；
    `readEmbeddingProviderConfig()` / `readRerankProviderConfig()` / `readJudgeProviderConfig()`（readiness 内）→ 三组 RAG provider 的启用状态。
  - `createDataSourceRuntime({ embeddingClient: createEmbeddingClientFromEnv() ?? undefined, reranker: createRerankerFromEnv() ?? undefined, contextEnricher: createContextEnricherFromEnv() ?? undefined, queryRewriter: createQueryRewriterFromEnv() ?? undefined, vectorStoreFactory: createVectorStoreFromEnv(...) })`（`:160-174`）：**四件套 + 向量库全部 env 驱动工厂注入**，`null` 归一为"未注入"；向量库的 `embeddingModel` / `dimensions` 直接来自同一份 Embedding provider 配置，不再硬编码 mock 模型或 1536。
  - readiness（`:188-221`）：返回 `RAG providers — embedding:on/off rerank:on/off judge:on/off`，未配置的 provider 以 `providerNote` 显式点名，不再静默降级。

**学习检查点**
- 为什么"组合根"是唯一读 env 的地方？`rag` / `database` / `parsing` 包**不读 `DATABASE_URL` / provider 变量**——env 解析集中在 `server.ts` 与 `provider-config.ts` 的读取函数，领域包保持纯净、可单测（依赖倒置的落点）。
- 为什么四个 `fromEnv` 改成"可用即返回、不可用即 `null`"，降级决策交给组合根？工厂只回答"provider 是否可用"，不再替调用方猜一个默认值。这样 P1–P5 仍能"接口已就绪、只换实现"，但**默认链路的缺失是显式的**：本地/CI 要可复现就注入测试替身，生产要可靠就在 readiness 看到 on/off。

---

## 8. 最小可演示路径（动手顺序建议）

1. `pnpm --filter @aiagent/rag test`：看 70 个用例（含 rerank 三层兜底、query rewrite、contextual 注入的链路行为，
   以及"provider 未启用时 `createRerankerFromEnv()` 返回 `null`"）。
2. `pnpm --filter @aiagent/parsing test`：看 12 个用例（含真实 PDF 解析出带页码/表格标记的 block，以及"无效 PDF 返回结构化错误"的缺口闭合）。
3. `pnpm --filter @aiagent/eval test`：看 62 个用例（含 `judgeFaithfulness`/`judgeContextRecall` 的容错、
   "judge provider 未启用时 `createLlmJudge()` 返回 `null`"，以及与历史基线的回归门禁）。
4. `pnpm --filter @aiagent/database test`：5 个通过、22 个 skip（需 live Postgres）；重点看迁移编号检查。本地起 Postgres：`pnpm db:up && pnpm db:migrate`，再跑可观察 pgvector 路径。
5. `pnpm --filter @aiagent/finance-api test`：28 个用例、25 通过 / 0 失败 / 3 skip（skip 为需 live Postgres 的续传与 compaction 用例）。
   测试装配器 `apps/finance-api/src/adapters/in-memory-test-runtime.ts:54` **显式注入** `createDeterministicMockEmbeddingClient()`
   ——这是"测试替身显式注入"的样板，生产组合根走 `server.ts` 的真实 provider。
6. `pnpm --filter @aiagent/report test`：13 个用例全通过。注意 `runReportWorkflow` / `createReportTool` 的
   `dataSourceRuntime` 已是**必填**（`packages/report/src/workflow-types.ts:28` / `:49`），report 包内不再自建 runtime。
7. 想看真实 provider 热插拔：在 `.env` 分别设置四组变量——`AIAGENT_LLM_*`（baseUrl/apiKey/model，改写与 chat 共用）、
   `AIAGENT_EMBEDDING_*`（含 `AIAGENT_EMBEDDING_DIMENSIONS=1536`）、`AIAGENT_RERANK_*`、`AIAGENT_JUDGE_*`；
   `server.ts` 组合根即装配对应真实客户端，readiness 返回各 provider 的 on/off，无需改码。

> 验收回执：reviewer 复核 **GO**；全量 `pnpm typecheck`（`tsc -b` 顺序构建）通过；
> rag 70 / eval 62 / parsing 12 / database 5 通过（22 skip 为无 DB 预期）/ api 25 通过（3 skip）/ report 13 通过，全部 **0 fail**。
> B-1 破坏性变更（`createDataSourceRuntime()` 不再自带 embedding 默认值）已同步到全部 6 个裸调用点，
> 测试侧一律显式注入 `testing.ts` 测试替身，生产侧一律改为调用方注入。
> 软 follow-up 已闭合：原 `parsing/src/index.ts` 约 545 行，P0-2 结构收敛后已退化为纯 re-export barrel（PDF/markdown/txt 解析各自拆入 `parsers/`）。
