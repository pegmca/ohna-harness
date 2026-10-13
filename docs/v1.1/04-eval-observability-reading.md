# 带读路线：评测增强（LLM-as-Judge）与可观测性对齐 OTel（v1.1）

> 配套文档：`docs/v1.1/04-eval-observability.md`（需求、行业速览与改造方向）
> 参考实现：`https://github.com/badlogic/pi-mono`（pi-agent，简称 pi）
> 本路线把 Task 2 落地的内容按"评测校准信号 → trace 三位一体 → token/成本字段 → token 级 PII 治理"的顺序，
> 把代码位置、设计思想、pi 对应物、零回归纪律与学习检查点串起来。
> 读法建议：先通读一节的理论，再打开对应 `file_path:line` 读源码，最后回看该节的「学习检查点」。

---

## 0. 全局心智模型（先看这张图）

```
                         ┌──────────────────────────────────────────────┐
  确定性质量闸门          │  runLoopEval（跑真 agentLoop + mock streamFn）   │
  （baseline 门禁，        │  1) 跑真循环 → run_events 投影 evidence          │
   7 项指标，零改动）       │  2) scoreCaseWithEvidence 确定性打分 + 门禁       │
                         └───────────────┬──────────────────────────────┘
                                         │ 可选注入 judge
                                         ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  P0 LLM-as-Judge（校准信号，不计入门禁）                              │
   │  createLoopLlmJudge → LoopLlmJudge（judgeAnswerCorrectness /       │
   │  judgeFaithfulness）→ 追加 llmAnswerCorrectness / llmFaithfulness    │
   │  默认确定性 mock（词元重叠，可复现）；可选真实模型（多数投票校准，降级）  │
   └──────────────────────────────────────────────────────────────────┘

                         ┌──────────────────────────────────────────────┐
  P1 可观测性对齐 OTel     │  RunEvent → OtelSpan（gen_ai.* 语义约定）        │
  + token/成本字段         │  agent.run / agent.generation / tool.call /    │
  + token 级 PII          │  retrieval / internal；defensive token/cost     │
                         │  redactTokenTrace / isSensitiveKey（字符串整值） │
                         └──────────────────────────────────────────────┘
```

**一句话**：Task 2 没有动"确定性质量闸门"的任何门禁口径（零回归硬约束），只在它旁边**挂了一层 LLM-as-Judge 校准信号**，把 trace 包从"最小事件契约"升级成"对齐 OTel `gen_ai` 的可观测边界 + token/成本字段 + token 级 PII 治理"。新增能力都是**可选追加 / 防御式读取**，缺省不生效、不破坏既有形状。

---

## 1. P0 LLM-as-Judge 层（语义校准，不碰门禁）

