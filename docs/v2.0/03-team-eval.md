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

#### 4.2.1 裁定：kernel 单测的局部 `createMockStreamFn` 不踩线

本节的适用对象是**评测档位**（T-L1/L2a/L2b/L4）——那里一旦 mock 模型输出，绿灯就不再能证明「真实编排机跑通了」。内核回归单测（`packages/agent/test/agent-loop.test.mjs`、`packages/mcp/test/agentloop-mcp-e2e.test.mjs`）是另一类：它们断言的是 **loop 自身的控制流**（`calls.length`、`tool.executions.length`、`ToolResultMessage.toolCallId` 序列、`agent_start`/`agent_end` 首尾），**没有一条断言「模型该选什么」**。按 §4.3 的判据「是否踩线取决于断言指向流程还是选择」，这属于合法用法，予以保留。

裁定边界（后续不得借这一条扩权）：

- 允许：`agentLoop` / `createCombinedAgentTools` 等**内核件**的控制流单测，用局部 helper 预置消息序列，且**全部断言只指向流程**。
- 禁止：任何 `eval.*` 评测档位、`team` 评测适配器、判定「决策正确性」的用例使用同类 helper。
- 禁止：把这类 helper 提成共享模块跨测试文件复用——一旦共享，它就会漂移成「事实上的评测夹具」。

> 因此 03 §6 的严格迁移**已完成且范围准确**：`packages/agent/test/team-controller.test.mjs` 里的 `createMockStreamFn`（同时扮演「模型」和「控制流夹具」）已删除，改由真 provider 链路 + adapter 位替换 + `pure.ts` 纯函数三件套覆盖；残留的两处 kernel 单测 helper 按上述裁定保留，**这不是遗漏**。若按「仓库内可执行数量必须为 0」这类绝对口径去清理，会让内核控制流回归失去确定性覆盖，是过度执行。

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

严格迁移不是「改测试」，而是把目前被「mock 模型输出」掩盖的编排机逻辑，抽成可脱离 `agentLoop` 直接测的纯函数，下沉到 L1。三个函数的精确契约如下（类型引用对齐 `packages/agent/src/types.ts` 与 `packages/agent/src/team/types.ts`）。

> **落点已落地（W1）**：三个纯函数现居 `packages/agent/src/team/pure.ts` 并从 `@aiagent/agent` 公共入口导出；`controller.ts` 只保留调用点。本文引用一律采用**「函数名 + 现有行号」双锚点**，函数名才是稳定锚点，行号仅供快速跳转，后续重排不必再逐条纠偏。

---

#### 6.1.1 `extractSummary`（导出，零改造）

**来源**：原 `controller.ts:91-110` 的模块私有纯函数，W1 抽离到 `pure.ts` 的 `extractSummary`（`pure.ts:37`）并 `export`，实现不变；`controller.ts` 在 `runMember` 的 `extractSummary(messages)`（`controller.ts:297`）处调用。

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

