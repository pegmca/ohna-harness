# 06 · 聊天附件处理（会话级临时 + Redis）

> 维度：Chat Attachment / Ephemeral Retrieval
> 现状：`POST /api/attachments` 只接受 Markdown/TXT 文本（≤10MB），且直接调用
> `dataSourceRuntime.ingest(...)` 写入**用户私有 RAG（Postgres，无 TTL）**；PDF/Word 进不来，
> 也没有"附件 + 内部数据"的跨源问答。
> 目标：附件**会话级临时、不落主库**，与内部数据做**多路召回合并**回答。
>
> 本文统一覆盖两部分：
> - **前置改造**：把 `@aiagent/filings` 正名为 `@aiagent/parsing` 并收敛解析结构（附件需要通用文档解析器）。
> - **附件方案 B**：会话级临时、Redis 存储、多路召回合并。

---

## 1. 场景

用户在对话里附带文件（PDF / Word），然后提问，例如：

> "这份 PDF 的内容和我内部数据的关联是什么？"

拆开是四个动作：**解析 → 定位（临时/持久）→ 双源检索 → 融合回答**。本方案聚焦"附件如何被解析、临时存放、并与内部知识库联合检索"。

## 2. 行业现状速览（2025–2026）

1. **附件默认临时 + TTL**：OpenAI 消息附件挂到 thread 的 vector store，默认 **7 天**过期；Gemini Files API 存 **48 小时**。持久进知识库是**用户显式动作**，不是默认。
2. **按大小路由**：Anthropic 指出知识库 **< 200k token（约 500 页）**时"整库内联 + prompt caching"更快更省（延迟 ↓>2×、成本 ↓最多 90%）。→ 小附件内联、大附件才检索。
3. **跨源关联 = 同索引 + metadata 过滤 + 多路召回合并**（不是把附件与知识库拼成一个大 prompt）。OpenAI vector store 支持 `attributes` 过滤；Microsoft Copilot 是"附件接地 + 企业 Graph 接地"并存。
4. **多模态 vs 文本抽取是成本取舍**：Claude/Gemini 原生 PDF 走视觉混合（能读图表，1500–3000 / 258 tok/页），ChatGPT 普通套餐走文本抽取。
5. **引用形态已标准化**：chunk 级 + 页码/位置 + 原文片段 + 相关性分。

## 3. 决策记录

| # | 决策 | 说明 |
|---|---|---|
| **D1** | 附件 = **会话级临时** | 绑定对话、可过期回收，不污染用户长期知识库 |
| **D2** | **小文件内联 + 大文件入库** | 低于阈值直接进 prompt；超阈值切块+embed 后存临时库 |
| **D3** | 关联 = **多路召回合并** | 附件路 + 内部库路各自 top-k → 合并 rerank → LLM；"跨源对比推理"留作后续增强 |
| **D4** | 临时存储**全部走 Redis（方案 B）** | 不落主库、不上对象存储；Redis TTL 精确过期，零清理任务 |
| **D5** | `@aiagent/filings` **保留并正名为 `@aiagent/parsing`** | 附件让解析器从"财报专用"变为"通用文档解析"；包保留（parsing ≠ retrieval），只正名 + 收敛结构 |
| **D6** | 暂不接 docx | 只做 registry + 骨架，docx 插件留到真正需要时再选依赖 |
| **D7** | `@aiagent/parsing` = **薄适配层**（不维护解析引擎） | 解析是商品化能力；只维护"接口 + 映射 + registry"，格式算法尽量交给 OSS，见 4.5 |
| **D8** | PDF 解析后端**暂不定** | 阶段 2 维持 pdf-parse + 手写分行；`PdfParser` 留可替换接口位，后续可换 Docling/unstructured |

> 形态选型：当前产品是 **web SaaS**（学习阶段），不做桌面客户端 / 本地 daemon / 远程容器；附件走服务端 Redis 临时存储。

---

## 4. 前置改造：filings → parsing

### 4.1 为什么必须先做

- 附件场景要求解析器处理**任意用户文件**（PDF/Word），而 `@aiagent/filings` 名字与结构都锁定在"公告/财报"。
- 现状 `ingestFiling` 是 **if/else 硬分支**：加一种格式就要再写一条分支 + 再抄一遍文档组装尾部。
- 这与 D1–D4 的"通用附件解析"目标冲突，故先收敛解析层。

