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
    contract.ts    # EvalReportDto / BaselineDiff / GateResult / exit code 语义
    gate.ts        # diffBaseline / evaluateGate（泛化到 Record<string, number>）
    report.ts      # renderMarkdown / writeReports（EvalReportDto 驱动）
    judge.ts       # parseJudgeJson / roundScore / majorityVote / sampleAndAverage / NEUTRAL_SCORE
    calibration.ts # calibrateJudgeScores（原样迁移）
    trajectory.ts  # matchTrajectory / extractToolTrajectory（入参抽象为 ToolCallStep[]）
    index.ts
```

**依赖方向**：`eval-core → types`（仅 `import type` 引用 primitives）。零 `@aiagent/agent` / `@aiagent/ai` / `@aiagent/rag` 依赖——这是内核的硬边界。

### 2.1 唯一跨 app 契约：`EvalReportDto`

> 归属修正：`EvalReportDto` **定义在 `eval-core/contract.ts`（拥有包）**，不进 `packages/types`。它是内核的运行时输入契约，不是跨边界线格式；仓库规范「types 只收跨边界 DTO」下它应归属拥有包，与 `Message` 归 `@aiagent/ai` 同范式。

```ts
// packages/eval-core/src/contract.ts
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

// trajectory.ts —— 入参抽象为 ToolCallStep[]，不依赖金融 fixture
export interface ToolCallStep { tool: string; args?: Record<string, unknown>; }
export function extractToolTrajectory(events: RunEvent[]): ToolCallStep[];
export function matchTrajectory(actual: ToolCallStep[], expected: ToolCallStep[], mode: "strict" | "subset"): TrajectoryMatch;
```

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
  run.ts            # coding 执行器（真 coding tools + mock 模型 + 临时工作区）
  metrics.ts        # fileChangeCorrectness / permissionCompliance / turnEfficiency
  adapter.ts        # 装配 coding tools + permission policy
  judge-rubrics.ts  # answerCorrectness coding rubric
  index.ts
```

### 3.1 执行档位（各 app 内部策略，不进内核）

| Tier | 模型 | 工具 | 检索 | 用途 |
|---|---|---|---|---|
| `replay` | mock streamFn | fixture 回放 | fixture 回放 | CI 门禁、零成本回归 |
| `mock-llm` | mock streamFn | **真工具** | 内存 adapter 真检索 | 验证工具接线与权限闸门 |
| `live` | 真 provider | 真工具 | 真检索（PG） | 发布前验收、judge 校准 |
| `shadow` | 不执行 | — | — | 线上采样重放打分 |

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
| retrievalHitRate | 确定性 | source/document 命中 topK | 否 | binary 召回；**砍掉 `expectedChunkIds`**（chunk 边界漂移、不可维护） |
| MRR | 确定性 | 期望命中的 rank | 否 | **补**：弥补召回无视排序的盲区 |
| NDCG | 确定性 | rank + score | 否 | **补**：同上，可复现 |
| citationCoverage | 确定性 | `citations ≥ minCitations` × 证据覆盖 | 否 | 与 deterministic faithfulness 合并（见下） |
| answerCorrectness | 确定性 | `expectedKeywords`/`expectedAnswer` 覆盖 | 否 | 关键词级近似，语义等价靠 judge |
| faithfulness（deterministic） | 确定性 | citation 证据支撑 | 否 | **降级合并**：现与 citationCoverage 语义重叠，是绕 `createQuote` 截断 bug 的重复信号 |
| llmFaithfulness | judge | RAGAS faithfulness | 否 | 校准信号，不进门禁 |
| llmContextRecall | judge | RAGAS context recall | 否 | 校准信号，不进门禁 |
| 拒答率 | 确定性 | `RagAnswerDto.status` | 否 | **前置**：需先给 `RagAnswerDto` 加 `status` 结构化字段 |

**明确不引入**：`context precision`（本质逐 chunk 语义相关性判定，需 judge rubric，与 `llmContextRecall` 定位重叠，重复造 rubric）。

