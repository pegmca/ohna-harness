# v2.0 评测体系改造方案（薄内核 + 领域自治）

> 状态：v2.0 规划 · 唯一权威文档（取代原 `02/03/04` 三份拆分稿）。
>
> **定调**：不建「统一评测体系」，只共享一套**纯机制薄内核（`packages/eval-core`）**；指标定义、数据集 schema、执行器、judge rubric 由各上层应用**完全自治**。
>
> **核心判断**：指标是领域语义——金融 RAG 的 `retrievalHitRate`/`financialAccuracy` 与 ohna 的 `fileChangeCorrectness`/`permissionCompliance` 零交集，强行统一成「指标注册表 + `appliesTo(mode)` 分流」是 leaky abstraction。真正值得共享的，只有「跑 case → 算指标 → 比 baseline → 出报告 → 定 CI 门禁」里那几块**纯机械、零领域知识**的零件。
>
> **研发阶段约束**：本项目无需兼容老代码，任何代码都可直接删除，不做 migrator / 兼容壳 / round-trip 迁移测试。改造以「直接删旧 + 重建新」为原则。

---

## 1. 现状与差距

### 1.1 现有评测资产（`packages/eval`，约 4000 行，全部可删）

| 模块 | 职责 | 改造去向 |
|---|---|---|
| `automation.ts` | `UnifiedEvalCase`/`AutomationMetrics`（7 项金融指标）+ baseline + 门禁 + SLO + Markdown 报告 | 门禁/报告泛化进 `eval-core`；7 项金融打分迁 finance-api |
| `loop-runner.ts` | mock `streamFn` 驱动 `agentLoop`，投影 run_events | 迁 finance-api（写死金融 systemPrompt/`search_filings`/`generate_report`） |
| `runner.ts` + `metrics.ts` + `types.ts` | RAG 执行器：`DataSourceRuntime.answer()`，4 指标 | 迁 finance-api |
| `judge.ts` / `judge-loop.ts` | LLM-as-Judge（rubric 硬编码） | 仅 ~60 行框架核心进内核；rubric+fetch 迁 app |
| `trajectory.ts` | 工具轨迹 match（strict/subset）+ 6 类失败 taxonomy | 匹配算法抽象后进内核；期望推导迁 finance-api |
| `cost-attribution.ts` | 三维成本归因（输入 `LoopEvalRunEvent`，eval 私有形状） | **不进内核**，迁 finance-api（见 §2.3） |
| `online-eval.ts` | 影子评测 | 迁 finance-api（`shadow.ts`） |
| `benchmark-adapters.ts` | GAIA/TAU-bench → `UnifiedEvalCase` | 重定位为通用 `BenchmarkCase`（见 §4.1） |
| `calibration.ts` | judge 偏差校准（纯函数 + 内存 store） | **原样进内核**（唯一零改造模块） |
| `cli.ts` | 硬编码单数据集入口 | 删除，由各 app `eval/index.ts` + 根脚本替代 |

### 1.2 上层应用接入面

- **finance-api**：`application/run-service.ts` 跑真 `agentLoop`，落 run_events / `cost_summary`；`http/routes/rag.ts` 暴露 retrieval/answer，注入 `DataSourceRuntime`。
- **ohna-cli / ohna-web**：`runtime/turn.ts` 调 `agentLoop`（`RunSetup.streamFn` 已是注入点）；`packages/serve` 的 `RunManager` 产 run-v2 事件（含 `llm_call`）。
- 当前 `packages/eval` **零 app 消费方**（grep 证实），可直接整体重写。

### 1.3 差距清单

| # | 差距 | 影响 |
|---|---|---|
| G1 | 评测不触达真实系统（fixture 自证：mock 工具回放 `fixture.retrievedChunks`） | 指标对检索/模型/工具回归失明 |
| G2 | 两套数据集/指标/报告并存（`EvalCaseDto`+`runRagEval` vs `UnifiedEvalCase`+`runLoopEval`） | 双倍口径；RAG 线无 baseline/门禁 |
| G3 | 金融逻辑硬编码在通用执行器（systemPrompt/mock 工具/budget 常量） | ohna 无法复用；违反领域边界 |
| G4 | ohna 产品线零覆盖 | coding/permission/team/compaction 无回归网 |
| G5 | 无期望字段 ⇒ 指标满分参与聚合（`ratio([],...) = 1`） | 虚高聚合值，掩盖回退 |
| G6 | CLI 单数据集硬编码 | 无法多数据集/多应用 |
| G7 | live/shadow/judge/benchmark 已存在但彼此孤立 | 不能一键出报告/判门禁 |
| G8 | case 数硬校验 30–50 | 小样本 benchmark 需绕过 |

---

## 2. 薄内核（`packages/eval-core`）

只放纯函数 + 纯机制，**不参与执行、不认识任何 app**。

```
packages/eval-core/
  src/
    gate.ts        # diffBaseline / evaluateGate（泛化到 Record<string, number>）
    report.ts      # renderMarkdown / writeReports（EvalReportDto 驱动）
    judge.ts       # parseJudgeJson / roundScore / majorityVote / sampleAndAverage / NEUTRAL_SCORE
    calibration.ts # calibrateJudgeScores（原样迁移）
    trajectory.ts  # matchTrajectory（入参抽象为 ToolCallStep[]）
    index.ts
```

> `EvalReportDto`/`BaselineDiff`/`GateResult` 三个跨边界 DTO 定义在 `packages/types/src/eval-report.ts`（见 §2.1），不进 `eval-core`；`eval-core` 以 `import type` 引用，并 re-export 便于调用方。

**依赖方向**：`eval-core → types`（仅 `import type` 引用 `EvalReportDto` 等跨边界 DTO）。零 `@aiagent/agent` / `@aiagent/ai` / `@aiagent/rag` / `@aiagent/trace` 运行时依赖——这是内核的硬边界。

