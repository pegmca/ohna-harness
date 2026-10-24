# v2.0 Team/Supervisor 多智能体编排评测方案

> 状态：v2.0 规划 · 承接 `02-eval-system-v2.md` §8 的 team gap。
>
> 本文是 team/Supervisor 编排评测的**收敛定稿**：在 `02` 薄内核（`packages/eval-core`）+ 领域自治框架下，回答「多智能体编排怎么测、门禁怎么分层、mock 边界在哪」。
>
> **硬约束（已定论，不再讨论）**：
> 1. 已删除 mock 模型——生产和评测路径都**不允许注入 mock `streamFn` 回放固定模型输出**。
> 2. 允许 mock **工具副作用**（write/edit/bash/search 的 execute 返回固定值），不允许 mock **模型输出**。
> 3. 门禁分层：编排机契约正确性进 CI 硬门禁；编排决策正确性（spawn 谁/派给谁）用真模型 + judge 进趋势门禁，不 block。

---

## 1. 被测单元：两个被测面

team 评测**不测**子代理内部的单 agent 行为（那是 `fileChangeCorrectness` 的职责），只测 team 特有的增量：建成员 → 权限最小化工具子集 → 派发 → 隔离上下文 → 摘要回收 → 成本护栏 → 并发约束 → 权限继承。

| 被测面 | 单元 | 直接证据源 | 对应 tier |
|---|---|---|---|
| **A. 编排语义层（确定性、零模型）** | `createTeamController` 暴露的 `createMember` / `runMember`（早退路径）/ `getTeamState` / `getBudgetAccumulator` + TeamCreate/SendMessage 两工具 | 内存态 `TeamState` / `SubagentResult` / `TeamBudgetAccumulator` | T-L1 / T-L2a |
| **B. 端到端编排层（真模型驱动）** | supervisor 的完整 `agentLoop`（装配 TeamCreate/SendMessage），断言「spawn 正确成员、派发正确 recipient、汇总引用子代理摘要」 | supervisor run_events + tool 轨迹（app eval 域投影） | T-L2b / T-L4 |

**明确排除项**：不测子代理内部单 agent 行为、不测「模型是否选对 recipient」的决策正确性（那归 T-L4 judge）。

---

## 2. 三层门禁总览

```
L1 纯函数投影        → CI 硬门禁（block）
L2a 编排机契约（纯状态迁移） → CI 硬门禁（block）
L2b 编排机契约（mock 工具控制流，真 provider 驱动） → CI 硬门禁（block，断言只指控制流）
L4 编排决策正确性（真模型 + judge） → 趋势门禁（不 block）
```

核心红线：**mock 的是「工具副作用出口」，不是「模型输出」**。

---

## 3. L2「mock 工具副作用」的精确边界

### 3.1 必须 mock 的工具（有副作用）

| 工具 | 文件 | 副作用出口 | 注入点 |
|---|---|---|---|
| `write` / `edit` / `bash` | `packages/coding` | 落盘 / 改文件 / 子进程 | `options.operations` 已是现成注入点 |
| `filing_search` | `packages/tools` | 调 `dataSource.searchFilings` | `createFilingSearchTool(dataSource)` 端口注入 |
| `generate_report` | `packages/report` | 六节点 workflow + 真实发 PDF | workflow / sink 注入 |

mock 方式：替换这些工具的 `execute`（或注入端口），返回固定值。

### 3.2 天然无副作用、测编排机契约时**不用 mock** 的工具

已逐行核实 `packages/agent/src/team/controller.ts` 与 `tools.ts`：

- `TeamCreate.execute`（`tools.ts`）→ 只调 `deps.createMember`（`controller.ts:185-201`），后者只做 `state.members.set()` / `state.inboundQueues.set()` / `state.events.push()` —— 纯内存态，无 IO。
- `SendMessage.execute`（`tools.ts`）→ 只调 `deps.runMember`（`controller.ts:213-381`），写 `member.status` / `member.summary` / `state.events` / `state.peakConcurrency` —— 纯内存态。副作用只发生在它内部发起的 `agentLoop` 里。

