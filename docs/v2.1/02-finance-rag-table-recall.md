# v2.1 财报 RAG 表格与图片召回改造方案（whole-table + screenshot + parsing 前置）

> 状态：v2.1 规划 · 针对「抽取锚点多是表格，如何召回整个表格或截图」的单点改造方案。
>
> 本版相对上一版的主要修正：把原「A 先做表级切块、B 再做截图」两步，重排为
> **D0 解析修复 → D1 表级切块 → D2 评测数据通道 → D3 整表召回诊断 → D4 截图召回**。
> 核心原因有二：一是当前最痛的一批表题在解析层就已经不可见，表级切块救不了它们；
> 二是现有评测只做 source 级命中，测不到「整表是否完整召回」，必须先补通道与诊断口径。

> **定调**：投研知识库的「难点」不在正文段落，而在**财报里铺天盖地的表格**——股东人数、主要会计数据、
> 控股参股公司、长期应收款、坏账准备、联系人均以表呈现。同时，真实财报 PDF 的**文本层质量差异极大**：
> 部分文件是干净的「表行逐行」层，部分文件是「字符间空格 + 每块一页」的坏层。本方案因此不把
> 「整表召回」单独押在切块器上，而是先修复解析层，再让表级切块、结构化数据通道和整表召回诊断闭环。
>
> **研发阶段约束**：本项目处于开发阶段，无需兼容老代码（`docs/v2.0/02-eval-system-v2.md` 已定调
> 「直接删旧 + 重建新」）。任何代码都可直接改，不做兼容壳。

---

## 1. 现状与根因

### 1.1 已落地资产（上一轮已验证可跑）

- 解析器：`@aiagent/parsing` 的 `parsePdfBlocks`（`packages/parsing/src/parsers/pdf.ts:60-95`）逐页按行切分，
  表格行单独成块并打标 `metadata.isTableRow` + `metadata.tableColumnCount`。不同财报的表格行密度差异极大：
  保利年报 9508 个 block 中 5228 个为表格行，而北方稀土/大秦铁路/中国船舶 2025 年报等文件为 0 表格行。
- 切块器：`packages/rag/src/chunking.ts` 的 `chunkDocumentBlocks`，`heading_aware` 策略
  （`DEFAULT_CHUNKING_OPTIONS`：`maxChars:1200 / overlap:150`，见 `packages/rag/src/types.ts:401`）
  **逐 block 调用 `createFixedSizeChunks`**。
- 评测集：作者集 `golden.jsonl` + 草稿 `datasets/finance/rag-golden/_drafts/batch-01/`，Web 标注器
  `test/annotate-finance-golden.mjs` 已支持 `gold_answer_table` 网格 / `gold_answer_form` 键值表单 / `page_image_ref`。
- Schema：`datasets/finance/rag-golden/SCHEMA.md` 已预留 `source_kind:"image"` + `ocr_required` + `page_image_ref`。

### 1.2 根因：不止「表被切碎」，还有「解析层坏层」和「数据通道丢结构」

`chunkDocumentBlocks` 的 `heading_aware` 分支对**每个 block** 单独切：

```ts
input.blocks.forEach((block) => {
  // 每个 block 各自走 createFixedSizeChunks，maxChars=1200
  chunks.push(...createFixedSizeChunks({ text: block.text, ... }));
});
```

而 `parsePdfBlocks` 给每一行表格都产出一个独立 `isTableRow` block。于是「北方稀土主要控股参股公司」这张
9 行 × 8 列的表，会变成 **9 个彼此割裂的 chunk**。当查询命中该表时，向量召回可能只浮出 2–3 行，
`gold_answer_table` 需要的整表 9 行永远凑不齐。

但这只是其中一个根因。当前 golden 表题的**实际可执行路径**还有三个更前置的问题：

