# 02 · RAG 与知识层生产化

> 维度：RAG / Retrieval / Knowledge Layer
> 现状：`packages/rag` 架构完整（chunking / embedding / vector-store / retrieval(hybrid) / answer / citation），
> P1–P5 接口与实现均已就绪：真实 OpenAI 兼容 embedding / rerank / contextual-enricher / query-rewriter
> 通过依赖倒置注入，`DATABASE_URL` 存在时向量库走 pgvector，PDF 解析缺口已闭合。
>
> **v1.1 provider 改造**：原 `bridge-config.ts` 的"bridge 统一收口"已拆成 **四个相互独立的 provider**
> ——LLM / Embedding / Rerank / Judge——各有独立 endpoint（baseUrl / apiKey / model）与 `enabled` 开关；
> **生产路径不再静默回退 mock**：provider 未启用即 disabled（`fromEnv` 工厂返回 `null`）；
> Embedding 未注入时 `DataSourceRuntime.ingest()` 返回结构化 `embedding_provider_disabled`，不会写入 mock 向量。
> mock 实现降级为 `packages/rag/src/testing.ts`、`packages/eval/src/testing.ts` 的测试替身，由测试显式注入。

## 1. 行业现状速览（2025–2026）

1. **混合检索 + Cross-Encoder 重排**是精度提升最成熟、ROI 最高的工程路径：Bi-Encoder 大范围召回，Cross-Encoder（BGE-Reranker-v2-m3 / Cohere）精排 Top-K。
2. **Contextual Retrieval（Anthropic）**：为每个 chunk 拼接文档级上下文再 embedding，比调 chunk size 收益高得多。
3. **Long-context vs RAG**：2025 进入实践检验——长上下文适合固定格式、延迟成本不敏感的审查类场景；RAG 在成本/延迟/可溯源上仍胜出，二者分层（RAG 召回 + 长上下文精读），非替代。
4. **Agentic / Self-RAG**：检索由 agent 决策（多跳、query 改写、迭代），GraphRAG 补足实体关系问答。
5. **Eval 标准化**：RAGAS（faithfulness / answer relevance / context precision / context recall）进 CI，LLM-as-judge 成标配。

## 2. 本项目差距（已闭合项 + 仍存在的缺口）

**已闭合**：
- 真实 embedding：`embedding-providers.ts` 的 `createOpenAiCompatibleEmbeddingClient`（POST `/embeddings`）。
- 真实 rerank：`reranking-providers.ts` 的 `createOpenAiCompatibleReranker`（`/rerank`，失败回退 LLM-judge）。
- pgvector：有 `DATABASE_URL` 即走 PostgreSQL，维度契约由 `DEFAULT_PRODUCTION_EMBEDDING_DIMENSIONS = 1536` 单一真相源约束。
- PDF/表格解析：`packages/parsing` 已用 `pdf-parse` + 子进程闭合，解析失败返回结构化 `parse_failed`。
- query 改写 / decomposition：`query-rewrite.ts` 的 `createLlmQueryRewriter`。
- LLM-as-judge：`packages/eval` 的 `judge.ts` / `judge-loop.ts`（RAGAS 对齐的 faithfulness / context recall）。

**仍存在的缺口**：
- citation 仅 coverage，无 entailment / faithfulness 校验。
- Embedding provider 未启用时，ingest 返回 `embedding_provider_disabled`，不会生成或写入 mock 向量；Rerank 未启用时检索器仍使用内建启发式排序，且 readiness 会显式报告能力状态。
- 无人工标注闭环、benchmark 仅自有 30 case。

## 3. 改造方向（按优先级）

### P1 接真实 EmbeddingClient（难度★，收益★）— ✅ 已落地
- **目标**：实现 `types.ts` 的 `EmbeddingClient` 接口，换 OpenAI/通义/bge-m3；维度升到 1024/1536，`upsertChunks` 与 trace 零改动。
- **落地**：`embedding-providers.ts` 新增实现，注入 `createDataSourceRuntime` 的 `embeddingClient` 选项。
- **配置**：`AIAGENT_EMBEDDING_BASE_URL` / `AIAGENT_EMBEDDING_API_KEY` / `AIAGENT_EMBEDDING_MODEL` / `AIAGENT_EMBEDDING_DIMENSIONS`（默认 1536）。
  由 `readEmbeddingProviderConfig()` 读取；`enabled=false` 时 `createEmbeddingClientFromEnv()` **返回 `null`（不再静默回退 deterministic mock）**。

### P2 接 Cross-Encoder Reranker（难度★，收益★）— ✅ 已落地
- **目标**：实现 `types.ts` 的 `Reranker`，本地跑 `bge-reranker-v2-m3`（ONNX）或 Cohere API，替换 `HeuristicReranker`；hybrid 负责召回、模型负责精排。
- **落地**：`reranking-providers.ts` 新增 `Reranker` 实现，`createHybridRetriever` 注入（`/rerank` 非 2xx 自动回退 LLM-judge）。
- **配置**：`AIAGENT_RERANK_BASE_URL` / `AIAGENT_RERANK_API_KEY` / `AIAGENT_RERANK_MODEL`；`enabled=false` 时 `createRerankerFromEnv()` 返回 `null`，
  由 `HybridRetriever` 内置 `HeuristicReranker` 保底（这是检索器自带行为，不是 provider 级静默兜底）。