两者都显式声明 `effect: "read"`。**结论：TeamCreate/SendMessage 的 execute 是纯状态操作，L2 不需要 mock 它们。**

### 3.3 L2 精确边界（一句话）

> **L2 mock 的，是子代理 `agentLoop` 里被授权给成员的那批 `availableTools`（write/edit/bash/filing_search/generate_report）的副作用出口；不是 TeamController 自己暴露的 TeamCreate/SendMessage。**

---

## 4. 红线清单

### 4.1 允许 mock（工具副作用出口）

- ✅ `write` / `edit` / `bash` 的 `execute`（或注入 `operations`）→ 返回固定输出。
- ✅ `filing_search` 的 `dataSource.searchFilings` → 返回固定结果。
- ✅ `generate_report` 的 workflow / sink → 固定结果，不真实发布 PDF。

**判据：mock 的是「动作发生后对外部世界的效果」，不是「模型决定做什么」。**

### 4.2 禁止 mock（模型输出 / streamFn）

- ❌ 注入假 `streamFn` 回放固定 assistant 消息（`createMockStreamFn`）。
- ❌ stub `agentLoop` 让它返回预置 messages。
- ❌ mock `Model` 让它吐出预置 tool_call 决策。

**判据：只要 mock 了「模型下一步选什么工具/说什么话」，就是踩红线。**

### 4.3 测「tool 选择」的分界

- **测控制流**（选了 write 之后，write 被正确调用、结果回收、护栏触发）→ 允许「真 provider 驱动 + mock 工具」，不踩红线，归 L2b。断言只能指向「流程」，不能指向「模型应该选 write」。
- **测决策**（该不该 spawn 这个成员 / 派给谁 / 该不该现在调 write）→ 只能真模型 + judge（L4）。用固定模型输出测这个 = 踩红线。

> 一句话：**「真 provider 驱动 + mock 工具」合法测 L2b（控制流），非法测 L4（决策）。是否踩线取决于断言指向「流程」还是「选择」。**

---

## 5. tier 档位（team 特有细化）

> 这是 `02-eval-system-v2.md` §3.1 通用档位在 team 场景下的细化。通用命名见 `02` §3.1，此处用 `T-` 前缀标注 team 特有。

| tier | 名称 | 覆盖 | 成本 | 确定性 | 门禁 | CI 位置 |
|---|---|---|---|---|---|---|
| **T-L1** | 纯函数投影 | `createBudgetGuard` / `projectTeamCostSummary` / `projectContextBudgetSummary` / `resolveTools` / `resolveModel` / `extractSummary` / `getTeamView` / `classifyAborted` / `assembleSubagentConfig` | 极低（纯 CPU） | 100% | **硬门禁（block）** | PR 必跑，最前置 |
| **T-L2a** | 编排机契约（纯状态迁移） | `createMember` / `TeamCreate.execute` / `SendMessage.execute` 的 TeamState 断言 | 极低 | 100% | **硬门禁（block）** | 紧随 L1 |
| **T-L2b** | 编排机契约（mock 工具控制流） | `runMember` + mock 的 write/search 返回固定值，真 provider 驱动 → 控制流 / 护栏 / 并发 / 摘要回收 | 低（真 provider 最小化 + 假工具） | 高（真 provider 非确定，但断言只指控制流故不 flaky） | **硬门禁（block）** | L2 内最后一段 |
| **T-L4** | 编排决策正确性（真模型 + judge） | 真模型驱动 TeamCreate/SendMessage，judge 判 spawn / 派发是否合理 | 高（真模型 token + judge 二次调用） | 低 | **趋势门禁（不 block）** | 夜间 trend job / PR 非阻塞 report |

### 5.1 CI 落位

> `T-L1 → T-L2a → T-L2b` 是 PR 上同一硬门禁 job 的三段断言（L1 失败即 fast-fail 短路）；`T-L4` 是独立 trend job，产出「决策正确率 vs 基线」趋势，红绿不阻断合并、只告警。

---

## 6. createMockStreamFn 严格迁移