### 4.2 三类符号分层（决定改名的边界）

`filings` 这个词实际盖住了两类不同东西，改名不能一刀切：

| 层 | 内容 | 处置 |
|---|---|---|
| **L1** | 包内解析 API：`ingestFiling`、`detectFilingFileType`、`FilingParsedBlock`、`createFilingsPackageSummary`、`boundary` 字符串、转发别名 | **改** |
| **L2** | 通用解析 DTO 与 rag 消费点：`IngestedFilingDocumentDto`、`FilingFileTypeDto`、`FilingSourceKindDto`、`chunkIngestedFilingDocument` | **改** |
| **L3** | 真正的财报领域概念：`FilingDocumentDto`（带 `ticker`/`reportType`）、`FilingReportTypeDto`、`FilingSourceDto`、`createFilingDocument()` | **删**（仅被自身测试调用） |

> 半改（只改包名）会制造 AGENTS.md 明确反对的"半统一状态"，因此 L1+L2 一并改；L3 是真实财报领域、且只服务一个 demo helper，塞进通用 `parsing` 包不搭，直接删。

### 4.3 改名映射（L1 + L2）

**包**
- `packages/filings/` → `packages/parsing/`，`@aiagent/filings` → `@aiagent/parsing`
- 改 `packages/rag/package.json`（deps + typecheck filter）、`rag/src/data-source-runtime.ts:1`

**L1 包内 API**

| 现名 | 新名 |
|---|---|
| `ingestFiling` / `IngestFilingRequest` | `ingestDocument` / `IngestDocumentRequest` |
| `FilingIngestionOptions` / `FilingIngestionResult` / `FilingIngestionError` / `FilingIngestionErrorCode` | `DocumentIngestion*` |
| `detectFilingFileType` | `detectDocumentFileType` |
| `FilingParsedBlock` | `ParsedBlock` |
| `createFilingsPackageSummary` / `FilingsPackageSummary` | `createParsingPackageSummary` / `ParsingPackageSummary` |
| `boundary: "filing_ingestion_and_raw_text"` | `"document_parsing_and_raw_text"` |
| 别名 `IngestedFilingDocument` | `IngestedDocument` |

**L2 types DTO + rag**

| 现名 | 新名 |
|---|---|
| `IngestedFilingDocumentDto` | `IngestedDocumentDto` |
| `FilingFileTypeDto` | `DocumentFileTypeDto` |
| `FilingSourceKindDto` | `DocumentSourceKindDto` |
| `chunkIngestedFilingDocument` | `chunkIngestedDocument` |
| `types/src/filings.ts` | → `types/src/documents.ts`（同步 barrel `index.ts` 与 `rag.ts:1` 的 `./filings.js` 引用） |

### 4.4 L3 删除

删除 `createFilingDocument`、`FilingDocumentDto`、`FilingReportTypeDto`、`FilingSourceDto` 及其测试用例。

依赖链已验证干净：`FilingSourceDto`/`FilingReportTypeDto` 只被 `FilingDocumentDto` 引用；`createFilingDocument` 只被 `filings.test.mjs:21` 引用；`FilingSourceKindDto` 被 `rag.ts:157`（lineage）引用 → **保留并改名为 L2**。

### 4.5 结构收敛与解析后端选型

**立场：薄适配层——不维护解析引擎，只维护契约**

解析是商品化能力，不值得自研算法；但 RAG citation 依赖一个稳定的 block 模型（`heading`/`pageNumber`/`lineStart`/`isTableRow`），而每个 OSS 解析器都有自己的 DTO（Docling 的 `DoclingDocument`、unstructured 的 `Element`）。因此：

> 删得掉的是**算法**，删不掉的是**契约**。`@aiagent/parsing` 只维护"接口 + 映射 + 注入"，不维护格式解析引擎。

| 立场 | 维护什么 | 结论 |
|---|---|---|
| A 全自研 | 每格式的解析算法 | ❌ 成本高、无差异化 |
| **B 薄适配层** | 接口 + 映射 + registry（约百行） | ✅ **采纳** |
| C 全删 | 什么都不维护 | ❌ 边界交给外部库 DTO，citation 受制于人 |