### 2.1 唯一跨 app 契约：`EvalReportDto`

> 归属修正（评审修订）：`EvalReportDto` **定义在 `packages/types`（跨边界线格式）**，`eval-core` 用 `import type` 引用。理由：它是「跨进程 / 跨包 / 跨 app 边界消费」的线格式——§5 规定它输出 `<app>/eval/report.json`、被 CI 门禁消费、未来可能进 Web `/eval` 路由；这与 `LlmCallRecordDto`（`packages/agent` 运行时产出、却定义在 `packages/types`、供 serve/SSE/ohna-web 三方共用）是同一范式。若 `EvalReportDto` 留在 `eval-core` 拥有包，Web 要消费报告就**只能直接依赖 `@aiagent/eval-core`**，违反「app 只依赖浏览器库 + `@aiagent/types`」的硬约束。

```ts
// packages/types/src/eval-report.ts —— 跨边界线格式，eval-core 用 import type 引用
export interface EvalMetricValue {
  name: string;
  value: number;
  unit?: "ratio" | "count" | "ms" | "tokens" | "currency";
  /** 无期望字段的指标不参与聚合（修 G5）。缺省 true。 */
  applicable?: boolean;
}
export interface EvalCaseOutcome {
  id: string;
  passed: boolean;
  /** 该 case 失败的具体指标名（修 RAG 归因丢失，见 §3.3）。 */
  failedMetrics?: string[];
  failedTaxonomy?: string;
}
export interface EvalReportDto {
  target: string;                 // 用 string 而非字面量联合：内核不枚举 app
  dataset: string;
  createdAt: string;
  metrics: EvalMetricValue[];
  cases: EvalCaseOutcome[];
  summary?: string;
}
export type BaselineDiff = {
  metric: string;
  current: number;
  baseline: number;
  delta: number;
  status: "regression" | "improvement" | "unchanged" | "new" | "missing";
};
export type GateResult = { passed: boolean; reasons: string[]; exitCode: 0 | 1 };
```

> 与 §4.2 的关系：`packages/types/src/eval.ts` 的执行 DTO（`EvalCaseDto`/`EvalResultDto`/`RagEvalReportDto`）仍删；新增 `eval-report.ts` 收纳 `EvalReportDto`/`BaselineDiff`/`GateResult` 三个跨边界 DTO。若 Web 要展示评测报告，消费的就是这里的 `EvalReportDto` 线格式，不再另设「展示 DTO」，二者合一。

### 2.2 内核 API（纯函数，无副作用）

```ts
// gate.ts —— 已泛化，不再依赖 AutomationMetrics
export function diffBaseline(curr: EvalReportDto, baseline: EvalReportDto | null): BaselineDiff[];
export function evaluateGate(diff: BaselineDiff[], slos: SloSpec[]): GateResult;

// report.ts
export function renderMarkdown(report: EvalReportDto, diff: BaselineDiff[]): string;
export function writeReports(report: EvalReportDto, outDir: string): Promise<void>;

// judge.ts —— 只共享「解析/投票/降级」机械零件，打分函数由调用方注入
export function parseJudgeJson(text: string): { score?: unknown; reason?: unknown } | null;
export function roundScore(s: number): number;
export function majorityVote(scores: number[], fallback: number): number;
export function sampleAndAverage(
  callModel: (system: string, user: string) => Promise<string>,
  systemPrompt: string, userPrompt: string, samples: number,
): Promise<{ score: number; reason: string }>;
export const NEUTRAL_SCORE = 0.5;

// trajectory.ts —— 入参抽象为 ToolCallStep[]，不依赖金融 fixture，也不依赖 run 事件形状
export interface ToolCallStep {
  tool: string;
  args?: Record<string, unknown>;
  /** 工具调用是否失败——工具检索/few-shot「调用成败」评测需要；薄内核可空但须保留字段位。 */
  isError?: boolean;
}
export function matchTrajectory(actual: ToolCallStep[], expected: ToolCallStep[], mode: "strict" | "subset"): TrajectoryMatch;
```
> **`not_applicable` 不算回归（两域共用的门禁语义，v2.0 team-eval 落地时的共享内核变更）**：
> `diffBaseline` 只比较**两侧都 `applicable !== false`** 的指标（G5 对称性）——之前只过滤当前侧，
> 导致 baseline 侧标记不适用的指标被当成 `missing` 或以 `current=0` 参与判定。此外，**baseline 有值、
> 当前侧不适用**的指标会以 `status: "not_applicable"` 保留在 diff 中（可观测），`evaluateGate` 显式
> 跳过它：既不算通过也不算失败。
>
> 语义依据：`applicable === false` 表示「**本次没有产出该指标的证据**」（典型场景：整档位因缺 provider
> 凭据被跳过），**不是「测出来是 0」**。因此它不得触发 `min` 下限失败，也不得计入 `maxRegression`
> 回归。该规则对 **finance-api 的 RAG 域与 ohna 的 coding / team 域同样生效**，不是 team 专属修复；
> 各域若要「某指标必须存在」，应通过 case 级断言或报告说明表达，而不是靠 baseline 门禁。

> 评审修订：**删掉 `extractToolTrajectory(events: RunEvent[])`**。真实 `RunEvent` 的 `tool_execution_*` 事件 `payload` 是 `unknown`，无法静态取出 `toolName/args/isError`；现有 `packages/eval` 之所以能投影，靠的是私有 `LoopEvalRunEvent`（`loop-projection.ts`），不是 `RunEvent`。若内核以 `RunEvent[]` 为入参，就会引入 `@aiagent/trace` 运行时依赖，违反 §2「零 `@aiagent/*` 依赖」边界。**投影留在各 app eval 域**（`<app>/eval/run.ts` 把 run 事件投影成 `ToolCallStep[]`），内核只做「匹配」，不做「从 run 事件投影轨迹」。这正好是「期望推导留 finance-api」的同一原则。