| # | 差距 | 影响 | 对应修复 |
|---|---|---|---|
| G0 | 字符间空格层 PDF 解析失效：北方稀土/大秦铁路/中国船舶/豪威 2025 年报被 `parsePdfBlocks` 抽成「每块一页 + CJK 字符间空格」，`isTableRow=0` | 最痛的一批表题在解析层就不可见，整表召回无从谈起 | D0 |
| G1 | 表格行被逐行切块，整表语义被打散 | `gold_answer_table` 抽取缺行；检索只命中片段 | D1 |
| G2 | 大块表格行（>1200 字）还会被 `fixed_size` 再次切 | 单行表格也可能被腰斩 | D1 |
| G3 | 图片型表格（`pdf-parse` 抽不到文本）零召回 | 中微公司等「图即是表」的 PDF 完全失明 | D4 |
| G4 | 截图通道缺失：无页面级 PNG 落库、无 image citation | 视觉证据无法呈现，golden 的 `page_image_ref` 空转 | D4 |
| G5 | 现有 `AttachmentStore` 是**会话级**（Redis TTL，按 `conversationId` 分桶），非文档级 | 语料 PDF 的图片无法作为「文档资产」持久召回 | D4 |
| G6 | golden 生成器把 PDF blocks 压平成纯文本 `.txt`，`pageNumber/heading/isTableRow/tableColumnCount` 全部丢失 | 即使实现 D1，评测端也看不到任何表格元数据，D1 空转 | D2 |
| G7 | 现有评测只有 source 级命中，无 chunk 级整表覆盖信号 | 方案 §6 的「整表是否整段召回」目前没有可观测分数 | D3 |
| G8 | 整表单 chunk 在 deterministic 向量下被稀释，且合成答案/citation 只截 120 字 | 大表召回分数下降；合成 answer 拿不到整表 | D1（summary sibling + 整表交付） |

> G8 的修复归属被拆成两段：`summary sibling` 解决「召回稀释」，`answer/citation` 的整表返回策略解决
> 「合成答案拿不到整表」。后者不是 D3 诊断绕行，而是 D1 里必须补齐的**用户可见交付**，见 §4.1 规则 6。

### 1.3 实测样本（把上述根因落到 golden 表题）

以下是对 golden 表题实际引用 PDF 的一次抽样（表行识别按当前 `isTableRow` 启发式）：

| 题目 | ticker | 文件 | blocks | isTableRow 块 | 表行 run 数 | gold 首列实体命中（CJK 归一后） | 判定 |
|---|---|---|---|---|---|---|---|
| fin-003 | 600111.SH | 2025 年报 | 263 | 0 | 0 | 0/8 | G0 解析层坏层，D1 无效 |
| fin-004 | 601006.SH | 2025 年报 | 221 | 0 | 0 | 0/2 | G0 解析层坏层，D1 无效 |
| fin-008 | 000963.SZ | 2026H1 半年报 | 4243 | 2114 | 1388 | 2/3 | G1 表行碎片化，D1 有效 |
| fin-009 | 600150.SH | 2025 年报 | 258 | 0 | 0 | 2/6 | G0 解析层坏层，D1 无效 |
| fin-011 | 603501.SH | 2025 年报 | 280 | 0 | 0 | 0/4 | G0 解析层坏层 |
| fin-011 | 603501.SH | 2024 年报 | 3451 | 1528 | 762 | 4/4 | G1 表行碎片化 |
| fin-013 | 600029.SH | 2025 年报 | 4747 | 1768 | 975 | 1/1 | G1 表行碎片化 |

结论：**「表被切碎」只覆盖部分题；对 fin-003/004/009/011 这类当前最硬的题，必须先修解析层（G0）**。
因此上一版「A 先做、覆盖 ~95% 表格题」的估计不成立，需按 D0 前置。

---

## 2. 方案总览（D0 → D4）

```
PDF ──parsePdfBlocks──▶ blocks(pageNumber / isTableRow / tableColumnCount)
        │
        ├─ D0) 解析修复：CJK 字符间空格归一 + 坏层表行识别
        │        → 让 fin-003/004/009/011 这类文件重新产出可检索文本与表格行
        │
        ├─ D1) table-aware 切块：连续 isTableRow 合并为「整表 chunk」
        │        + 并列生成 summary sibling chunk（共享 tableGroupId）
        │        + 命中后按 tableGroupId 展开 sibling，answer/citation 走整表交付
        │        → 解决 G1/G2/G8 的召回稀释与「合成答案拿不到整表」
        │
        ├─ D2) 评测数据通道保留结构：不再压平成 .txt
        │        → 让 D1 的表格元数据真正进入 deterministic 评测链路
        │
        ├─ D3) 整表召回诊断：chunk 级 gold 表行覆盖
        │        → 给出 D1 可观测的验收信号
        │
        └─ D4) 截图召回：pdftoppm 按页渲染 PNG → 文档级图片资产 + image citation
                 → 解决 G3/G4/G5，覆盖图片型表少数场景（先补 image 金丝雀）
```