**开源方案调研（2025–2026）**

统一文档解析器几乎全是 Python；Node 生态只有"每格式一个库"，没有统一门面：

| 工具 | 语言 | 输入 → 输出 | 位置信息 | 备注 |
|---|---|---|---|---|
| **Docling**（IBM） | Python | PDF/DOCX/PPTX/XLSX/HTML → `DoclingDocument` | ✅ `page_no` + `bbox` + 阅读顺序 | 分栏/表格成熟 |
| **unstructured** | Python | 同上 → `Element[]` | ✅ `metadata.page_number` | RAG 生态最广 |
| **MarkItDown**（微软） | Python | 20+ 格式 → Markdown | ❌ 丢页码 | **架构范本**（见下） |
| MinerU | Python | PDF → Markdown | ⚠️ | 中文/学术强 |
| `pdf-parse` | JS | PDF → 纯文本 | ⚠️ 仅行 | 我们已在用 |
| `mammoth` | JS | docx → HTML | ❌ | docx 首选 |
| `officeparser` | JS | docx/xlsx/pptx/odt/pdf | ⚠️ | API 质量待验 |
| `file-type` | JS | magic bytes 检测 | — | 类型检测补强 |

结论：**没有可直接复用的 TS 统一解析器**；但可照搬 MarkItDown 的架构。

**架构范本：MarkItDown（Facade + Converter 链）**

- `MarkItDown` 是 **Facade**：类型检测（扩展名 + magic bytes）→ converter 路由 → 输出
- 每格式一个 `DocumentConverter`，实现统一接口；`convert()` 故意宽松（本地文件 / 远程 URI / 字节流都能接）
- **converter 链 + 回退**：逐个试，全失败才抛 `FileConversionException`
- 插件经 Python entry points 注册，默认关闭
- 维护者原则：**新格式一律做成独立插件，不进核心仓库，尤其当它引入新依赖时**

**据此的目录与接口**

```
packages/parsing/src/
  index.ts            barrel：导出 parseDocument / registry / 类型
  parse-document.ts   Facade：detect → resolve → parse → assemble
  registry.ts         ParserRegistry：register / resolve / list
  types.ts            DocumentParser / ParsedBlock / ParsedDocument / 错误
  block-collector.ts  共享骨架 collectParagraphBlocks（桶 B）
  parsers/
    markdown.ts
    txt.ts
    pdf.ts            薄适配：内部实现可替换（见下"PDF 后端"）
  pdf-worker.ts       子进程源码（从 pdf.ts 拆出，职责单一）
```

```ts
interface DocumentParser {
  readonly fileType: DocumentFileType;
  readonly contentTypes: readonly string[];
  readonly extensions: readonly string[];
  accepts?(input: ParserInput): boolean;    // magic bytes 校验（PDF 用 %PDF-）
  parse(input: ParserInput): ParsedBlock[]; // 失败抛错，由 facade 收敛为结构化错误
}
```

`parseDocument` 退化为 `detect → registry.resolve → parse → buildParsedDocument`；**检测与解析共用同一份 `contentTypes`/`extensions`**（单一事实来源），加格式只注册一个 parser，**零改主流程**。设计模式：Facade + Registry + Adapter/Strategy。

**关键收益：OSS 采纳变成"每格式一个 adapter"**

registry 让"自研 vs OSS"从**全有或全无**变成**每格式增量选择**：

- 现在：`PdfParser`（pdf-parse 子进程）、`MarkdownParser`、`TxtParser`
- 将来：`DocxParser`（包 `mammoth`）
- 再将来：`DoclingParser` / `UnstructuredParser`（**子进程 shell out 到 Python**）——本就有子进程模式（`pdf.ts:90`），加它只是**再注册一个 parser**，不动主流程

**PDF 后端（暂不定，留接口位）**

现状 `pdf.ts` 手写了"按 y 坐标把字符聚成行"（`pdf.ts:46-54`），这是重新发明 Docling/unstructured 已做好的事，且**处理不了分栏与阅读顺序**。因 `PdfParser` 是 registry 里一个可替换 adapter，内部换实现不影响外部契约：

