# 金融财报 RAG 黄金评测集 · 作者集 Schema

本文件定义投研知识库 RAG 的**黄金评测集（golden set）**手工标注格式。目标是：从真实 PDF 中人工挑题、转录真值，供管线做端到端评测与解析质量评测。

适用阶段：学习期自建评测集。建议规模 30–50 条为正式基准，15–20 条可用于早期迭代。

## 一、统一规则（已与用户敲定）

1. **数字事实题**：标准答案必须同时给出**合计 + 拆分**，缺拆分视为不完整（例：股东人数要答 A 股 + H 股 + 合计）。
2. **表格 / 多字段题**（`type: "table"` 或联系信息、公司概况等结构化答案）：标准答案一律用 `gold_answer_table`（多行表）或 `gold_answer_form`（键值表单）结构化呈现，不可只用散文摘要。`gold_answer` 仍保留一句人类可读摘要作为兜底与降级展示。
3. **图片源题目**：财报中表格本身是图片（非可选中文本）时，在 `evidence` 上标记 `source_kind: "image"` + `ocr_required: true`，并尽量填写 `page_image_ref` 定位到 PDF 页码，便于解析质量抽查。
4. **跨期 / 跨报告陷阱**：用 `distractors` 显式列出易混淆的同源文档（如不同年度年报），并在 `note` 里写明坑点。
5. **报告期锁定**：`evidence` 必须明确 `ticker / report_type / period`，避免模型串报告期。
6. **评测关键词**：所有非 negative 题必须手填 `expected_keywords: string[]`，至少一个非空值；每个关键词必须能在本题 `evidence` 指向的真实解析 PDF 中命中。不得从 `gold_answer` 自动反推，也不得用不存在的词凑数。
7. **来源引用可校验**：`evidence` 的 `ticker / report_type / period` 三元组必须与 `manifest.jsonl` 中至少一条记录精确匹配，不允许回退到同公司其他报告期；evidence 非空且每条来源 PDF 必须可读取、可解析。`file_path` 是 manifest 的唯一文档身份，同一语义三元组可以对应 A/H 等不同变体；此时无选择器的 evidence 必须报结构化歧义，作者需填写 `document_file_path`。
8. **作者集完整性**：`evidence.section` 不得残留 `（待补：…）` / `（候选：…）` 标记；`golden.jsonl` 每行一个对象、ID 唯一、文件至少一条记录。任何 ERROR 都会阻止 promote / generate。

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
| `expected_keywords` | string[] | 非 negative 题必填；人工确认、PDF 原文可达的评测关键词 |
| `resolution` | object | 可选；时间路由或反例的解析规则，见时间解析与反例约定 |
| `snapshot_dependent` | bool | 可选；快照型 `latest_by` 题必须为 `true` 且带 `resolution` |

### `type` 枚举
`numeric_fact` / `definitional` / `comparison` / `multi_doc` / `table` / `unit_trap` / `negative`

### `evidence` 元素

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ticker` | string | 证券代码，如 `000776.SZ` |
| `report_type` | enum | `annual` / `interim` / `q1` / `q2` / `q3` / `prospectus` / `announcement` / `esg` |
| `period` | string | 报告期，如 `2025Q1` / `2025` / `2025H1` |
| `document_file_path` | string | 可选；同三元组存在多个 manifest 文档时必填，精确选择 `file_path` |
| `section` | string | 已完成定位的真实章节名；草稿阶段可临时写 `（待补：xxx）`，校验 / 入册时必须替换 |
| `page` | int | 页码，未知填 0 |
| `quote` | string | 人工从真值转录的原文 / 数值 |
| `source_kind` | enum | `text` / `table` / `image`（图片源必填 `ocr_required`） |
| `ocr_required` | bool | 出处为图片时 `true` |
| `page_image_ref` | string | 可选，`<file_path>#page=N` 定位 |

### `expected_keywords` 写作规则

- 只写人工能从来源原文复核的短锚点，优先使用题目要求的关键数值、单位组合、实体名或字段名。
- PDF 空白差异可以忽略：匹配时会去掉 Unicode 空白并统一大小写；标点、数字分隔符和其余字符仍需一致。
- 每个关键词独立扫描本题全部 evidence PDF；至少命中一份即可，报告会保留命中的 evidence 索引。
- 空数组、空白字符串、非字符串、来源中不可达的关键词均为 ERROR。negative 题不要求该字段；如填写，仍须可解析为字符串数组。
- `expected_keywords` 直接供 `generate` 使用，生成器不得自行从答案文本推导关键词。

### `gold_answer_table` 规则

- `columns` 必须是非空字符串数组，`rows` 必须是数组，每个单元格必须是字符串（缺失单元格用 `""`）。
- 行单元格数少于 `columns` 时允许作为稀疏行，但会产生 `table_sparse_row` WARNING，作者必须在 `note` 中确认该省略是有意的。

## 四、反例题约定

- `is_negative: true`、`type: "negative"`、`evidence: []` 必须同时成立。
- `resolution.type` 必须为 `"ticker_absent"`。使用 scoped 形态时写 `scope: "ticker=<ticker>"` 与 `expected_report: "（无）"`；也支持显式 `ticker` 的直接形态。
- 校验器会在 manifest 中确认该 ticker 确实缺席；若语料已收录该 ticker，反例失效并报 ERROR。
- negative 不要求 `expected_keywords`，因为无来源 PDF 可供可达性检查。

## 五、时间解析类题目（“最新 / 最近 / 近年来” 等相对时间词）