### P3 升级 VectorStore 为 pgvector/Qdrant（难度★★）— ✅ 已落地
- **目标**：实现 `types.ts` 的 `VectorStore`，内存版收编为测试 fixture；加 HNSW 索引与 `documentId` filter。
- **落地**：pgvector adapter 已在生产 composition 中默认启用（有 `DATABASE_URL` 即生效）。

### P4 PDF/表格解析 + Contextual Retrieval（难度★★★）— ✅ 已落地
- **目标**：填 parsing 缺口；ingest 时调 LLM 生成 chunk 上下文前缀，经挂载点①（`grounding-hook.ts`）注入。
- **配置**：上下文前缀复用 LLM provider 的 `AIAGENT_LLM_*`；未启用时 `createContextEnricherFromEnv()` 返回 `null`（chunk 保持原样）。

### P5 Agentic 检索 + RAGAS 校准（难度★★★）— ✅ 已落地
- **目标**：加 query 改写节点；eval 接 LLM-as-judge，对齐 faithfulness / context recall。
- **配置**：改写复用 LLM provider 的 `AIAGENT_LLM_BASE_URL` / `AIAGENT_LLM_API_KEY` / `AIAGENT_LLM_MODEL`；
  judge 走独立的 `AIAGENT_JUDGE_BASE_URL` / `AIAGENT_JUDGE_API_KEY` / `AIAGENT_JUDGE_MODEL`。
  两者 `enabled=false` 时对应工厂返回 `null`，judge 信号缺席（而非伪装成中性分基线）。

### provider 配置契约（v1.1 新增，取代原 bridge 统一收口）

| provider | 环境变量 | 读取函数 | 未启用（`enabled=false`）时 |
| --- | --- | --- | --- |
| LLM（chat / enricher / rewriter） | `AIAGENT_LLM_BASE_URL` `AIAGENT_LLM_API_KEY` `AIAGENT_LLM_MODEL` | `readLlmProviderConfig` | 组合根不注入 LLM 增强项 |
| Embedding | `AIAGENT_EMBEDDING_BASE_URL` `AIAGENT_EMBEDDING_API_KEY` `AIAGENT_EMBEDDING_MODEL` `AIAGENT_EMBEDDING_DIMENSIONS` | `readEmbeddingProviderConfig` | `createEmbeddingClientFromEnv()` → `null` |
| Rerank | `AIAGENT_RERANK_BASE_URL` `AIAGENT_RERANK_API_KEY` `AIAGENT_RERANK_MODEL` | `readRerankProviderConfig` | `createRerankerFromEnv()` → `null` |
| Judge | `AIAGENT_JUDGE_BASE_URL` `AIAGENT_JUDGE_API_KEY` `AIAGENT_JUDGE_MODEL` | `readJudgeProviderConfig` | `createLlmJudge()` / `createLoopLlmJudge()` → `null` |

- 四组变量**互不共享**：包括 model 在内，缺某一组只禁用对应能力，不影响其它 provider。
- 变量名集中在 `packages/rag/src/provider-config.ts` 的 `PROVIDER_ENV`，避免各处硬编码产生命名漂移。
- `enabled` 判定统一要求 `baseUrl`、`apiKey` 与本 provider 的 `model` 同时非空；Embedding/Rerank 不继承 chat model，
  避免把 chat 模型名误发到 `/embeddings` 或 `/rerank`。组合根 `apps/finance-api/src/server.ts` 的 readiness
  会显式报告 `embedding/rerank/judge` 的 on/off，避免"配了却没生效"的静默降级。

> **接口已就绪、只换实现的高性价比点：P1、P2、P3。**

## 4. 学习路径（TS 强）

- **阶段一（架构）**：读 `types.ts` 四个边界 + `retrieval.ts` hybrid 流程；读 `provider-config.ts` 的四组 provider 契约。
- **阶段二（精排）**：本地部署 bge-reranker ONNX，实现 `Reranker`；对比 heuristic vs 模型 rerank 的 hit rate 差异。
- **阶段三（持久化）**：实现 pgvector `VectorStore`，内存版降级为 eval fixture；核对 1536 维契约。
- **阶段四（解析+上下文）**：接 PDF 解析，做 Contextual Retrieval 前缀。
- **阶段五（评估闭环）**：加 query 改写 + LLM-as-judge，用 RAGAS 四指标校准 eval 套件。
- **阶段六（provider 治理）**：在 `.env` 分别配齐 `AIAGENT_LLM_*` / `AIAGENT_EMBEDDING_*` / `AIAGENT_RERANK_*` / `AIAGENT_JUDGE_*`，
  观察 readiness 的 provider on/off 与"未启用即 disabled"的结构化行为。
- **产出**：可替换的真实栈 PR + `` 学习笔记。