> 现状：`packages/agent/test/team-controller.test.mjs` 里的 `createMockStreamFn` 注入固定 assistant 消息流，属于「mock 模型输出」踩红线。本文给出严格迁移：**删除该 mock，改为「真 provider 驱动 + mock 工具副作用」，断言面收敛到控制流**。

### 6.1 三个必须新增/导出的纯函数（迁移的真正落点）

严格迁移不是「改测试」，而是把目前被「mock 模型输出」掩盖的编排机逻辑，抽成可脱离 `agentLoop` 直接测的纯函数，下沉到 L1。三个函数的精确契约如下（类型引用对齐 `packages/agent/src/team/controller.ts` 与 `packages/agent/src/types.ts`）。

---

#### 6.1.1 `extractSummary`（导出，零改造）

**来源**：`controller.ts:91-110` 已是模块私有纯函数，直接 `export`，实现不变。

```ts
import type { AgentMessage } from "../types.js";

/**
 * 从子代理最终消息集提取「摘要 + 产物引用」（上下文隔离的第一性）。
 * 摘要取最后一条 assistant 文本；产物收集所有 toolResult 的工具名 + 短摘要。
 * 纯函数，零 IO，可脱离 agentLoop 直接测。
 *
 * @param messages 子代理 agentLoop 最终回写的消息集（含 prompt 与工具结果）。
 * @returns 摘要文本与产物引用列表；无 assistant 文本时 summary 为「(子代理无文本输出)」。
 */
export function extractSummary(
  messages: AgentMessage[],
): { summary: string; artifacts: string[] };
```

**断言清单（L1 硬门禁）**：
- 无任何 assistant 消息 → `summary === "(子代理无文本输出)"`、`artifacts === []`。
- 末条 assistant 文本非空 → `summary` 等于该末条 assistant 的 `text` 内容块拼接。
- 多条 assistant → 只取**最后一条**非空文本（逆向扫描），不是第一条。
- 有 `toolResult` 消息 → `artifacts` 每个元素形如 `${toolName}:${文本截断到 120 字符}`，且顺序与消息顺序一致。
- `toolResult` 无文本内容 → artifact 文本部分为 `"(空)"`。

---

#### 6.1.2 `classifyAborted`（新增导出）

**来源**：抽自 `controller.ts:329-331` 的失败判定逻辑。原逻辑依赖 `lastAssistant.stopReason`，抽成纯函数后不再需要 mock `stopReason:"error"` 来注入失败。

```ts
import type { AgentLoopError, AgentMessage } from "../types.js";

/**
 * 把「子代理是否异常终止」的判定抽成纯函数（失败隔离的确定性证据源）。
 * 判定：agent_end.error（兜底收尾）或最终 assistant 的 stopReason 为 error/aborted。
 *
 * @param endError agent_end 携带的兜底错误（agentLoopError）；正常结束为 undefined。
 * @param lastAssistant messages 中最后一条 assistant 消息（可能为 undefined）。
 * @returns aborted=true 时携带结构化 error（endError 优先，否则由 stopReason 派生）。
 */
export function classifyAborted(input: {
  endError: AgentLoopError | undefined;
  lastAssistant: AgentMessage | undefined;
}): { aborted: boolean; error?: { code: string; message: string } };
```

**断言清单（L1 硬门禁）**：
- `endError` 有值 → `aborted === true`，且 `error` 严格等于 `endError`（`{code, message}` 原样透传，不重包装）。
- `endError === undefined` 且 `lastAssistant.stopReason === "error"` → `aborted === true`，`error.code === "subagent_failed"`、`message` 含 `stopReason: error`。
- 同上但 `stopReason === "aborted"` → `aborted === true`、`message` 含 `stopReason: aborted`。
- `endError === undefined` 且 `lastAssistant === undefined` → `aborted === true`，`error.code === "subagent_failed"`、`message === "unknown"`（对齐 `controller.ts:337` 兜底）。
- `endError === undefined` 且 `lastAssistant.stopReason === "stop"`（或其他非 error/aborted）→ `aborted === false`，`error === undefined`。

