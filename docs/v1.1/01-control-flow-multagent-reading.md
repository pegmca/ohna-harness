# 带读路线：从 ReAct 内核到多智能体 / 记忆 / Goal（v1.1）

> 配套文档：`docs/v1.1/01-control-flow-multagent.md`（需求与行业速览）
> 参考实现：`https://github.com/badlogic/pi-mono`（pi-agent，简称 pi）
> 本路线按"由简入繁、复用内核"的顺序，把代码位置、设计思想、pi 对应物、学习检查点串起来。
> 读法建议：先通读一节的理论，再打开对应 `file_path:line` 读源码，最后回看该节的「学习检查点」。

---

## 0. 全局心智模型（先看这张图）

```
                         ┌─────────────────────────────────────────┐
   用户 / 编排层          │  AgentLoopConfig（钩子切片 = 全部可插拔边界） │
   （组装 config）         │  convertToLlm · transformContext ·          │
                         │  beforeToolCall · afterToolCall ·           │
                         │  prepareNextTurn · shouldStopAfterTurn ·    │
                         │  getSteeringMessages · getFollowUpMessages  │
                         └───────────────────┬───────────────────────┘
                                              │ 注入
                                              ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  agentLoop / agentLoopContinue  （纯函数双循环内核，零改动）          │
   │  runLoop: 内层(turn: 思考→工具→回喂) → 外层(follow-up 续跑)          │
   │  错误即数据 · 事件流 · token 预算 · 结构化错误兜底                    │
   └──────────────────────────────────────────────────────────────────┘
        ▲                 ▲                    ▲                ▲
        │                 │                    │                │
   P4 Goal 守卫     P1 Context 装配       P3 多智能体          P5 规划+反思
   (挂钩子)         (transformContext)   (agentLoop 作 subagent) (挂钩子)
   P2 记忆层         (prepareNextTurn/    TeamCreate/SendMessage
   (afterToolCall    afterToolCall 注入)  消息总线
    写回/检索)
```

**一句话**：`agentLoop` 是已经做好的"最难的控制流内核"（纯函数双循环 + 事件流 + 错误即数据 + 全钩子挂载点）。v1.1 的所有新能力（P1–P5）都只是**在外层组装 config / 把 `agentLoop` 当子 Agent 原语复用**，内核一行没改。这正是本仓库相对多数框架最值钱的地方。

---

## 1. 起点：ReAct 控制流内核（必读，最值钱）

**读什么**
- `packages/agent/src/agent-loop.ts`
  - `agentLoop` / `agentLoopContinue`：外壳，创建事件流、起 `runLoop`（`agent-loop.ts:46`、`agent-loop.ts:82`）。
  - `runLoop`（双循环）：`agent-loop.ts:186` 起。内层处理 toolCall 与 steering，外层在可停止时查 `getFollowUpMessages` 续跑。
  - 钩子调用点（这是后面所有 P1–P5 的"插座"）：`transformContext` `agent-loop.ts:306`、`shouldStopAfterTurn` `agent-loop.ts:269`、`prepareNextTurn` `agent-loop.ts:254`、`getFollowUpMessages` `agent-loop.ts:278`。
  - 错误即数据：`stopReason === "error" | "aborted"` 时直接 `agent_end` 收尾（`agent-loop.ts:226`），不抛异常。
- `packages/agent/src/types.ts`
  - `AgentLoopConfig`（`:127` 起）：把所有挂载点集中定义。读懂这个接口，就懂了"控制逻辑外置"的全部维度。
  - `AgentEvent`（`:185` 起）：生命周期事件契约（`agent_start/end`、`turn_start/end`、`message_*`、`tool_execution_*`）。

**pi 对应物**：`badlogic/packages/agent/src/agent-loop.ts` 的 `runLoop()`（`:155`）几乎同构；钩子清单见 pi 的 `AgentLoopConfig`。pi 的差异点（本项目裁剪）：用 `zod` 替代 typebox 校验参数；工具执行拆到 `tool-execution.ts`。

