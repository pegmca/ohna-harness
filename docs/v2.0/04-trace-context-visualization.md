# v2.0 · ohna-web 运行轨迹与上下文/Token 可视化改造方案

> 状态：v2.0 规划 · 唯一权威文档（取代 docs/v1.4/02-web-llm-trace.md、docs/v1.4/03 的 Trace 章节、docs/v1.4/07 的 Trace 视觉描述）。
>
> **范围决策**：本方案对**代码与已落盘数据均不追求向后兼容**——旧事件、旧 DTO、旧投影、旧组件直接删除重建，不留 migrator / 兼容壳（对齐 `02-eval-system-v2.md` 的研发约束）；v2.0 上线时 `runs/*.jsonl` 历史数据直接删除，web 投影层按「所有可回放记录均为 v2.0 形状」的简化假设编写，**不做缺失字段降级分支**。唯一例外见 §1.1：`composition` / `agentId` 在错误路径下于采集时刻物理上不存在，按可空建模——这是类型契约忠实运行时事实，与兼容无关。
>
> **架构基线**：沿既有「内核出挂载点、serve 计算」模式——`packages/agent` 只提供观测钩子（StreamFn 包装、`onSubagentEvent` 转发回调），所有事件发射、sequence 分配、落盘归 `packages/serve`。本方案为 Team 子代理生命周期事件补齐同类钩子（§2），不发明新发射机制。
>
> **目标**：把 ohna-web 的 Trace 从「扁平的排查列表」升级为「可探索的运行执行地图 + 上下文/Token 可视化」，对齐 `bowenliang123/dsh-context` 的「Context Trend / Context Events / Current Context / Fleet」四类能力，但**只做运行级**（单次 run 的窗口演化与成本），不做跨会话的 Insights 聚合页（那是另一个产品面，见 §9 开放项）。

---

## 0. 现状盘点（全部经实跑核实）

| 能力 | 现状 | 结论 |
|---|---|---|
| LLM 调用级 token/成本采集 | `LlmCallRecordDto` + `LlmCallUsageDto`（input/output/cacheRead/cacheWrite/cost）已采集并落盘，`LlmCallBlock` 已展示 | ✅ **已具备，是地基** |
| provider 实际 token | `usage.input/output/cacheRead/cacheWrite` 来自 provider 回报 | ✅ 已具备 |
| 成本费率 | `@aiagent/ai` 的 `Model.cost: ModelCost`（美元/百万 token），`calculateUsageCost` 收尾换算 | ✅ 服务端已具备，web 未透出 |
| 模型上下文窗口 | `Model.contextWindow: number`、`Model.maxTokens: number` | ✅ 服务端已具备，web 未透出 |
| token 估算器 | `estimateMessageTokens`（`@aiagent/ai`） | ✅ 可复用 |
| 每次请求的组装内容 | `LlmCallRequestDto.systemPrompt / messages / tools`（convertToLlm 之后的最终形态） | ✅ 已具备（= "Context Browser" 的原始材料） |
| Team 子代理 LLM 调用 | 子代理与主线程共用同一 traced StreamFn + 共享 counter（`createLlmTraceStreamFn` 的 S1 共享计数），`llm_call` 记录已从子代理流出 | ✅ 已具备 |
| Team 子代理生命周期事件 | `team/controller.ts` 的 `runMember` 在函数内部消费完整个子 `agentLoop` 流（只提取 `agent_end.error` 与结果），`agent_start/turn_*/agent_end` **从不逃出 runMember**，不会出现在 run-v2 事件流 | ❌ **缺**（缺口 A：需转发钩子，见 §2） |
| serve 托管 run 的 Team 接线 | `run-manager.ts` 只跑单层 `agentLoop`；Team wiring 目前仅存在于 CLI（`apps/ohna-cli/src/runtime/team-wiring.ts`） | ❌ **缺**（缺口 B：serve 无 TeamController，web 端 Team 场景不可达） |
| 每类别 token 构成 | **无**——只有整段 input 总数，没有 system/tools/user/assistant/toolResult 五分类 | ❌ **缺**（缺口 1） |
| 窗口占用百分比 | **无**——web 拿不到 `contextWindow` | ❌ **缺**（缺口 2） |
| 上下文事件 | **无**——compaction 只在会话消息流里是 `messageType:"compaction"`，从未作为 run 事件发射。发射点归 serve：`RunManager.createRun` 在 run 前会话级压缩**真的发生**（`compacted === true`）时经 `run/context-event.ts` 投影发射 `context_event`，位置在 `user_message` 之后、`agent_start` 之前（可 replay）；web 侧 `trace-context.ts` 的 `buildContextEvents` 只做投影，不派生、不重估压缩前后的 token | ❌ **缺**（缺口 3：发射点在编排层，见 §3） |
| 跨 Agent 归因 | `agent_start` 是 `{ type:"agent_start" }`（`packages/agent/src/types.ts`）；`LlmCallRecordDto` 无 `agentId`；`StreamFn` 签名无身份通道 | ❌ **缺**（缺口 4） |
| 执行轨迹投影 | `trace-projection.ts` 保留 message/tool/llm/terminal 四类行并**逐行打 `agentId`**；`trace-spans.ts` 按键归属 Agent/Turn 森林（W3 已落地） | ✅ 已具备 |
| 成长曲线 / 堆叠条可视化 | `ContextComposition`（五分类堆叠条 + reserve/maxTokens 斜纹掩码）/ `ContextTrend`（per-call 柱 + ✂ 定位）/ `ContextEvents`（compaction chip） | ✅ 已具备（W3） |
| 口径标注（估算 vs 实际） | 三面板共用 `CONTEXT_ESTIMATE_NOTE`（写明 chars÷4 对 CJK 是**低估**）+ 实际用量取自 `response.usage` | ✅ 已具备（W3） |
| run 事件枚举双套 | `RunEventTypeDto`（`packages/types/src/run-v2.ts`）与 `RunEventType`（`packages/trace/src/index.ts`）是两份独立枚举，任何新增 kind 必须**三处同步**（两枚举 + serve 侧类型窄化映射） | ⚠️ 已知约束，落地清单须显式列出 |