---

#### 6.1.3 `assembleSubagentConfig`（新增导出）

**来源**：抽自 `controller.ts:291-311` 的 `subConfig` 装配。这是 K3「继承通道」的确定性证据源——脱离 `agentLoop` 就能断言 `beforeToolCall` / `shouldStopAfterTurn` 是否按预期注入。

```ts
import type { AgentLoopConfig } from "../types.js";
import type { MemberBudgetHook } from "./budget.js";
import type { TeamMember } from "./types.js";

/**
 * 装配子代理的 AgentLoopConfig（编排机契约 + 权限继承通道）。
 * 纯函数：只根据输入决定 config 里有哪些键、值是什么引用，不做任何运行期副作用。
 *
 * 关键边界：本函数只负责「静态装配」——
 * - beforeToolCall 有值 → 原样透传（同一引用），保证子代理与 supervisor 共用同一闸门；
 * - budgetHook 有值 → 注入 shouldStopAfterTurn 直通 hook.shouldStopAfterTurn；
 * - 两者皆无 → config 不含对应键（保持「无权限装配/无预算」场景零多余钩子）。
 *
 * 「budgetHook 触发时标记 budgetExceeded」这个运行期副作用**不属于本函数**：
 * 由 runMember 在拿到返回的 config 后，自行薄包装 shouldStopAfterTurn 捕获 stoppedByBudget。
 *
 * @param member 目标成员（提供 model 与工具子集，供权限闸门解析 effect）。
 * @param budgetHook 成本护栏句柄（未配置预算时为 undefined）。
 * @param beforeToolCall supervisor 的权限闸门（K3 策略继承来源，可为 undefined）。
 * @param convertToLlm 子代理消息→LLM 消息转换器。
 * @returns 装配好的 AgentLoopConfig（model 取 member.model）。
 */
export function assembleSubagentConfig(input: {
  member: TeamMember;
  budgetHook: MemberBudgetHook | undefined;
  beforeToolCall: AgentLoopConfig["beforeToolCall"] | undefined;
  convertToLlm: AgentLoopConfig["convertToLlm"];
}): AgentLoopConfig;
```

**断言清单（L1 硬门禁）**：
- `config.model` 严格等于 `input.member.model`（同一引用）。
- `config.convertToLlm` 严格等于 `input.convertToLlm`（同一引用）。
- `beforeToolCall` 有值 → `config.beforeToolCall === input.beforeToolCall`（同一引用，**继承通道**）；`beforeToolCall === undefined` → `"beforeToolCall" in config === false`（零多余钩子）。
- `budgetHook` 有值 → `config.shouldStopAfterTurn` 存在且函数类型正确；`budgetHook === undefined` → `"shouldStopAfterTurn" in config === false`。
- **不含** `deadlineMs`（对齐 `controller.ts:299` A-2 修复：agent-loop 从不消费 deadlineMs，真正生效的是护栏闭包墙钟自查）。

---

> 这三个纯函数一旦导出，L2b 里「失败隔离」「权限继承通道」「摘要回收」的**逻辑正确性**就被 L1 硬门禁覆盖，L2b 只剩「真 provider 下这些逻辑确实被串起来」的集成验证。`assembleSubagentConfig` 抽离后，`runMember` 保留一个薄包装层用于捕获 `stoppedByBudget`（回写 `member.budgetExceeded`），该包装不属于纯函数契约。

### 6.2 现有 8 个测试的迁移映射