### 2.3 关键边界修正（评审结论）

1. **成本归因不进内核**。`cost-attribution.ts` 的输入 `LoopEvalRunEvent` 是 eval 私有事件形状，对生产 `cost_summary`/`llm_call` 无效——抽进内核只能服务 mock 执行形态，是「绑定私有形状的领域逻辑」而非「纯机制」。迁 `finance-api/eval/`。未来若要做「生产 run 成本归因」，需先把输入泛化到 `run-v2`/`LlmCallRecordDto`，届时再考虑进内核（不在 v2.0 范围）。

2. **judge 只抽框架壳，rubric 与 provider 读取留 app**。真正可复用的是 `parseJudgeJson`/`roundScore`/`majorityVote`/`sampleAndAverage`/中性分降级（约 60 行）。rubric prompt 文本、`fetch /chat/completions` 调用、`readJudgeProviderConfig`（来自 `@aiagent/rag`）都留 app——后者若进内核会造成 `eval-core → rag` 非法反向依赖。

3. **`target`/`dataset` 用 `string` 而非字面量联合**。`"finance-api" | "ohna"` 会让内核隐式认识具体 app，与「内核不认识任何 app」自述矛盾。

4. **trajectory 匹配是跨 app 通用机制**，但当前 `trajectory.ts` 依赖金融 `UnifiedEvalFixture`。抽象入参为 `ToolCallStep[]` 后进内核；「期望轨迹推导」（依赖金融 fixture）留在 finance-api。

---

## 3. 领域自治（各 app 自己的 `eval/`）

```
apps/finance-api/eval/
  dataset.ts        # 金融 schema + loader（requiredSources/requiredDocumentIds/expectedFacts）
  run.ts            # 执行器：loop / rag / http / shadow
  metrics.ts        # retrievalHitRate / MRR / NDCG / citationCoverage / financialAccuracy ...
  adapter.ts        # 装配 PG/内存 runtime + 金融工具 + 金融 systemPrompt
  judge-rubrics.ts  # faithfulness/contextRecall rubric（含 readJudgeProviderConfig）
  index.ts          # 产出 EvalReportDto → 交给 eval-core 收尾

apps/ohna-cli/eval/
  dataset.ts        # coding schema（workspace 种子、expectedFileChanges、expectedPermissionDenials）
  run.ts            # coding 执行器（真 provider 最小驱动 + mock 工具副作用 + 临时工作区）
  metrics.ts        # fileChangeCorrectness / permissionCompliance / turnEfficiency
  adapter.ts        # 装配 coding tools + permission policy
  judge-rubrics.ts  # answerCorrectness coding rubric
  index.ts
```

### 3.1 执行档位（各 app 内部策略，不进内核）

> **无 mock 模型定调（评审修订）**：已删除 mock 模型——评测**不允许注入 mock `streamFn` 回放固定模型输出**。允许 mock 的只有**工具副作用**（write/edit/bash/search 的 execute 返回固定值），模型这层要么走纯函数（零模型）、要么走真 provider。红线的判据：mock「动作对外部世界的效果」✅，mock「模型下一步选什么工具/说什么话」❌。

| Tier | 模型 | 工具 | 检索 | 用途 | CI 门禁 |
|---|---|---|---|---|---|
| `deterministic` | 零模型（纯函数） | — | — | 纯函数投影 + 纯状态迁移：护栏估算、成本投影、工具子集/摘要解析、轨迹匹配、归因聚合 | **硬门禁（block）** |
| `integration` | 真 provider（最小化：低温、小 `maxTokens`、单轮收敛） | **mock 工具副作用**（execute 返回固定值） | 内存 adapter | 验证工具接线、权限闸门通道、控制流（断言只指流程，不指模型决策） | **硬门禁（block，断言只指控制流）** |
| `live` | 真 provider | 真工具 | 真检索（PG） | 发布前验收、judge 校准、编排决策正确性 | **趋势门禁（不 block）** |
| `shadow` | 不执行 | — | — | 线上采样重放打分 | 趋势门禁（不 block） |

**与 team 场景的关系**：team/Supervisor 评测在此通用档位基础上细化为 `T-L1 / T-L2a / T-L2b / T-L4`（见 `03-team-eval.md`），其中 `deterministic` 拆为纯函数（T-L1）与纯状态迁移（T-L2a），`integration` 对应 mock 工具控制流（T-L2b），`live` 对应真模型 + judge 编排决策（T-L4）。

### 3.2 `packages/eval` 模块去向（完整映射）

| 模块 | 去向 |
|---|---|
| `automation.ts` 门禁/报告 | 泛化进 `eval-core/gate.ts` + `report.ts`（金融指标类型不迁移） |
| `automation.ts` 打分（`scoreCaseWithEvidence`） | `finance-api/eval/metrics.ts`（7 项金融指标） |
| `loop-runner.ts` | `finance-api/eval/run.ts` |
| `loop-projection.ts` | `finance-api/eval/`（金融工具名/事件专属） |
| `runner.ts` + `metrics.ts`（RAG） | `finance-api/eval/` |
| `judge*.ts` 的 rubric + fetch + provider 读取 | `finance-api/eval/judge-rubrics.ts` |
| `judge*.ts` 的 JSON/投票/降级核心 | `eval-core/judge.ts`（~60 行） |
| `calibration.ts` | `eval-core/calibration.ts`（原样） |
| `trajectory.ts`（匹配算法） | `eval-core/trajectory.ts`（入参抽象 `ToolCallStep[]`） |
| `trajectory.ts`（期望推导） | `finance-api/eval/` |
| `cost-attribution.ts` | `finance-api/eval/`（不进内核） |
| `online-eval.ts` | `finance-api/eval/shadow.ts` |
| `benchmark-adapters.ts` | 重定位为通用 `BenchmarkCase`（§4.1） |
| `cases.ts`（demo 语料） | `finance-api/eval/` |
| `testing.ts`（mock judge 替身） | 随目标模块分发 |
| `cli.ts` | 删除，由各 app `eval/index.ts` + 根脚本替代 |
| `packages/types/src/eval.ts` | 删除执行 DTO（`EvalCaseDto`/`EvalResultDto`/`RagEvalReportDto`）；保留 `report.ts` 的展示 DTO 若 Web 仍消费 |