**读什么**
- `packages/eval/src/judge-loop.ts`
  - `LoopLlmJudge` 接口（`:27`）：两个 rubric——`judgeAnswerCorrectness`（答案是否覆盖期望要点）、`judgeFaithfulness`（答案论断是否被检索上下文支撑，无幻觉）。注意返回值 `JudgeScore { score, reason }`。
  - `createLoopLlmJudge(options?)`（`:191`）：工厂。**未显式传 `baseUrl`/`apiKey` 时从 `@aiagent/rag` 的 `readBridgeConfig` 读 bridge env**；仅当两个都非空才绑定 `callModel`（真实模型模式），否则 `null` → 确定性 mock。
  - `deterministicAnswerCorrectness`（`:142`）/ `deterministicFaithfulness`（`:164`）：用"有意义词元重叠率"打分（过滤中英文停用词，见 `STOPWORDS` `:64` / `extractMeaningfulTerms` `:92`）。**完全可复现**——测试与 CI 依赖它，真实模型模式只是可选的增强。
  - `sampleAndAverage`（`:293`）：真实模型模式下每个 rubric 采样 `samples`（默认 3）次取平均（多数投票校准）；单次失败 `catch` 后降级中性分 `NEUTRAL_SCORE = 0.5`（`LOOP-JUDGE` 兜底，绝不 throw 到主流程）。
  - `parseJudgeJson`（`:111`）：容错解析模型 JSON（支持 ```json 围栏与散落文本抽取），解析不出 → 中性分。
- `packages/eval/src/automation.ts`
  - `CaseMetrics`（`:44`）：在 7 项确定性指标基础上，**可选**追加 `llmAnswerCorrectness?` / `llmFaithfulness?`（带 `?`，缺省不存在）。
  - `scoreCaseWithEvidence(item, f, judgeScores?)`（`:129`）：**`judgeScores` 为可选参数**。仅当传入时才在 `metrics` 追加两项校准分（`:156-159`）；**不传时函数行为与改造前逐字节一致**（字段数量、顺序、`passed`、返回形状全不变）——这是零回归的物理保证。
  - `AGGREGATED_METRIC_KEYS`（`:165`）：聚合口径**显式写死 7 项确定性指标**，judge 校准分永不进入聚合。
  - `renderMarkdownReport`（`:94`）：报告头 `LLM judge: ${report.run.llmJudge ? "已启用" : "未使用"}`——动态反映是否启用。
- `packages/eval/src/loop-runner.ts`
  - `LoopEvalOptions.judge?`（`:98`）：注入入口。
  - `computeLoopJudgeScores(judge, item, evidence)`（`:185`）：把 `evidence.answer`/`expectedFacts+expectedCitations`/`retrievedChunks` 编排成两个 rubric 调用，返回已解析纯数字。`runLoopEval`（`:140-142`）仅在 `options.judge` 存在时才计算并透传；报告 `llmJudge: Boolean(options.judge)`（`:165`）。

**pi 对应物**：pi 的 RAGAS 对齐 judge（`packages/eval/src/judge.ts` 的 `createLlmJudge` / `computeRagMetrics`）已有 `faithfulness` / `context_recall` 范式。本处把它**同构迁移到 loop eval**：rubric 文案（`:274` / `:279`）、`response_format: json_object`、`temperature=0`、失败降级中性分，都与 RAG judge 一致——体现"一套 judge 工程范式复用"。

**零回归纪律（最关键）**
- 门禁阈值（`checkAutomationRegression` `:193`）只看 7 项确定性指标；judge 校准分 `passed` 恒为 `true`（`:151`），绝不进 `failures`，绝不拉低门禁。
- 不传 judge 时：`AutomationReport.run.llmJudge === false`，逐条 `metrics` 无 `llm*` 键，聚合无 `llm*` 键，与改造前完全一致。测试 `loop-runner-judge.test.mjs` 用 `deterministicKeys` 只比 7 项来守护这一点。

**学习检查点**
- 为什么 judge 必须"只做校准、不进门禁"？LLM-as-Judge 有偏差（RAGAS 论文已述），直接当门禁会让 CI 抖动、噪声变高；把它放成"人读报告时的语义参考 + 未来人工校准集"才是工程正解。
- 为什么默认走确定性 mock 而非强制真实模型？真实模型有网络/密钥/成本依赖，会让 eval 不可复现；**默认可复现、真实模式可选**是"质量工程素养"的体现（对齐 `04-eval-observability.md` 的"LLM 初筛 + 人工抽检"混合）。
- 多数投票校准：为什么采样 3 次取平均？单样本 LLM 打分方差大，多次采样平均近似降低方差、逼近"多数投票"稳定值。

---

## 2. P1 trace 对齐 OTel GenAI 语义约定

**读什么**
- `packages/trace/src/otel-semconv.ts`
  - `OtelSpan` 接口（`:18`）：`traceId` / `spanId` / `parentSpanId` / `name` / `kind`（`agent`/`tool`/`retrieval`/`internal`）/ `startTime` / `endTime?` / `attributes`。
  - `toOtelSpan(event)`（`:57`）：把单条 `RunEvent` 投影为 span。关键映射：
    - `agent_start`/`agent_end` 共享 `spanId: agent-${traceId}`（后端合并为一个 run span），start 写请求侧（`gen_ai.request.model`/`gen_ai.system`/`gen_ai.agent.name`），end 写响应侧（`gen_ai.response.model` + `gen_ai.token.count.*` + `cost.total` + 错误标记）。
    - `message_end` → `gen_ai.agent.generation` 子 span（parent 挂在 agent span）。
    - `tool_execution_start/end` → `gen_ai.tool.call`（`gen_ai.tool.name` / `gen_ai.tool.call.id` / `gen_ai.tool.call.status` = ok|error）。
    - `retrieval` → `gen_ai.retrieval.*`（`query_preview`/`top_k`/`mode`/`result_count` 等）。
    - `workflow_node`/`pdf_export`/`mcp_tool_discovered` → `internal` span 透传关键 payload。
  - `runEventsToOtelSpans(events)`（`:236`）：遍历并**自动过滤 `null`**（中间事件 `message_start/update`、`tool_execution_update`、`turn_*`、`run_*` 不映射），保证 span 集合只含可观测边界。测试验证 12 事件 → 6 span。
  - `readTokenCounts`（`:251`）/ `readCostTotal`（`:266`）/ `toNumber`（`:281`）：token/cost **全部防御式读取**——字段可能缺失或类型不对，缺失填 0、成本无则省略，**绝不抛异常**（测试"agent_end 缺失 usage/cost 不抛错且填 0"）。
- `packages/trace/src/index.ts`（`:410-411`）：re-export `toOtelSpan` / `runEventsToOtelSpans` / `OtelSpan`，与既有脱敏共用同一包，避免跨包耦合。

**pi 对应物**：pi 把 trace 直接喂 Phoenix（`gen_ai.*` semconv + trace/metric/log 三位一体）。我们此处先把"RunEvent → OTel span"映射层做出来，落库/导出到 OTel Collector 或 Phoenix 是下一步（P3 成本归因可在 `cost.total` 上直接做）。

**学习检查点**
- 为什么 `agent_start`/`agent_end` 共享 `spanId`？OTel 里一次 agent run 是一个 span，start/end 是同一 span 的起止事件，而非两个 span；合并后后端才显示为一条 trace。这是对齐 semconv 的细节。
- 为什么中间事件返回 `null` 而非跳过？因为 `runEventsToOtelSpans` 用 `if (span) push` 统一过滤，比在 `toOtelSpan` 内 `continue` 更清晰，也便于未来给"未知事件类型"加测试兜底。
- 防御式读取为什么重要？trace 数据来自多包、多 provider，字段形状不可信；任何 `undefined.xxx` 都会让整条 trace 导出崩溃——这是 observability 边界必须"吞错"的原因。

---

## 3. token / 成本字段扩展（跨边界 DTO）

**读什么**
- `packages/trace/src/index.ts`
  - `TraceTokenUsage`（`:270`）：对齐 `@aiagent/ai` 的 `Usage` 子集（`input`/`output`/`cacheRead?`/`cacheWrite?`/`totalTokens`，可选 `cost` 明细）。**定义在 trace 包内**而非 import ai 包——避免反向依赖（AGENTS.md 单向依赖硬规则）。
  - `TraceCost`（`:286`）：仅保留 `total?` 总成本口径。
  - 事件 payload 扩展：`AgentEndEvent`（`:80-82` `usage?`/`cost?`）、`MessageEndEvent`（`:123-125`）、`ToolExecutionEndEvent`（`:152-154`）均在原索引签名 `[key: string]: unknown` 上**追加可选字段**，向后兼容——旧 run_events 无这些字段时读取方防御式填 0。

**学习检查点**
- 为什么 token/cost 用"可选字段 + DTO 在 trace 包内自建"？`usage`/`cost` 是**跨边界线格式**（`@aiagent/types` 才收线格式），但这里只是 trace 事件 payload 的**可选增强**，且为不反向依赖 ai 包，把子集 DTO 定义在消费侧 trace 包——既对齐 OTel 又守住包边界。
- 为什么给 `MessageEndEvent`/`ToolExecutionEndEvent` 也加 usage/cost？OTel 里每次 generation（消息）和 tool call 都是独立 span，要分别归因 token/成本（P3 成本归因的粒度基础）。

---

## 4. token 级 PII 治理（B1 教训：脱敏不能污染数据）

**读什么**
- `packages/trace/src/index.ts`
  - `isSensitiveKey(key)`（`:323`）：在原有 `api[-_]?key`/`authorization`/`password`/`secret`/`token`/`session`/`cookie` 之外，**追加模型 I/O 文本常见键**：`prompt`/`completion`/`messages`/`content`/`output`/`input`/`answer`。命中即整值脱敏（"token 级 PII"）。键名带边界（`^|[-_]` 与 `$|[-_]`）避免误伤 `inputValidation` 等复合键。
  - `sanitizeValue`（`:351-374`）：递归深拷贝脱敏。**关键修复（B1）**在 `:369-370`：
    ```ts
    sanitized[key] =
      isSensitiveKey(key) && typeof child === "string" ? "[redacted]" : sanitizeValue(child);
    ```
    **仅当值为 `string` 才整值脱敏**；数字 / 数组 / 对象一律递归保留。
  - `redactTokenTrace<TValue>`（`:404`）：对外语义入口，当前复用同一 `sanitizeValue` 核心（JSDoc 已如实说明两者等价），未来可在此独立增强（如对全部字符串强制跑 PII 模式）。

**B1 事故复盘（务必理解）**
- reviewer 初版把 `isSensitiveKey` 扩展到 `content`/`input`/`output`/`messages` 等键后，**全局 `redactSensitiveValue`（apps/api run-service 落 `run_events` 时对每个 payload 调用）会把**：
  - `message.content`（字符串）→ 被抹成 `"[redacted]"`（可接受，是 PII 文本）；
  - `usage.input`/`usage.output`（**数字**，token 计数）→ 被整值替换成字符串 `"[redacted]"`，**类型被污染**；
  - `agent_end.messages`（**数组**）→ 被整值替换成 `"[redacted]"`，**落库数据整块丢失**。
  这在静默中破坏了持久化的 `run_events`。
- **修复**：脱敏只针对"敏感键 + 字符串整值"；数字/数组/对象递归保留。回归测试 `packages/trace/test/redact.test.mjs` 三类断言：content→redacted；usage 数字 `typeof === "number"` 且值不变；messages 数组保留且元素递归保留。

**学习检查点**
- 为什么"敏感键扩展"是高风险改动？脱敏是**跨边界全局应用**的（run-service 落库、报告输出都调），任何键名匹配规则都会放大到所有事件。扩展键集合前必须想清"该键的值是不是字符串 PII"。
- 为什么用 `typeof child === "string"` 这一行就能救命？它把"敏感键"的语义从"整值抹除"降级为"仅文本整值抹除"，数字/结构数据天然豁免——一个 guard 表达式挡住一类数据损坏。
- 为什么 `redactTokenTrace` 与 `redactSensitiveValue` 当前等价但仍分两个 API？语义边界清晰（token 轨迹级脱敏是高频敏感场景的独立入口），且未来增强 `redactTokenTrace` 时不影响既有 `redactSensitiveValue` 行为——留好扩展点。

---

## 5. 零回归纪律与包边界（Task 2 的两条红线）

**红线一：确定性门禁零回归**
- 不传 judge 时，报告 `metrics`/`results[].metrics`/`aggregateAutomationMetrics` 与改造前**逐字节一致**（B2 教训：测试曾用 `deepEqual` 比较含 `averageLatencyMs` 的整对象而失败——因为 latency 是墙钟实时测量，两次跑必不同；修正为只比 7 项确定性指标 + `passed` + `llm*` 键存在性）。

**红线二：trace 不反向依赖 agent/ai**
- grep `packages/trace/src` 实际 import 仅 `otel-semconv.ts:15` 的 `import type { RunEvent } from "./index.js"`（纯类型，单向）；无运行时回指。
- eval 依赖 `@aiagent/agent`/`@aiagent/ai`/`@aiagent/rag`/`@aiagent/types` 均已在其 `package.json` 声明；`judge-loop.ts` 用的 `@aiagent/rag`（仅 `readBridgeConfig` 这一纯函数）已声明。
- 无新增生产依赖（zod 本已存在）。

**学习检查点**
- 为什么 `import type` 不受单向依赖限制？类型在编译期擦除、不产生运行时模块边，所以类型级循环无害；但**运行时符号必须单向**，否则会出现初始化顺序 / 循环引用运行时错误。
- 为什么新增公共 API（`createLoopLlmJudge`/`LoopLlmJudge`/`JudgeScore`）必须进 barrel `index.ts` 并同步文档？AGENTS.md 要求"公共 API 变更同步调用方与文档"，且 reviewer 曾因 `createMcpGenericTool` 漏导出而打回。

---

## 7. 最小可演示路径（动手顺序建议）

1. `pnpm --filter @aiagent/eval test` 看 31 个用例（含 `judge-loop.test.mjs` 5 例 + `loop-runner-judge.test.mjs` 零回归 2 例）。
2. `pnpm --filter @aiagent/trace test` 看 15 个用例（含 `otel-semconv.test.mjs` 14 例 + `redact.test.mjs` B1 回归 1 例）。
3. 想看 judge 默认行为：在测试或脚本里 `createLoopLlmJudge()`（无 key）→ 走确定性 mock，`judgeAnswerCorrectness` 分数每次相同（可复现）。
4. 想看 OTel 映射：构造几条 `RunEvent`（agent_start/end、message_end、tool_execution_end、retrieval），调 `runEventsToOtelSpans` 看生成的 `gen_ai.*` span 与 `cost.total`/`gen_ai.token.count.*` 属性。
5. 想看 B1 防护：`redact.test.mjs` 直接读——断言 `usage.input` 仍是 `number` 且值不变，`messages` 数组保留。

---

## 8. P2 轨迹评测 + 失败 taxonomy（Task 2 扩展，已落地）

**读什么**
- `packages/eval/src/trajectory.ts`
  - `ToolCallStep`（`:16`）：单步工具调用视图（`seq`/`toolName`/`args`/`isError`/`resultSummary`）。
  - `extractToolTrajectory(events)`（`:37`）：从 `LoopEvalRunEvent[]`（run_events 投影）按 `seq` 排序，把 `tool_execution_start` 与同 `toolCallId` 的 `tool_execution_end` 配对，得到**有序工具调用序列**；缺 end 时用 start 信息、`isError` 默认 `false`（防御式）。
  - `matchTrajectory(expected, actual, mode)`（`:151`）：轨迹匹配评分。
    - `strict`：期望工具名序列须与 actual **顺序且数量一致**（actual 多余 → `extra`，expected 多 → `missing`）；
    - `subset`：期望须是 actual 的**保序子序列**；
    - 对匹配上的同名调用，检查 `requiredArgs` 是否出现在 `args`（缺失进 `paramMismatches`）。`matched = missing 空 && (subset? true : extra 空) && paramMismatches 空`。
  - `deriveExpectedTrajectory(item)`（`:207`）：从 fixture 推导期望工具序列（有 workflow 期望 → 期望 `generate_report`；否则有检索证据 → 期望 `search_filings`）——与 `loop-runner.ts` 的 mock 脚本口径一致。
  - `FailureCategory`（`:191`）：`retrieval_missing` / `hallucination` / `tool_misuse` / `workflow_incomplete` / `loop` / `none`。
  - `classifyFailure(input)`（`:273`）：对单条 case 给**单一主分类**，按优先级链（越具体的结构性失败越先判）：
    1. `workflow_incomplete`：期望工作流节点未跑完；
    2. `retrieval_missing`：期望引用但 citation 未被检索接地（`isCitationsGrounded` `:224` 判 quote 是否出现在某 chunk 文本）；
    3. `hallucination`：期望事实却无检索/引用支撑（编造）；
    4. `tool_misuse`：工具执行报错或 strict 轨迹不匹配（调用了非预期工具）；
    5. `loop`：连续 ≥3 次同名工具调用（`hasConsecutiveLoop` `:238`）；
    6. 兜底：`ok=false` 未命中以上 → `tool_misuse`；默认 `none`。
- `packages/eval/src/loop-runner.ts`：`LoopEvalCaseRun` 追加 `trajectory: ToolCallStep[]`（`runEvalCaseWithLoop` 内 `extractToolTrajectory(events)`）；`runLoopEval` 对每条结果附加 `failureCategory` 与 `trajectory`（subset 用于展示、strict 用于分类器内部检测非预期工具）。
- `packages/eval/src/automation.ts`：`AutomationCaseResult` 追加**可选**字段 `failureCategory?` / `trajectory?`——**不进 7 项门禁与聚合**（零回归）。

**pi 对应物**：pi 与多数 trace 系统都把"工具调用序列 / 图结构"作为轨迹评测对象（trajectory match：strict/subset + 参数校验）。本处把它从"结果级打分"上移到"过程级诊断"，与 `run_events` 投影天然对齐。

**零回归纪律（P2 红线）**
- `failureCategory` / `trajectory` 是可选字段，**不参与** `checkAutomationRegression`（7 项阈值）与 `aggregateAutomationMetrics`（7 键聚合）。`scoreCaseWithEvidence` 行为完全不变。
- 数据集 `datasets/eval-financial-v1.json` **不改动**（schema 不变）；分类器只读 fixture/evidence，不写。
- 验证：`pnpm --filter @aiagent/eval test` 39/39（新增 8，含 `runLoopEval passes regression gate` 7 指标门禁仍通过）。

**学习检查点**
- 为什么轨迹评测要分 strict/subset？真实 agent 常会多调工具（兜底/探查），严格相等会误报；subset 保序子序列更贴近"是否完成了关键步骤"，strict 则用于捕捉"是否调了不该调的工具"（tool_misuse）。
- 为什么 `retrieval_missing` 用"citation 是否被 chunk 文本接地"而非"有无检索"？`fail-002` 的 `retrievedChunks` 非空（有检索动作）但 citation 文本并不在任何 chunk 中——这是"检索到了却没用上/编造引用"，比单纯"无检索"更隐蔽；接地校验能抓住这类未接地引用。
- 为什么分类器不参与门禁？失败 taxonomy 是**诊断信号**（人读报告、未来人工校准集），不是硬门禁——直接当门禁会让分类边界的误判放大成 CI 抖动（同 LLM-as-Judge 的站位一致）。

**P2 演示**：`trajectory.test.mjs` 直接用数据集 `fail-001/002/003` 与某 rag 用例验证 `classifyFailure` 四个分类断言 + `matchTrajectory` strict/subset/paramMismatch 行为。

---

## 9. 最小可演示路径（P2 追加）

1. `pnpm --filter @aiagent/eval test` 现 **39 个用例**（原 31 + `trajectory.test.mjs` 8 例）。
2. 想看失败分类：在 `trajectory.test.mjs` 里读 `fail-001→hallucination`、`fail-002→retrieval_missing`、`fail-003→workflow_incomplete`、rag→`none` 四个断言。
3. 想看轨迹匹配：`matchTrajectory` 的 strict（extra 工具→matched=false）/ subset（extra→matched=true）/ requiredArgs 缺失→paramMismatches 三个用例。

---

## 10. P3 成本归因 + SLO/错误预算（Task 2 扩展，已落地）

**读什么**
- `packages/eval/src/cost-attribution.ts`
  - `CostDimension`（`:14`）：`model` / `tool` / `provider`。
  - `CostAttributionRecord`（`:17`）：单维度聚合（`key`/`inputTokens`/`outputTokens`/`totalTokens`/`cost`/`callCount`）。
  - `extractCostInputs(events)`（`:69`）：从 `LoopEvalRunEvent[]` 防御式抽取用量——`message_end` 读 `message.usage`+`model`+`provider`（source=message），`tool_execution_end` 读可选 `result.usage`/`result.details.usage`（source=tool）；缺失 `usage` 跳过、非有限数字归 0。
  - `computeCostAttribution(events, dimension)`（`:125`）：按维度聚合，`totalTokens` 降序；`summarizeCost(events)`（`:171`）便捷返回 byModel/byTool 两份聚合 + 总计。
- `packages/eval/src/automation.ts`
  - `RegressionThresholds` 新增 `p95LatencyMs`（`:72`）；`DEFAULT_REGRESSION_THRESHOLDS` 给 `p95LatencyMs: 10000`（起始 SLO，保守默认，不影响现有门禁）。
  - `SloSummary`（`:81` 附近）+ `computeSloSummary(metrics, thresholds)`（`:240`）：P95 预算（`value>budget→breached`）+ 错误预算（`budget=1-successRate`、`consumed=1-successRate`、`remaining=max(0,budget-consumed)`、`breached=consumed>budget`）。
  - `AutomationReport` 新增可选 `slo?`（`:75`）；`checkAutomationRegression` 追加 P95 绝对阈值规则（与既有 `maxP95LatencyIncreaseMs` baseline 比较共存）；`renderMarkdownReport` 在回归门禁前加 `## SLO / 错误预算` 段（`:130`）。