**来源**：抽自原 `controller.ts:329-331` 的失败判定逻辑，W1 落到 `pure.ts` 的 `classifyAborted`（`pure.ts:81`）；`controller.ts` 在 `runMember` 的 `classifyAborted({ endError, lastAssistant })`（`controller.ts:305`）处调用。原逻辑依赖 `lastAssistant.stopReason`，抽成纯函数后不再需要 mock `stopReason:"error"` 来注入失败。

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
- **`lastAssistant` 存在但不是 assistant 消息（类型误用）→ `aborted === false`，不是 fail-closed。**
  契约依据：`AgentMessage` 联合中的 `user` / `toolResult` 都不携带 `stopReason`，即「没有任何终止信号」；抽取前 `controller` 对该情形同样判 falsy（`lastAssistant.stopReason` 为 `undefined`，不命中 error/aborted 分支）。
  `classifyAborted` 只负责忠实投影停止信号，**不承担**「调用方传错类型」的防御职责——调用方契约是传入 `messages` 中最后一条 assistant（`runMember` 用 `find(m => m.role === "assistant")` 保证）。
  需要 fail-closed 语义的上层必须自行校验入参类型。**若要变更本契约（改为 fail-closed），必须同时改本节与本条实现、以及 `packages/agent/test/team-pure.test.mjs` 的断言，不得静默变更。**

  **L1 探针分支覆盖要求（对 eval 域 `run-l1.ts` 的强制契约）**：本节每一条断言都必须在 `apps/ohna-cli/src/eval/team/` 的 L1 探针里有对应证据，否则「文档声明的契约面」会比「数据集实际覆盖」宽一档，出现「文档说测了、数据集没测」的假绿灯。`l1ProbeMode` 必须覆盖以下全部分支：

  | `l1ProbeMode` | 对应断言 | `abortInputFor` 构造 |
  |---|---|---|
  | `clean` | 「无输出 → `unknown` 兜底」的对照基线 | `{ endError: undefined, lastAssistant: undefined }` |
  | `end_error` | 「`endError` 原样透传」 | `{ endError: {code,message}, lastAssistant: undefined }` |
  | `stop_reason_error` | 「`stopReason=error` → `subagent_failed`」 | `{ endError: undefined, lastAssistant: assistant(stopReason:"error") }` |
  | `misuse` | 「**非 assistant → `aborted:false`，不是 fail-closed**」 | `{ endError: undefined, lastAssistant: { role: "user", ... } }`（或 `toolResult`） |
  | `with_hooks` | §6.1.3 两个钩子键均注入 | —（走 `configInputFor`） |

  `misuse` 分支的探针判定必须**正向**断言 `probe.aborted === false` 且 `"error" in probe === false`：仅靠「没有抛错 / 没进失败分支」默认通过是不够的——那样无法区分「契约选择为 false」与「误判漏测」。实现落点：`run-l1.ts` 的 `abortMisuseNotFailClosed`（写入 `evidence.l1.abortMisuseNotFailClosed`，仅在 `probeMode === "misuse"` 时有值）+ `contract.ts` 的 `contractL1` 判据。

  **数据集覆盖现状（与上表严格一一对应，五个分支各至少一条）**：`datasets/ohna/team-v1.json` 共 29 条，`l1ProbeMode` 分布为 `clean` 25 条（缺省）+ `end_error` 1 条（`team-26-l1-probe-end-error`）+ `stop_reason_error` 1 条（`team-27-l1-probe-stop-reason`）+ `with_hooks` 1 条（`team-28-l1-probe-with-hooks`）+ `misuse` 1 条（`team-29-l1-probe-misuse`）。`apps/ohna-cli/test/team-eval-contract.test.mjs` 另有两条锁定：`misuse` 判据翻成 `false` 时 `teamL1Contract` 必须判 0（防止断言恒真）、以及非 `misuse` 分支不得产出该证据字段（防止串档）。

  **加载期硬拦（`dataset.ts`）**：`l1ProbeMode` 只接受上表五个值，其它任何取值（含拼错）在 `parseTeamDataset` 阶段直接抛错。理由是该字段一旦非法，`run-l1.ts` 的 `abortInputFor` / `abortCodeTransparent` 会一路落到缺省（= `clean` 探针），探针照跑、`teamL1Contract` 照判 1，而数据集宣称的分支其实一条都没测——这正是「校验但不生效」的静默通道。同时 `teamL1Contract` 只对 `abortMisuseNotFailClosed === false` 判错（缺字段放行），因此非法分支必须由 loader 拦，不能指望指标兜底。回归见 `team-eval-contract.test.mjs` 的「loader 拦下非法 l1ProbeMode」。

---

#### 6.1.3 `assembleSubagentConfig`（新增导出）

**来源**：抽自原 `controller.ts:291-311` 的 `subConfig` 装配，W1 落到 `pure.ts` 的 `assembleSubagentConfig`（`pure.ts:126`）；`controller.ts` 在 `runMember` 的 `assembleSubagentConfig({...})`（`controller.ts:269`）处调用，其后仍保留一层薄包装来捕获 `stoppedByBudget`。这是 K3「继承通道」的确定性证据源——脱离 `agentLoop` 就能断言 `beforeToolCall` / `shouldStopAfterTurn` 是否按预期注入。

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
 * - identity **无条件装配**（v2.0 起，docs/v2.0/04 §1.3）：由 `deriveSubagentIdentity(member)`
 *   给出 agentId = member.name、parentId = "supervisor"，是 Trace 归属与身份的可断言证据；
 * - 两个钩子皆无 → config 恰为 model + convertToLlm + identity 三键（零多余钩子）。
 *
 * 「budgetHook 触发时标记 budgetExceeded」这个运行期副作用**不属于本函数**：
 * 由 runMember 在拿到返回的 config 后，自行薄包装 shouldStopAfterTurn 捕获 stoppedByBudget。
 *
 * @param member 目标成员（提供 model 与工具子集，供权限闸门解析 effect；identity 的来源）。
 * @param budgetHook 成本护栏句柄（未配置预算时为 undefined）。
 * @param beforeToolCall supervisor 的权限闸门（K3 策略继承来源，可为 undefined）。
 * @param convertToLlm 子代理消息→LLM 消息转换器。
 * @returns 装配好的 AgentLoopConfig（model 取 member.model，identity 必含）。
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
- `identity` **无条件存在**：`config.identity.agentId === member.name`、`config.identity.parentId === "supervisor"`（v2.0 起，对齐 docs/v2.0/04 §1.3）。
- `beforeToolCall` 有值 → `config.beforeToolCall === input.beforeToolCall`（同一引用，**继承通道**）；`beforeToolCall === undefined` → `"beforeToolCall" in config === false`（零多余钩子）。
- `budgetHook` 有值 → `config.shouldStopAfterTurn` 存在且函数类型正确；`budgetHook === undefined` → `"shouldStopAfterTurn" in config === false`。
- **两钩子皆无时键集恰为 `["convertToLlm","identity","model"]`**（三键，顺序无关）——「零多余钩子」的可失败断言。
- **不含** `deadlineMs`（对齐 A-2 修复：`assembleSubagentConfig` 的实现注释见 `pure.ts:117`、`pure.ts:126` 起的返回对象；agent-loop 从不消费 deadlineMs，真正生效的是护栏闭包墙钟自查）。

