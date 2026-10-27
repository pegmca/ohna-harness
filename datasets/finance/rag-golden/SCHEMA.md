# 金融财报 RAG 黄金评测集 · 作者集 Schema

本文件定义投研知识库 RAG 的**黄金评测集（golden set）**手工标注格式。目标是：从真实 PDF 中人工挑题、转录真值，供管线做端到端评测与解析质量评测。

适用阶段：学习期自建评测集。建议规模 30–50 条为正式基准，15–20 条可用于早期迭代。

## 一、统一规则（已与用户敲定）

1. **数字事实题**：标准答案必须同时给出**合计 + 拆分**，缺拆分视为不完整（例：股东人数要答 A 股 + H 股 + 合计）。
2. **表格 / 多字段题**（`type: "table"` 或联系信息、公司概况等结构化答案）：标准答案一律用 `gold_answer_table`（多行表）或 `gold_answer_form`（键值表单）结构化呈现，不可只用散文摘要。`gold_answer` 仍保留一句人类可读摘要作为兜底与降级展示。
3. **图片源题目**：财报中表格本身是图片（非可选中文本）时，在 `evidence` 上标记 `source_kind: "image"` + `ocr_required: true`，并尽量填写 `page_image_ref` 定位到 PDF 页码，便于解析质量抽查。
4. **跨期 / 跨报告陷阱**：用 `distractors` 显式列出易混淆的同源文档（如不同年度年报），并在 `note` 里写明坑点。
5. **报告期锁定**：`evidence` 必须明确 `ticker / report_type / period`，避免模型串报告期。

## 二、两级评估约定

- **一级·解析准确率**：针对 `ocr_required: true` 的图片源题目，比对解析器 OCR 文本与人工 `quote`，衡量"有没有把图片里的表抽出来"。这是管线的"金丝雀"。
- **二级·端到端回答准确率**：标准 RAG 评测（检索 + 生成 vs `gold_answer` / `gold_answer_table`）。评测报告应按 `source_kind` 拆分，区分"答错"还是"根本没解析/没检索到"。

## 三、字段定义

顶层对象（每条一行 JSONL）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 编号，如 `fin-001` |
| `query` | string | 用户问句 |
| `type` | enum | 见下方枚举 |
| `difficulty` | enum | `easy` / `medium` / `hard` |
| `answer_type` | enum | `number` / `list` / `table` / `form` / `text` |
| `gold_answer` | string | 人类可读摘要（兜底 / 降级展示） |
| `gold_answer_table` | object | 可选；多行表 `{columns, units?, rows}` |
| `gold_answer_form` | object | 可选；键值表单 `{groups?, items:[{key,value}]}` |
| `answer_unit` | string | 单位，如 `户` / `元` / `家/万元` / `文本` |
| `evidence` | array | 真值出处，见下方 |
| `requires_multi_doc` | bool | 是否必须跨文档 |
| `distractors` | array | 易混淆同源文档 `{ticker, report_type, period}` |
| `is_negative` | bool | 是否为"文档中无答案"的反例题 |
| `note` | string | 坑点 / 标注说明 |

### `type` 枚举
`numeric_fact` / `definitional` / `comparison` / `multi_doc` / `table` / `unit_trap` / `negative`

### `evidence` 元素

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ticker` | string | 证券代码，如 `000776.SZ` |
| `report_type` | enum | `annual` / `interim` / `q1` / `q2` / `q3` / `prospectus` / `announcement` / `esg` |
| `period` | string | 报告期，如 `2025Q1` / `2025` / `2025H1` |
| `section` | string | 章节（待补时写 `（待补：xxx）`） |
| `page` | int | 页码，未知填 0 |
| `quote` | string | 人工从真值转录的原文 / 数值 |
| `source_kind` | enum | `text` / `table` / `image`（图片源必填 `ocr_required`） |
| `ocr_required` | bool | 出处为图片时 `true` |
| `page_image_ref` | string | 可选，`<file_path>#page=N` 定位 |

## 四、时间解析类题目（“最新 / 最近 / 近年来” 等相对时间词）

