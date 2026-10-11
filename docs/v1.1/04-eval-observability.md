# 04 · 评测、可观测性与成本工程

> 维度：Evaluation / Observability / Cost Engineering
> 现状：`packages/eval` 确定性 runner（跑真 agentLoop + mock streamFn，从 run_events 投影打分）+ 30 case + 4 指标 + baseline 门禁；
> `packages/trace` 最小 RunEvent 契约 + `redactSensitiveValue` 脱敏；run-service 落 `run_events` + SSE 广播。
> 缺口：无 LLM-as-judge、无轨迹级评测、trace 未对齐 OTel、无 token/成本字段、无 SLO。

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

### P0 加 LLM-as-Judge 层（低投入高收益）
- **目标**：在 `packages/eval` 对 answerCorrectness/faithfulness 加 rubric 语义校验。
- **落地**：新增 `judge/` 模块（ESM 导入），复用 `run_events` 投影证据；mock 模式用确定性 rubric，真模型走 `packages/ai` 的 `streamSimple`；现有 30+3 失败 case 作校准集，多数投票。

### P1 trace 对齐 OTel GenAI 语义（低投入高收益）
- **目标**：RunEvent → `gen_ai` span/attribute，补 token/成本字段。
- **落地**：`packages/trace` 加 semconv 映射层（span=`agent.*/tool.*`，attr=`gen_ai.token.count.*`、`gen_ai.request.model`、`cost`）；run-service 落表同步 OTel 字段；`redactSensitiveValue` 扩到 token 级 PII。

### P2 轨迹评测 + 失败 taxonomy（中收益）
- **目标**：重建 trajectory 评 tool 顺序/参数；定义失败分类（检索缺失/幻觉/工具误用/循环）。
- **落地**：`packages/eval` 增 trajectory 投影与 match 评分，把 3 失败 case 归类。

### P3 成本归因 + SLO/错误预算（高价值）
- **目标**：跨 run/tool/provider 的 token/成本归因；成功率/延迟 SLO + 错误预算。
- **落地**：run-service 汇总 token→cost 按 provider/model/tool 维度；基线门禁升级为 SLO（P95、成功率预算）。

### P4 online eval + 真实 benchmark + 人工校准（进阶）
- 采样线上 run 影子评测；接 GAIA/TAU-bench 适配器；人工标注回流校准 judge。

## 4. 学习路径（TS 友好）

- **阶段一（1–2 周）**：读 LLM-as-Judge 模式文 + RAGAS；改 `packages/eval` 加 judge 层 + 多数投票校准；**产出**：混合评分报告。
- **阶段二（2–3 周）**：读 OTel `gen_ai` 规范 + 三位一体文；改 `packages/trace` 加 semconv 映射 + token/cost 字段；**产出**：可接 Phoenix 的 trace。
- **阶段三（3–4 周）**：读 trajectory eval / failure taxonomy；改 eval 加 trajectory match + 失败分类；run-service 加 SLO 门禁；**产出**：轨迹诊断 + 错误预算面板。
- **阶段四（可选）**：接 GAIA 适配器、online 影子评测、人工标注回流。