---

> 这三个纯函数一旦导出，L2b 里「失败隔离」「权限继承通道」「摘要回收」的**逻辑正确性**就被 L1 硬门禁覆盖，L2b 只剩「真 provider 下这些逻辑确实被串起来」的集成验证。`assembleSubagentConfig` 抽离后，`runMember` 保留一个薄包装层用于捕获 `stoppedByBudget`（回写 `member.budgetExceeded`），该包装不属于纯函数契约。

### 6.2 现有 8 个测试的迁移映射

| 现有测试 | 现状 | 迁移后归属 | 关键变化 | 当前环境可验证性 |
|---|---|---|---|---|
| TeamCreate 注册 | 无 streamFn | **T-L2a**（不变） | 无 | **确定性（L1/L2a）** |
| SendMessage 摘要回收 | mock 固定「看涨」文本 | **T-L2b 真 provider** | 摘要不再固定内容，改为「断言 summary 非空 + 是 assistant 文本」 | **需凭据（未验证）** |
| 失败隔离 | mock 固定 `stopReason:"error"` | **拆分**：失败判定 → L1（`classifyAborted`）；端到端真实失败 → L4（真模型自然出错，统计观测） | 无法确定性注入 `stopReason:"error"` | 判定逻辑**确定性（L1）**；端到端**需凭据（未验证）** |
| member_not_found | mock 任意文本 | **T-L2a 纯状态**（不改） | `runMember` 早退发生在 `agentLoop` 之前，本就不依赖模型输出 | **确定性（L2a）** |
| 成本护栏 | mock `costedMessage` 带 usage | **L1**（`createBudgetGuard` 已独立）+ **T-L2b 真 provider**（测护栏 hook 真被触发，不断言精确 usage） | 无法断言 `usage.cost === 0.07` 精确值 | 纯函数/钩子**确定性（L1）**；真 provider 触发**需凭据（未验证）** |
| 并发信号量 | `delayStreamFn` 只测在飞计数 | **T-L2b 真 provider**（保留在飞计数观测，但 `streamFn` 改真 provider） | 在飞计数是合法控制流观测，不是 mock 模型输出 | 信号量本身**确定性（L1）**；经 `runMember` 的端到端在飞计数**需凭据（未验证）** |
| 团队聚合 ceiling | mock `costedMessage` | **L1**（`createBudgetGuard` + 累加器原子性用合成事件测）+ **T-L2b 真 provider**（测护栏真触发，不精确断言） | 同上 | 原子性**确定性（L1）**；真 provider 触发**需凭据（未验证）** |
| 并发原子性 | mock `costedMessage` | **L1**（AsyncMutex 临界区逻辑用合成输入测） | 原子性是纯函数性质，可脱离 `agentLoop` 测 | **确定性（L1）** |
| K3 权限继承 | mock 两条 scripted 消息（先 toolCall write） | **拆分**：继承通道 → L1（`assembleSubagentConfig`）；工具子集 → L1（`resolveTools`）；真实触发 → L4（真模型 + 定向「写文件」任务 + judge 观测是否被拦） | **最该拆的一个** | 继承通道 / 工具子集**确定性（L1）**；真实触发**需凭据（未验证）** |

**可验证性列的读法（重要）**：本仓库开发环境与 CI 均未配置 `AIAGENT_LLM_API_KEY_*`，因此带「需凭据（未验证）」的行在本环境**没有任何一次真跑证据**——它们由 `packages/agent/test/team-l2b-provider.test.mjs` 显式 skip 覆盖（skip 原因写明「无 provider 凭据，跳过真 provider 档」，绝不静默通过）。

另有一层**传输层契约**证据（`packages/agent/test/team-l2b-kernel.test.mjs` 的 `[L2b-kernel]` 与 `[transport-contract]` 用例）：用网络字节层桩（替换 `fetch` 回放 SSE 字节）驱动真 `streamSimple` 链路，验证「护栏 / 并发 / 失败路径 / tool_calls 落到被 mock 的 execute 出口」这些**契约**。它**不是**模型行为证据，故不计入 L2b 硬门禁的「决策/内容」证据面，也不能替代带凭据 job。

> **验收前提**：这套迁移的完整验收必须包含一次**带凭据 job**（跑 `--tier T-L2b`）。在没有该 job 之前，T-L2b 档在 CI 上的语义是「不可判定」（见 §8.1），不是「通过」。

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

下表「简称」列只用于本文件行文；**报告（`report.json` / `report.md`）里一律是带 `team` 前缀的全名**——按简称去 grep 报告是找不到的。

