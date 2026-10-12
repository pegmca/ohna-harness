# 带读路线：RAG 生产化（P1–P5，v1.1）

> 配套文档：`docs/v1.1/02-rag-production.md`（需求：P1 真实 Embedding / P2 Cross-Encoder Reranker / P3 pgvector / P4 PDF+Contextual Retrieval / P5 Agentic 检索+RAGAS 校准）
> 实现仓库：`.`（pnpm monorepo，strict TS，ESM）
> 本路线按"接口已就绪 → 只换实现 → 装配进组合根"的顺序，把代码位置、设计思想、业界对应物、学习检查点串起来。
> 读法建议：先通读一节的理论，再打开对应 `file_path:line` 读源码，最后回看该节的「学习检查点」。
> 状态：P1–P5 已实现，reviewer 复核 **GO**（1 个阻塞项 + 若干 minor 已全部修复，仅 filings `index.ts` ~545 行作为软 follow-up）。

---

## 0. 全局心智模型（先看这张图）

```
                        真实 provider 统一收口（依赖倒置）
   ┌──────────────────────────────────────────────────────────────┐
   │  packages/rag/src/bridge-config.ts  (BRIDGE_ENV / readBridgeConfig) │
   │  → 所有真实 embedding / rerank / judge 客户端只读这一组环境变量         │
   │  → 缺 key 时 enabled=false，调用方回退 mock / 启发式 / 恒等            │
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
   │  Filings            (P4)  filings: PDF/表格解析（pdf.ts）          │
   │  Eval/Judge         (P5)  eval: LLM-as-judge + RAGAS 指标        │
   └─────────────────────────────────────────────────────────────────┘
                        组合根：apps/api/src/server.ts（env 驱动装配）
```

**一句话**：`rag` 包的 `EmbeddingClient` / `VectorStore` / `Reranker` / `Retriever` 接口在 foundation 阶段就已稳定（`types.ts`），本次 P1–P5 是"**接口已就绪、只换实现**"——真实 OpenAI 兼容客户端、pgvector、cross-encoder rerank、contextual retrieval、agentic rewrite 全部通过依赖倒置 + env 工厂注入，默认回退 mock/启发式，零外部依赖即可本地跑通。

---

## 1. P1 真实 EmbeddingClient（★ 最值钱的一换）

**读什么**
- `packages/rag/src/bridge-config.ts`
  - `BRIDGE_ENV`（`:16`）：所有 bridge 环境变量名集中在此（`AIAGENT_LLM_BASE_URL_BRIDGE_AI` 等）。
  - `readBridgeEmbeddingConfig`（`:68`）：读取 embedding 端点配置，**维度默认 1536**（`DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS`，`:13`），可由 `AIAGENT_LLM_EMBEDDING_DIMENSIONS_BRIDGE_AI` 覆盖。
  - `readBridgeConfig`（`:41`）：通用 chat/judge 配置，`enabled = baseUrl && apiKey` 非空。
- `packages/rag/src/embedding-providers.ts`
  - `createOpenAiCompatibleEmbeddingClient`（`:37`）：POST `${baseUrl}/embeddings`，把文本批变成向量；非 2xx / 网络异常 → 结构化错误，**不抛原始异常**。
  - `createEmbeddingClientFromEnv`（`:227`）：`enabled` 为假时回退 `createDeterministicMockEmbeddingClient`（**默认 32 维**，保证本地 demo / CI 零外部依赖可复现）。

**参考实现·业界对应物**：LangChain `OpenAIEmbeddings` / Haystack `SentenceTransformersDocumentEmbedder` 同构思路；但本仓库把"真实/ mock 切换"收敛到单个 `fromEnv` 工厂 + 中央 `bridge-config`，比散落各处的 `if (apiKey)` 更利于审计与热插拔。

**学习检查点**
- 为什么维度必须全局一致？P1 真实 embedding 是 1536 维，`database` 的 pgvector 列（`0070` 迁移固定 `vector(1536)`）也必须 1536——这是一处跨包**维度契约**，由 `DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS` 单一真相源约束（见 P3）。
- 为什么 `fromEnv` 默认回退 mock？生产化 ≠ 把 mock 删掉，而是"env 就绪走真实、否则确定性 mock"，保证本地/CI 可跑、真实环境零改码热插拔（依赖倒置）。

---

## 2. P2 Cross-Encoder Reranker（★ 检索排序升级）

