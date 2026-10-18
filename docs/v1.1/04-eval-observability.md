# 04 · 评测、可观测性与成本工程

> 维度：Evaluation / Observability / Cost Engineering
> 现状：`packages/eval` 确定性 runner（跑真 agentLoop + mock streamFn，从 run_events 投影打分）+ 30+ case + 7 指标 + baseline 门禁；
> `packages/trace` 最小 RunEvent 契约 + `redactSensitiveValue` 脱敏；run-service 落 `run_events` + SSE 广播。
> 缺口（已落地部分见 §3 标记）：无轨迹级评测、trace 未全量接 OTel 导出管线、无 SLO。
> **已实现（本阶段）**：P0 LLM-as-Judge 校准层（`createLoopLlmJudge` 公共 API）、P1 trace 对齐 OTel `gen_ai` semconv + token/成本字段 + token 级 PII 治理。详见带读文档 `04-eval-observability-reading.md`。

## 1. 行业现状速览（2025–2026）

- **轨迹评测为一等公民**：不只看结果，评 tool 参数、多步、图结构；确定性任务用 trajectory match（strict/subset），开放任务用 LLM-as-Judge，二者混搭。
- **LLM-as-Judge 是默认但有偏差**：需 rubric + 参考答案 + 结构化 JSON；多次采样多数投票校准，"LLM 初筛 + 人工抽检"混合。
- **OTel GenAI 语义约定（2025–26）标准化**：`gen_ai` span、token 属性、agent/MCP 调用，trace/metric/log 三位一体。
- **基准转向真实失败驱动 dataset**：WebArena / SWE-bench / TAU-bench / GAIA + trace→dataset 闭环。
- **成本与可靠成质量第一线**：token/成本归因、SLO+错误预算、对抗/泄露评测（agent failure taxonomy）。

## 2. 本项目差距

- 仅确定性 4 指标，无 LLM-as-Judge（缺语义级、开放任务评分）。
- 无**轨迹级**评测：从 `run_events` 投影"证据"打分，但未把 tool 参数/步骤顺序当评分对象。
- `trace` 未对齐 OTel `gen_ai`，跨 run/tool/provider 不可关联，无 token/成本字段。
- 缺 online eval、人工标注/校准、SLO/错误预算；benchmark 仅自有 30 case。

## 3. 改造方向（按优先级）

### P0 加 LLM-as-Judge 层（低投入高收益）— ✅ 已落地
- **目标**：在 `packages/eval` 对 answerCorrectness/faithfulness 加 rubric 语义校验。
- **落地**：新增 `judge-loop.ts`（`createLoopLlmJudge` 已导出为公共 API），复用 `run_events` 投影证据；
  v1.1 起 judge 走**独立的 judge provider**（`AIAGENT_JUDGE_BASE_URL` / `AIAGENT_JUDGE_API_KEY` / `AIAGENT_JUDGE_MODEL`，
  由 `@aiagent/rag` 的 `readJudgeProviderConfig` 读取）的 `/chat/completions`
  （temperature=0、json_object、samples=3 多数投票、失败降级中性分）；
  **provider 未启用时 `createLoopLlmJudge` 返回 `null`，不再静默回退确定性 mock**（避免伪装成"judge 已运行"的无意义基线），
  需要可复现打分时由测试/调用方显式注入 `packages/eval/src/testing.ts` 的 `createDeterministicMockLoopLlmJudge()`；
  校准分仅追加到逐条 `metrics`（不计入门禁与聚合），**确定性门禁零回归**。现状：judge provider 可选启用，禁用即 `null`。

### P1 trace 对齐 OTel GenAI 语义（低投入高收益）— ✅ 已落地
- **目标**：RunEvent → `gen_ai` span/attribute，补 token/成本字段。
- **落地**：`packages/trace` 加 `otel-semconv.ts`（`toOtelSpan`/`runEventsToOtelSpans`，已 re-export）；
  span 对齐 `gen_ai.agent.run`/`agent.generation`/`tool.call`/`retrieval`；attr 含 `gen_ai.token.count.*`、`gen_ai.request/response.model`、`cost.total`；
  事件 payload 扩展可选 `usage`/`cost`/`model`（向后兼容）；`redactSensitiveValue`/`redactTokenTrace` 扩到 token 级 PII（仅字符串整值脱敏，保护数字/数组落库）。现状：映射层就绪，导出到 Phoenix/OTel Collector 为下一步。