**三个前置修正（RAG 落地前必须做）**：

1. **给拒答补结构化信号**。`RagAnswerDto` 增加 `status?: "answered" | "insufficient_evidence"`（或 `refused: boolean`），`synthesizeRagAnswer` 两条分支分别打标。否则「拒答率」只能匹配魔法字符串或 `citations.length === 0` 这种脆弱代理，是假指标。这是唯一需要动 `packages/rag` 的前置项。

2. **收敛命中字段并迁出 types**。`EvalCaseDto` 的 `requiredDocumentIds`/`requiredSources`/`expectedChunkIds` 三套命中约束中，**删 `expectedChunkIds`**（chunk 级命中不可维护），统一为「source 级命中 + 可选 documentId 级命中」。同时把 `EvalCaseDto` 从 `packages/types` 迁到 `finance-api/eval/dataset.ts`（兑现「领域 case 类型不进 types」）。

3. **写死 `EvalMetricDto → EvalReportDto` 映射契约**。现有 `EvalMetricDto` 是 `{name, score, passed, details?}`，与 `EvalReportDto.metrics` 的 `{name, value, unit?}` 不同构：
   - `metrics[].value` = 各指标跨 case 聚合均值（复用 `averageMetric`）；
   - `cases[].passed` = `metrics.every(m => m.passed)`；
   - **`cases[].failedMetrics`** 承载「哪几个指标挂了」，否则逐 case 归因在扁平化时丢失、内核失败归因退化。

**shadow 衔接**：`ShadowResult`（`{caseId, query, answerCorrectness, faithfulness, ...}`）与 `EvalReportDto` 无法直接衔接，且其 `faithfulness` 是 judge 判定、与 runner 的 deterministic `faithfulness` **同名不同源**。需补 `ShadowResult → EvalReportDto` 适配器，并将 shadow 的 `faithfulness` 改名 `llmFaithfulness`（或独立 dataset `finance/rag-shadow`）。

### 3.4 编码 Agent 侧（ohna）

首批指标：`fileChangeCorrectness`（mustContain/diff 匹配）、`permissionCompliance`（拒绝/批准行为符合 `expectedPermissionDenials`）、`turnEfficiency`（实际 turn vs 预算）。证据来自 run_events + workspace 快照。从 `--tier mock-llm`（真 coding tools + mock 模型 + 临时工作区）起步。

---

## 4. 两处归属决策（需拍板，但不阻塞主线）

### 4.1 `benchmark-adapters.ts`（GAIA/TAU-bench）

GAIA/TAU 是通用 benchmark，非金融专属，但当前 `benchmarkCaseToUnified` 把 `expectedAnswer` 合成金融 `UnifiedEvalCase`（fixture），被金融 schema 绑架。**建议**：适配器产出通用 `BenchmarkCase`，由各 app 自己的 loader 决定如何映射到自己的 case schema。

### 4.2 `packages/types/src/eval.ts` 去留

删除执行 DTO（`EvalCaseDto`/`EvalResultDto`/`RagEvalReportDto`）；若 Web 仍消费 `ProductEvalReportDto`（`report.ts`），保留展示 DTO，否则一并删。

---

## 5. CI 约定（唯一跨 app 的强制接口）

1. **命令**：每个 app 暴露 `pnpm eval:<app>`（`eval:finance-api` / `eval:ohna`）。
2. **产物**：跑完输出 `<app>/eval/report.json`（`EvalReportDto`），调用 `eval-core.evaluateGate` 决定 exit code（门禁非零即 1）。

```bash
pnpm eval:finance-api --tier replay          # CI 门禁
pnpm eval:ohna         --tier mock-llm
pnpm eval:finance-api --tier live --judge    # 发布前
pnpm eval:finance-api --update-baseline      # 只写 <app>/eval/baseline.json
```