### 3.3 RAG 侧专项（finance-api）

**被测单元**：`DataSourceRuntime.answer(question, {topK, mode})` —— 无 loop 的同步单元，一次调用产出 `RagAnswerDto {answer, citations, retrievalResults}`。这是 RAG 与 Agent「机制可共享、执行不可共享」的根因。

**指标清单（分层，避免过度设计）**：

| 指标 | 类型 | 数据源 | 进内核? | 备注 |
|---|---|---|---|---|
| retrievalHitRate | 确定性 | source/document 命中 topK | 否 | binary 召回；**砍掉 `expectedChunkIds`**（chunk 边界漂移、不可维护，见下） |
| MRR | 确定性 | **document 级**命中的 rank | 否 | **补**：弥补召回无视排序的盲区；rank 口径 = 期望命中文档在 topK 中的位置，**不锚 chunk** |
| NDCG | 确定性 | **document 级** rank + score | 否 | **补**：同上，可复现 |
| citationCoverage | 确定性 | `citations ≥ minCitations` × 证据覆盖 | 否 | 与 deterministic faithfulness 合并（见下） |
| answerCorrectness | 确定性 | `expectedKeywords`/`expectedAnswer` 覆盖 | 否 | 关键词级近似，语义等价靠 judge |
| faithfulness（deterministic） | 确定性 | citation 证据支撑 | 否 | **删除合并进 citationCoverage**：现二者语义重叠，是绕 `createQuote` 截断 bug 的重复信号 |
| llmFaithfulness | judge | RAGAS faithfulness | 否 | 校准信号，不进门禁；**合并后成为唯一 faithfulness 信号，故保留作为门禁的 faithfulness 校准参考** |
| llmContextRecall | judge | RAGAS context recall（输入 `goldEvidence`） | 否 | 校准信号，不进门禁；输入必须是真正的期望证据文本，见前置修正 4 |
| contextPrecision | judge | RAGAS context precision（逐 chunk 相关性） | 否 | 校准信号，不进门禁；见下「保留 context precision」 |
| 拒答率 | 确定性 | `RagAnswerDto.status` | 否 | **前置**：需先给 `RagAnswerDto` 加 `status` 结构化字段；**须与 topK 耦合评测**（见下） |

**保留 `context precision`（评审修订，推翻原「明确不引入」）**：`context recall`（期望证据召没召回）与 `context precision`（召回的东西纯不纯净）是正交维度。对金融 RAG 尤其关键——手写的中文单字 tokenizer（`tokenizeForRetrieval` 把「不良率」「毛利率」拆成单字）会让「率」「毛」「不」互相命中，召回噪声天然偏高；缺 precision 就测不出 keyword 权重调高带来的噪声惩罚。它确实需要 judge rubric，但那是**与 `llmContextRecall` 同一 judge 基础设施下的另一个 rubric**，不是「重复造 rubric」。**降级为 judge 校准信号（不进门槛）保留**，与 `llmContextRecall`/`llmFaithfulness` 并列。

**六个前置修正（RAG 落地前必须做）**：

1. **给拒答补结构化信号 + 暴露证据充分性阈值**。`RagAnswerDto` 增加 `status?: "answered" | "insufficient_evidence"`（或 `refused: boolean`），`synthesizeRagAnswer` 两条分支分别打标。注意：拒答分支当前**并非** `citations.length === 0`（`answer.ts` 里拒答时 `citations: retrievalResults.slice(0, 2)` 有值），真正的现状是只能匹配 `answer` 文本里的魔法字符串「当前资料不足，无法可靠回答」——这才是要消灭的脆弱代理。**同时**把 `isEvidenceSufficient`（`answer.ts` 硬编码 `queryTermCoverage >= 0.15 || finalScore >= 0.42`）的阈值做成可注入/可观测参数：否则「拒答率」只能测「拒没拒」，测不了「该拒的拒没拒、不该拒的误拒没拒」（拒答的 precision/recall 才是金融 RAG 的核心风险点）。

2. **收敛命中字段并迁出 types**。`EvalCaseDto` 的 `requiredDocumentIds`/`requiredSources`/`expectedChunkIds` 三套命中约束中，**删 `expectedChunkIds`**（chunk 级命中不可维护，见前置修正 4），统一为「source 级命中 + 可选 documentId 级命中」。同时把 `EvalCaseDto` 从 `packages/types` 迁到 `finance-api/eval/dataset.ts`（兑现「领域 case 类型不进 types」）。

3. **写死 `EvalMetricDto → EvalReportDto` 映射契约**。现有 `EvalMetricDto` 是 `{name, score, passed, details?}`，与 `EvalReportDto.metrics` 的 `{name, value, unit?}` 不同构：
   - `metrics[].value` = 各指标跨 case 聚合均值（复用 `averageMetric`）；
   - `cases[].passed` = `metrics.every(m => m.passed)`；
   - **`cases[].failedMetrics`** 承载「哪几个指标挂了」，否则逐 case 归因在扁平化时丢失、内核失败归因退化。

4. **给 dataset 增加与切块解耦的语义级期望证据 `goldEvidence`**。`expectedChunkIds` 之所以砍，除了「边界漂移」，真正的坑是 `chunking.ts` 的 `heading_aware` 与 `fixed_size` 两种策略对同一文档 `chunkIndex` 递增语义不同（block 顺序 vs 字符窗口）、chunk id 命名空间却相同——切块策略一换，chunk 级 golden label 整体作废。因此：**命中约束只用 document/source 级（deterministic 指标），语义级「期望证据」用独立于切块参数的 `goldEvidence` 文本表达，让 judge 判语义覆盖**。同时修掉 `llmContextRecall` 现状的语义 bug：`runner.ts` 现用 `expectedAnswer + expectedKeywords` 冒充「期望证据」，judge 拿答案比检索结果，测出来既不是 context recall 也不是 answer correctness——必须改喂 `goldEvidence`。