| 简称 | 报告中的指标名 | 定义 | 证据源 | tier | 进 eval-core? |
|---|---|---|---|---|---|
| `dispatchCorrectness` | `teamDispatchCorrectness` | supervisor 是否 spawn 期望成员集、派发正确 recipient（对齐 `expectedSpawns`/`expectedSends`） | supervisor `tool_execution_*` 投影成 `TeamDispatchStep[]` | T-L4 | 否 |
| `subagentCompletionRate` | `teamSubagentCompletionRate` | `status==="done"` 的 SubagentResult 数 / 派发总数 | `SubagentResult.status` | T-L2b | 否 |
| `costAmplificationRatio` | `teamCostAmplificationRatio` | `team.totalCost / 单 agent 等价成本`；**评测侧的单 agent 等价成本取「最大单成员成本」（`Math.max(...memberCosts)`），即该比值的下界近似**——真正的等价成本本应是「不委派时主上下文自己做这件事」的成本，评测侧不跑那条对照线，只能取最贵成员作保守下界（下界 ⇒ 放大比偏大 ⇒ 只在旺火时才告警，不会因低估而漏警）。**基线为 0（`Math.max(...memberCosts) === 0`）时放大比不可算**：指标 `applicable=false`，且当 `team.totalCost > 0` 时 detail 必须写「无成本基线」并带上团队成本实测值，不得写成「成本为 0」——那是一句与事实相反的说明，会把唯一该被看见的场景说成无事发生；`apps/ohna-cli/test/team-eval-contract.test.mjs` 有正反两条锁定 | `cost_summary.team` vs `totalCost` | T-L4 | 否 |
| `tokenAttributionToMember` | `teamTokenAttributionToMember` | 每成员 tokens/cost 是否等于该成员各轮 usage 之和 | `members[].usage` vs llm 记录 | T-L4（有缺口） | 否 |
| `permissionInheritanceCorrectness` | `teamPermissionInheritanceCorrectness` | 子代理是否继承 `beforeToolCall` 且按自己 `allowedTools` 子集裁决 | 继承通道（L1）+ 真实触发（L4） | L1 / L4 | 否 |
| `convergence` | `teamConvergence` | 是否在预算/deadline 内正常收尾 | `cost_summary.team.members[].budgetExceeded` / `durationMs` | T-L2b | 否 |
| `overBudget` | `teamOverBudget` | 触发护栏时干净停止且团队累计严格 ≤ ceiling | `budgetExceeded` + `TeamBudgetAccumulator` | L1 | 否 |
| `peakConcurrency` | `teamPeakConcurrency` | 在飞成员峰值 ≤ `maxConcurrentMembers` | `TeamState.peakConcurrency` | T-L2b | 否 |
| （契约） | `teamContractStatuses` | 成员终态 / 整体结果 / `maxTurns` / 失败注入点与声明一致 | `subagentResults` + 声明 | T-L2b / T-L4（见 §8 注） | 否 |
| （L1 契约） | `teamL1Contract` | §6.1 三件纯函数契约 | `evidence.l1` | T-L1 | 否 |

**成本放大比不做硬门禁**（叙事证据，非正确性；模型变便宜会导致放大比升高被误判回归），作为 `SloSpec` 的 soft/warn 阈值。

---

## 8. 与单 agent 评测的关系 & CI 门禁分层

- **独立 dataset** `datasets/ohna/team-v1.json`（≥20 cases：编排成功 / 成员不存在 / 超预算 / 权限继承 deny / 并发 / 失败隔离各若干），**不混进** `coding-v1.json`（避免 `fileChangeCorrectness` 虚高）。
- **代码落点** `apps/ohna-cli/src/eval/team/{dataset,run,run-l1,metrics,specs,adapter,trajectory,trend,types,index}.ts`（放在 `src/` 下与 coding 评测 `src/eval/*.ts` 同一约定，随 `tsc -b` 编译到 `dist/`，测试从 `dist/eval/team/*.js` 导入）；入口复用 `pnpm eval:ohna --dataset team --tier <tier>`。
  - `run-l1.ts` 独立承载纯函数档；`specs.ts` 承载指标规约表（tier / 门禁归属 / 证据源 / 确定性），`metrics.ts` 只做计算，报告聚合与门禁投影再从 `metrics.ts` 拆出 `report.ts`——拆分使 `src/eval/team/` 下**每个源文件 <500 行**（实测最大 `metrics.ts` 470 行）。
  - `apps/ohna-cli/test/team-eval-*.test.mjs` 同样受 500 行纪律约束：契约类断言单列 `team-eval-contract.test.mjs`，避免与 core 合并后超限。