### P2 轨迹评测 + 失败 taxonomy（中收益）— ✅ 已落地
- **目标**：重建 trajectory 评 tool 顺序/参数；定义失败分类（检索缺失/幻觉/工具误用/工作流不完整/循环）。
- **落地**：`packages/eval` 新增 `trajectory.ts`：`extractToolTrajectory`（run_events→有序工具序列）、`matchTrajectory`（strict/subset + 参数校验）、`classifyFailure`（6 类主分类优先级链，覆盖 fail-001 幻觉 / fail-002 检索缺失 / fail-003 工作流不完整）。分类结果作为可选字段挂到 `AutomationCaseResult`，**不进门禁与聚合**（零回归）；`trajectory.test.mjs` 8 例。

### P3 成本归因 + SLO/错误预算（高价值）— ✅ 已落地
- **目标**：跨 run/tool/provider 的 token/成本归因；成功率/延迟 SLO + 错误预算。
- **落地**：
  - 成本归因：`packages/eval` 新增 `cost-attribution.ts`（`computeCostAttribution`/`summarizeCost`，按 model/tool/provider 三维度聚合，防御式读 `usage`/`cost`，缺失/非有限归 0）；run-service 在 `agent_end` 后落 `cost_summary` 能力事件（按 **model/tool** 维度，provider 仅作为 eval 纯函数维度、不落库），`@aiagent/types` 的 `RunEventTypeDto` 与 `@aiagent/trace` 的 `RunEventType` 均扩展 `"cost_summary"`，并新增 DB 迁移 `0230` 扩展 `run_events_event_type_check` 白名单（幂等 + 中文 COMMENT）。
  - SLO/错误预算：`automation.ts` 的 `RegressionThresholds` 增 `p95LatencyMs`（P95 延迟 SLO 预算），新增 `computeSloSummary`（P95 预算 + 错误预算：budget=`1-successRate`、consumed=`1-successRate`、remaining=`max(0,budget-consumed)`、`breached=consumed>budget`）；`checkAutomationRegression` 加 P95 绝对阈值规则（与既有 `maxP95LatencyIncreaseMs` baseline 比较共存）；`AutomationReport` 增可选 `slo?` 字段、`renderMarkdownReport` 增 `## SLO / 错误预算` 段（均增量、零回归）。

### P4 online eval + 真实 benchmark + 人工校准（进阶）— ✅ 已落地
- **目标**：采样线上 run 影子评测；接 GAIA/TAU-bench 适配器；人工标注回流校准 judge。
- **落地**（全部在 `packages/eval`，离线学习级，未改 apps/finance-api 与数据库）：
  - 在线影子评测：`online-eval.ts` 的 `createShadowEvaluator({ judge })` + `sampleAndEvaluate`，只读取线上采样 `{answer, query, contexts}` 离线跑 judge，**绝不写回生产/改 run 状态**。
    v1.1 起 **options.judge 为必填依赖**（不再内部回退确定性 mock 基线）：真实场景传 `createLoopLlmJudge()`（judge provider 启用时返回实例，否则 `null` 需先判空），
    要可复现就显式传 `packages/eval/src/testing.ts` 的 `createDeterministicMockLoopLlmJudge()`。
  - 真实 benchmark 适配器：`benchmark-adapters.ts` 的 `BenchmarkAdapter` 接口 + `benchmarkCaseToUnified` → `benchmarkDatasetToEvalDataset` → 直接喂 `runLoopEval` 管线；`createMockGaiaAdapter`/`createMockTauBenchAdapter` 为确定性 mock（不发起 HTTP）；**真实 GAIA/TAU-bench 集成是扩展点**——只需改写 `loadCases()`，下游管线不变。
  - 人工校准：`calibration.ts` 的 `HumanCalibrationStore`（in-memory）+ `calibrateJudgeScores`（全局偏差 `mean(human)-mean(judge)` + `clamp01` 钳制，纯函数）。
  - `online-eval.test.mjs` / `benchmark-adapters.test.mjs` / `calibration.test.mjs` 初始新增 9 例；当前叠加 provider/model 护栏后 eval 62/62 全绿（含 runLoopEval 7 指标门禁零回归）。

## 4. 学习路径（TS 友好）

- **阶段一（1–2 周）**：读 LLM-as-Judge 模式文 + RAGAS；改 `packages/eval` 加 judge 层 + 多数投票校准；**产出**：混合评分报告。
- **阶段二（2–3 周）**：读 OTel `gen_ai` 规范 + 三位一体文；改 `packages/trace` 加 semconv 映射 + token/cost 字段；**产出**：可接 Phoenix 的 trace。
- **阶段三（3–4 周）**：读 trajectory eval / failure taxonomy；改 eval 加 trajectory match + 失败分类；run-service 加 SLO 门禁；**产出**：轨迹诊断 + 错误预算面板。
- **阶段四（可选）**：接 GAIA 适配器、online 影子评测、人工标注回流。