5. **把 `ChunkingOptions` 贯穿到 runtime ingest**。`chunkIngestedDocument(document, options)` 接受 `ChunkingOptions`，但 `data-source-runtime.ts` 调用时不传 options、永远用 `DEFAULT_CHUNKING_OPTIONS`（heading_aware/1200/150）。§3.3 想测「切片评测维度（maxChars 800 vs 1200 的 ablation）」，当前 ingest 路径**根本没有切块参数注入点**——要么绕过 runtime 直接调底层函数（不算测真实系统，撞上 G1 要修的坑），要么死路。把 `ChunkingOptions` 作为 `DataSourceRuntimeOptions` 的一部分可注入（或在 ingest 请求里透传）。

6. **正视 `RagAnswer = RagAnswerDto` 的隐性耦合**。`packages/rag/src/types.ts` 里 `export type RagAnswer = RagAnswerDto`——rag 领域类型直接别名了 types 跨边界 DTO。给 `RagAnswerDto` 加 `status` 会同时改 `synthesizeRagAnswer` 返回、`DataSourceRuntime.answer` 返回、`packages/types` 线格式，「动一处改三处」。这不是「轻量加一个可选字段」，需在 Step 3 验收时明确这条前置项同时触及三处，并据此决定是否要把 rag 领域类型与跨边界 DTO 拆开（`RagAnswer` 为领域类型、`RagAnswerDto` 为线格式）。

**前置修正 #1 / #5 / #6（部分）已完成状态（rag-prereq）**：本阶段已在共享包落地非破坏性实现，Step 3 无需重复处理：
- **#1**：`packages/types/src/rag.ts` 的 `RagAnswerDto` 已加可选 `status?: "answered" | "insufficient_evidence"`（中文 JSDoc 说明取代魔法字符串）；`packages/rag/src/answer.ts` 的 `synthesizeRagAnswer` 末尾追加可选 `threshold?: { minQueryTermCoverage?: number; minFinalScore?: number }`（缺省沿用常量 0.15 / 0.42，行为零回归），`isEvidenceSufficient` 改用注入阈值，两分支分别打 `insufficient_evidence` / `answered`；`createRagAnswer` 入参增可选 `status` 并透传。阈值可注入使「拒答率」可测 precision/recall。
- **#5**：`chunkIngestedDocument(document, options)` 的 options 注入点已贯通——`DataSourceRuntimeOptions` 增可选 `chunkingOptions?: ChunkingOptions`，`data-source-runtime.ts` 构造时保存、ingest 透传 `options.chunkingOptions ?? DEFAULT_CHUNKING_OPTIONS`，缺省行为不变（仍 heading_aware/1200/150）。
- **#6（部分，决策：不拆分）**：本阶段**保持** `export type RagAnswer = RagAnswerDto` 别名，仅在 DTO 加可选 `status`（非破坏性），未拆分领域类型与跨边界 DTO。理由：拆分属 Step 3 更大重构、会动 `packages/eval` 与 `apps/*` 的既有消费，超出本前置修正的「零回归」边界；`status` 作为可选字段已让三处（synthesizeRagAnswer / DataSourceRuntime.answer / 线格式）同步受益，无需拆类型即满足 #1 目标。若 Step 3 决定拆分，再单独排期。
- 验收护栏：`pnpm --filter @aiagent/rag test` 全绿（含默认阈值回归 + 调高阈值翻转为拒答用例），`packages/types`、`packages/rag`、`packages/eval` 均 `build` 成功，零新增 `@aiagent/*` 运行时依赖。

**shadow 衔接**：`ShadowResult`（`{caseId, query, answerCorrectness, faithfulness, ...}`）与 `EvalReportDto` 无法直接衔接，且其 `faithfulness` 是 judge 判定、与 runner 的 deterministic `faithfulness` **同名不同源**。需补 `ShadowResult → EvalReportDto` 适配器，并将 shadow 的 `faithfulness` 改名 `llmFaithfulness`（或独立 dataset `finance/rag-shadow`）。

**rerank 回退层级可观测性（补强）**：rerank 当前是三层回退（`HeuristicReranker` → cross-encoder `/rerank` → LLM-judge → hybridScore 兜底），且 `reranking-providers.ts` 明确「rerank 永远 ok、绝不抛异常」——live 环境 rerank provider 未配好时 NDCG 会**无声退化回 heuristic**。当前 `RetrievalTraceSummary` 只记录 `rerankScore/finalScore`，不记录走了哪层。**评测 rerank 维度时，trace 必须能区分「走了 /rerank / judge / heuristic / hybrid 兜底」哪一层**，否则精排静默失效会被误判为「rerank 本身不行」。

**topK 与拒答耦合（补强）**：topK 不是孤立参数——`synthesizeRagAnswer` 的拒答分支在 `sufficientResults.length === 0` 时触发，而 `sufficientResults` 来自 topK 召回经 `isEvidenceSufficient` 过滤，**topK 越小越容易误拒**。金融场景拒答是安全网（不编造数据），topK 太小会误杀可答问题、太大塞噪声。**topK 的评测应做成「topK × 拒答率 × 答案正确性」的三元权衡**，而非孤立测「topK=3/5/8/10 的 NDCG」；默认 topK=5 对需要跨段证据的金融答案可能偏小。