**读什么**
- `packages/rag/src/reranking-providers.ts`
  - `createOpenAiCompatibleReranker`（`:68`）：先尝试 `/rerank` 端点；**404 或失败自动回退 LLM-as-judge**（`/chat/completions` 让模型给相关性分）；两层都失败 → 安全回退为原 `hybridScore` 顺序，**绝不让整条检索链路崩**。
  - 分数合并（`reranking-providers.ts:136`）：`finalScore = clampScore(hybridScore*0.7 + rerankScore*0.3)`，clamp 到 0..1，避免不同尺度污染加权。
  - `createRerankerFromEnv`（`:365`）：env 缺失 → 回退 `HeuristicReranker`（恒等/原顺序），无网络调用。
- `packages/rag/src/types.ts`：`Reranker` 接口（`:156`）——`rerank(results)` 返回带 `scoreBreakdown.rerankScore`/`finalScore` 的结果，纯函数式、可测试。

**参考实现·业界对应物**：Cohere `rerank` / Jina `rerank` 的"两阶段检索"（BM25+向量召回 → cross-encoder 精排）是 2024–2025 RAG 标配；本仓库用"优先 `/rerank`，否则 LLM-judge 兜底"对齐该思想，且不绑定单一厂商。

**学习检查点**
- 为什么 rerank 必须"失败即降级"而不是抛错？rerank 是检索链路的**增强**而非必须；一旦外部 rerank 服务抖动就拖垮问答，是典型生产事故。分层兜底（rerank→judge→hybridScore）是把"增强"与"必需"解耦的工程纪律。
- `finalScore` 加权为什么是 0.7/0.3？hybrid 召回分是召回阶段已稳定的信号，rerank 是精排修正，给召回更高权重避免精排过拟合；这是个可调超参，注释里写清楚 why。

---

## 3. P3 pgvector 生产化（★★ 持久化升级）

**读什么**
- `packages/database/src/vector-store-factory.ts`
  - `createVectorStoreFromEnv`（`:28`）：**有 `DATABASE_URL` → 生产走 PostgreSQL pgvector**；否则退化为内存 `VectorStore`（仅单测/eval/本地 demo）。这是组合根的注入边界。
  - `allowedDimensions: [dimensions]`（`:42`）：pgvector 分支显式声明允许维度集合（而非宽松 `"any"`），让维度不匹配在入库前就以**结构化错误**暴露，而不是在 SQL 层炸出难懂的报错。
- `packages/database/src/rag-vector-store.ts`
  - `validateChunks`（`:330`）：按 `allowedDimensions` 判定——`"any"` 接受任意有限向量；数组则要求成员；否则等于 `options.dimensions`。**`databaseFailure()`（`:506`）保证 DB 异常不泄漏 SQL**，统一转成 `RagStructuredError`。
  - 列维度固定 1536：与 P1 的真实 embedding 维度契约一致。
- `packages/database/migrations/0070_rag_vector_dimensions.sql`
  - `vector(1536)`（`:40`）、`TRUNCATE chunk_embeddings`（`:37`，**一次性、潜在数据丢失**，已写 release note 注释 `:23-25`）。
  - `COMMENT ON COLUMN`（`:57-59`）：按本仓库数据库硬规则，每个受改字段都有准确中文注释（含"非 1536 维度需新增迁移重建列"的限制说明）。

**参考实现·业界对应物**：pgvector 是 Postgres RAG 生产落地的主流选择（对标 Pinecone/Qdrant 的自托管替代）；HNSW 索引 + cosine 距离检索是标准做法。本仓库把"维度契约"用迁移 + 运行时校验双重守住。

**学习检查点**
- 为什么 `DATABASE_URL` 缺失就退内存？内存实现来自 `@aiagent/rag`，`database` 只消费其类型与工厂——**database 不反向依赖 rag 的运行时细节**，仅通过 `VectorStore` 接口消费（值依赖单向）。
- 阻塞项复盘（已修复）：早期 `validateChunks` 忽略 `allowedDimensions` 且 pgvector 硬编码 1536，而 mock embedding 是 32 维 → 真实 1536 列与 32 维向量不匹配。修复后 `allowedDimensions:[dimensions]` 让该 misconfiguration 在入库前以清晰结构化错误暴露（提示"配置 bridge 环境变量或去掉 DATABASE_URL"），而非 SQL 层崩溃。
- 迁移为什么带"数据丢失"注释？`TRUNCATE` 遗留 32 维向量不可原地 resize；诚实标注一次性、可重摄取恢复，是生产迁移的基本操守。

---

## 4. P4 PDF/表格解析 + Contextual Retrieval（★★★  ingestion 升级）