- “最新”不是固定时间点，而是**查询时解析**出来的：同一 `ticker` 在语料中 `disclosure_date` 最晚的那条记录。它属于 Query Understanding / 时间路由子系统的职责，作者集不应把它当静态真值写死进 `evidence`。
- 存放约定：
  - `query` 保持自然语言（含“最新”），不要预解析成具体报告期。
  - 黄金答案数值是**快照值**：以数据集定稿时的语料为准计算；新增顶层字段 `resolution` 记录解析规则与当时解析出的报告期，并在顶层标 `snapshot_dependent: true`。若语料后续新增更晚披露的文件，数值与解析结果必须重算。
  - `resolution` 结构：`{ type: "latest_by", field: "disclosure_date", scope: "ticker=<ticker>", expected_report: "<report_type>/<period>" }`。
  - `evidence.period` 在此类题里表示“期望解析命中的文档”，是**解析正确性的诊断项**，不是不可变来源；评测应拆出“解析是否正确命中最新文档”与“答案数值是否正确”两个指标。
  - `distractors` 放往期文档（如旧年报），用于检验时间路由而非检索。

## 五、已记录样例索引

- `fin-001` 广发证券 2025Q1 股东人数（数字事实，合计+拆分）
- `fin-002` 华东医药 2025 vs 2024 营收对比（`comparison`）
- `fin-003` 北方稀土主要控股参股公司（`table`，`gold_answer_table`）
- `fin-004` 大秦铁路联系人和联系方式（`table`，`gold_answer_table`）

- 作者集扩量与半自动抽取工具链见同目录 `TAXONOMY.md`（题型模板库 + 挑题→标注→校验清单）、`test/mine-finance-golden.mjs`（候选抽取）、`test/promote-finance-golden.mjs`（草稿定稿入册）。
- 人工补真值最便捷的方式是 Web 标注器：`node test/annotate-finance-golden.mjs`（默认端口 5174），浏览器打开 `http://localhost:5174/` 即可逐条填表单（query / gold_answer / gold_answer_table 表格网格 / gold_answer_form 键值表单 / evidence.section / distractors / 勾选「已审核」），并内嵌原文 PDF 预览链接；保存后写回 `_drafts/<batch>/<id>.jsonl`，`promote` 闸门只读 `_draft.approved=true` 的草稿。对应 pnpm 脚本：`eval:finance-golden:annotate`。

种子数据见同目录 `golden.jsonl`。

## 六、从作者集到评测器的映射（生成链路）

- 作者集（`golden.jsonl`）是人工标注的单一事实来源；**不要把真值直接写成评测器的 `rag-golden-v1.json`**，统一由生成器映射。
- 生成器：`test/generate-finance-golden-v1.mjs`（`node test/generate-finance-golden-v1.mjs`），产出 `datasets/finance/rag-golden-v1.json`。
- 映射约定（与 `rag-v1.json` 口径对齐）：
  - 每条非 negative case 按 `evidence[].ticker+report_type+period` 从 `manifest/manifest.jsonl` 定位真实 PDF，把原始字节以 `{contentEncoding:"base64", contentBase64}` 信封填入 `documents.content`；loader 解码为 `Uint8Array` 后直接进入真实 `ingestDocument`。
  - `source` 标识稳定为 `<ticker>/<report_type>/<period>`，`.fileName` 保持 `.pdf`。
  - **不设 `expectedDocumentIds`**（真实 `citation.documentId` 是 ingest 时 UUID）；`minCitations=2`。
  - `latest_by` 时间解析题：生成器按当前 manifest 取同 ticker 披露日最晚的一条**重算**报告期与 `file_path`，避免引到过时/不存在的 PDF；gold_answer 仍是作者集快照值，语料变更须人工重抄（见 `fin-008` 示例）。
  - `negative` 题（语料无此 ticker）映射为 `mode="failure"` + `documents:[]` 占位；deterministic 档当前不执行，留 Step 5。
- 校验顺序：先 `node test/validate-finance-golden.mjs` 校验作者集，再生成并跑评测器。
- 当前 PDF 解析在 worker 行聚合阶段归一 CJK/数字坏层，保留 `U+3000` 与真实列间隔，并用 `sourceLayer:"char_spaced"` 标记坏层页面。
- 当前 `table_aware` 切块生成共享 `tableGroupId` 的整表与 summary sibling；命中任一同组 chunk 后会在 rerank 前展开整表，整表 answer/citation 保留完整表文本。
- `rag-golden-v1.json` 因内嵌 PDF 原始字节（base64）约 73 MB；这是让确定性评测走真实解析路径的当前取舍。
- 已知局限（学习期预期）：deterministic 档的 answer 是 mock-embedding + 摘要式 stub，`answerCorrectness` 偏低属正常；真实语义判分需 Step 5 的 live/judge。当前 golden 尚无 `source_kind:"image"` 样本，图片 citation/OCR 通道以 image 金丝雀为前置。