**一句话结论**：Token/成本/窗口的**原始数据几乎全在**（子代理的 `llm_call` 也已在总线上），真正缺的是四条管线——「子代理生命周期事件转发」「serve 的 Team 接线」「每类别 token 构成采集」「上下文压缩事件发射」，以及「成长曲线 + 编队森林」这层可视化。

---

## 1. 目标数据模型（clean-sheet，直接重建）

### 1.1 `LlmCallRecordDto` 扩展（packages/types/src/llm-trace.ts）

在现有字段之上**新增**三个字段。`composition` / `agentId` 可空——错误路径（`base()` 同步 throw、流提前结束、abort）下二者在采集时刻可能尚未产生；`window` 必填（构造 wrapper 时即由 serve 注入，与请求成败无关）：

```ts
/** 单次 LLM 请求的窗口构成快照（五分类 token 数，分块估算口径，见 1.4）。 */
export interface LlmCompositionDto {
  system: number;      // 系统提示词
  tools: number;       // 工具 schema（name + description + inputSchema）
  user: number;        // 用户消息正文（含记忆/检索/skill 等注入内容——注入后与普通 user 消息在最终形态上不可区分，统一并入本类）
  assistant: number;   // 历史 assistant 回复
  toolResult: number;  // 历史工具结果
  total: number;       // 五项之和
}

/** 窗口参数（随每次调用落盘，是 Trace 面板的单一事实源；对齐 @aiagent/ai 的 Model）。 */
export interface LlmWindowDto {
  contextWindow: number;  // 模型全窗口
  maxTokens: number;      // 输出预算（contextWindow 之外的输出窗）
  reserveTokens: number;  // 压缩预留（compaction settings，注入点见 3.2）
}

export interface LlmCallRecordDto {
  // ...既有字段不变...
  /**
   * 发起本次调用的 agent 身份（跨 Agent 归因锚点）。
   * 可空：错误路径下请求未到达 onPayload；缺省归 supervisor 根节点。
   */
  agentId?: string;
  /**
   * 窗口构成快照（采集层在 onPayload 现算，见 1.4）。
   * 可空：同上，错误早退时可能尚未计算。
   */
  composition?: LlmCompositionDto;
  /** 窗口参数（serve 构造 wrapper 时注入，必填）。 */
  window: LlmWindowDto;
}
```