**读什么**
- `packages/filings/src/pdf.ts`（从 `index.ts` 抽取的 PDF 专用模块，单一方向依赖 `index.ts → pdf.ts`）
  - `FilingParsedBlock`（`:10`）：带 `pageNumber` / `metadata.isTableRow` / `metadata.tableColumnCount` 的解析草稿，保留"第几页/第几行/是否表格"位置线索，供 chunk / citation 溯源。
  - `PDF_WORKER_SOURCE`（pdf.ts `:33` 常量）：子进程源码——**为什么用子进程？** `ingestFiling` 边界是同步契约（rag runtime 同步调用），但 pdf.js 解析是异步重 CPU；把解析放进独立 Node 子进程、用 `execFileSync` 同步回收，既不改调用约定也把失败收敛为结构化错误。
  - `parsePdfBlocks`（`:74`）：写临时 PDF → 子进程 `pdfParse` → 逐页按 `y` 坐标聚行 → 回传 `{ pages }`。**已知坑（已修）**：Node 26 下 `readFileSync` 返回 buffer-pool `Buffer`（`byteOffset≠0`），pdf.js 直接读底层 `ArrayBuffer` 会读错内存 → 已用 `new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)` 包成独立切片。
  - `buildPdfBlocks`（`:113`）/`isTableRow`（`:189`）/`countTableColumns`（`:210`）：表格行单独成块打标（多列空格 / 制表符 / `|`），便于上层区分"叙述"与"表格行"。
- `packages/filings/src/index.ts`：`ingestFiling`（已退化为壳 + 路由），PDF 走 `parsePdfBlocks`，解析失败返回 `parse_failed` 结构化错误（不再有 `pdf_parser_not_configured` 缺口）。
- `packages/rag/src/contextual-retrieval.ts`
  - `createContextualChunkEnricher`（`:29`）：给每个 chunk 前拼接一段 **LLM 生成的 doc 级上下文前缀**（Anthropic 2024 "Contextual Retrieval"），提升检索命中率。
  - `createNoopContextEnricher`（`:66`）/ `createLlmContextPrefixGenerator`（`:92`）/ `createContextEnricherFromEnv`（`:157`，env 缺失回退 noop）。

**参考实现·业界对应物**：Anthropic "Contextual Retrieval"（先给 chunk 补一段文档上下文再 embed）显著降检索漏召；PDF 表格抽取对齐 unstructured.io / LlamaParse 的"保留版面结构"思路。本仓库用 `pdf-parse` + 坐标聚合行，零新增重依赖。

**学习检查点**
- 为什么 ingestion 边界保持同步、把重解析丢给子进程？保持 rag runtime 调用约定不变（不强制全链路 async），同时把不可控的第三方解析失败收敛为结构化错误——边界清晰、可测试。
- 为什么单列 `pdf.ts`？`filings/src/index.ts` 超过 ~500 行软上限后，按内聚领域拆分（PDF 解析独立成模块），公共 API 通过 `index.ts` 的 `export ... from "./pdf.js"` 原样透出，导入方零修改。

---

## 5. P5 Agentic 检索改写 + RAGAS/LLM-Judge 校准（★★★ 检索与评测升级）

**读什么**
- `packages/rag/src/query-rewrite.ts`
  - `createQueryRewriter`（`:50`）/`createNoopQueryRewriter`（`:70`）：改写接口与恒等实现（默认不改写，保持链路稳定）。
  - `createLlmQueryRewriter`（`:137`）：用 LLM 把用户口语/多轮上下文改写成更利于检索的 query（agentic retrieval）。
  - `createQueryRewriterFromEnv`（`:193`）：env 缺失回退 noop，无网络。
- `packages/eval/src/judge.ts`
  - `createLlmJudge`（`:131`）：返回一个 `LlmJudge`，其 `judgeFaithfulness` / `judgeContextRecall` 方法（接口定义 `:47` / `:56`，工厂体 `createFaithfulnessJudge` / `createContextRecallJudge` 在 `:182` / `:219`）做 RAGAS 对齐判定（忠实度 / 上下文召回）。
  - 容错兜底：`NEUTRAL_SCORE = 0.5`（`:67`）；解析失败或 bridge env 缺失一律降级为中性分（`:88/:188/:203/:208/:227/:240/:243`），不抛异常、不发起网络。
- `packages/eval/src/runner.ts`
  - `runRagEvalWithJudge`（`:70`）：把 judge 结果接入 `computeRagMetrics`（`packages/eval/src/metrics.ts:120`，4 个确定性指标不变 + 可选 judge 分数），保证历史回归基线不被破坏。