**学习检查点**
- 为什么说"纯函数双循环"是难点？因为它把副作用（stream / tool / hook）全部通过 `AgentLoopConfig` 注入，loop 本体无状态、可测试、可复用。
- `agentLoopContinue`（`agent-loop.ts:82`）为什么能"续跑/重试"？它不追加 prompt，直接进 `runLoop`——这正是 P4 Goal 跨轮持续工作的底层能力（类 `/fork`）。
- 事件流 `EventStream` 既是 async-iterable 又能 `await result()` 拿终值（pi `packages/ai/src/utils/event-stream.ts`）。

---

## 2. P1 系统化 Context Engineering（分层上下文装配）

**读什么**
- `packages/agent/src/context-assembly.ts`
  - 四层模型：system prompt / 工作记忆 / 检索记忆 / compaction 摘要（文件头注释 `:1`）。
  - `DEFAULT_CONTEXT_BUDGET`（`:51`）、`ContextBudgetSettings`（`:36`）：token 预算分级（low/medium/high 占可用窗口比例）。
  - `limitContextByBudget`（`:194`）：预算内保留记忆、超预算整块丢弃。
  - `createContextAssemblyTransform`（`:292`）：返回可直接挂 `transformContext` 的函数——**返回新数组、不原地改**，且保留 `CompactionMessage`（见 `convert.ts`）。
- 关联：`packages/agent/src/compaction.ts`（`estimateContextTokens` `:71`、`shouldCompact` `:103`、`prepareCompaction` `:134`、`compact` `:180`）是 P1 的"压缩摘要"那一层。

**pi 对应物**：pi 的 `harness/compaction/compaction.ts` 的三层管线（`transformContext → convertToLlm → Context`），及其结构化摘要模板 `SUMMARIZATION_PROMPT`（含 `## Goal / ## Progress / ## Key Decisions / ## Next Steps`）——我们此处用 fenced 区块（`[工作记忆]`/`[检索记忆 N]`）对齐该思想。

**解耦要点**：P1 **不 import 任何 memory 包**，只接受 `getWorkingMemory` / `retrieveMemory` 两个 provider 回调。这样 P1（装配）与 P2（记忆）在"组装 config"时组合，互不耦合。

**学习检查点**
- 为什么 context 要"分级"？Anthropic 2025.6 起把"Context Engineering"取代"Prompt Engineering"——上下文是稀缺资源，要体系化装配 + 预算守口。
- 为什么 `transformContext` 必须返回新数组？因为它的值只用于当次 LLM 调用、不被写回持久历史（对比 P2 早期一个 bug：在 `prepareNextTurn` 里原地 `unshift` 会让记忆块逐轮累积污染对话——已改为 transformContext 修正）。

---

## 3. P2 长期记忆层（独立包 `@aiagent/memory`）

**读什么**
- `packages/memory/src/types.ts`
  - `EpisodeMemory`（`:21`）、`RetrievedMemory`（`:42`）、`WorkingMemory`（`:61`）、`MemoryStore` 接口（`:74`）：三层记忆（短期/长期/语义）的类型契约。
  - `MemoryMessage`（新增，`:16` 附近）：与 agent 包 `AgentMessage` 结构等价，但**不反向依赖 `@aiagent/agent`**——避免包级依赖环。
- `packages/memory/src/hooks.ts`
  - `createMemoryRetrieveHook`（结构兼容 `transformContext`）：每轮把 top-k 检索记忆以**前导 user 消息**注入当次 LLM 调用（瞬时、不污染历史）。
  - `createMemoryWriteHook`（结构兼容 `afterToolCall`）：把成功工具结果写回为 `EpisodeMemory`（纯副作用，返回 `undefined` 不覆盖工具结果）。
- `packages/memory/src/in-memory-store.ts` / `jsonl-store.ts` / `store-factory.ts`：两种持久化（内存 / JSONL 文件，零外部依赖）。
- `packages/memory/src/similarity.ts`：`cosineSimilarity` / `jaccardSimilarity`——**本地 TF 余弦替代向量库**，是学习级占位（接口不变，未来可换 PG + pgvector）。

**pi 对应物**：pi 没有语义/向量记忆；它的"长期记忆"= **append-only 会话树 + compaction/branch_summary 条目**（`packages/agent/src/harness/session/session.ts` 的 `buildContext`）。启示：先有可靠压缩与会话树，再谈检索。我们此处用 JSONL 落盘对齐 pi 的 JSONL 后端（`packages/storage/sqlite-node/.../001_initial.sql`）。