| 现有测试 | 现状 | 迁移后归属 | 关键变化 |
|---|---|---|---|
| TeamCreate 注册 | 无 streamFn | **T-L2a**（不变） | 无 |
| SendMessage 摘要回收 | mock 固定「看涨」文本 | **T-L2b 真 provider** | 摘要不再固定内容，改为「断言 summary 非空 + 是 assistant 文本」 |
| 失败隔离 | mock 固定 `stopReason:"error"` | **拆分**：失败判定 → L1（`classifyAborted`）；端到端真实失败 → L4（真模型自然出错，统计观测） | 无法确定性注入 `stopReason:"error"` |
| member_not_found | mock 任意文本 | **T-L2a 纯状态**（不改） | `runMember` 早退发生在 `agentLoop` 之前，本就不依赖模型输出 |
| 成本护栏 | mock `costedMessage` 带 usage | **L1**（`createBudgetGuard` 已独立）+ **T-L2b 真 provider**（测护栏 hook 真被触发，不断言精确 usage） | 无法断言 `usage.cost === 0.07` 精确值 |
| 并发信号量 | `delayStreamFn` 只测在飞计数 | **T-L2b 真 provider**（保留在飞计数观测，但 `streamFn` 改真 provider） | 在飞计数是合法控制流观测，不是 mock 模型输出 |
| 团队聚合 ceiling | mock `costedMessage` | **L1**（`createBudgetGuard` + 累加器原子性用合成事件测）+ **T-L2b 真 provider**（测护栏真触发，不精确断言） | 同上 |
| 并发原子性 | mock `costedMessage` | **L1**（AsyncMutex 临界区逻辑用合成输入测） | 原子性是纯函数性质，可脱离 `agentLoop` 测 |
| K3 权限继承 | mock 两条 scripted 消息（先 toolCall write） | **拆分**：继承通道 → L1（`assembleSubagentConfig`）；工具子集 → L1（`resolveTools`）；真实触发 → L4（真模型 + 定向「写文件」任务 + judge 观测是否被拦） | **最该拆的一个** |

### 6.3 L2b 的「真 provider 最小回放」形态

真 provider 驱动 `agentLoop` 时保持「最小」且「断言只指控制流」：

1. **最小化模型**：注入最小真 provider（低温、`maxTokens` 小、单轮收敛），只负责「把一个简单委派任务跑完」，不追求输出特定内容。
2. **mock 工具副作用**：子代理 `availableTools` 里放 mock 了 `execute` 的工具（如 `write` 返回固定结果），真模型即便决定调 write，写盘副作用也是被 mock 的、零成本零污染。
3. **断言面收敛**：只断言——
   - `result.status === "done"`（控制流走通）
   - `result.summary` 非空（摘要回收走通）
   - 工具被调用了几次（断言「调了」这个事实，不断言「该不该调」）
   - 护栏/并发/权限**通道**是否被触发（观测信号，不断言精确值）
4. **失败隔离/预算护栏的确定性面**：下沉到 L1 纯函数（`classifyAborted` + `createBudgetGuard` + `assembleSubagentConfig`），L2b 只覆盖「真模型下这条链路能跑通、不崩」。

> L2b 进硬门禁但不会 flaky 的原因：它断言的「控制流走通 / 状态机合法 / 不崩」对任意合理模型输出都成立，真 provider 的非确定性不会导致断言失败。

### 6.4 迁移净效果

| 现状 | 迁移后 |
|---|---|
| `createMockStreamFn` 一个 mock 同时扮演「模型」和「控制流夹具」 | 「模型」归真 provider（L2b/L4），「控制流夹具」下沉为 L1 纯函数 |
| 失败隔离/护栏/继承靠「写死模型输出」测 | 靠「纯函数判定逻辑」测（L1 硬门禁） |
| 一个测试混着「控制流」和「决策」断言 | 控制流断言归 L1/L2b，决策断言归 L4 |
| K3 权限继承靠「回放 toolCall 脚本」 | 继承通道抽 `assembleSubagentConfig`（L1）+ 真实触发归 L4 |

---

## 7. 指标清单