- **产物目录** `apps/ohna-cli/eval/team/{report.json,report.md,baseline.json,trend.json,trend.md}`，与 coding 的 `apps/ohna-cli/eval/` **物理隔离**，互不覆盖 baseline。
- **硬门禁（block，确定性）**：`subagentCompletionRate`、`permissionInheritanceCorrectness`（继承通道 = 100%，fail-closed 是安全语义）、`overBudget`（严格 ≤ ceiling）、T-L1/T-L2a/T-L2b 的纯函数与契约断言。
  - 其中**契约断言**落成两条可计分指标：`teamContractStatuses`（`expectedMemberStatus` / `expectedResultStatus` / `maxTurns` / 失败注入点必须与观测一致）与 `teamL1Contract`（`extractSummary` / `classifyAborted` / `assembleSubagentConfig` 三件纯函数契约）。二者都是 hard，确保数据集里声明的期望**真的被断言**，不会退化成「校验但不生效」。
  - **`teamContractStatuses` 的判定力只存在于 T-L2b / T-L4（实测口径，不是设计意图）**：该指标的前置条件是「本档真的驱动过成员」（`evidence.subagentResults.some(r => r.ran)`，见 `contract.ts`）。而 T-L1 恒置 `subagentResults: []`、T-L2a 只走纯状态迁移不跑子代理，因此这两个**确定性档**上它一律 `applicable=false`。直接后果：数据集里的 `expectedResultStatus` / `expectedMemberStatus` 字段在 T-L1 / T-L2a 的报告里**不产生任何判定**，其判定力只落在需要 provider 凭据的 T-L2b / T-L4 上——**无凭据环境下这条契约没有任何执行证据**。代码对此是诚实的（判不适用而非记 1 分假通过），但读者不得把 T-L1 的「29/29 通过」理解为「成员终态契约已被验证」。
- **趋势门禁（不 block）**：`dispatchCorrectness`、`costAmplificationRatio`、`tokenAttributionToMember`、真实权限触发——真模型的统计趋势 + 错误预算。

### 8.1 档位可判定性与 CI 处理（重要）

**T-L2b / T-L4 在本仓库当前环境不可验证。** 二者需要真实 provider 凭据（`AIAGENT_LLM_API_KEY_*`），而本仓库的 CI 与开发环境均未配置，因此：

| 情形 | 行为 |
|---|---|
| 有凭据 | T-L2b/T-L4 正常执行，硬门禁按 §8 判定；`--update-baseline` 可写基线 |
| 无凭据 | 全部 case 显式 skip（`executed:false` + 原因），本档判定为**「不可判定」**：`gate.passed=false`、`exitCode=1`、reason 写明「无任何 case 执行，本档不可判定」；`--update-baseline` 被**拒绝**并返回 `2`，绝不产出「8 个指标全 applicable=false」的空基线 |

拒绝写基线是本节的硬要求：空基线会让该档门禁此后每次都走「空 diff = 通过」而恒绿——CI 上一条断言都没跑却显示绿灯，等于静默通过（§4.2 红线）。

**指标级的不可判定清单（与档位级分开记，避免漏项）**：

| 指标 | T-L1 | T-L2a | T-L2b | T-L4 | 无凭据环境下的实际判定力 |
|---|---|---|---|---|---|
| `teamL1Contract` | ✅ | — | — | — | **有**（确定性） |
| `teamPermissionInheritanceCorrectness` | ✅ 通道 | ✅ 通道 | ✅ | ✅ 真实触发 | 通道部分**有** |
| `teamOverBudget` | ✅ | ✅ | ✅ | — | **有**（确定性） |
| `teamDispatchCorrectness` | — | ✅ | — | ✅ | **有**（T-L2a 上按声明回放式核对） |
| `teamTokenAttributionToMember` | — | ✅ | — | ✅ | 部分**有**（零成本档恒 0，判定力弱） |
| `teamContractStatuses` | ❌ 不适用 | ❌ 不适用 | ✅ | ✅ | **无**（见 §8 注） |
| `teamSubagentCompletionRate` / `teamConvergence` / `teamPeakConcurrency` | — | — | ✅ | — | **无**（需真实驱动成员） |
| `teamCostAmplificationRatio` | — | — | — | ✅ trend | **无**（且永不 block） |

> 「无」不等于「实现错误」：这些指标在对应档位会显式 `applicable=false` 并写明原因，门禁不会因此放行——但它们**不能**被拿来当「已覆盖」的证据。

**CI 侧处理**：
- 无凭据 job：**不跑** `T-L2b` / `T-L4`（不要用 `--update-baseline` 试图「先建个空基线」，会被 exit 2 拒绝）；只跑 `T-L1` / `T-L2a` 两个确定性档作为合并门禁。上表中标「无」的指标因此**在无凭据 CI 里没有任何执行证据**，评审时不得据 T-L1/T-L2a 的绿灯推断它们已被验证。
- 带凭据 job（如 nightly / 发布前）：跑 `T-L2b` 并允许 block；`T-L4` 只产出趋势段，不参与 exitCode。
- 报告 `summary` 顶部固定带可判定性标注（`【本档可判定】` / `【本档不可判定：0 条 case 执行】` / `【本档部分不可判定：N/M 条未执行】`），便于一眼区分「真通过」与「根本没跑」。