- `packages/types/src/run-v2.ts`：`RunEventTypeDto` 加 `"cost_summary"`（线格式/DTO 归属正确）。
- `packages/trace/src/index.ts`：`RunEventType` 加 `"cost_summary"` + 新增 `CostSummaryEvent`（payload 含 `byModel`/`byTool`/`totalTokens`/`totalCost`）并加入 `RunEvent` 联合（otel 映射 `default` 分支返回 `null`，不映射成 span）。
- `apps/api/src/application/run-service.ts`：`execute` 事件循环前声明 `costByModel`/`costByTool`/`totalTokens`/`totalCost` 累加器；循环内紧跟 `publish` 后累加 `message_end`（仅 assistant 带 usage）与 `tool_execution_end`（用量可选、防御式）；`agent_end` 分支内 `publish("cost_summary", …)` 落在线汇总（try/catch 最佳努力，不把成功 run 变 failed）。
- `packages/database/src/schema.ts`（`run_events_event_type_check`）+ 迁移 `0230_cost_summary_event_type.sql`：扩展白名单（幂等 `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` + 中文 `COMMENT ON COLUMN`），使 `cost_summary` 可持久化。

**pi 对应物**：pi 与 OpenTelemetry 的 cost/usage 都按 `gen_ai.token.count.*` + `cost.total` 做跨维度归因；本处把"离线 eval 聚合（eval 包纯函数）"与"在线 run 落库（run-service 能力事件）"分离，cost 信号既能在评测报告里看、也能在真实 run 的 `run_events` 里回放。