**为什么在采集层算、而不是 web 现算**：`createLlmTraceStreamFn` 已在「构造请求体之后、发 POST 之前」的 `onPayload` 拿到最终 context（`llm-trace.ts`），此时 systemPrompt/messages/tools 三者齐全；在这里一次性算好 composition，web 只做展示，不重复推导、也不依赖任何估算器。

**分类学说明**：dsh-context 的六分类（含 inject/skill 独立成类）建立在「组装前采集」的前提上；本方案采集发生在 convertToLlm **之后**的最终 LLM 消息形态，注入内容与普通 user 消息在此层级不可区分。因此降到五类——这是层级错配下的诚实选择，注入内容的独立归因需要前置到 context-assembly 层打 provenance 元数据，列为开放项（§9）。

### 1.2 agentId 注入通道：`SimpleStreamOptions` 观测字段

`StreamFn` 签名 `(model, context, options)` 没有身份通道。方案在 `@aiagent/ai` 的 `SimpleStreamOptions` 增加一个**可选观测字段**（不进 provider 请求体，adapter 层忽略）：

```ts
// packages/ai —— SimpleStreamOptions 扩展
export interface SimpleStreamOptions {
  // ...既有字段不变...
  /** 观测扩展：调用方（TeamController / RunManager）注入的 agent 身份，采集层读取。 */
  observer?: {
    agentId?: string;
  };
}
```

- `createLlmTraceStreamFn` 在 `onPayload` 读取 `options.observer?.agentId` 写入 `LlmCallRecordDto.agentId`。
- Team 场景：`runMember` 给子 `agentLoop` 传 subConfig 时同时把 streamFn 包装为「补 observer 字段」的薄转发（外层仍是同一 tracedStreamFn 实例——`isTracedStreamFn` 防二次包装已处理这一点，转发器保持标记即可）。
- 改动集中在采集层，CLI/serve 通用，不穿三层签名、不污染 `Context`。

### 1.3 Agent 边界事件补身份（packages/agent）

`AgentEvent` 的边界事件补身份字段，发射处（`agent-loop.ts` 的 `runLoop`）填入当前 agent 身份：

```ts
// packages/agent/src/types.ts —— AgentEvent 边界事件补身份
| { type: "agent_start"; agentId: string; parentId?: string; label: string; role: string; modelId: string }
| { type: "agent_end"; agentId: string; messages: AgentMessage[]; error?: AgentLoopError }
| { type: "turn_start"; agentId: string; turnIndex: number }
| { type: "turn_end"; agentId: string; turnIndex: number; message: AgentMessage; toolResults: ToolResultMessage[] }
```

- `agentLoop` 的 `AgentLoopConfig` 增加 `identity` 字段（agentId/parentId/label/role），supervisor 与 controller 两侧都显式传，不再隐式缺省。
- `team/controller.ts` 的 `runMember`：把 `member.{name, role, model.id}` 作为 identity 传入子代理的 `agentLoop`；子代理 `agentId` = `member.name`（已是 bus key，稳定），`parentId` = supervisor `agentId`。

### 1.4 composition 计算：分块精细估算

`estimateMessageTokens` 只覆盖单条 `Message`；systemPrompt 是纯字符串、tools 是 schema 对象，三类各有口径。**统一系数表**（全部为估算口径，图例固定脚注，见 §5.4）：

| 构成类 | 估算方法 |
|---|---|
| `system` | `systemPrompt` 字符串长度 ÷ 4（ASCII 主导假设；CJK 字符每字约占 1 token 甚至更多，按 chars/4 会**低估**中文的 token 数——注意是「token 被低估」，不是占比被高估；图例注明） |
| `tools` | 每个工具 `JSON.stringify({ name, description, inputSchema })` 长度 ÷ 4 |
| `user` / `assistant` | 按消息 content blocks 分块加权：文本块 chars ÷ 4；toolCall 块 `JSON.stringify` 长度 ÷ 4；其余块（image 等）按其 JSON 序列化长度 ÷ 4 |
| `toolResult` | 同上分块口径（toolResult 消息的 content blocks） |
| `total` | 五项之和 |

实现为 `packages/agent/src/llm-trace.ts` 内的纯函数 `estimateComposition(systemPrompt, messages, tools)`，可单测（固定输入 → 固定构成）。

**口径统一（缺口 6）**：composition 是估算（上述系数表），provider 回报的 `usage.input/output/cacheRead/cacheWrite` 是实际；web 展示时估算与实际并列、不强行对齐，估算用于「构成占比」，实际用于「总账」。三个面板共享同一份固定脚注文案，不各写一套。