**`createBudgetGuard` 的 token 上限缺陷（已修复）**：该函数（`packages/agent/src/team/budget.ts`）原先**只比较成本上限**（`maxCostPerMember` / `maxCostTotal`），忽略 `maxTokensTotal` / `maxTokensPerMember`。后果是：零成本模型（评测占位模型、本地小模型、缓存全命中）的估算成本恒为 0，纯 token ceiling 的 case（team-10/11/13）在派发前永远拒不掉，「派发前拒绝」这一层被静默跳过，`teamOverBudget` 因此判失败。

修复：`createBudgetGuard` 新增与成本上限**对称**的 token 判定（`maxTokensPerMember` 与 `maxTokensTotal` 的剩余余量），判定口径对齐运行时钩子 `createMemberStopHook`。回归防护见 `packages/agent/test/team-controller.test.mjs` 的「createBudgetGuard 派发前估算」用例（含零成本模型 + token 上限的 4 条反向断言）。

修复后实测：`T-L1` 与 `T-L2a` 两个确定性档均 `exit 0`，`teamOverBudget` 值恢复为 1（当时 28 条 case 全部执行，其中 over_budget 类 4 条；加入 `misuse` 探针后为 29 条）。**CI 上这两档现为可用的硬门禁。**

> 纪律说明：本节只记录**当前状态**。历史状态（修复前的 exit 1）见 git 历史，不在文档里保留会迅速过期的数字。同类缺陷若再次出现，应由 `apps/ohna-cli/test/team-eval-gate.test.mjs` 的 `assertHardGateSatisfied`（逐条核对 `TEAM_HARD_GATE_SLOS` + 以自身为基线复判）自动拦截，而不是靠人工巡检。

**T-L4 的定位**：当前实现中 T-L4 是**决策观测档，没有 judge 评分**（`trend.ts` 只做指标 diff，不接 judge）。`--judge` 仅对 coding 域生效，team 域会打印一条忽略提示。若要接入 judge 评分，需在 `trend.ts` 增加对 dispatch 决策的裁判链路，届时再更新本节。

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
| 内联 team 成本投影曾位于 **finance-api** 的 `run-service.ts`，它**不创建** `TeamController`（grep 无 `createTeamController`），只防御性消费 SendMessage 事件。**该内联累加已按本节结论删除**（§9.1.5），仅保留一条「team 成本只由 serve 投影」的显式告警 | `apps/finance-api/src/application/run-service.ts`（`SendMessage` 分支告警，原 `teamMembers` 累加已移除） |
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
3. **run 级归因（跨 run 重复计费的根治）**：`TeamController` 是**会话级**实例（`createTeamToolset` 每个 CLI 进程只创建一个，`state.members` / `usage` 跨 run 存活），而 `cost_summary` 是**run 级**事件。若收尾时直接 `projectTeamCostSummary(getTeamState())` 投影全量状态，同一进程第二个 run 的 team 段会把第一个 run 的成员成本再算一遍，成本归因随会话单调虚高（§7 的 `tokenAttributionToMember` / `costAmplificationRatio` 全部失真）。
   实现（`packages/serve/src/run/cost-summary.ts`）：
   - `snapshotTeamBaseline` 在 `RunCostTracker.begin`（run 建立、任何派发之前）给成员用量打快照 `{member → {tokens, cost}}`；
   - `projectRunTeamSection(getTeamState, baseline)` 收尾时只报**增量**（`当前值 − 基线值`），本 run 无增量的成员被剔除，`totalTokens` / `totalCost` 由增量成员**重新求和**（不能沿用全量段的合计，否则明细是增量、合计是累计，自相矛盾）；
   - 未传 baseline 时保留全量投影语义（供单 run 场景 / 测试直接使用）。
   回归防护：`packages/serve/test/team-cost-projection.test.mjs` 的「同一会话连跑两个 run → 第二个 run 的 team 段不重复计入第一个 run」，断言 run 2 只报增量（bull 60 / bear 30 / 合计 90，而非累计 190）。
   > 注意：因此 team 段里的 0 用量成员**不会**出现在「本 run 没跑过它」的场景中——§9.1.4 第 1 条描述的「含 0 用量成员」只在**不传 baseline** 的全量投影下成立。这是刻意的取舍：run 级归因优先于「展示全部成员」。

#### 9.1.5 落点总结