未来 app 若连「跑→打分→出报告」节奏都不同，可完全不引入 `eval-core`——薄内核是「可选共享」，不是「强制框架」。

---

## 6. 改造步骤（不兼容老代码，直接删 + 重建）

> 每步独立可验收；不做 migrator / 兼容壳 / round-trip 测试。

### Step 0 — 盘点与删除清单确认
- **产出**：确认 `packages/eval` 全量可删、`packages/types/src/eval.ts` 执行 DTO 可删（Web 展示 DTO 去留见 §4.2）。
- **验收**：删除清单无外部引用（grep 无 app 消费方）。

### Step 1 — 抽薄内核 `packages/eval-core`
- **产出**：`packages/eval-core/{contract,gate,report,judge,calibration,trajectory,index}.ts`。
- **接口**：见 §2.1、§2.2。
- **命令**：`pnpm --filter @aiagent/eval-core build && pnpm --filter @aiagent/eval-core test`。
- **验收**：`calibration.ts` 原样迁移测试全绿；`judge.ts` 60 行核心测试全绿；`gate.ts`/`report.ts` 对 `Record<string, number>` 输入单测通过；`trajectory.ts` 入参为 `ToolCallStep[]` 的单测通过。
- **关键**：本步只**新增** `eval-core`，不动 `packages/eval`。

### Step 2 — 修 G5（applicable）
- **产出**：`EvalMetricValue.applicable?: boolean`；`evaluateGate` 聚合跳过 `applicable === false`。
- **验收**：单测覆盖「无期望字段的 chat case 其 citationCoverage 不进聚合」。

### Step 3 — finance-api 领域自治化
- **产出**：`apps/finance-api/eval/{dataset,run,metrics,adapter,judge-rubrics,index}.ts`；`datasets/finance/rag-v1.json`（迁原 `datasets/eval-financial-v1.json`）。
- **接口**：`run.ts` 导出 `runFinanceEval(dataset, {tier, judge?, baseline?}): Promise<EvalReportDto>`；`metrics.ts` 导出 `scoreCaseWithEvidence`（金融指标）；`index.ts` 调 `eval-core.evaluateGate` 判 exit code。
- **前置**：先完成 §3.3 的 `RagAnswerDto.status` 结构化字段 + `EvalCaseDto` 迁出 types + 删 `expectedChunkIds` + `EvalMetricDto → EvalReportDto` 映射。
- **命令**：根 `package.json` 增 `"eval:finance-api": "pnpm --filter finance-api eval"`。
- **验收**：`--tier replay` 跑通并**新建 baseline**（RAG 线当前无 baseline，验收是「首次产出 `EvalReportDto` 并建基线」，不是「保持一致」）；`eval-core` 只被 `finance-api/eval` 依赖。

### Step 4 — ohna 接入（完全自治）
- **产出**：`apps/ohna-cli/eval/{dataset,run,metrics,adapter,judge-rubrics,index}.ts`；`datasets/ohna/coding-v1.json`（首批 ≥20 cases：read/edit/bash 闭环、权限拒绝、超预算收敛）。
- **接口**：`metrics.ts` 导出 `fileChangeCorrectness`/`permissionCompliance`；`run.ts` 导出 `runOhnaEval(dataset, {tier, judge?, baseline?})`。
- **命令**：根增 `"eval:ohna": "pnpm --filter ohna-cli eval"`。
- **验收**：`--tier mock-llm` 跑通 ≥20 cases，产出 `EvalReportDto` 判门禁；ohna-cli 增 `@aiagent/eval-core` 依赖声明。

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

- `eval-core` 只 `import type` 引用 `@aiagent/types` 的 primitives；零 `agent/ai/rag` 依赖。
- 各 app `eval/` 新增 `@aiagent/eval-core` 依赖声明（遵守「依赖声明与引用一致」规范）。
- depcruise 白名单：`apps/*/eval → packages/eval-core`。
- 每步同步更新 `ARCHITECTURE.md` 与 `docs/v1.1/04` 状态段。