**为什么这样排序**：

- D0 是 D1 的前置：不修坏层，D1 在多数硬表题上无对象可切。
- D2 是 D1 的验收前提：不保留 `isTableRow` 等元数据，D1 在评测里不可观测。
- D3 是验收口径本身：现有 source 级指标测不到「整表是否召回」，必须补 chunk 级诊断；
  但诊断只负责「把问题测出来」，真正让整表可交付的检索侧展开与 answer 层策略归 D1。
- D4 成本最高且当前无真实 image 金丝雀，放在最后并收紧范围。

---

## 3. D0 · 解析层修复（最高优先）

### 3.1 设计

在 `@aiagent/parsing` 的 PDF 行聚合/表格识别边界做归一与坏层识别。归一化要区分「CJK 字符间
空格」与「数字/符号字符间空格」两类，并严格排除全角空格 `U+3000` 这个合法的列分隔符。

1. **CJK 字符间空格归一**：把 `[\u4e00-\u9fff]` 之间的 ASCII 空白合并
   （`华 美 公 司 → 华美公司`），但**不处理全角空格 `U+3000`**（`华美公司　子公司` 的
   `U+3000` 是列分隔，归一后会破坏列对齐）。归一范围排除数字、英文、标点，保证
   `213,252.00  462,419.73` 这类仍能被列分隔识别。
2. **数字/符号坏层归一**：对 `1 0%`、`67,78 7`、`( 1 9 3 )`、`24 . 2 5` 这类
   「数字与数字/小数点/千分位逗号/百分号/负号/括号之间被空格打断」的坏层，在行聚合阶段把
   相邻数字符号之间的 ASCII 空格合并。这是 fin-013 的根因，不能只靠 CJK 归一。
3. **两列表识别**：`isTableRow` 现有 `\S\s{2,}\S` 要求「至少两处列间隔」，会把只有一处间隔的
   两列表（联系人、简单键值表）漏判。坏层识别后需单独处理：一行恰好出现一处稳定列间隔且
   首列非纯数字时，也判为表格行。
4. **归一发生在 worker 行聚合阶段**：当前 `parsePdfBlocks` 拿到的已经是 `pdf-worker.ts` 里
   `rows[y].join(" ")` 拼好的行文本，父进程不存在可保护的「逐字层」。因此归一化必须下沉到
   `PDF_WORKER_SOURCE` 的 `pagerender` 聚合逻辑（在 `join` 前按字符类型合并空格），而不是在
   `buildPdfBlocks` 消费文本之前做字符串替换，否则会污染列间隔、使归一后的
   `isTableRow`/`countTableColumns` 失效。
5. **坏层表行识别增强**：对「每块一页 + 相当比例 CJK 字符间空格」的文件，不能简单复用
   `\S\s{2,}\S` 的列间隔启发式；应先做归一，再对归一后的行做列分隔判断，并在 `metadata`
   里保留 `sourceLayer: "char_spaced"` 等诊断标记。`sourceLayer` 同时作为 D4 渲染 pass 的输入，
   避免另立一套「图片页判定」。

这一步会把 `test/mine-finance-golden.mjs` 里已有的 `normalizeCjk` 收敛到 parsing 包内，
避免「候选抽取器归一、正式评测生成器不归一」的分叉。

### 3.2 验收

- `packages/parsing` 单测覆盖：CJK 字符间空格、数字/符号坏层、全角空格列分隔、两列表四类样本的
  `isTableRow` 与 `countTableColumns` 输出可复现。