- 阶段 2 **不动** pdf-parse + 手写分行
- 后续可换 **Docling**（保 page + bbox）或 **unstructured**（保 page_number），代价是引入 Python 运行时
- 决策**推迟**，作为独立议题

**桶 A — 真重复（删/合并）**

| # | 重复物 | 位置 |
|---|---|---|
| A1 | 死类型 `FilingParseStatus` / `FilingParseError` / `FilingParseResult`（全仓零引用） | `index.ts:20,22,28` |
| A2 | 死错误码 `pdf_parser_not_configured`（无生产路径产生） | `index.ts:38` |
| A3 | `ingestFiling` 两分支的**尾部完全相同**（`documentId`/`metadata`/`title`/`createdAt`/`blocks` 组装）→ 抽 `buildIngestedDocument()` | `index.ts:170-187` vs `211-228` |

**桶 B — 共享骨架（三份同一算法）**

"逐行累积非空行成段落、遇空行 flush、记录 `lineStart/lineEnd`"被抄了三遍：

| 实现 | 位置 | 差异钩子 |
|---|---|---|
| `parseMarkdownBlocks` | `index.ts:285` | 检测 `#` heading |
| `parseTxtBlocks` | `index.ts:352` | 长段按 `maxLinesPerBlock` 再切 |
| `buildPdfBlocks` | `pdf.ts:113` | `pageNumber` + `isTableRow` 表格行 |

→ 抽低层 `collectParagraphBlocks(lines, emit, hooks)` 承担累积/flush/行号簿记，三个 parser 变薄。

### 4.6 分两阶段

- **阶段 1（纯机械改名）**：无行为变化，测试须全绿。改名是纯机械、易审、可单独验证。
- **阶段 2（清理 + registry）**：有行为变化（删死代码、抽骨架、加 registry）。混在阶段 1 会让 diff 过大。

> docx 解析：暂不接（D6）。若后续接入，沿用 PDF 的**子进程 + `execFileSync`** 模式保持 `ingestDocument` 同步契约（`pdf.ts:23` 已解释该取舍）。

---

## 5. 附件设计

### 5.1 架构

```
小文件(≤阈值)  → 解析成文本 → 直接内联进 prompt（零存储）
大文件(>阈值)  → 解析 → chunk → embed → 存 Redis（会话级 + TTL）

提问 → 内部库检索(pgvector)  +  附件检索(Redis)  → 合并 rerank → LLM → 标注来源(附件/KB)
```

### 5.2 链路

**上传（`POST /api/attachments`）**
1. 保留现有 **sha256 幂等 + 租约/心跳**（`attachments.ts:55,92`）。
2. 新增 `convId` 入参（当前只有 `clientAttachmentId`/`userId`）。
3. 解析（`@aiagent/parsing`，PDF 已支持；Word 需补 docx 插件）。
4. 按阈值路由：
   - 小文件：文本写入该会话的**内联缓存**（供当轮/后续轮拼 prompt），不建索引；
   - 大文件：切块 + embed → 写 Redis 临时索引。
5. **不再调用 `dataSourceRuntime.ingest`**（那会写 Postgres）。

**提问（`search` / `answer` 路径）**
1. 内部库检索：现有 `dataSourceRuntime.search`（pgvector）。
2. 附件检索：`AttachmentStore.search(convId, queryVector, topK)`（Redis）。
3. 合并两路结果 → 复用现有 **reranker** 精排 → 交给 LLM。
4. citation 标注**来源 = 附件 / 内部库**。

### 5.3 Redis key schema 与 TTL

```
attach:conv:{convId}:doc:{docId}                 HASH
  { fileName, contentType, sizeBytes, checksum, chunkCount, createdAt, parserVersion }

attach:conv:{convId}:doc:{docId}:chunk:{index}   HASH
  { convId, docId, chunkIndex, text, heading, pageNumber, lineStart, lineEnd,
    embedding: <FLOAT32 二进制> }
```