### 1.5 实现落点与冻结约定（W1 已落地，后续工作项必须遵守）

> 本节记录 §1/§2 的实现确定值，防止后续工作项按草稿自行发挥。

- **`createLlmTraceStreamFn` 的签名是 `(base, sink, counter, options)`**：第 3 参仍是共享计数器（可传 `undefined`），第 4 参 `{ window: LlmWindowDto }` **必填**，无重载、无缺省兜底——要让缺省悄悄造一个假窗口，比编译期报错危险得多。所有调用方（serve `run-manager.ts`、CLI `runtime/observation.ts` / `runtime/turn.ts`）已同批改完。
- **`window.reserveTokens` 的唯一算法**：`resolveCompactionSettings(contextWindow).reserveTokens`（`@aiagent/agent` 导出），即与 run 前压缩共用同一函数，禁止另写一套预留口径。serve 与 CLI 两侧都用它。
- **`composition` 与 `agentId` 的可空时机不同**（§1.1 只说了「都可能为空」，实现上更精确）：
  - `composition` 依赖 adapter 回灌最终 context（onPayload），**仅在到达 onPayload 后存在**；
  - `agentId` 是**发起方属性**，在 streamFn 调用入口读取 `options.observer`，因此**同步 throw 的错误记录同样带 agentId**——否则 Trace 森林里会出现一批无主的失败调用。
- **`observer` 不写入任何落盘/请求体字段**：只存在于 `options`，adapter 零改动。
- **身份常量**：`SUPERVISOR_AGENT_ID = "supervisor"` 由 `@aiagent/agent` 导出；`AgentLoopConfig.identity` 缺省时 agentLoop 兜底为该根身份（`modelId = config.model.id`），因此事件里 `agentId` 永远必填。
- **`turnIndex` 计数规约**：首个 turn 的 `turn_start` 由 `runAgentLoop` 在 `agent_start` 之后立即发出、`turnIndex = 0`；`runLoop` 内首个 `firstTurn` 分支不发事件，后续每次 `turn_start` 自增。`turn_end` 复用当前 turn 的序号。
- **`onSubagentEvent(event, identity)`**：`identity` 是 `Pick<AgentIdentity, "agentId" | "parentId">`；`parentId` 只在 `agent_start` 上有值（其余边界事件不含该字段）。回调抛错被吞掉。
- **serve / CLI 的 Team 接线（§7 第 1 步）不在 W1 范围**：本项只保证钩子存在且语义正确；observer 注入与 `context_event` 发射随各自工作项落地。

---

## 2. 子代理事件转发钩子（缺口 A + B 的解）

### 2.1 `onSubagentEvent` 转发回调（packages/agent）

`runMember` 目前在函数内部消费完子流（[controller.ts] 的 `for await`）。给 `TeamControllerOptions` 增加可选回调，让子代理的边界事件逃出 runMember：

```ts
// packages/agent/src/team/types.ts —— TeamControllerOptions 扩展
export interface TeamControllerOptions {
  // ...既有字段（beforeToolCall 等）不变...
  /**
   * 子代理事件转发钩子：runMember 消费子 agentLoop 流时，把边界事件
   * （agent_start/end、turn_start/end）透传给宿主。宿主（serve / CLI）负责
   * 打 sequence、落盘、广播——内核只出挂载点，不算任何东西。
   */
  onSubagentEvent?: (
    event: Extract<AgentEvent, { type: "agent_start" | "agent_end" | "turn_start" | "turn_end" }>,
    identity: { agentId: string; parentId?: string }
  ) => void;
}
```

- `runMember` 的消费循环里，匹配到这四类事件时**先透传回调再继续本地投影**；`message_*` / `tool_execution_*` **不转发**（控制 JSONL 体积与 SSE 流量；子代理的 LLM 调用已通过共享 tracedStreamFn 以 `llm_call` 记录流出，不受此限）。
- 回调抛错被吞掉（同 `LlmTraceSink` 语义：转发链路故障不得打断子代理）。
- 事件已带 `agentId`（§1.3），`identity` 参数为冗余保险（防未来事件形状漂移）。

### 2.2 serve 托管 run 接入 TeamController（缺口 B）

`RunManagerOptions` 增加团队装配，让 web 端 Team 场景可达：