| 文件 | 改动 |
|---|---|
| `apps/ohna-cli/src/runtime/team-wiring.ts` | ✅ 已落地：`TeamToolset` 增 `getTeamState?`；`createTeamToolset` 透传 `() => controller.getTeamState()`；`enabled=false` 时返回对象**不含该键**（旧形状向后兼容） |
| `apps/ohna-cli/src/cli/harness.ts` | ✅ 已落地：`hostOhnaWeb` 增 `...(team.getTeamState ? { getTeamState: team.getTeamState } : {})`（`--no-team` 时不带该键） |
| `apps/ohna-cli/src/cli/web-host.ts` | ✅ 已落地：`HostOptions.getTeamState?` 条件展开透传到 `createOhnaServer` |
| `packages/serve/src/index.ts` | ✅ 已落地：`OhnaServerOptions.getTeamState?`（`import type { TeamState } from "@aiagent/agent"`），条件展开下传 `RunManager` |
| `packages/serve/src/run/types.ts` | ✅ 已落地：`RunManagerOptions.getTeamState?`（唯一入口，指向 `controller.getTeamState`） |
| `packages/serve/src/run/cost-summary.ts`（新） | ✅ 已落地：`snapshotTeamBaseline`（run 起点用量快照）+ `projectRunTeamSection(getTeamState, baseline)` → `projectTeamCostSummary` 的**增量**投影（**唯一** team 投影路径，不做二次累加）、`RunCostAccumulator`（byModel/byTool）、`buildCostSummaryPayload`。详见 §9.1.4 第 3 条 |
| `packages/serve/src/run-manager.ts` | ✅ 已落地：`createRun` 建 `ActiveRun` 后立即 `costTracker.begin(runId)`（覆盖 cancel / shutdown / execute 全部收尾入口），`execute` 内 `seedTools` 补工具全集，`turn_end` / `tool_execution_end` 逐事件累加；`finishStatus` 内联投影并发帧（`costTracker.project` → `emitFrame(run, "cost_summary", …)`，**先于 `run_status`**），投影异常只写 stderr 诊断（含 runId），不改变终态 |
| `packages/serve/test/team-cost-projection.test.mjs`（新） | ✅ 已落地：注入假 `getTeamState` → 跑最小 run → 断言 `cost_summary.payload.team` 与 `projectTeamCostSummary` 输出逐字段相等；未注入 / 团队为空时不出现 team 段；先于 `run_status` 且随 JSONL 落盘；**同一 getTeamState 连跑两个 run → 第二个 run 只报增量**（跨 run 重复计费回归） |
| `apps/ohna-cli/test/team-wiring.test.mjs` | ✅ 已落地：`getTeamState` 透传断言（enabled / disabled 两侧 + 经 `TeamCreate` 建成员后实时可见 + `hostOhnaWeb` 端到端产出 team 段） |
| `apps/finance-api/src/application/run-service.ts` | ✅ 已明确禁用第二口径：删除 `teamMembers` Map 与 569-598 的手工累加、651-663 的 team 段组装；`SendMessage` 分支改为按 run 只打一次 `process.emitWarning`（code `OHNA_TEAM_COST_SECOND_SOURCE_DISABLED`），`cost_summary` 不再写 `team` 段 |

> **唯一真相源的适用范围（已全仓闭合）**：`cost_summary.payload.team` 在两个产品线里都**只有**一条产线——由 serve 收尾调 `projectTeamCostSummary` 投影。finance-api 不创建 `TeamController`，其 `run-service.ts` 的本地累加已删除并改为显式告警，因此不再存在「字段口径不同的第二份 team 成本」。**后续若 finance-api 要跑 team**，正确做法是同样注入 `getTeamState` 走 serve 同一条投影，而不是在本文件重新累加。
>
> **v2.0 修正（Team 装配点上移，docs/v2.0/04 §2.2）**：`TeamController` 的**唯一生产装配点已从 ohna-cli 移到 serve**（`packages/serve/src/run/team-session.ts`）。CLI 组合根不再自建 controller，只把 `--no-team` 透传为 `createOhnaServer({ team })`；`apps/ohna-cli/src/runtime/team-wiring.ts` 的 `createTeamToolset` 保留但**无生产调用方**（仅 `apps/ohna-cli/test/team-wiring.test.mjs` 使用），`getTeamState` 链路因此退化为历史 fallback（serve 侧 controller 是首选来源，见 `RunManagerOptions.getTeamState` 注释）。上述「透传 `getTeamState`」的旧描述仅对 fallback 路径成立。
>
> **端到端 team 成本段的已知限制（评测侧必须知道，v2.0 已核实并更正）**：`hostOhnaWeb` 的 `HostOptions.streamFn` 是**测试注入口**（`web-host.ts` 注释已声明「生产中不传：serve 直接用真实 provider」），CLI 的 `harness.ts` 也不再把它下传——`setup.streamFn`（带采集 wrapper 的那个）只服务 `runtime/turn.ts` 的本地注入通道。托管路径的采集 wrapper 由 serve **自己**在 `RunManager.continueRun` 里按 run 现造（`createSupervisorTracedStreamFn(streamSimple, sink, runWindow)`），window 取 `options.model.contextWindow` 并经同一个 `resolveCompactionSettings` 算 reserveTokens，因此**采集与压缩两侧口径一致**——这一点已由 `test/verify-ohna-web-trace.mjs` 在真实 serve 实例上端到端断言（`llm_call.window` 必填 + `agentId` + `composition` + `context_event`）。
> 仍然成立的限制只有一条：**无真实 provider 凭据时，托管路径上的 team 与主线程都跑不到真实模型**，因此 `team-wiring.test.mjs` 的端到端断言用的是「脚本化 StreamFn + 假 `getTeamState`」而非真实 provider。评测侧对应结论不变：T-L2b/T-L4 的 team 成本指标（`teamTokenAttributionToMember` / `teamCostAmplificationRatio`）只能在评测进程内自建的 controller 上取数，不能依赖需要凭据的托管路径（详见 §8.1）。
>
> **serve 侧「从无到有」边界**：serve 原先**不发** `cost_summary`（该事件此前只有 finance-api 内联产线）。本次按 `packages/trace` 既有的 `CostSummaryEvent.payload` 契约补齐 serve 产线，未新增/修改任何事件类型或 DTO 字段（`team` 段与 `members[].durationMs` 在 trace 契约中本就声明为可选）；`cost_summary` 不属于瞬态事件，随 `runs/<runId>.jsonl` 落盘，断线重连 replay 可读。