- “最新”不是固定时间点，而是**查询时解析**出来的。默认作用域是同一 `ticker + report_type + period` 内 `disclosure_date` 唯一最晚的那条记录；其他报告类型或报告期不参与比较。若 A/H 等变体披露日并列，解析器返回结构化歧义，绝不按 manifest 行序选择。它属于 Query Understanding / 时间路由子系统的职责，作者集不应把它当静态真值写死进 `evidence`。
- 存放约定：
  - `query` 保持自然语言（含“最新”），不要预解析成具体报告期。
  - 黄金答案数值是**快照值**：以数据集定稿时的语料为准计算；新增顶层字段 `resolution` 记录解析规则与当时解析出的报告期，并在顶层标 `snapshot_dependent: true`。若语料后续新增更晚披露的文件，数值与解析结果必须重算。
  - `resolution` 结构：`{ type: "latest_by", field: "disclosure_date", scope: "ticker=<ticker>", expected_report: "<report_type>/<period>", variant?: "<a|h|...>" }`。`variant` 只在同报告期跨 A/H 变体消歧时填写；不得从 `title` 猜测 H 股。
  - `evidence.period` 在此类题里表示“期望解析命中的文档”，是**解析正确性的诊断项**，不是不可变来源；评测应拆出“解析是否正确命中最新文档”与“答案数值是否正确”两个指标。
  - `distractors` 放往期文档（如旧年报），用于检验时间路由而非检索。

## 六、已记录样例索引

- `fin-001` 广发证券 2025Q1 股东人数（数字事实，合计+拆分）
- `fin-002` 华东医药 2025 vs 2024 营收对比（`comparison`）
- `fin-003` 北方稀土主要控股参股公司（`table`，`gold_answer_table`）
- `fin-004` 大秦铁路联系人和联系方式（`table`，`gold_answer_table`）

- 作者集扩量与半自动抽取工具链见同目录 `TAXONOMY.md`（题型模板库 + 挑题→标注→校验清单）与 `apps/finance-golden-studio/README.md`。候选抽取、草稿标注、校验、定稿、生成和评测统一经 `pnpm golden-studio <subcommand>`。
- 人工补真值的入口是 Finance Golden Studio Web 工作台：先运行 `pnpm --filter @aiagent/finance-golden-studio dev` 并打开 `http://127.0.0.1:5173/`，或构建后运行 `pnpm golden-studio serve`（默认 `http://127.0.0.1:4318/`）。工作台支持 query、`gold_answer`、表格/表单、`evidence.section`、distractors、来源 PDF 与 `expected_keywords`；保存写回 `_drafts/<batch>/<id>.jsonl`，`promote` 只发布 `_draft.approved=true` 且校验通过的草稿。

种子数据见同目录 `golden.jsonl`。

## 七、从作者集到评测器的映射（生成链路）

- 作者集（`golden.jsonl`）是人工标注的单一事实来源；**不要把真值直接写成评测器的 `rag-golden-v1.json`**，统一由生成器映射。
- 生成器：`pnpm golden-studio generate`，产出 `datasets/finance/rag-golden-v1.json`。
- 映射约定（与 `rag-v1.json` 口径对齐）：
  - 每条非 negative case 按 evidence 的 `document_file_path` 或无歧义三元组从 `manifest/manifest.jsonl` 定位真实 PDF，把原始字节以 `{contentEncoding:"base64", contentBase64}` 信封填入 `documents.content`；loader 解码为 `Uint8Array` 后直接进入真实 `ingestDocument`。
  - `source` 与 `fileName` 使用解析出的稳定 `file_path`，`expectedSources` 同步使用该文件身份；同一三元组可区分 A/H 文件。
  - **不设 `expectedDocumentIds`**（真实 `citation.documentId` 是 ingest 时 UUID）；`minCitations=2`。
  - `latest_by` 时间解析题：生成器按当前 manifest 取同 `ticker/report_type/period` 披露日唯一最晚的一条**重算** `file_path`，避免引到过时/不存在的 PDF；披露日跨变体并列时报结构化歧义，可由 `resolution.variant` 显式消歧。gold_answer 仍是作者集快照值，语料变更须人工重抄（见 `fin-008` 示例）。
  - `negative` 题（语料无此 ticker）映射为 `mode="failure"` + `documents:[]` 占位；deterministic 档当前不执行，留 Step 5。
  - `expected_keywords` 原样映射为评测器的 `expectedKeywords`，不得从 gold prose、表格或表单反推。
- 校验顺序：先 `pnpm golden-studio validate --golden --json` 校验作者集，再 `pnpm golden-studio generate --json` 生成并跑 `pnpm eval:finance-golden`。
- 当前 PDF 解析在 worker 行聚合阶段归一 CJK/数字坏层，保留 `U+3000` 与真实列间隔，并用 `sourceLayer:"char_spaced"` 标记坏层页面。
- 当前 `table_aware` 切块生成共享 `tableGroupId` 的整表与 summary sibling；命中任一同组 chunk 后会在 rerank 前展开整表，整表 answer/citation 保留完整表文本。
- 图片型来源由 `source_kind:"image"` + `ocr_required:true` + `page_image_ref` 标记；图片资产按 `<documentId>#page=N` 存入文档级 `PageImageRepository`。`fin-014` 是中微公司 2025 年报第 25 页的页面图片金丝雀，OCR 尚未接入。
- `rag-golden-v1.json` 因内嵌 PDF 原始字节（base64）约 73 MB；这是让确定性评测走真实解析路径的当前取舍。
- 已知局限（学习期预期）：deterministic 档的 answer 是 mock-embedding + 摘要式 stub，`answerCorrectness` 偏低属正常；真实语义判分需 Step 5 的 live/judge。图片视觉通道当前止于页面 PNG 与 image citation 元数据，OCR 仍留作后续。