**失败样例回灌闭环（补强，原文档缺失）**：现有 `collectFailures` 只把失败 case 打进报告，`fail-001/002/003` 是手写死的 demo，`rootCause()/improvement()` 是硬编码字符串映射——v2 删掉重建后**没有替代的回灌机制**，shadow 又「只读不写回」，线上累积的检索 miss 永远进不了评测集。补一个最小闭环（不进 `eval-core`，留各 app）：

```
线上/评测失败 case → 归因（failedMetrics + failedTaxonomy）
  → 按失败类别分流（检索缺失→切片/topK/embedding；幻觉→rerank/prompt；工具误用→工具检索）
  → 修复后把 case 回灌 dataset 作回归护栏 → 重跑 baseline
```

落点：`<app>/eval/dataset.ts` 的 loader 支持「从上次报告 `failures + failedTaxonomy` 反推生成/追加候选 case」，或至少声明「回灌 = 手写入 `<app>/eval/dataset.json` + 提交 git，不进 eval-core」；shadow 采样的 `{query, 检索 miss 标记, 期望证据}` 沉淀为候选 case，走显式「promote to golden」动作（哪怕 v2 范围只做「导出候选 + 人工确认」，也要定下接口位置）。

### 3.4 编码 Agent 侧（ohna）

首批指标：`fileChangeCorrectness`（mustContain/diff 匹配）、`permissionCompliance`（拒绝/批准行为符合 `expectedPermissionDenials`）、`turnEfficiency`（实际 turn vs 预算）。证据来自 run_events + workspace 快照。从 `--tier integration`（真 provider 最小驱动 + mock 工具副作用 + 临时工作区）起步。

**控制类 RAG 指标（补强，原文档缺失）**：上述三项都是「单 agent 执行结果」视角，漏了「工具检索 / few-shot 选择」这条控制类链路——对编码 Agent，工具选择正确性比文件改动正确性更靠前的回归点。补一个 `toolSelectionCorrectness`（期望工具序列 vs 实际 `ToolCallStep[]`，含 `isError`），证据源是 `agentLoop` 的 `tool_execution_*` run 事件（经 app eval 域投影成 `ToolCallStep[]`，不进内核投影）。**这依赖「模型自主选择工具」而非已删除的 Intent Router**——评测以 run 事件为唯一事实源，不重建任何路由分支。

**评测范围声明（补强）**：v2.0 评测范围 = **单 agent 闭环**。`team`/Supervisor 多智能体编排（`ARCHITECTURE §8` 的 `TeamController`、`projectTeamCostSummary`、`cost_summary.team` 段）**不在本期评测覆盖内，作为明确 gap 记录**。原因：① team 的 15× token 成本收口是 P0 但属独立评测面；② `permissionCompliance` 需扩展到「supervisor 派发的子代理是否继承权限策略（`beforeToolCall` 继承）」；③ team 成本归因有现成的 `projectTeamCostSummary` 投影可复用。三者单列一节（建议 v2.1）再补，本期不混入单 agent 指标。

---

## 4. 两处归属决策（需拍板，但不阻塞主线）

### 4.1 `benchmark-adapters.ts`（GAIA/TAU-bench）

GAIA/TAU 是通用 benchmark，非金融专属，但当前 `benchmarkCaseToUnified` 把 `expectedAnswer` 合成金融 `UnifiedEvalCase`（fixture），被金融 schema 绑架。**建议**：适配器产出通用 `BenchmarkCase`，由各 app 自己的 loader 决定如何映射到自己的 case schema。

### 4.2 `packages/types/src/eval.ts` 去留

删除执行 DTO（`EvalCaseDto`/`EvalResultDto`/`RagEvalReportDto`）；新增 `eval-report.ts` 收纳 `EvalReportDto`/`BaselineDiff`/`GateResult`（见 §2.1），供 `eval-core` 与 Web 共用同一线格式，不再设独立的「展示 DTO」。若 Web 仍消费旧 `ProductEvalReportDto`（`report.ts`），迁移到 `eval-report.ts` 后一并删除旧 `report.ts`。

---

## 5. CI 约定（唯一跨 app 的强制接口）

1. **命令**：每个 app 暴露 `pnpm eval:<app>`（`eval:finance-api` / `eval:ohna`）。
2. **产物**：跑完输出 `<app>/eval/report.json`（`EvalReportDto`，定义在 `packages/types`），调用 `eval-core.evaluateGate` 决定 exit code（门禁非零即 1）。

```bash
pnpm eval:finance-api --tier deterministic   # CI 硬门禁（纯函数 + 纯状态）
pnpm eval:ohna         --tier integration    # CI 硬门禁（真 provider + mock 工具）
pnpm eval:finance-api --tier live --judge    # 趋势门禁 / 发布前验收
pnpm eval:finance-api --update-baseline      # 只写 <app>/eval/baseline.json
```

**强制接口 vs 可选共享的澄清（评审修订）**：原「薄内核是可选共享，不是强制框架」与「产物/门禁是强制接口」自相矛盾——若某 app 完全不引入 `eval-core`，就无法产出 `EvalReportDto` 形状的 report.json、也无法调 `evaluateGate`。澄清为二选一：

- **`report.json` 的形状约定（`EvalReportDto`）是「可选」的**：app 可自定报告形状，只要 CI 能判 exit code；不强制所有 app 都用 `eval-core`。
- **`EvalReportDto` 与 `evaluateGate` 对「已采用 `eval-core` 的 app」是「事实强制」的**：一旦引入 `eval-core`，产物形状与门禁语义就固定。

即：**薄内核是可选共享；但「CI 门禁 exit code」是强制约定**——app 可用 `eval-core` 实现，也可自实现等价门禁，只要「门禁失败 → 非零退出」成立。二者不再互斥。

**`evaluateGate(null baseline)` 语义写死（补强）**：首次跑（`baseline === null`）时，`evaluateGate` 的判定**强制为「先建 baseline，不判 pass/fail」**——返回 `GateResult{ passed: false, reasons: ["无 baseline，需先 --update-baseline"], exitCode: 1 }`（或用独立 exit code 语义如「0 但提示待建基线」，需在契约里明确）。避免两个 app 各自解释「无 baseline 是放行还是拦停」。Step 3 验收「首次产出报告并建基线，不是保持一致」正对应此语义。