1. **团队工具注册**：`run-manager.ts` 在装配工具集时注册 Team 的 spawn/teammate 工具（复用 `packages/agent/src/team/tools.ts`），`TeamControllerOptions.beforeToolCall` 接现有 `createPolicyState` + `createPermissionGate` 产物——子代理与主线程共用同一权限闸门（K3 策略继承机制已就绪）。
2. **事件接线**：`TeamControllerOptions.onSubagentEvent` 接到 run 事件 sink——`emitTypedFrame(run, 事件.type, { ...事件, agentId, parentId })`，与主线程事件共用同一 sequence counter（`emitFrame` 已保证 sink 同步契约下 sequence 单调）。
3. **observer 注入**：子代理 streamFn 薄转发补 `observer.agentId`（§1.2）；主线程 `agentLoop` 调用传 `observer: { agentId: supervisorId }`。
4. **CLI 对齐**：`apps/ohna-cli/src/runtime/team-wiring.ts` 同步接同一回调（CLI 单一形态下执行走 serve `createRun`，Team wiring 逻辑上移到 serve 后 CLI 只保留装配参数）。

### 2.3 跨度归属原则：按键归属，不按 sequence 区间切割

子代理事件与主线程事件**共用同一 sequence 序列且必然交错**（子代理运行嵌在主线程工具执行之间），因此：

- `TurnSpan` 按 `(agentId, turnIndex)` **键归属**事件；`[startSeq, endSeq]` 仅作展示参考（首尾锚点），不作区间切割依据。
- `trace-projection.ts` 的扁平行**按 payload 里的 agentId 归属打标**（message/tool/llm/terminal 四类行语义保留，新增 `agentId` 字段——见 §4.1）；未打标的行归 supervisor 根节点。
- `TraceTeamCards` 的「运行中绿点 / 点击滚动」直接消费 agent 级 span，不依赖区间推导。

---

## 3. 上下文事件管线（缺口 3：compaction-only，发射点在编排层）

### 3.1 事件类型与 payload

`RunEventTypeDto`（`packages/types/src/run-v2.ts`）与 `RunEventType`（`packages/trace/src/index.ts`）**两处同步**新增：

```ts
| "context_event"
```

payload 收敛为 compaction 单 kind（`prune/inject/mode/model_switch` 对应的运行时动作当前不存在——模型在 run 创建时固定、记忆/检索无统一注入点，列入 §9 开放项，待管线存在再扩枚举）：

```ts
/** 上下文结构变化事件（v2.0 仅 compaction：run 前会话级压缩）。 */
export interface ContextEventPayloadDto {
  kind: "compaction";
  tokensBefore: number;   // 压缩前会话 token（run-manager 已有该数据）
  tokensAfter: number;    // 压缩后 token（净回收量自解释）
  detail?: string;        // 可读说明（摘要长度、保留轮数等）
}
```

### 3.2 发射点：RunManager.createRun（不在内核）

`compaction-enforce.ts` 是纯函数（输入 messages、输出 result），没有 sink、没有 run 上下文——**保持纯净，不加重载**。实际的会话级压缩调用点在 `RunManager.createRun`（`compactHistoryForRun`，`run 前会话级 compaction` L3-3），`tokensBefore/After` 就在其返回值里：

- `RunManager.createRun` 在 compaction 实际发生（非空压缩）时，`emitTypedFrame(run, "context_event", payload)`。此时 run 事件流已开始发射（agent_start 之前），sequence 正常分配。
- 同一调用点的 `resolveCompactionSettings(model.contextWindow)` 现算产物 `reserveTokens`，在同一处作为 `createLlmTraceStreamFn` 的构造参数注入——**构造顺序依赖**：`compactHistoryForRun`（拿 reserveTokens）必须先于 tracedStreamFn 构造，当前代码顺序已满足。

---

## 4. 存储与 SSE

- `run-store.ts` 的 `TRANSIENT_EVENT_TYPES` 只含 `message_update`；`context_event`、扩展后的 `llm_call`、补身份的 `agent_*/turn_*` **自动落盘并可 replay**。
- `run-manager.ts` 的 `emitTypedFrame` 原样透传 payload，`emitFrame` 只分配 sequence + 落盘 + 广播，**不感知 payload 形状**。
- 落地清单须显式确认三处同步：`packages/types/src/run-v2.ts`、`packages/trace/src/index.ts`、serve 侧任何 `type → handler` 的窄化映射；并确认 `context_event` 不在未来被误加进 TRANSIENT 集合。