**学习检查点**
- 跨会话记忆为什么是生产级分水岭？PG 线性消息只是真相源，缺语义/情节记忆就无法跨会话积累知识。
- 为什么 memory 包不反向依赖 agent？AGENTS.md 的硬规则：值依赖单向、包级不能成环；`import type` 不受此限但运行时符号必须单向。
- 已知限制：本包 hook 与 `AgentLoopConfig` 的结构兼容是"运行时 duck typing"，未加编译期集成测试（避免引入 agent→memory 依赖）。集成层组装 config 时自行确认形状即可。

---

## 4. P3 多智能体 Supervisor 编排（复用 `agentLoop` 作 subagent 原语）

**读什么**
- `packages/agent/src/team-controller.ts`（barrel）→ `packages/agent/src/team/controller.ts`
  - `createTeamController`：维护 `TeamState`（成员表 name/role/status、每成员 inbound 队列、`run_events` 投影）。
  - `runMember`（`team/controller.ts:160` 附近，**已修正**）：每个子代理 = **一次独立 `agentLoop([task], subContext, ...)`**——天然独立 `context.messages` + 独立 EventStream + 独立 token 预算；只把"摘要 + 产物引用"回写 team 状态（上下文隔离 + 摘要回收）。
  - `team/tools.ts`：`TeamCreate(name, role, tools, model)` 与 `SendMessage(recipient, content)` 两个 `AgentTool`，注册进 supervisor 的 `context.tools`——由 model 自行决定何时 spawn / 委派 / 汇总。
  - `team/presets.ts`：`createBullBearRiskTeam`——落地 roadmap 阶段五的 bull/bear/risk 评审（角色化 system prompt + 只读工具最小化）。
  - `team/pure.ts`（L1 纯函数投影层，docs/v2.0/03-team-eval.md §6.1）：`extractSummary`（摘要回收）/ `classifyAborted`（失败隔离判定）/ `assembleSubagentConfig`（子代理 config 静态装配 + 权限继承通道）。三条编排机契约的逻辑正确性在此零模型、零 IO 地断言；`controller.ts` 只保留运行期副作用（状态回写、护栏触发标记）。
- 关键纪律：**`agentLoop` 控制流零改动**；唯一显式例外是 v2.0 为边界事件补身份字段（`AgentLoopConfig.identity` + `SUPERVISOR_AGENT_ID` 兜底 + `turnIndex`），纯增量、不改任何分支判定（docs/v2.0/04 §1.3）；子代理失败以结构化 error 回传 supervisor，主循环不崩（失败隔离）。

**pi 对应物**：pi 的多智能体是"子进程委派"（每个 subagent 跑独立 `pi` 进程 + JSON 行协议，`packages/coding-agent/examples/extensions/subagent/`）；其 `mapWithConcurrencyLimit`（`:219`）是并发受限 worker 池范式。我们此处是单进程拓扑，先把"隔离上下文 + 消息总线"跑通，未来可丢进 `05-P1` 的 worker 队列做真后台并发。

**设计三原则（Claude Code Subagent 思想）**
1. **上下文隔离**：子代理独立 `context.messages`，主上下文只回收摘要（subagent 第一性价值）。
2. **工具/权限最小化**：子代理只拿所需工具子集（如评审代理只读工具，`disallowedTools` 收口）。
3. **成本路由**：轻任务小模型、重分析大模型，supervisor 派发时决定 `model`。
4. **消息总线而非共享内存**：跨 agent 只走显式 `SendMessage`（可 replay / trace / 审计，失败隔离）。

**学习检查点**
- 为什么 `runMember` 把任务**只**通过 `agentLoop` 的 `prompts` 注入一次？（回归点：早期 bug 是 `subContext.messages` 和 `prompts` 同时塞了任务，导致子代理上下文里任务重复。）`agentLoop` 会把 prompt 并入 `context.messages`，所以子上下文初始化为空即可。
- 为什么这是"低成本亮点"？`agentLoop` 本身就是现成的 subagent 原语，TeamCreate/SendMessage 全走已有 `RunEvent` 边界，比 pi 的 `agent-*.jsonl` 更规整。

---