| 指标 | 定义 | 证据源 | tier | 进 eval-core? |
|---|---|---|---|---|
| `dispatchCorrectness` | supervisor 是否 spawn 期望成员集、派发正确 recipient（对齐 `expectedSpawns`/`expectedSends`） | supervisor `tool_execution_*` 投影成 `TeamDispatchStep[]` | T-L4 | 否 |
| `subagentCompletionRate` | `status==="done"` 的 SubagentResult 数 / 派发总数 | `SubagentResult.status` | T-L2b | 否 |
| `costAmplificationRatio` | `team.totalCost / 单 agent 等价成本` | `cost_summary.team` vs `totalCost` | T-L4 | 否 |
| `tokenAttributionToMember` | 每成员 tokens/cost 是否等于该成员各轮 usage 之和 | `members[].usage` vs llm 记录 | T-L4（有缺口） | 否 |
| `permissionInheritanceCorrectness` | 子代理是否继承 `beforeToolCall` 且按自己 `allowedTools` 子集裁决 | 继承通道（L1）+ 真实触发（L4） | L1 / L4 | 否 |
| `convergence` | 是否在预算/deadline 内正常收尾 | `cost_summary.team.members[].budgetExceeded` / `durationMs` | T-L2b | 否 |
| `overBudget` | 触发护栏时干净停止且团队累计严格 ≤ ceiling | `budgetExceeded` + `TeamBudgetAccumulator` | L1 | 否 |
| `peakConcurrency` | 在飞成员峰值 ≤ `maxConcurrentMembers` | `TeamState.peakConcurrency` | T-L2b | 否 |

**成本放大比不做硬门禁**（叙事证据，非正确性；模型变便宜会导致放大比升高被误判回归），作为 `SloSpec` 的 soft/warn 阈值。

---

## 8. 与单 agent 评测的关系 & CI 门禁分层

- **独立 dataset** `datasets/ohna/team-v1.json`（≥20 cases：编排成功 / 成员不存在 / 超预算 / 权限继承 deny / 并发 / 失败隔离各若干），**不混进** `coding-v1.json`（避免 `fileChangeCorrectness` 虚高）。
- **代码落点** `apps/ohna-cli/eval/team/{dataset,run,metrics,adapter,trajectory,index}.ts`，与 coding 并列；入口复用 `pnpm eval:ohna --dataset team --tier <tier>`。
- **硬门禁（block，确定性）**：`subagentCompletionRate`、`permissionInheritanceCorrectness`（继承通道 = 100%，fail-closed 是安全语义）、`overBudget`（严格 ≤ ceiling）、T-L1/T-L2a/T-L2b 的纯函数与契约断言。
- **趋势门禁（不 block）**：`dispatchCorrectness`、`costAmplificationRatio`、`tokenAttributionToMember`、真实权限触发——真模型 + judge 的统计趋势 + 错误预算。

---

## 9. 落地前必须解决的代码缺口

| 缺口 | 现状 | 后果 | 优先级 |
|---|---|---|---|
| **G-T1** | `projectTeamCostSummary` 是孤儿投影（无生产消费方）；team 成本投影是**产品线断层**：ohna-cli 创建 `TeamController` 但丢弃引用、且 serve 包无投影；finance-api 的 `run-service.ts` 有内联投影但无 `TeamController` | 成本归因 mock 态与 live 态口径不一致，`tokenAttributionToMember` 空中楼阁 | 最高 |
| **G-T2** | `TeamControllerOptions.streamFn` 单注入点，supervisor 与子代理无法分层 | L2b 真 provider 驱动需确认「supervisor 与子代理用同一真 provider」是否可接受 | 高 |
| **G-T3** | `MemberBudgetHook.usage` 只在配 `budget` 时存在 | 成本归因证据源不是 `llm_call` 而是护栏累计 usage，与单 agent 根本不同 | 高 |
| **G-T4** | `BeforeToolCallContext` 不含调用者身份 | 权限继承「这次 deny 是子代理触发还是 supervisor 触发」无法断言 | 中 |

### 9.1 G-T1 收敛：team 成本投影的单一路径（B-1 接线草稿）

#### 9.1.1 先点破：G-T1 的「双实现」本质是产品线断层

核实代码后，G-T1 不是「两份相同逻辑」，而是**两个产品线各自缺了一半**：