---

## 5. Web 投影层与可视化表面（apps/ohna-web/src/features/trace/）

### 5.1 `trace-projection.ts`：保留四类行 + agentId 打标

message/tool/llm/terminal 四类扁平行是「细节排查」的最终形态，语义保留；每行新增 `agentId` 归属字段（来自事件 payload / `llm_call.agentId`，缺省归 supervisor 根节点）。`LlmCallBlock` 的 request/response/raw 三 tab 保留（它就是「Context Browser」的 raw 视图）。

### 5.2 新增 `trace-spans.ts`（纯函数，可单测）

```ts
/** Agent 跨度：按 agent_start/end 归属推导森林；sequence 只记首尾锚点。 */
export interface AgentSpan {
  agentId: string;
  parentId?: string;
  label: string;
  role: string;
  modelId: string;
  startSeq: number;
  endSeq: number;
  children: string[];
}

/** Turn 跨度：按 (agentId, turnIndex) 键归属事件；区间仅作展示参考。 */
export interface TurnSpan {
  agentId: string;
  turnIndex: number;
  startSeq: number;
  endSeq: number;
}

export interface TraceSpans {
  agents: Map<string, AgentSpan>;
  rootAgentId: string;
  turns: TurnSpan[];
}

export function buildTraceSpans(events: readonly RunStreamEventDtoV2[]): TraceSpans;
```

单 run（非 Team）退化为单 root 跨度，不破坏单智能体体验。

### 5.3 新增 `trace-context.ts`（纯函数，可单测）

从 `llm_call` 记录序列直接投影上下文可视化数据，**不重新估算**（composition 已在采集层算好）：

```ts
export interface ContextPoint {
  callIndex: number;
  agentId?: string;
  composition?: LlmCompositionDto;
  window: LlmWindowDto;
  actual: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: LlmCallUsageDto["cost"];
  startedAt: number;
  durationMs?: number;
}

export function buildContextPoints(events: readonly RunStreamEventDtoV2[]): ContextPoint[];
export function buildContextEvents(events: readonly RunStreamEventDtoV2[]): ContextEventPayloadDto[];
```

### 5.4 `use-trace-stream.ts`：增量归并 + memo 化（v2.0 一并做）

现状 `appendEvents` 每帧 `[...prev, event].sort()` 全量重投影——live 大 run（500+ 事件）每帧 O(n log n)。改造：

- **增量归并**：live 流 sequence 单调递增时免 sort 直接 append；replay 一次性装载可 sort；乱序回填（理论不应发生）才走归并路径。
- **memo 化**：`traceRows / traceSpans / contextPoints` 均经 `useMemo` 依赖 `events` 引用派生，append 复用上帧数组引用时下游 memo 自动命中。
- 验收条目「live 大 run 不卡」由此直接达成。

**Trace 数据单一事实源**：三面板与执行地图只读 run 事件（per-call `window` 已随 `llm_call` 落盘、可 replay）；`ModelOptionDto` 的窗口/费率扩展（见 §5.6）仅服务设置弹窗/模型选择器，**Trace 不读 `/api/models`**。

**消息级「开发者详情」入口移除（2026-10-26）**：assistant 消息内的「查看开发者详情」与 Trace 功能重复，已整体删除；消息只保留单行运行状态摘要，完整运行排查统一从头部的 Trace 开关进入抽屉（默认选中当前会话最新 run）。`RunDetailPanel` / `SelectedRunDetail` / `RunDetailSection`、消息级 `onOpenTrace` / `requestedRunId` 定位链路与 `has-detail-panel` 列位均已删除。消息时间线里仍内联渲染 thinking / toolCall 折叠块，供快速查看单条工具参数与结果。

### 5.5 可视化表面（复用 Glass Depths 令牌，不新增配色）

**Trace 执行地图（改造抽屉内部，维持右侧抽屉为家）**：