- **TTL**：滑窗续期——每次该会话有活动（新消息/新提问）就对该会话的 `attach:conv:{convId}:*` 刷新 TTL（默认 **7 天**，对齐 OpenAI）。到期 Redis 自动回收，**无需清理任务**。
- **隔离**：`convId` 强制过滤；建议 key 前缀再带 `userId` 做纵深防御。
- **向量编码**：`FLOAT32` 二进制（省内存），不用 JSON 数组。

### 5.4 `AttachmentStore` 抽象

与现有 `VectorStore` 同形，便于依赖倒置与测试：

```ts
interface AttachmentStore {
  upsert(convId: string, docId: string, chunks: EmbeddedChunk[]): Promise<Result>;
  search(convId: string, queryVector: EmbeddingVector, topK: number): Promise<SearchResult>;
  touch(convId: string): Promise<void>;   // 刷新 TTL（滑窗续期）
  drop(convId: string): Promise<void>;     // 主动回收（会话删除时）
}
```

- 提供 **Redis 实现** + **内存实现**（测试用，复用现有 in-memory 思路）。
- 客户端用**官方 `redis`（node-redis v4+）**，原生 Promise/TS。
- 检索先用**应用内暴力余弦**（**裸 Redis 即可**，复用 `rag/vector-math.ts`；单会话 chunk 量小，毫秒级），量大再升级 RediSearch / Redis 8 Vector Sets。

### 5.5 多路召回编排

- 新增一个检索编排（在 `DataSourceRuntime` 或独立 orchestrator）：
  `searchPersistent(query)` + `searchAttachments(convId, query)` → 合并候选 → 现有 rerank → 输出。
- 复用现有 `filter.documentId/source`、hybrid、rerank 能力，避免重造。

### 5.6 阈值路由

- 可配置阈值（参考 Anthropic **~200k token** 分界）。
- 小文件内联**不写 Redis**；只有超阈值才建索引。

---

## 6. 统一改动清单

| # | 改动 | 位置 |
|---|---|---|
| 1 | 包正名 `filings` → `parsing`（L1+L2 改名，L3 删除） | `packages/filings/**` → `packages/parsing/**` |
| 2 | 结构收敛：拆 `parsers/` + `parse-document.ts`(Facade) + `registry.ts` + `block-collector.ts`；删桶 A 死代码；桶 B 抽共享骨架 | `packages/parsing/src/*` |
| 3 | types DTO 改名与文件迁移 | `packages/types/src/filings.ts` → `documents.ts`、`rag.ts` |
| 4 | rag 消费点改名 | `chunking.ts` / `data-source-runtime.ts` / `contextual-retrieval.ts` / `testing.ts` / `types.ts` |
| 5 | 附件改道，不再 `dataSourceRuntime.ingest` | `apps/api/src/http/routes/attachments.ts:104` |
| 6 | 新增 `AttachmentStore`（Redis + 内存实现） | 新模块（建议 `packages/rag` 或新 `packages/attachment`） |
| 7 | 上传请求新增 `convId` | `apps/api` schema + `@aiagent/types` DTO |
| 8 | 多路召回编排 | `packages/rag`（`DataSourceRuntime` 或 orchestrator） |
| 9 | 新增依赖：Redis 服务 + 官方 `redis` 客户端 | 基础设施 / `package.json` |
| 10 | 文档与 notes 同步 | 本文件 + `README.md` + `notes/` + `docs/worktree/06` + `docs/v1.1/02-rag-production-reading.md` |

---

## 7. 取舍与风险

- **Redis 依赖**：新增基础设施（当前仓库无 Redis）。裸 Redis 足够（暴力余弦）；RediSearch 需 Redis Stack / Redis 8。
- **TTL 语义**：Redis TTL 精确，但"过期即丢、需重传"（与业界临时附件一致）。
- **多实例**：Redis 共享存储天然支持多实例（相比进程内存的优势）。
- **幂等/租约**：复用现有 `sha256 + clientAttachmentId + lease` 机制。
- **大文件同步阻塞**：当前 ingest 同步；大文件 embedding 可能超时，后续需异步化 + 状态轮询。
- **跨源对比推理**：本方案只做"多路召回合并"，不做跨源对比推理（后者需改 answer/grounding 的 prompt 与引用设计）。
- **不落主库的边界**：附件**原文与索引都在 Redis**；主库只保留必要的上传记录（幂等/审计），不存附件正文。
- **改名的风险控制**：阶段 1 是纯机械改名，靠 `pnpm typecheck` + 各包测试全绿来保证零行为变化；阶段 2 才引入行为变化。
- **薄适配层的边界**：`@aiagent/parsing` 只维护"接口 + 映射 + registry"，不维护解析算法；代价是自研 PDF 分行能力弱于 OSS（分栏/阅读顺序），故 PDF 后端留可替换位（D8）。
- **OSS 引入的运行时风险**：若后续接 Docling/unstructured，会引入 **Python 运行时**（新基础设施 + 部署复杂度）；但子进程调用模式与现状一致，且是**每格式增量**引入，不影响其它 parser。