- 新增仓库根 `test/` 诊断脚本，对 golden 表题逐一输出 `isTableRow` 块数、gold 首列实体命中率，
  作为 D0 的回归信号。**先跑一次 D0 改动前的基线并落库**，P1 结束时以「fin-003/004/009/011/013
  的 gold 首列实体命中率」对比基线判定，不得再用「显著回升」这类无基线口径。目标阈值在拿到基线后
  于 P1 开工前写入本节，作为硬门禁。

**D0 基线与硬门禁**（2026-10-28，改动前 `parsePdfBlocks`）：

| 题目 | blocks | pages | blocks/page | isTableRow | gold 首列实体 |
| --- | ---: | ---: | ---: | ---: | ---: |
| fin-003 | 263 | 263 | 1.00 | 0 | 8/8 |
| fin-004 | 221 | 221 | 1.00 | 0 | 2/2 |
| fin-008 | 4243 | 250 | 16.97 | 2114 | 2/3 |
| fin-009 | 258 | 258 | 1.00 | 0 | 6/6 |
| fin-013 | 4747 | 246 | 19.30 | 1768 | 1/1 |

命中口径：gold 首列实体在 CJK 归一后的解析全文里完整出现。P1 的硬门禁是上述五题
**逐题保留基线命中数**（fin-003 8、fin-004 2、fin-008 2、fin-009 6、fin-013 1），
且 fin-003/004/009/013 均至少产出一条 `isTableRow` 块；解析单测与
`test/diagnose-finance-table-parsing.mjs` 均须通过。当前 D0 结果满足该门禁，
并以 `sourceLayer:"char_spaced"` 标记坏层页面。

---

## 4. D1 · table-aware 整表切块（整表 + summary sibling 同批）

### 4.1 设计

在 `chunkDocumentBlocks` 增加 `strategy: "table_aware"`，扫描 blocks 时把**连续 `isTableRow === true`
的块**聚合成一个表组，并产出**两种并列 chunk**，共享 `tableGroupId`：

- **整表 chunk**：表组全部行按 `\n` 拼接，作为单一 chunk；`metadata.isTableChunk: true`。
- **summary sibling chunk**：表头 + **首列全部 rowKey 枚举** + 行数，作为紧凑摘要 chunk；
  `metadata.isTableSummary: true` + `metadata.tableGroupId`。

> summary 不能用「首 3 行 + 末 3 行」：fin-003 这类题要召回的是表格首列全部 8 个实体，
> 而位于中间的「北方磁材 / 天骄清美」既不在首 3 行也不在末 3 行，summary 会正好漏掉它们；
> 同时整表 chunk 又被全表 token 稀释排不进 topK。因此 summary 的召回语义必须是「表头 +
> 首列 rowKey 全枚举 + 行数」，才能覆盖以首列实体定位的控股参股公司、长期应收款、坏账准备等题。

规则：

1. **表边界**：遇到（a）`isTableRow === false` 的非空块，或（b）新 heading 块时结束当前表组。
   **不以 `pageNumber` 跳变断组**：跨页表只要中间无正文/标题分隔，就应属于同一表组，
   `pageStart/pageEnd` 只作来源元数据，不作切分依据。
   - 「新 heading 块」只对 markdown 来源生效；财报 PDF 的 block 当前不携带 `heading`（见
     `buildPdfBlocks`），因此 PDF 表组切分主要依赖（a）。
   - 页眉页脚是 `isTableRow === false` 的非空块，会触发（a）误断跨页表。D1 需在（a）之外
     加入**疑似页眉豁免**：单行、长度短、或命中公司名/页码模式的非表行块，允许作为表组内的
     粘连行而不结束表组。豁免阈值作为 `table_aware` 的可测试纯函数参数。
2. **整表为最小单元**：表组永不按 `maxChars` 再切；超大表也不腰斩，而是靠 summary sibling 保召回。
3. **保留结构元数据**：
   - `isTableChunk` / `isTableSummary` / `tableGroupId`
   - `tableColumnCount`：用列数**中位数/去抖**而非简单众数，避免逐行列数抖动
   - `tableRowCount`
   - `tableHeader`：优先取表组首个非数字表头行，并保留原始行
   - `tableHeading`：表组前最近 heading
   - `pageStart` / `pageEnd`
   - `tableColumnCount` 统计需排除稀疏抵减行（如 fin-009 的「其中：未实现融资收益」只有 2 列），
     否则中位数会被这类行拉偏。