- `ExecutionRibbon.tsx`：step-brief（turn 数 / step 数 / llm 调用数 / 工具数 / 总耗时 / 状态徽标），复用 `.trace-summary-grid` + `.md-badge` + `runStatusBadgeClass`。
- `TurnGroup.tsx`：可折叠 `turn → [message/tool/llm/terminal]`，复用 `.trace-message/.trace-tool/.trace-llm/.trace-terminal`；**默认全部展开**；turn 标题 "Turn N"，失败加 `.trace-turn.is-failed` 左侧色条。**渲染预算**：500+ 事件 run 下默认展开的 DOM 量级需惰性渲染（`LlmCallBlock` 的 raw tab 含 `providerPayload` 全量 JSON，进入视口才挂载；复用 `JsonViewer` 的批量展开预算机制）。
- `TraceTeamCards.tsx`：成员玻璃小卡（label + role + 运行中绿点），复用 `.md-glass`；**点击高亮+滚动**至该 agent 跨度内行，不隐藏其他。
- `TraceDrawer.tsx` 仅编排：Ribbon +（仅 Team run）TeamCards + TurnGroup 列表；live 保留 `.trace-live-dot`，turn 级加 "● running"。

**上下文/Token 三面板（同抽屉内）**：

- **① Current Context** —— 五分类堆叠条，对照 `window.contextWindow`，尾部两个 hatch 掩码 = 压缩预留（`reserveTokens`）+ 输出预算（`maxTokens`）。数据源 = 最近一次 `llm_call` 的 `composition` + `window`。
- **② Context Trend** —— 每次 LLM 请求一根堆叠条（`ContextPoint[]`），按 `callIndex` 顺序横排；`context_event` 的 ✂（compaction）标记钉在对应位置，掉量自解释。
- **③ Context Events** —— `buildContextEvents` 的日志，compaction chip 带净 token delta 与说明。

三面板共享固定估算口径脚注（§1.4 系数表的一句话版本），复用 `.trace-` 类 + glass 令牌（`--md-glass-inspector` / `--md-glass-sunken`），强调色 `#89D7B7` 用于 live/active。

### 5.6 模型目录透出窗口与费率（仅设置 UI 通道）

`ModelOptionDto` 由「产品能力摘要」扩展为「含成本计量字段」（`packages/types/src/models.ts`；serve 侧 `createSingleModelCatalog` 投影 `model.contextWindow / maxTokens / cost`，数据就在 `RouteDeps["model"]`，零新增来源）：

```ts
export interface ModelOptionDto {
  id: string;
  label: string;
  provider: "deepseek" | "openrouter" | "bridge_ai" | "mock";
  description: string;
  isDefault: boolean;
  capabilities: { structuredOutput: boolean; toolCalling: boolean };
  // 新增：成本计量（不含凭据，纯费率与窗口，可安全下发给浏览器；仅服务设置弹窗/模型选择器）
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };  // 美元/百万 token
}
```

注意：mock/bridge 模型费率可能全 0 或部分缺失，设置 UI 按「缺失显示 —」处理（Trace 不消费此通道，无连带影响）。

---

## 6. 组件分解（apps/ohna-web/src/features/trace/）

沿用 colocated 目录 + barrel 模式，公共 API 不变：

| 文件 | 职责 |
|---|---|
| `trace-projection.ts` | 扁平行投影（保留四类行 + agentId 打标） |
| `trace-spans.ts` | Agent/Turn 跨度森林（新） |
| `trace-context.ts` | 上下文点/事件投影（新） |
| `use-trace-stream.ts` | 数据编排（增量归并 + 返回 spans/context） |
| `TraceDrawer.tsx` | 编排壳（Ribbon + 面板 + TeamCards） |
| `ExecutionRibbon.tsx` | step-brief 摘要（新） |
| `TurnGroup.tsx` | turn→step 分组（新，含视口惰性渲染） |
| `TraceTeamCards.tsx` | 编队森林小卡（新） |
| `ContextComposition.tsx` | Current Context 堆叠条（新） |
| `ContextTrend.tsx` | 窗口成长曲线（新） |
| `ContextEvents.tsx` | 上下文事件日志（新） |
| `LlmCallBlock.tsx` | LLM 调用细节（保留，作 Context Browser raw 视图） |

---

## 7. 落地顺序（每步独立 typecheck / build）