## 5. P4 Goal 模式（目标守卫，依赖倒置判定器）

**读什么**
- `packages/agent/src/goal-controller.ts`
  - `GoalJudger` 接口（`:74`）：判定器抽象；两种实现 `createCommandJudger`（跑命令看退出码，`:147`）、`createLlmJudger`（一次 `streamSimple` 自检返回 JSON，`:196`）。
  - `createGoalController`（`:279`）：返回 `hooks`（挂 `shouldStopAfterTurn` / `getFollowUpMessages` / `prepareNextTurn`），调用方 `{ ...config, ...controller.hooks }` 即可。
  - `shouldStopAfterTurn`（`:318`）：达成→true；`maxTurns` 预算→强制停（避免烧 token 无限循环）；判定器异常兜底为"未达成"（结构化兜底，不升级成硬错误）。
  - `getFollowUpMessages`（`:354`）：未达成时推回一条 meta 用户消息，形成"判定未达成 → 继续"闭环。

**pi 对应物**：pi 没有显式 `/goal`，但 `stopReason` + `shouldStopAfterTurn` + `getFollowUpMessages` 承担了"何时停 / 外部继续驱动"。Claude Code 2026 的 `/goal` 是"设完成条件、跨轮次持续工作直到满足"——本实现即对齐该思想。

**学习检查点**
- 为什么"控制逻辑外置到 config 层、loop 内核零改动"值得作为工程纪律讲？`shouldStopAfterTurn`/`getFollowUpMessages` 钩子**已经是"目标守卫"的最小原语**，只需上层 `GoalController` 把自然语言 goal 编译成可判定器。
- 依赖倒置：新增判定器只需实现 `GoalJudger` 接口（命令断言 / LLM 自检 / 未来任意），`GoalController` 不依赖具体实现。

---

## 6. P5 Plan-and-Execute + Reflexion（规划 DAG + 自评估重试）

**读什么**
- `packages/agent/src/plan-reflexion.ts`（barrel）→ `plan-reflexion/planner.ts` 与 `plan-reflexion/reflexion.ts`
  - `createPlanner`（planner.ts `:434`）：在 `agentLoop` **之前**用一次 LLM 调用把目标拆成子任务图 `Plan`（`parsePlanFromModel` `:255`）。解析失败结构化降级为单子任务计划（`createFallbackPlan`），**绝不抛错**。
  - `createReflexionHook`（reflexion.ts `:486`）：复用 `shouldStopAfterTurn` / `prepareNextTurn` 做"自评估→重试"闭环；每轮一次 `streamSimple` 自评，不满意且预算未耗尽时 `prepareNextTurn` 把 `[反思]` 自评注入下轮（新建数组，不原地改）。
  - **组合性**：`baseShouldStop` / `basePrepareNextTurn` 委托——满意/预算耗尽后把停止/续跑决策交回下游（如 P4 Goal），不覆盖其预算逻辑。

**pi 对应物**：pi 的结构化摘要模板（`## Progress` / `## Next Steps`）即"规划 + 反思"思想的雏形；2026 强 Agent 普遍 **Plan-and-Execute + ReAct + Reflexion** 组合而非单模式。

**学习检查点**
- 为什么反思本身不驱动"下一轮"触发？loop 内核只在模型发工具调用或有 pending/follow-up 消息时续跑；与 P4 Goal 叠加时，反思注入自然落入续跑轮次，形成"目标守卫 + 反思修正"组合范式。
- 反思 LLM 调用失败一律按"满意/中性"处理（结构化兜底）——绝不拖垮主循环。

---

## 8. 最小可演示路径（动手顺序建议）

1. `pnpm --filter @aiagent/agent test` 看全部 58 个用例（含 P1/P3/P4/P5 行为 + 回归保护）。
2. `pnpm --filter @aiagent/memory test` 看 8 个记忆用例。
3. 想看多 Agent 评审：写一个小脚本 `test/` 用 `createBullBearRiskTeam` + mock `streamFn`，观察 team 状态投影与摘要回收。
4. 想看 Goal：用 `createGoalController({ judger: createCommandJudger({ command: "npm test" }) })`，把 `hooks` 并入一个 `agentLoop` config，观察"未达成→续跑→达成停"。