**零回归纪律（P3 红线）**
- SLO/错误预算是**增量可选**：`slo?` 字段、`p95LatencyMs` 阈值（默认 10000 远高于 mock 运行）都不改变既有 7 项门禁与 `AggregatedMetricKeys`；`runLoopEval passes regression gate`（regressionReasons===[]）仍成立。
- run-service 改动只在既有事件循环**追加**累加与一条 publish，不触碰错误处理、快照形状、`agent_end` 终态推导；累加全程防御式，缺失/非有限归 0，绝不 throw 到主流程。
- 验证：`pnpm --filter @aiagent/eval test` 48/48（原 39 + 新增 9）；types/trace/api/agent typecheck 全绿。

**学习检查点**
- 为什么成本归因分"离线纯函数（eval）"与"在线能力事件（run-service）"？eval 包不该被 api 反向依赖（包边界）；成本聚合逻辑放在 eval 作为**可测纯函数**，run-service 只负责在真实 run 里把原始用量落成 `cost_summary` 事件，消费侧（报告/Phoenix）再按需聚合——职责单一、可独立演进。
- 为什么 `cost_summary` 事件只落 model/tool 维度、provider 仅作 eval 纯函数维度？在线事件应最小且跨 provider 稳定；provider 维度在离线评测里按需聚合即可，不必污染线格式。这体现了"线格式只收必要字段"的 DTO 纪律。
- 为什么错误预算用 `1-successRate` 而非新增一个独立阈值？成功率阈值本就是"允许的最低成功率"，其补集天然是"允许的最大失败率=错误预算"，复用同一阈值避免双口径漂移（SLO/错误预算的经典定义）。