---

## 8. 分阶段实施

- **P0（前置改造）**：
  - P0-1：纯机械改名（包 + L1 + L2 + L3 删除 + 文档同步），测试全绿。
  - P0-2：结构收敛——拆 `parsers/` 目录 + `parse-document.ts`（Facade）+ `registry.ts` + `block-collector.ts`；删桶 A 死代码；桶 B 抽共享骨架。
- **P1（最小可用）**：`AttachmentStore`（内存 + Redis）+ 附件改道 + `convId` + 单源附件检索。
- **P2**：多路召回合并 + citation 来源标注 + 阈值路由（小文件内联）。
- **P3**：docx 插件（`mammoth`）+ PDF 后端选型（Docling/unstructured 或维持现状）+ 大文件异步化 +（可选）RediSearch 升级 + 跨源对比推理。

## 9. 学习路径 / 验收证据

- 学习点：
  - parsing 层：格式解析与检索解耦、**薄适配层**（不维护引擎只维护契约）、Facade + Registry + Adapter（开闭原则）、共享骨架抽取、依赖方向（parsing → rag 单向）、OSS 与自研的边界（每格式可替换 adapter）。
  - 附件层：Redis 作为临时向量存储（key schema / TTL / 会话隔离）、多路召回合并、阈值路由、依赖倒置（`AttachmentStore` 接口 + 注入）。
- 验收：
  - P0：`pnpm typecheck` + `@aiagent/parsing` / `@aiagent/rag` / 下游包测试全绿；`ingestDocument` 对 md/txt/pdf 行为与旧 `ingestFiling` 一致；registry 新增 parser 不改 `ingestDocument`。
  - P1/P2：上传 PDF → 会话内问答命中附件 + 内部库，citation 标注来源；Redis TTL 到期后附件不可检索。
- 产出：`@aiagent/parsing` 重构 PR + `AttachmentStore` PR + `` / `` 学习笔记。

## 附：已确认决策

| 项 | 结论 |
|---|---|
| Redis 客户端 | **官方 `redis`（node-redis v4+）** |
| Redis 部署形态 | **裸 Redis**（检索走应用内暴力余弦，无需 RediSearch / Redis Stack / Redis 8） |
| 主库附件记录 | **保留最小元数据**（`clientAttachmentId` / `checksum` / `userId` / `convId` / 状态），**不存附件正文**，用于幂等与审计 |
| TTL 默认 | 7 天（滑窗续期，对齐 OpenAI） |
| 小文件内联阈值 | 可配置，默认参考 Anthropic ~200k token |
| parsing 包去留 | **保留 + 正名 `@aiagent/parsing`**，改名深度 L1+L2，L3 删除 |
| parsing 包定位 | **薄适配层**（接口 + 映射 + registry），不维护解析引擎；算法尽量交给 OSS（D7） |
| parsing 架构 | Facade（`parse-document.ts`）+ Registry（`registry.ts`）+ `parsers/*.ts` + `block-collector.ts`，照搬 MarkItDown 范式 |
| PDF 解析后端 | **暂不定**；阶段 2 维持 pdf-parse + 手写分行，`PdfParser` 留可替换位（D8） |
| docx | **暂不接**；接入时沿用子进程模式保持同步契约 |

> 下一步：按 P0-1（纯改名）→ P0-2（结构收敛 + registry）→ P1/P2 顺序实施；每步派 coder 实现、reviewer 审核。