4. **非表格块**保持原 `heading_aware` 行为不变。
5. **检索侧按 `tableGroupId` 展开 sibling**：命中 `isTableSummary` 或 `isTableChunk` 的候选后，
   把同 `tableGroupId` 的整表 chunk 一并纳入检索结果（去重后保留），而不是依赖 summary 与整表
   各自独立命中 topK。展开发生在 rerank 前，让 sibling 共享同一相关性上下文；缺省可关闭以便
   与 `heading_aware` 行为对比。没有这一步，D3 的「联合覆盖」是一条检索链路永远无法达成的
   目标，只能测出失败而无法定位修复归属。
6. **answer/citation 整表交付**：对 `isTableChunk` 命中，`synthesizeRagAnswer` 与 citation 不再走
   120 字单句截断，改为返回完整表文本（或至少返回全表行），否则整表 chunk 即便被召回，用户
   看到的仍是截断片段。这条与 §6 的诊断绕行不同，是 G8 的**产品交付修复**，属于 D1 范围。

> summary sibling 不是后续增强，而是 D1 的必要组成：当前 deterministic embedding 是
> token 袋 + CJK 单字 hash（`packages/rag/src/vector-math.ts`），整表单 chunk 会被全表 token 稀释。
> summary chunk 负责「把表召回」，整表 chunk 负责「给全表内容」，二者通过 `tableGroupId` 关联。

### 4.2 改造点（代码，后续执行）

- `packages/rag/src/chunking.ts`：新增 `table_aware` 分支与 `mergeTableBlocks` 纯函数；
  `heading_aware` 分支保持。
- `packages/rag/src/types.ts`：`ChunkingStrategy` 增加 `"table_aware"`，放开 `validateChunkingOptions`。
- **chunkerVersion 由「本次实际生效的策略」派生**，不写死在 `DEFAULT_CHUNKING_OPTIONS`：
  新增 `resolveChunkerVersion(options)`（`strategy-maxChars-overlap-v1`），ingest 时把
  `this.chunkingOptions` 解析出的版本写入 lineage。保留 `RAG_CHUNKER_VERSION` 仅作默认档标识，
  并**删除 `data-source-runtime.ts:212` 对 `RAG_CHUNKER_VERSION` 的硬编码写入**，改为
  `resolveChunkerVersion(this.chunkingOptions ?? DEFAULT_CHUNKING_OPTIONS)`，避免两个版本来源并存
  导致 `table_aware` 文档仍被标成 `heading_aware` 版本。
- `packages/rag/src/retrieval.ts` 或同目录新模块：增加 `tableGroupId` sibling 展开（规则 5），
  并提供关闭开关，保证与 `heading_aware` 的对比实验可控。
- `packages/rag/src/answer.ts`：对 `isTableChunk` / `isTableSummary` 命中增加整表交付分支（规则 6）。
- 单测 `packages/rag/test/chunking.table.test.mjs`：覆盖整表合并、summary sibling、跨页不误切、
  页眉粘连豁免、稀疏行列数去抖、单行超大表不腰斩、`tableGroupId` 关联、版本派生正确；
  另补检索侧 sibling 展开与 answer 整表交付的定向单测。

**当前实现**：`table_aware` 已聚合连续表行并生成共享 `tableGroupId` 的整表与 summary sibling；
检索在 rerank 前展开同组整表 chunk（`expandTableGroups` 可关闭）；`tableColumnCount` 取中位数并排除
`其中/减/加` 稀疏抵减行；表头行计入 `tableRowCount`，但不计入 summary 的首列实体枚举。
ingest lineage 的 `chunkerVersion` 由当前实际生效的 chunking options 派生。

---

## 5. D2 · 评测数据通道保留结构（D1 验收前提）

### 5.1 问题

旧数据通道先把 PDF 解析成 blocks，再压成纯文本 `.txt`；评测端 `.txt` 只会按空行/固定行数切块，
**没有 `isTableRow`**，导致 D1 在评测里不可观测。当前生成器已改为内嵌 PDF 原始字节，直接走真实
`ingestDocument`。