- `packages/rag/src/types.ts`：`DataSourceRuntimeOptions`（`:258`）已扩展可选 `reranker` / `contextEnricher` / `queryRewriter`。

**参考实现·业界对应物**：RAGAS（faithfulness / context_recall / context_precision）是 RAG 评测事实标准；"agentic query rewrite" 对齐 2025 主流（用 LLM 改写 query 提升召回）。本仓库把 judge 分数作为"可选增强"叠加在确定性指标之上，避免评测本身变成不可复现的 LLM 黑盒。

**学习检查点**
- 为什么 query rewrite / judge 必须"env 缺失即恒等/中性"？评测与检索增强都依赖外部 LLM，本地/CI 必须仍能跑且结果可复现——这是"生产化但不绑架默认链路"的同一原则。
- 为什么 judge 失败降级中性分而不是报错？评测不应因 judge 抖动而整体失败；忠实度缺失时给中性分，让确定性指标继续说话（结构化兜底）。

---

## 6. 组合根：P1–P5 如何被装配（最该动手读的一节）

**读什么**
- `packages/rag/src/data-source-runtime.ts`
  - 构造期保存三个可选增强（`:113-115`）：`this.reranker` / `this.contextEnricher` / `this.queryRewriter`。
  - `ingest`（`:131`）在 chunk 与 embed 之间调用 `contextEnricher`（`:241-242`）注入 doc 前缀。
  - `createRetriever`（`:416`）把 `reranker` 透传给 `createHybridRetriever`（`:441`）。
  - `search`（`:325`）/ `answer`（`:360`）在 retrieve 前调用 `queryRewriter`（`:333` / `:368`）改写 query。
- `apps/api/src/server.ts`（唯一生产组合根）
  - `bridgeAiRuntime`（`:43`）：baseUrl 已去掉硬编码 IP，改用 `process.env[BRIDGE_ENV.baseUrl]`，缺省回退环境变量。
  - `createDataSourceRuntime({ embeddingClient: createEmbeddingClientFromEnv(), reranker: createRerankerFromEnv(), contextEnricher: createContextEnricherFromEnv(), queryRewriter: createQueryRewriterFromEnv(), vectorStoreFactory: createVectorStoreFromEnv(...) })`（`:149-154`）：**四件套 + 向量库全部 env 驱动工厂注入**，mock/启发式为默认，真实 provider 热插拔。

**学习检查点**
- 为什么"组合根"是唯一读 env 的地方？`rag` / `database` / `filings` 包**不读 `DATABASE_URL` / bridge 变量**——env 解析集中在 `server.ts` 与 `bridge-config.ts`，领域包保持纯净、可单测（依赖倒置的落点）。
- 为什么四个 `fromEnv` 都是"可选增强 + 默认回退"？新增生产能力零侵入默认链路：没配 bridge → 仍可用确定性 mock/启发式跑通；配了 → 自动升级。这就是 P1–P5 能"接口已就绪、只换实现"而不破坏既有 demo/CI 的根本原因。

---

## 8. 最小可演示路径（动手顺序建议）

1. `pnpm --filter @aiagent/rag test`：看 62 个用例（含 rerank 三层兜底、query rewrite、contextual 注入的链路行为）。
2. `pnpm --filter @aiagent/filings test`：看 12 个用例（含真实 PDF 解析出带页码/表格标记的 block，以及"无效 PDF 返回结构化错误"的缺口闭合）。
3. `pnpm --filter @aiagent/eval test`：看 23 个用例（含 `judgeFaithfulness`/`judgeContextRecall` 的容错与"无 bridge env 中性分"，以及与历史基线的回归门禁）。
4. `pnpm --filter @aiagent/database test`：5 个通过、22 个 skip（需 live Postgres）；重点看迁移编号检查。本地起 Postgres：`pnpm db:up && pnpm db:migrate`，再跑可观察 pgvector 路径。
5. 想看真实 provider 热插拔：在 `.env` 设置 `AIAGENT_LLM_*_BRIDGE_AI` 三组变量（baseUrl/apiKey/model），`server.ts` 组合根即自动从 mock 切到真实 embedding/rerank/judge，无需改码。

> 验收回执：reviewer 复核 **GO**；全量 `tsc -b` 顺序构建通过；rag 62 / eval 23 / filings 12 / database 5 通过（22 skip 为无 DB 预期）。唯一软 follow-up：`filings/src/index.ts` 仍约 545 行（PDF 已拆到 `pdf.ts`，markdown/txt 解析可后续再拆）。