**P3 演示**：`cost-attribution.test.mjs` 验证 model/tool 聚合、缺失用量防御、`computeSloSummary` 的 p95/errorBudget breached 与达标、以及 `checkAutomationRegression` 新 P95 规则；run-service 改动由 `pnpm --filter @aiagent/api typecheck` 守护。

---

## 11. 最小可演示路径（P3 追加）

1. `pnpm --filter @aiagent/eval test` 现 **48 个用例**（原 39 + `cost-attribution.test.mjs` 9 例）。
2. 想看 SLO 报告：`renderMarkdownReport` 在回归门禁前输出 `## SLO / 错误预算`；把 `DEFAULT_REGRESSION_THRESHOLDS.p95LatencyMs` 临时调到极小（如 0）可看到 `p95 latency ... 超过 SLO` 触发门禁（仅为演示，勿提交）。
3. 想看在线成本汇总：起 api 跑一次真实 run，`run_events` 末尾会出现 `cost_summary` 事件（byModel/byTool 聚合），需先应用迁移 `0230`。

---

## 12. P4 online eval + 真实 benchmark 适配器 + 人工校准（Task 2 扩展，已落地）

> P4 是学习级进阶，**全部落在 `packages/eval`**——离线即可，未改 `apps/api` 与数据库。它把"评测闭环"从离线 fixture 扩展到三个方向：线上影子评测、外部 benchmark 接管、人工标注回流校准。