| 事实 | 位置 |
|---|---|
| `TeamController` 只在 **ohna-cli** 创建（`team-wiring.ts`），且 controller 引用被**丢弃**（`createTeamToolset` 只返回 `.tools`/`.teamToolNames`） | `apps/ohna-cli/src/runtime/team-wiring.ts:77-86` |
| ohna-cli 的 run 走 **`packages/serve`**（`createOhnaServer` → `RunManager.createRun`），serve 包**零 team 成本投影** | `packages/serve`（grep 无 `projectTeamCostSummary`/`cost_summary.team`） |
| 内联 team 成本投影在 **finance-api** 的 `run-service.ts`，它**不创建** `TeamController`（grep 无 `createTeamController`），只防御性消费 SendMessage 事件 | `apps/finance-api/src/application/run-service.ts:487/569-598/651-663` |
| AGENTS.md 硬约束：`apps/ohna-cli` 与 `apps/finance-api` **互不依赖** | AGENTS.md |

**结论**：B-1 原始「把 controller 引用传给 run-service」设想**在产品线边界下不成立**——`TeamController` 只在 ohna-cli 创建，`run-service` 只在 finance-api。正确收敛是：**让「创建 TeamController 的产品线（ohna-cli）」自己负责投影，投影点落在共享 serve 包**，使 `projectTeamCostSummary` 成为唯一真相源。

#### 9.1.2 完整接线链路（修正后）

```
team-wiring.ts:  createTeamController → 保留 getTeamState（不再丢弃）
        ↓
harness.ts:      team.getTeamState 传给 hostOhnaWeb
        ↓
web-host.ts:     透传给 createOhnaServer options
        ↓
serve 包 RunManager:  新增 getTeamState? 选项
        ↓
run 收尾（agent_end）:  projectTeamCostSummary(getTeamState()) → cost_summary.team
        ↓
packages/agent:   projectTeamCostSummary 成为唯一真相源（L1 硬门禁覆盖）
```

#### 9.1.3 改动点草稿

**改动点 1：`team-wiring.ts` —— 把 controller 透传出去（不再丢弃）**

```ts
import type { TeamState } from "@aiagent/agent";

export interface TeamToolset {
  tools: AgentTool<any>[];
  teamToolNames: Set<string>;
  /** 新增：暴露 controller 的 getTeamState，供 run 结束时投影 team 成本段（G-T1 收敛）。 */
  getTeamState?: () => TeamState;
}

export function createTeamToolset(options: TeamToolsetOptions): TeamToolset {
  if (!options.enabled) return { tools: [], teamToolNames: new Set() };
  const controller = createTeamController({
    availableTools: [...options.codingTools],
    defaultModel: options.defaultModel,
    beforeToolCall: createTeamGateForwarder(options.getGate),
    ...(options.streamFn ? { streamFn: options.streamFn } : {}),
  });
  return {
    tools: controller.tools,
    teamToolNames: new Set(controller.tools.map((tool) => tool.name)),
    // 新增：透传 getTeamState（绑定 controller 实例），丢弃前先保留投影入口。
    getTeamState: () => controller.getTeamState(),
  };
}
```

**改动点 2：`harness.ts` —— 把 `getTeamState` 传进 serve 装配**

```ts
const team = createTeamToolset({ enabled: options.team, codingTools, defaultModel: active.model, getGate: () => gateRef, streamFn: tracedStreamFn });
tools.push(...team.tools);
// ... 现有 teamToolNames / onGateReady 逻辑不变 ...

const hosted = await hostOhnaWeb({
  workspaceRoot: cwd,
  active,
  tools,
  autoApprove: options.yes,
  observeOnly: false,
  port: options.webPort,
  conversationTitle: `CLI · ${(options.resume ?? cwd).slice(0, 8)}`,
  dataDir,
  // 新增：透传 team 状态投影入口（--no-team 时为 undefined）。
  getTeamState: team.getTeamState,
});
```

**改动点 3：`web-host.ts` → `createOhnaServer` → `RunManager` 透传（serve 包，真正落点）**

`RunManagerOptions`（或 `createOhnaServer` options）新增可选字段：

```ts
/** 可选：team 状态投影入口，run 结束时用 projectTeamCostSummary 并入 cost_summary.team。 */
getTeamState?: () => import("@aiagent/agent").TeamState;
```