### 5.2 改造点

**选定路径（不再二选一）：评测直接走真实 PDF bytes，不在 `ingestDocument` 之外再造一条评测-only
通道。** 原方案里的「解析 blocks 直通切块评测-only 路径」会再造一条和生产 ingest 不同的代码路径，
违反 v2.0「评测必须触达真实系统、禁止 fixture 自证」的原则。

- `test/generate-finance-golden-v1.mjs`：不再 `parsePdfBlocks` 后 `blocks.map(...).join("\n")` 压成
  `.txt`，改为把 PDF 原始字节写入 `documents`（`fileName` 保持 `.pdf`，`content` 为
  `Uint8Array`）。golden 生成器不再做二次解析，也不再产出会丢失元数据的中间文本。
- `apps/finance-api/src/eval/adapter.ts`：把 `FinanceEvalDocumentLike.content` 从 `string` 放宽为
  `string | Uint8Array`，并在 ingest 时原样透传给 `DataSourceRuntime.ingest`。这样评测端会走真实
  `ingestDocument` → PDF 解析 → `table_aware` 切块，`isTableRow` 等元数据天然进入链路，和生产
  金融语料 ingestion 完全同源。
- `createDeterministicFinanceRagRuntime` 显式注入 `chunkingOptions: { strategy: "table_aware" }`，
  保证 golden 评测与金融语料生产 ingestion 同策略。
- 同步校验 `FinanceEvalCase`/`dataset.ts` 的 loader 约束：若其强制 `content: string`，需随本次
  一并放宽为 `string | Uint8Array`，不能让 adapter 支持字节而 loader 又拒收。

### 5.3 验收

- 评测 trace 或 `listChunks` 能看到 `isTableChunk` / `isTableSummary` / `tableGroupId` 元数据，
  且表格题不再因为 `.txt` 二次解析而丢失结构。
- 生成器不再出现 `.txt` 中间产物；`rag-golden-v1.json` 的 documents 能承载 `Uint8Array` 并
  被 loader 正确接受。

**当前实现**：生成器写入 `{contentEncoding:"base64", contentBase64}` 文档信封，`.fileName`
保持 `.pdf`；loader 解码为 `Uint8Array` 后透传真实 `ingestDocument`。`rag-golden-v1.json`
当前约 73 MB，是内嵌 PDF 字节的显式取舍。17 个来源文档中表格题已产出 `isTableChunk`、
`isTableSummary` 与 `tableGroupId`（fin-003 为 2301 个表组）；完整 golden deterministic 跑通
12 条 RAG case，source 级 retrievalHitRate=1、mrr=1、ndcg=0.995。

---

## 6. D3 · chunk 级整表召回诊断（D1 的真正验收）

### 6.1 问题

现有 `retrievalHitRate / mrr / ndcg` 都是 **source 级**，只回答「命中了哪个文档」，不回答
「整表行是否凑齐」。因此需要新增独立的 chunk 级诊断，初期放仓库根 `test/`，不进 CI 门禁。

### 6.2 设计

新增 `test/assert-finance-table-recall.mjs`：

- 对 `type:"table"` 且带 `gold_answer_table` 的题，跑 retrieval-only（关闭合成 answer）。
- 对每条 case 统计：
  - 单个被召回 chunk 的 `text` 是否**完整包含** gold 表全部行；
  - 若单 chunk 不完整，whole-table + summary 是否通过 `tableGroupId` 联合覆盖全部行。
- 输出 `tableRowCoverage`（gold 行完整出现的比例）与每题的缺行清单。

注意：诊断读 `retrievalResults[].text`（全文在），不要读合成 answer / citation quote——
两者在旧实现有 120 字截断。**这不是替代 §4.1 规则 6 的借口**：诊断只负责定位问题，真正的
用户可见交付（answer/citation 返回整表）归 D1；若 D1 未落地整表交付，D3 只能证明「召回行齐了」，
不能证明「用户拿得到整表」。