**读什么**
- `packages/eval/src/online-eval.ts`
  - `ShadowEvaluator`（`:47`）+ `createShadowEvaluator(options?)`（`:67`）：默认用 `createLoopLlmJudge()`（确定性 mock，可复现、无网络）；`evaluate(input)` 只读取线上采样的 `{ caseId, query, answer, expectedText?, contexts? }` 跑 judge，**绝不写回生产、绝不改 run 状态**（JSDoc 与注释明确"影子"语义）。
  - `sampleAndEvaluate(evaluator, samples)`（`:100`）：`Promise.all` 并发跑整批样本，返回与输入等长、顺序一致的结果。
- `packages/eval/src/benchmark-adapters.ts`
  - `BenchmarkCase`（`:20`）/ `BenchmarkAdapter`（`:36`）：外部基准的轻量契约——`loadCases()` 是唯一"接缝"。
  - `benchmarkCaseToUnified(c, datasetVersion)`（`:61`）：把 `BenchmarkCase` 合成合法 `UnifiedEvalCase`（fixture 用 `expectedAnswer` 作 answer、`ok:true`、字段齐全）。
  - `benchmarkDatasetToEvalDataset(adapter, seed)`：直接包成 `EvalDataset`（**无需 30~50 条**，因 `runLoopEval` 不校验数量，只有 `loadEvalDataset` 校验）。
  - `createMockGaiaAdapter()`（`:125`）/ `createMockTauBenchAdapter()`（`:184`）：确定性 mock（不发起 HTTP）；文件头注释说明**真实 GAIA/TAU-bench 集成只需改写 `loadCases()`**，下游 `→ runLoopEval` 管线不变。
