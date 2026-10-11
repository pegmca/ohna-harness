# 02 · RAG 与知识层生产化

> 维度：RAG / Retrieval / Knowledge Layer
> 现状：`packages/rag` 架构完整（chunking / embedding(mock) / vector-store(内存为主) / retrieval(hybrid heuristic) / answer(deterministic) / citation），
> 但**数据全 mock、无真实 embedding、无 cross-encoder rerank、默认内存向量库、PDF 解析未配置**。

## 1. 行业现状速览（2025–2026）

1. **混合检索 + Cross-Encoder 重排**是精度提升最成熟、ROI 最高的工程路径：Bi-Encoder 大范围召回，Cross-Encoder（BGE-Reranker-v2-m3 / Cohere）精排 Top-K。
2. **Contextual Retrieval（Anthropic）**：为每个 chunk 拼接文档级上下文再 embedding，比调 chunk size 收益高得多。
3. **Long-context vs RAG**：2025 进入实践检验——长上下文适合固定格式、延迟成本不敏感的审查类场景；RAG 在成本/延迟/可溯源上仍胜出，二者分层（RAG 召回 + 长上下文精读），非替代。
4. **Agentic / Self-RAG**：检索由 agent 决策（多跳、query 改写、迭代），GraphRAG 补足实体关系问答。
5. **Eval 标准化**：RAGAS（faithfulness / answer relevance / context precision / context recall）进 CI，LLM-as-judge 成标配。

## 2. 本项目差距

- 真实 embedding 缺失（`embedding.ts` deterministic mock，同文本恒等、无语义）。
- 真实 rerank 缺失（`retrieval.ts` heuristic，非模型）。
- 默认内存向量库，pgvector 非默认。
- PDF/表格解析为 `pdf_parser_not_configured` 结构化错误（`packages/filings` 缺口）。
- citation 仅 coverage，无 entailment / faithfulness 校验。
- 无 query 改写/分解、无 RAGAS、无 LLM-as-judge、无人工标注。

## 3. 改造方向（按优先级）

### P1 接真实 EmbeddingClient（难度★，收益★）
- **目标**：实现 `types.ts:68` 接口，换 OpenAI/通义/bge-m3；维度升到 1024/1536，`upsertChunks` 与 trace 零改动。
- **落地**：仅新增一个实现 `EmbeddingClient` 的类，注入 `createDataSourceRuntime` 的 `embeddingClient` 选项。

### P2 接 Cross-Encoder Reranker（难度★，收益★）
- **目标**：实现 `types.ts:154` `Reranker`，本地跑 `bge-reranker-v2-m3`（ONNX）或 Cohere API，替换 `HeuristicReranker`；hybrid 0.65/0.35 负责召回、模型负责精排。
- **落地**：新增 `Reranker` 实现，`createHybridRetriever` 注入。

### P3 升级 VectorStore 为 pgvector/Qdrant（难度★★）
- **目标**：实现 `types.ts:124`，内存版收编为测试 fixture；加 HNSW 索引与 `documentId` filter。
- **落地**：本项目已有 pgvector adapter，使其在生产 composition 中默认启用。

### P4 PDF/表格解析 + Contextual Retrieval（难度★★★）
- **目标**：填 filings 缺口；ingest 时调 LLM 生成 chunk 上下文前缀，经挂载点①（`grounding-hook.ts`）注入。

### P5 Agentic 检索 + RAGAS 校准（难度★★★）
- **目标**：加 query 改写节点；eval 接 LLM-as-judge，对齐 faithfulness / context recall。

> **接口已就绪、只换实现的高性价比点：P1、P2、P3。**

## 4. 学习路径（TS 强）

- **阶段一（架构）**：读 `types.ts` 四个边界 + `retrieval.ts` hybrid 流程；写真实 embedding client 实现并跑通现有 30 case。
- **阶段二（精排）**：本地部署 bge-reranker ONNX，实现 `Reranker`；对比 heuristic vs 模型 rerank 的 hit rate 差异。
- **阶段三（持久化）**：实现 pgvector `VectorStore`，内存版降级为 eval fixture。
- **阶段四（解析+上下文）**：接 PDF 解析，做 Contextual Retrieval 前缀。
- **阶段五（评估闭环）**：加 query 改写 + LLM-as-judge，用 RAGAS 四指标校准 eval 套件。
- **产出**：可替换的真实栈 PR + `` 学习笔记。