1. **serve Team 接线（前置工作项）**：`RunManagerOptions` 团队工具装配 + `beforeToolCall` 权限继承 + `onSubagentEvent` 接 run 事件 sink + observer 注入；CLI `team-wiring.ts` 对齐上移。这是 Team 可视化在 web 端可达的前提，先于一切类型工作落地。
2. **类型 + 采集（packages/types + packages/agent + packages/ai）**：`LlmCompositionDto`（五分类）/`LlmWindowDto`/`ContextEventPayloadDto`（compaction-only）、`SimpleStreamOptions.observer`、`AgentEvent` 身份、`AgentLoopConfig.identity`、`LlmCallRecordDto.agentId?/composition?/window`、`estimateComposition`（分块系数表）、`createLlmTraceStreamFn` 现算 composition + 带 window + 读 observer；`RunEventTypeDto` 与 `RunEventType` **两枚举同步**加 `"context_event"`。
3. **serve 发射**：`RunManager.createRun` 的 compaction 点 emit `context_event`（含 reserveTokens → wrapper 注入的构造顺序确认）；`createSingleModelCatalog` 投影 `contextWindow/maxTokens/cost`；删除 `runs/*.jsonl` 历史数据（上线动作，随本次发布）。
4. **web 投影**：`trace-spans.ts`（按键归属森林）+ `trace-context.ts` + `trace-projection.ts` agentId 打标 + `use-trace-stream.ts` 增量归并（含单测）。
5. **web UI**：执行地图（Ribbon/TurnGroup/TeamCards）+ 上下文三面板（Composition/Trend/Events）+ 渲染预算惰性挂载。
6. **文档同步**：更新 ARCHITECTURE.md、docs/v1.4/03、docs/v1.4/07 的 Trace/上下文相关章节，指向本文档。

---

## 8. 验证

- `pnpm typecheck` / `pnpm build`（每步）。
- 单测：
  - `estimateComposition`（分块系数表固定输入 → 固定构成）；
  - `createLlmTraceStreamFn`（composition 统计、window 带入、observer.agentId 读取、错误路径 agentId/composition 为空）；
  - `onSubagentEvent` 转发（四类事件透传、回调抛错不打断子代理、message_*/tool_* 不转发）；
  - `RunManager.createRun` 的 `context_event` 发射（compaction 触发时 tokensBefore/After 正确、未触发不发射）;
  - `trace-spans.ts`（按键归属森林：子代理事件与主线程事件交错时归属正确）；
  - `trace-context.ts`（composition/events 投影）；
  - `use-trace-stream.ts`（sequence 单调免 sort 增量归并）。
- 手动：跑一个带 Team + 触发 compaction 的 run，核对抽屉内「Current Context 占比 / Trend 掉量 ✂ / Team 卡高亮滚动」三处联动；再跑一个 500+ 事件的 live run 验证不掉帧。

---

## 9. 非目标 / 开放项（明确排除）

- **跨会话 Insights 聚合页**（KPI band / 7 天用量图 / activity heatmap / session cards）——属独立产品面，需跨 run 聚合与新的路由，不在本方案范围。
- **跨会话成本日历 / pricing 页**——同上。
- **per-attempt 多记录**（`LlmCallRecordDto` 现只记一次聚合）——dsh-context 也无，暂不做。
- **文件活动（File Activity）行级 diff**——可从 `tool_execution_*` 派生，属后续增强，非本方案核心。
- **注入内容独立归因（inject/skill 分类）**——需在 context-assembly 层给注入消息打 provenance 元数据并随 Context 传递，改动面大；待该管线存在后再把 `user` 类拆细。
- **`context_event` 的 `prune/inject/mode/model_switch` 扩展**——对应的运行时动作（mid-run 模型切换、统一记忆/检索注入点）当前不存在；待管线出现再扩枚举与 payload。
- **子代理 message_*/tool_* 转发**——v2.0 只转发生命周期 + llm_call；若 Events 视图需要子代理内部明细，再评估体积/流量代价。

---

## 10. 与既有 v2.0 文档的关系

- `02-eval-system-v2.md`：本方案新增的 `composition`/`context_event` 可作为评测的可观测断言源（「compaction 是否触发」「窗口构成是否合理」），但不反向依赖。
- `03-team-eval.md`：§1.3 的 Agent 身份发射与 §2 的转发钩子直接服务于 03 的「spawn 谁/派给谁」可观测性（`agent_start.parentId/label/role` 是可断言证据），需在 03 的 mock 边界章节补一句「身份字段随真实 agentLoop 发射，mock 工具副作用不覆盖身份」。