---

## 10. 复用的现成投影（零改动）

`TeamState.events` / `TeamMember.usage/status/summary/budgetExceeded/durationMs`、`SubagentResult`、`TeamBudgetAccumulator`、`projectTeamCostSummary`（内存态）、`eval-core` 的 gate/report/judge/calibration、`createPermissionGate`/`createPolicyState`/`createPresetPolicy`、`createBullBearRiskTeam`（mock 种子）。

**身份字段由真实 `agentLoop` 发射，mock 工具副作用不覆盖身份。** 具体口径：

- `agentId` / `parentId` / `label` / `role` / `modelId` 来自 `AgentLoopConfig.identity`（子代理由 `assembleSubagentConfig` 经 `deriveSubagentIdentity` 无条件装配，`pure.ts` 里**不存在**「有钩子才装配」的分支），由 `agent-loop.ts` 在四类边界事件（`agent_start` / `agent_end` / `turn_start` / `turn_end`）与 `llm_call` 采集入口读取；缺省兜底为根身份 `SUPERVISOR_AGENT_ID`。
- 评测里的 mock 只替换**工具副作用**与 **StreamFn**（adapter 位置）。mock 工具即便自己 emit 一份带别的 `agentId` 的事件，也**不参与**身份推导：归属键取自内核 emit 点，评测断言因此不可能被 mock 伪造成功。
- 因此 `teamPermissionInheritanceCorrectness` / `teamTokenAttributionToMember` 这类依赖归因的指标，其证据链是「真实 loop 发的身份 + 真实采集包出来的记录」；mock 只决定模型说了什么、工具做了什么，不决定「谁做的」。

**归因键的唯一边界（评测断言必须按这个口径写）**：`agentId` 之外的三个计数各自有各自的唯一性——
  - `sequence`：**整个 run 唯一**，是跨 agent 配对事件与投影（如 Trend 柱列、`context_event` ✂ 定位）的唯一键；
  - `callIndex`：**per agent 从 1 起**（子代理与主线程各持一条 `agentLoop` 链、各一条采集 wrapper），Team run 内**会重号**，只能在 `agentId` 内比较；
  - `turnIndex`：**per agent 从 0 起**（`agentLoop` 每个实例的首个 `turn_start` 恒为 `0`），Team run 内同样**会重号**——supervisor / researcher / spawn-agent 可以同时存在 `turnIndex: 0`。**Turn 的唯一键是 `(agentId, turnIndex)` 这一对，不是单独一个 `turnIndex`**（web 侧 `trace-spans.ts` 的 `turnKey` 即按此编码）。

  评测里任何「按 turn / 按调用」的分组或计数都必须带上 `agentId`；用裸 `turnIndex` 或裸 `callIndex` 做键会在 Team case（`dispatch` / `concurrency`）上把两个 agent 的回合合并成一条，指标会静默偏高而不是报错。

---

## 11. 明确不做

- 不改 `agent-loop.ts` 的控制流（team 复用内核，评测不侵入）。**唯一的显式例外**：v2.0 按 docs/v2.0/04 §1.3 给 `AgentEvent` 的四类边界事件补了身份字段（`AgentLoopConfig.identity` + `SUPERVISOR_AGENT_ID` 兜底 + `turnIndex`），纯增量、不改任何分支判定——本文件 §10 的「身份字段随真实 agentLoop 发射」正是它的直接后果。
- 不把 team 投影/匹配算法放 `eval-core`（保持内核零 `@aiagent/*` 依赖，对齐 `02` §2.2）。
- 不合并 `projectTeamCostSummary` 与 `run-service` 内联逻辑为「评测」，那是「重构」，但**建议在 v2.1 落地前先消 G-T1 双实现**。
- 不重建 Intent Router（编排决策由模型自主完成，评测以 run 事件为唯一事实源）。