---

## 6. 改造步骤（不兼容老代码，直接删 + 重建）

> 每步独立可验收；不做 migrator / 兼容壳 / round-trip 测试。

### Step 0 — 盘点与删除清单确认
- **产出**：确认 `packages/eval` 全量可删、`packages/types/src/eval.ts` 执行 DTO 可删（Web 展示 DTO 去留见 §4.2）。
- **验收**：删除清单无外部引用（grep 无 app 消费方）。

### Step 1 — 抽薄内核 `packages/eval-core`
- **产出**：`packages/eval-core/src/{gate,report,judge,calibration,trajectory,index}.ts`；`packages/types/src/eval-report.ts`（`EvalReportDto`/`BaselineDiff`/`GateResult`）。
- **接口**：见 §2.1、§2.2。
- **命令**：`pnpm --filter @aiagent/eval-core build && pnpm --filter @aiagent/eval-core test`。
- **验收**：`calibration.ts` 原样迁移测试全绿；`judge.ts` 60 行核心测试全绿；`gate.ts`/`report.ts` 对 `Record<string, number>` 输入单测通过；`trajectory.ts` 入参为 `ToolCallStep[]`（无 `extractToolTrajectory`，投影留 app）的单测通过；`eval-core` 以 `import type` 引用 `packages/types` 的 `EvalReportDto` 且无任何 `@aiagent/agent/ai/rag/trace` 运行时依赖。
- **关键**：本步只**新增** `eval-core` + `packages/types/src/eval-report.ts`，不动 `packages/eval`。

### Step 2 — 修 G5（applicable）
- **产出**：`EvalMetricValue.applicable?: boolean`；`evaluateGate` 聚合跳过 `applicable === false`。
- **补充（v2.0 team-eval 落地时回改内核）**：`applicable` 的语义在**门禁**层补齐为对称过滤——`diffBaseline` 两侧都过滤，新增 `BaselineDiff.status` 的 `"not_applicable"` 取值，`evaluateGate` 跳过它（详见 §2.2「`not_applicable` 不算回归」）。这是**跨域行为变更**（同时影响 finance-api 的 RAG 域与 ohna 的 coding / team 域），不是 team 专属修复；两域基线若含历史 `applicable=false` 指标，重跑 baseline 后不再产生假失败。
- **验收**：单测覆盖「无期望字段的 chat case 其 citationCoverage 不进聚合」，以及 `gate.test.mjs` 的「当前侧 `applicable=false` 记 `not_applicable` 而非 `missing`」「`not_applicable` 不触发 `min` 失败」。

### Step 3 — finance-api 领域自治化
- **产出**：`apps/finance-api/src/eval/{dataset,run,metrics,adapter,judge-rubrics,index}.ts`；`datasets/finance/rag-v1.json`（迁原 `datasets/eval-financial-v1.json`）。
- **接口**：`run.ts` 导出 `runFinanceEval(dataset, {tier, judge?, baseline?}): Promise<EvalReportDto>`；`metrics.ts` 导出 `scoreCaseWithEvidence`（金融指标）；`index.ts` 调 `eval-core.evaluateGate` 判 exit code。
- **数据集生成器唯一性（provenance 约束，跨工作项对齐）**：`datasets/finance/rag-v1.json` 的**唯一权威生成器是 `test/generate-finance-rag-v1.mjs`**（幂等、字节级可复现，输出自描述 `generatedBy` 字段）。该生成器**不写 `expectedDocumentIds`**（仅 source 级命中），且 `minCitations=2`。**禁止**改用已被取代的旧迁移脚本（`test/migrate-finance-eval-dataset.mjs`，v2.0 落地时已删除；本文档若再引用该名字均指这一历史脚本）重跑——它会按 source 列表回填 `expectedDocumentIds`，而真实 `citation.documentId` 是 ingest 生成的 UUID，会让 `metrics.ts` 的 documentId 优先匹配分支恒为 0，导致 `retrievalHitRate`/`mrr`/`ndcg` 跌至 ~0、破坏 CI 门禁。若需调整数据集，一律改 `generate-finance-rag-v1.mjs` 后重跑。
- **黄金评测集 → 评测器映射（学习期自建真值链路）**：人工标注的投研知识库真值放在 `datasets/finance/rag-golden/golden.jsonl`（作者集，约定见同目录 `SCHEMA.md`），由 `apps/finance-golden-studio` 的 `golden-studio generate` 映射为评测器格式 `datasets/finance/rag-golden-v1.json`。它与 `rag-v1.json` 的权威生成器**互不覆盖**：前者把真实 PDF 原始字节以 base64 信封填入 `documents.content`，loader 解码后直接走真实 `ingestDocument`（deterministic 档真实 ingest 的前提），source 标识稳定为 `<ticker>/<report_type>/<period>`，同样**不设 `expectedDocumentIds`**、`minCitations=2`；`latest_by` 时间解析题按当前 manifest 重算最新报告期，避免引到过时或不存在的 PDF。运行：
  ```bash
  pnpm eval:finance-golden:validate                          # 校验作者集 golden.jsonl（结构/引用/答案）
  pnpm eval:finance-golden:generate                          # 由 golden.jsonl 生成 rag-golden-v1.json
  pnpm eval:finance-golden:update-baseline                   # 建基线（等价底层 --update-baseline）
  pnpm eval:finance-golden                                  # 判门禁（等价底层确定性档）
  ```
  前三个根脚本直接委托 `apps/finance-golden-studio` 的单一 `golden-studio` bin；评测门禁继续落到 `apps/finance-api` 的 `eval:golden*` 子脚本。底层等价命令为
  `pnpm golden-studio generate` 与
  `pnpm --filter @aiagent/finance-api eval --dataset ../../datasets/finance/rag-golden-v1.json [--update-baseline]`。
  注意：deterministic 档的 `answer` 是 mock-embedding + 摘要式 stub 合成（无 LLM），真实 PDF 经 OCR 后数字常带空格（如 `184, 679`），故 `answerCorrectness` 偏低属预期；该指标的真实语义需等 Step 5 的 live/judge 链路。`negative` 反例题（语料无此 ticker）映射为 `mode="failure"` 占位，deterministic 档当前不执行，留 Step 5。

  **作者集扩量与半自动抽取（学习期 30–50 条基准）**：人工从 1000 份 PDF 挑题最烦的是「找 PDF + 抄数字」。复用工具链见同目录 `datasets/finance/rag-golden/TAXONOMY.md`（题型模板库 + 挑题→标注→校验清单）与 `apps/finance-golden-studio/README.md`：
  ```bash
  pnpm golden-studio mine --candidates <candidates.json> --batch <batch> # 抽候选片段落 _drafts/<batch>/
  pnpm --filter @aiagent/finance-golden-studio dev                      # Web 补答案并手填 expected_keywords
  pnpm golden-studio validate --batch <batch> --json                    # 0 ERROR 才可发布
  pnpm golden-studio promote --batch <batch>                            # 人工审核(_draft.approved=true)后并入 golden.jsonl
  ```
  关键约束：每道非负例题必须手填至少一个来源可达的 `expected_keywords`，`generate` 不得自行从答案反推；抽取健康度闸门会拦截「字符间空格缺陷」PDF（如 `000001.SZ` 年报每块一页、CJK 带间距，锚点搜索与子串匹配全废），这类文件**不要手工挑入册**；`_drafts/` 是人工待审核工作区，已加 `.gitignore`，作者集 `golden.jsonl` 本身保留入库。