在 serve 的 run 收尾（产出 `cost_summary` 事件处，等价于 finance-api run-service 的 `agent_end` 分支）加：

```ts
if (getTeamState) {
  const team = projectTeamCostSummary(getTeamState());
  if (team.members.length > 0) {
    costSummaryPayload.team = team;
  }
}
```

> serve 包 import `projectTeamCostSummary` 会引入 `@aiagent/agent` 依赖；AGENTS.md 已确认 serve 复用 `@aiagent/agent` 的 permission 策略，故**无新增依赖**。

**改动点 4：`finance-api/run-service.ts` —— 内联逻辑判定为「预留死代码」**

finance-api 目前**不创建** `TeamController`（grep 无 `createTeamController`），其 run-service 的 SendMessage 处理（`487` 行 `teamMembers` Map、`569-598` 手工累加、`651-663` team 段组装）是「未来预留」，永远走不到 `teamMembers.size > 0`。处理二选一：

- **删除**（推荐，若 finance-api 近期不接 team）：删 `teamMembers` Map 与 569-598/651-663 内联逻辑，等 finance-api 真接 team 时复用 serve 包同一条投影路径。
- **保留但改造**：finance-api 若也要跑 team，改为「注入 `getTeamState` + 调 `projectTeamCostSummary`」，与 serve 包共用单一真相源。

#### 9.1.4 收敛时的语义差异（不能无脑替换）

1. **members 集合**：`projectTeamCostSummary` 输出**所有成员**（含 0 用量成员，防御式 `tokens=0`），内联逻辑只输出有用量成员。收敛后 team 段会多出「创建了但未产生用量的成员」——通常是好事（更完整可观测），但需确认下游 Web 展示不渲染误导性「0 用量行」（`getTeamView` 已做「0 用量不渲染」，但 `TeamCostSection.members` 本身仍含 0 用量成员）。
2. **`durationMs` 字段**：`projectTeamCostSummary` 输出 `durationMs`（时延归因，新增能力），内联逻辑没有。收敛后 team 段新增该字段，需核对 `packages/trace` 的 `CostSummaryEvent.payload.team.members` 契约是否已声明 `durationMs`（`run-event.ts:29` 已声明为可选）。

#### 9.1.5 落点总结

| 文件 | 改动 |
|---|---|
| `apps/ohna-cli/src/runtime/team-wiring.ts` | `TeamToolset` 增 `getTeamState?`；`createTeamToolset` 透传 `controller.getTeamState` |
| `apps/ohna-cli/src/cli/harness.ts` | `hostOhnaWeb` 增 `getTeamState: team.getTeamState` |
| `apps/ohna-cli/src/cli/web-host.ts` | 透传 `getTeamState` 到 serve options |
| `packages/serve`（`RunManagerOptions` / `createOhnaServer`） | 增 `getTeamState?` 选项；run 收尾用 `projectTeamCostSummary` 并入 team 段 |
| `apps/finance-api/.../run-service.ts` | 内联 SendMessage 成本逻辑判定为「预留死代码」，可删或改为复用 `projectTeamCostSummary` |

---

## 10. 复用的现成投影（零改动）

`TeamState.events` / `TeamMember.usage/status/summary/budgetExceeded/durationMs`、`SubagentResult`、`TeamBudgetAccumulator`、`projectTeamCostSummary`（内存态）、`eval-core` 的 gate/report/judge/calibration、`createPermissionGate`/`createPolicyState`/`createPresetPolicy`、`createBullBearRiskTeam`（mock 种子）。

---

## 11. 明确不做

- 不改 `agent-loop.ts`（team 复用内核，评测不侵入）。
- 不把 team 投影/匹配算法放 `eval-core`（保持内核零 `@aiagent/*` 依赖，对齐 `02` §2.2）。
- 不合并 `projectTeamCostSummary` 与 `run-service` 内联逻辑为「评测」，那是「重构」，但**建议在 v2.1 落地前先消 G-T1 双实现**。
- 不重建 Intent Router（编排决策由模型自主完成，评测以 run 事件为唯一事实源）。