- `packages/eval/src/calibration.ts`
  - `HumanCalibrationStore`（`:15`）+ `createInMemoryCalibrationStore()`（`:49`）：同一 case 可录多条 label、取平均。
  - `calibrateJudgeScores(judgeScores, store)`（`:103`）：**全局偏差** `bias = mean(人工标注均值) − mean(judge 原始分)`（仅在带标注的 case 集合上算；无标注→`bias=0`）；逐条 `calibratedScore = clamp01(rawScore + bias)`（`:124`，`clamp01` `:136` 钳制 [0,1]）。

**pi 对应物**：pi 与 RAGAS/DeepEval 都强调"离线评测 + 在线影子 + 人工校准"的闭环；本处把这三块收敛成 eval 包内三个纯模块，复用已有的 `LoopLlmJudge` 与 `runLoopEval`，不重复造轮子。

**零回归纪律（P4 红线）**
- P4 全是**新增文件 + 新导出**；除 `index.ts` 追加导出外，`automation.ts`/`loop-runner.ts`/`judge-loop.ts` 现有行为零改动。
- 默认 judge 走确定性 mock，**不引入任何网络依赖**（package.json 无 axios/fetch 类库）；benchmark mock 适配器纯返回常量。
- 验证：`pnpm --filter @aiagent/eval test` 57/57（原 48 + 新增 9，含 `runLoopEval passes regression gate` 7 指标门禁零回归）；build/typecheck 全绿。