- **前置**：先完成 §3.3 的六个前置修正（`RagAnswerDto.status` + 阈值暴露、`EvalCaseDto` 迁出 types、删 `expectedChunkIds`、`goldEvidence`、`ChunkingOptions` 贯穿、`RagAnswer`/`RagAnswerDto` 拆解决策、`EvalMetricDto → EvalReportDto` 映射）。
- **命令**：根 `package.json` 增 `"eval:finance-api": "pnpm --filter finance-api eval"`。
- **验收**：`--tier deterministic` 跑通并**新建 baseline**（RAG 线当前无 baseline，验收是「首次产出 `EvalReportDto` 并建基线」，不是「保持一致」）；`eval-core` 只被 `finance-api/eval` 依赖。

### Step 4 — ohna 接入（完全自治）
- **产出**：`apps/ohna-cli/src/eval/{dataset,run,metrics,adapter,judge-rubrics,index}.ts`（v2.0/03 追加 `src/eval/team/` 子域）；`datasets/ohna/coding-v1.json`（首批 ≥20 cases：read/edit/bash 闭环、权限拒绝、超预算收敛）。
- **接口**：`metrics.ts` 导出 `fileChangeCorrectness`/`permissionCompliance`；`run.ts` 导出 `runOhnaEval(dataset, {tier, judge?, baseline?})`。
- **命令**：根增 `"eval:ohna": "pnpm --filter ohna-cli eval"`。
- **验收**：`--tier integration` 跑通 ≥20 cases，产出 `EvalReportDto` 判门禁；ohna-cli 增 `@aiagent/eval-core` 依赖声明。

### Step 5 — live / judge / shadow / benchmark（各 app 内部）
- **产出**：`finance-api/eval/run.ts` 增 `--tier live`（真 provider + PG 检索）；`judge-rubrics.ts` 接校准；`shadow.ts`（迁 online-eval + `ShadowResult → EvalReportDto` 适配器 + faithfulness 改名）；benchmark 走通用 `BenchmarkCase`，case 校验放宽为 dataset 级 `minCases`（修 G8）。
- **命令**：`pnpm eval:finance-api --tier live --judge`。
- **验收**：live 产出报告判门禁（judge 仅校准信号，不进 pass/fail）；shadow 只读不写回；benchmark 小样本（3–5 cases）可跑。

### Step 6 — 删除 `packages/eval` + 收尾
- **产出**：删除 `packages/eval`（全量，不保留 barrel）；清理 `packages/types/src/eval.ts`；更新 `ARCHITECTURE.md`、`docs/v1.1/04` 状态段；CI 增 ohna 门禁。
- **命令**：`pnpm eval:finance-api && pnpm eval:ohna` 双门禁。
- **验收**：双门禁全绿；depcruise 无 `packages/eval` 残留引用；typecheck 全绿。

---

## 7. 依赖合规

- `eval-core` 只 `import type` 引用 `@aiagent/types` 的 `EvalReportDto`/`BaselineDiff`/`GateResult`（新增 `eval-report.ts`）；零 `agent/ai/rag/trace` 依赖。
- 各 app `eval/` 新增 `@aiagent/eval-core` 依赖声明（遵守「依赖声明与引用一致」规范）。
- depcruise 白名单：`apps/*/eval → packages/eval-core`。
- 每步同步更新 `ARCHITECTURE.md` 与 `docs/v1.1/04` 状态段。

## 8. 本期明确的边界与 gap（评审增补）

- **范围**：v2.0 评测覆盖 = 单 agent 闭环（finance 单 agent + ohna 单 agent）；`team`/Supervisor 多智能体编排评测**不在本期**，作为 gap 记录（§3.4）。
- **失败回灌**：只做「归因输出 + 候选 case 沉淀」，full 自动回灌不进 `eval-core`（§3.3）。
- **控制类 RAG**（工具检索/few-shot）评测归属各 app 自己的 eval 域，`ToolCallStep[]` 为证据源，不重建 Intent Router（§3.4）。
