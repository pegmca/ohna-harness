# 金融财报 RAG 黄金评测集 · 题型库与标注清单（挑题 → 标注 → 校验）

本文件是「扩作者集到 30–50 条」的**可复用操作手册**。配合 `test/mine-finance-golden.mjs`
（半自动候选抽取）与 `test/promote-finance-golden.mjs`（草稿定稿入册）使用，目标：
把人工挑题最烦的两步——找 PDF、从 PDF 抄数字——自动化掉，人只做「确认 / 改数 / 补拆分」。

## 一、整体流程（四步闭环）

1. **挑题（mine）**：`node test/mine-finance-golden.mjs <candidates.json>` 读候选清单
   `(ticker, report_type, period, type)`，从 manifest 定位 PDF → 抽全文（CJK 空格归一 + 健康度闸门）
   → 按题型模板抽候选片段（含 `page`/`quote`）→ 落 `_drafts/<batch>/<id>.jsonl`（未定稿草稿）。
2. **标注（人工）**：打开草稿，补 `gold_answer` / `gold_answer_table` / `gold_answer_form` / `note`，
   把 `evidence.section` 的「（待补）」换成真实章节名；图片源题补 `source_kind:"image"+ocr_required`。
3. **校验（validate）**：`pnpm eval:finance-golden:validate` 跑结构 / 引用 / 答案层校验，0 ERROR 才许入册。
4. **入册（promote）**：`node test/promote-finance-golden.mjs <batch>` 把该批草稿并入 `golden.jsonl`
   （自动排重 id、去空行、保持 fin-XXX 递增），再 `generate + eval` 看门禁。

## 二、题型模板库（7 类，各给锚点 + 必填字段）

所有 `query` 用自然问句；`evidence` 必锁 `ticker/report_type/period`，避免串报告期。

| type | 锚点（PDF 内章节标题） | 必填答案字段 | 必填/注意 |
| --- | --- | --- | --- |
| `numeric_fact` 数字事实 | 主要会计数据、股东信息、主要会计数据和财务指标 | `gold_answer` + `answer_unit`；**必须合计+拆分** | 拆分不全视为不完整（如股东人数要答 A 股 + H 股 + 合计） |
| `comparison` 跨期对比 | 主要会计数据（两年并列表） | `gold_answer` 显式写「本年 vs 上年 + 增减%」 | 必须给 `distractors`（往期）；`requires_multi_doc` 视是否跨文档 |
| `table` 多行表 | 主要控股/参股公司、长期应收款、坏账准备、应收账款 | `gold_answer_table{columns,rows,units?}` | 稀疏抵减行允许列数少，但要在 `note` 标；`gold_answer` 兜底摘要 |
| `form` 键值表单 | 联系人和联系方式、公司概况 | `gold_answer_form{items:[{key,value}]}` | 同 `table`，结构化呈现，不得只用散文 |
| `definitional` 定义/业务 | 公司从事的主要业务、主营业务 | `gold_answer`（散文）+ 可附 `gold_answer_form` 业务板块 | 长业务描述题，答案要覆盖核心板块 |
| `multi_doc` 跨文档 | 跨报告期/跨公司的同口径数据 | 多 `evidence` + `requires_multi_doc:true` | evidence 至少 2 条；`distractors` 放易混同口径文档 |
| `unit_trap` 单位陷阱 | 主要会计数据（单位：元 / 千元 / 万元） | `gold_answer` 含原单位；`answer_unit` 写清 | 必在 `note` 写明单位坑；优先选单位非「元」的报表 |
| `negative` 无答案反例 | —（语料无此 ticker 或确无该数据） | `gold_answer` 写「语料中无」+ `resolution` | `is_negative:true`、`evidence:[]`、`resolution.type:"ticker_absent"` |

> `form` 与 `table` 在 schema 里是同层（gold_answer_form / gold_answer_table），本报告把它们并为一类
> 「结构化答案」，模板上按「多行=table、键值=form」区分。生成器两种都接受。

## 三、难度分级（difficulty）

- `easy`：单文档单值，字面可答（股东人数、营业收入、联系方式）。
- `medium`：需跨期/跨列计算或结构化抽取（对比增减、控股公司表、坏账表）。
- `hard`：跨文档、单位换算、图片 OCR、最新时间路由（latest_by）、拒答边界。

建议配比：easy 40% / medium 40% / hard 20%。

## 四、覆盖矩阵（目标 30–50 条）

按「题型 × 报告期 × 公司异质度」铺满，而非随机抽：

- **题型**：7 类都要有；`unit_trap` / `multi_doc` / `negative` 至少各 3 条（最测 RAG 弱点的三类）。
- **报告期**：annual 为主（信息最全），补 q1 / interim / q3 各若干；跨期题优先 annual 对 annual。
- **公司异质度**：优先覆盖不同行业（银行/券商/医药/稀土/铁路/电力设备/免税），避免 50 条全是制造业。
- **解析黑名单**：`000001.SZ` 年报抽出来是字符间空格（每块一页），健康度闸门会自动拦截；
  入册前不要手动挑它的年报。其他公司若抽出来空层或异常，mine 会标 `extraction_health:"bad"` 跳过。

## 五、校验清单（入册前逐条过）

- [ ] `id` 唯一、`fin-XXX` 连续、无空行。
- [ ] 非 negative 题 `evidence` 非空且每条命中 manifest（ticker/report_type/period 三元组存在）。
- [ ] `evidence.section` 已填真实章节（无「（待补）」）。
- [ ] 数字事实题给了「合计 + 拆分」。
- [ ] `table`/`form` 题有结构化答案；稀疏行已在 `note` 说明。
- [ ] 跨期/跨文档题 `distractors` 已列易混文档，`note` 写坑点。
- [ ] `unit_trap` 题 `note` 写明单位，`answer_unit` 准确。
- [ ] `latest_by` 题带 `snapshot_dependent:true` + `resolution`（按当前 manifest 重算，语料变要重抄）。
- [ ] `validate` 脚本 0 ERROR（允许 fin-009 式稀疏行 WARN）。
- [ ] `table` 题在 golden 回归中验证 chunk 级整表召回：summary/whole-table 命中后须通过 `tableGroupId` 覆盖全部 gold 行。
- [ ] 运行 `node test/assert-finance-table-recall.mjs <out.json>`，确认 `tableRowCoverage`、缺行清单与 sibling 展开状态符合当前诊断基线；当前 fin-008 仍缺组合计提坏账行，其余四题应完整覆盖。

## 六、与评测管线的关系

- 作者集 `golden.jsonl` 是单一事实来源；**不直接写** `rag-golden-v1.json`。
- 映射：`test/generate-finance-golden-v1.mjs` → `rag-golden-v1.json`（评测器格式）。
- 门禁：`pnpm eval:finance-golden`（deterministic 档）；`answerCorrectness` 偏低属 stub 预期，非映射 bug。