**学习检查点**
- 为什么影子评测必须"只读、不回写"？线上采样的 answer/contexts 是生产产物，离线评测只是"旁路打分"用于监控 judge 漂移；一旦回写就污染生产 run、破坏数据血缘。这也是"评测/生产分离"的工程纪律。
- 为什么 benchmark 适配器只留 `loadCases()` 一个接缝？真实 GAIA/TAU-bench 是外部数据集/API，变化点只在"数据从哪来"；把摄取隔离在 `loadCases()`，下游 `→ UnifiedEvalCase → runLoopEval` 完全不动——这是"适配器模式"的最小扩展点。
- 为什么校准用"全局偏差 + 钳制"而非逐 case 拟合？人工标注稀疏且噪声大，逐 case 拟合会过拟合；用全量标注估计一个系统性偏差（judge 整体偏高/偏低）再平移，是 RAGAS/LLM-as-Judge 校准的经典做法，配合 `clamp01` 保证分数仍合法。

**P4 演示**：`online-eval.test.mjs`（可复现断言）、`benchmark-adapters.test.mjs`（GAIA/TAU 前缀 + 转换合法性）、`calibration.test.mjs`（偏差平移 + [0,1] 钳制边界）。

---

## 13. 最小可演示路径（P4 追加）

1. `pnpm --filter @aiagent/eval test` 现 **57 个用例**（原 48 + `online-eval`/`benchmark-adapters`/`calibration` 各 3 例）。
2. 想看影子评测：`createShadowEvaluator()` 对采样 `{answer, query}` 调用 `evaluate`，两次调用分数相同（可复现）。
3. 想看 benchmark 接管：`benchmarkDatasetToEvalDataset(createMockGaiaAdapter(), 1)` 产出 `EvalDataset` 后直接喂 `runLoopEval(dataset, { judge })` 跑完整管线。
4. 想看人工校准：`recordLabel` 录几条后 `calibrateJudgeScores` 会按全局偏差平移 judge 分并钳制到 [0,1]。