> `tableRowCoverage` 用「gold 行是否在 `tableGroupId` 关联组内完整出现」作为口径，因此它隐式
> 依赖 §4.1 规则 5 的 sibling 展开。诊断脚本需同时输出「命中 chunk 是整表还是 summary」和
> 「是否触发 sibling 展开」，避免把「展开没生效」误判成「整表没被召回」。

### 6.3 门禁

先在 `test/` 手工回归。稳定后，若要把「整表召回」纳入门禁，再在金融评测新增
`tableRowCoverage` 指标（仅对 `type:"table"` 适用），并只对 table 题设 SLO；不要改动
现有 source 级门禁的语义。

**当前诊断基线**（2026-10-28，retrieval-only，keyword topK=20）：

| 题目 | tableRowCoverage | 单 chunk 完整 | 组联合完整 | sibling 展开 |
| --- | ---: | --- | --- | --- |
| fin-003 | 1.000 | 是 | 是 | 是 |
| fin-004 | 1.000 | 是 | 是 | 是 |
| fin-008 | 0.667 | 否 | 否 | 是 |
| fin-009 | 1.000 | 是 | 是 | 是 |
| fin-013 | 1.000 | 是 | 是 | 是 |

该诊断仍是手工回归，不进入现有 source 级 CI 门禁。当前缺口集中在 fin-008 的稀疏/组合坏账行；
其余表题已通过单整表或 sibling 组覆盖。表内换行业务文本必须留在当前表组，不能再制造一行一组。

---

## 7. D4 · 截图召回（图片型表，收紧后执行）

### 7.1 前提

先给 golden 增加 1–2 条**真实 `source_kind:"image"`** 的题（如中微公司「图即表」页面），再动手。
当前 golden 尚无 image 样本，直接实现 `PageImageRepository + pdftoppm + OCR` 属于无金丝雀的重资产。

### 7.2 设计

1. **渲染**：ingestion 阶段对需要视觉证据的页用 `pdftoppm` 渲染 PNG（分辨率 `-r 110` 附近），
   优先只渲染被判定为图片表/锚点/坏层的页，避免整份 PDF 全量 PNG 落库。渲染 pass 复用 D0 的
   `sourceLayer: "char_spaced"` 与「每块一页」密度诊断作为触发条件，不另立一套独立的「图片页
   判定」——G3 的图片页文本为空，G0 的坏层页文本被拆空格，两者都应进入视觉抽查范围。
2. **文档级图片资产**：新增 `PageImageRepository`，key = `<documentId>#page=N`，按文档作用域持久化，
   不混用会话级 `AttachmentStore`。
3. **视觉通道**：answer 阶段把 `page_image_ref` 作为 image citation 传给视觉模型直接读图。
   VLM 能力属于 RAG answer 的模型边界，最终由 `packages/ohna-runtime` 装配，不落在即将退役的
   `ohna-cli` / `ohna-web` 组合根（见 `docs/v2.1/01-electron-client.md`）。
4. **OCR（挂起）**：先验证视觉通道闭环，OCR 留作后续；OCR 文本可作为同级文本 chunk 入库，
   使非视觉模型也能向量命中。
5. **不参与向量召回**：截图 PNG 本身只作视觉证据与解析质量抽查，不 embedding。

### 7.3 改造点（后续）

- 新增 `packages/rag/src/page-image-repository.ts`。
- ingestion 增加页面渲染 pass，写回 `page_image_ref`。
- `createCitationFromRetrievedChunk` 增加 image 类型 citation。

**当前实现**：golden 已加入 `fin-014`（中微公司 2025 年报第 25 页，`source_kind:"image"`）；
`PageImageRepository` 以 `<documentId>#page=N` 保存页面 PNG，`pdftoppm` 只渲染明确点名的页面
（110 DPI 默认，可覆盖），citation 带 `citationKind:"image"` 与 `pageImageRef`。OCR 与 VLM
实际读图仍留作后续，当前金丝雀验证“页面 PNG 可落库、可定位、可形成 image citation 元数据”。

---

## 8. 与现有评测资产 / 流程的衔接

- **golden 表题作回归目标**：D1 的 `table_aware` 召回 + `tableGroupId` 展开 + 整表交付共同构成
  A 路线的产品目标；D3 的 chunk 级 `tableRowCoverage` 只是把「召回行是否齐全」变成可观测分数，
  不替代整表交付。source 级指标保持不变。
- **image 金丝雀作 D4 验收**：先在 golden 加 1–2 条 `source_kind:"image"`，验证 `page_image_ref` 定位与视觉呈现。
- **评测报告按 `source_kind` 拆分**：金融线报告分 `text / table / image` 三栏，区分「答错」还是
  「根本没解析 / 没检索到」。
- **标注器/注解流程不变**：mine → 标注 → validate → promote 四步照旧。

---

## 9. 阶段划分与节奏

1. **P0 · 方案定稿（本文件）**：确认 D0→D4 顺序、`table_aware` 策略、`tableGroupId` 展开、
   answer 整表交付、`PageImageRepository` 边界。
2. **P1 · D0 解析修复**：CJK 归一 + 数字/符号坏层归一 + 两列表识别 + parsing 单测 + `test/` 诊断脚本。
   开工前先跑基线；门禁为 fin-003/004/009/011/013 的 gold 首列实体命中率对比基线达标（阈值 P1 开工前落定）。
3. **P2 · D1 表级切块**：`table_aware` + summary sibling + chunkerVersion 派生 + `tableGroupId` 展开 +
   answer/citation 整表交付 + 单测。
4. **P3 · D2 数据通道**：generator 改传 PDF bytes，adapter/loader 放宽 `content` 并注入 `table_aware`。
5. **P4 · D3 整表召回诊断**：`test/assert-finance-table-recall.mjs`，对 golden 表题输出 `tableRowCoverage`。
6. **P5 · D4 截图召回（按需）**：先补 image 金丝雀，再落 `PageImageRepository` + 渲染 + image citation。
7. **P6 · 迭代**：rerank 对整表/summary chunk 的权重、OCR 通道、大表分级策略；按诊断持续调参。

> 评审 / 评测节奏约定（学习期）：每个 P 结束跑「单测 + 评测回归 + 文档同步」三件套，门禁不过不进下一 P；
> golden 集随语料增长从 23 条扩到 30–50 条正式基准，`table`/`image` 题各占稳定比例。

---

## 10. 验证方式（验收口径）

- **解析层（D0）**：CJK/数字/全角空格/两列表样本 `isTableRow`/列数可复现；`test/` 诊断对比基线，
  gold 实体命中率达到 P1 开工前约定的阈值。
- **切块层（D1）**：`chunking.table.test.mjs` 断言整表合并、summary sibling、跨页不误切、超大行不腰斩、
  页眉粘连豁免、稀疏行列数去抖、版本派生正确；检索侧 sibling 展开与 answer 整表交付另有定向单测。
- **检索层（D3）**：`test/assert-finance-table-recall.mjs` 输出 chunk 级 `tableRowCoverage`，
  以「gold 表全部行是否出现在单个 chunk 或 `tableGroupId` 关联组内」为召回通过口径，并区分
  「整表/summary 命中」与「sibling 展开是否生效」。
- **视觉层（D4）**：image 金丝雀能定位 `page_image_ref` 并以图呈现。
- **回归门禁**：`pnpm eval:finance-golden`（deterministic 档）现有 source 级门禁不回归；table 题新增
  诊断与既有门禁解耦。

---

## 11. 文档影响与后续

落地后需同步：

- `datasets/finance/rag-golden/SCHEMA.md`：补 `isTableChunk` / `isTableSummary` / `tableGroupId` 召回语义、
  sibling 展开语义与 image citation 说明。
- `TAXONOMY.md`：校验清单加「整表题须验证 chunk 级整表召回」。
- `packages/rag/src/types.ts` 注释（策略枚举、`resolveChunkerVersion` 版本语义、sibling 展开开关）。
- `apps/finance-api/src/eval/adapter.ts` 注释（`content` 放宽为 `string | Uint8Array`）。
- `test/generate-finance-golden-v1.mjs` 头部注释：说明不再压平 `.txt`、直接透传 PDF bytes。

暂不动代码（本任务仅出方案）；P1 起按 §3 顺序改动。
