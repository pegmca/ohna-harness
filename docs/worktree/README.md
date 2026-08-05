# 工程化改造总览：对齐 pi-mono 的 Agent 架构重构

本目录是一套面向实现的改造方案文档（01～07），目标是把本项目的 agent 内核从
"单轮意图路由流水线"重构为参照 badlogic/pi-mono 的 "多轮 ReAct loop + 统一 LLM 抽象"
架构。参照对象为 `https://github.com/badlogic/pi-mono`（badlogic/pi-mono 浅克隆），文中所有
pi 侧路径均已对照该仓库核实。

## 改造动机

### 现状：单轮三分支流水线

本项目当前 agent 内核在 `packages/agent/src/agent-loop.ts`（`runAgent`，约 867 行）：

1. `route_intent` 步调用 `createIntentRouter`（`packages/agent/src/intent-router.ts`）
   把用户消息分类为 `chat` / `explain` / `report_skill` 三种意图之一；
2. 按意图进入三个各自硬编码的分支（报告分支见 `agent-loop.ts:146` 起的
   `route.intent === "report_skill"`）；
3. 每个分支内部以"最多 N 步"的方式串工具调用和 LLM 调用，最后汇入
   `final_response` 收尾。

这个结构的根本局限：

- **模型不主导流程**。走哪个分支由意图分类器预先决定，LLM 不能在对话中自主决定
  "再查一次数据"还是"可以回答了"，多轮工具交互被压进分支内部的固定骨架里。
- **消息模型不统一**。意图、步骤、工具结果以 `AgentStep` / trace 事件表达，而不是
  统一的 `Message` 序列，导致上下文裁剪、压缩、续跑都要为每个分支单独发明。
- **LLM 调用面分散**。`packages/agent/src/llm-client.ts` 与 `reliability.ts` 自行封装
  chat 调用，没有 provider 差异归一化层，换模型/换 provider 成本高。

### 参照：pi 的多轮 ReAct loop

pi-mono 的内核是经典 ReAct（Reasoning + Acting）循环
（`packages/agent/src/agent-loop.ts`，`agentLoop` / `runAgentLoop`）：

- 每一轮（turn）调用一次 LLM；模型返回的 `AssistantMessage` 里若含 `toolCall`
  内容块，loop 就执行对应 `AgentTool`，把 `ToolResultMessage` 追加进上下文，
  然后开始下一轮；直到模型不再发起工具调用（或 `shouldStopAfterTurn` 判定停止）。
- 意图选择、工具选择、回答时机全部由模型在多轮中自主完成，没有预定义的意图分支。
- 上层通过 `transformContext` / `convertToLlm` / `beforeToolCall` / `afterToolCall` /
  `prepareNextTurn` / `shouldStopAfterTurn` 等 hook
  （`packages/agent/src/types.ts` 的 `AgentLoopConfig`）定制行为，而不是改 loop 本体。
- LLM 层由独立的 pi-ai 包承担：`stream` / `streamSimple`
  （`packages/ai/src/compat.ts:250,275`）屏蔽各 provider 差异，统一产出
  `AssistantMessageEvent` 事件流（`packages/ai/src/utils/event-stream.ts`）。

差距一句话概括：**本项目是"分类器选流水线"，pi 是"模型开循环"**。改造就是把前者
推倒，换成后者，并把本项目特有的能力（RAG grounding、report/workflow、MCP、eval）
作为工具和能力包挂回新 loop 上。

## 已确认决策（全套文档口径一致）

- **LLM 层完全按 pi-ai 改造**，内部命名与 pi 保持一致：`Message` / `UserMessage` /
  `AssistantMessage` / `ToolResultMessage`、`stream` / `streamSimple`、`compat`、
  `AssistantMessageEvent`、`EventStream`、`agentLoop` / `agentLoopContinue`、
  `AgentTool`、`transformContext` / `convertToLlm` / `beforeToolCall` / `afterToolCall` /
  `prepareNextTurn` / `shouldStopAfterTurn` 等。
- **会话存储**：线性消息表 + run 表，Postgres schema 推倒重来，不采用 pi 的 entry 树
  结构。Compaction 以一种特殊 message 类型落在线性表中。
- **彻底删除 approval/permission 体系**：executor 权限门、approval-repository、
  审批 HTTP API、相关 trace 事件、前端审批 UI 全部移除。`beforeToolCall` 仅作为
  观测 / block 的挂载点保留。
- **保留能力**：RAG 附件 grounding、report/workflow（含 PDF 导出）、MCP 工具接入、
  eval。工具继续用 zod 校验参数并保留超时/重试/deadline（schema 仍用 zod，接口形状
  对齐 pi 的 `AgentTool`）。
- 用户接受**完全不兼容**改造，不留旧接口兼容层。

## 目标架构分层

```text
┌─────────────────────────────────────────────────────────┐
│ apps/web                                                 │
│   Agent Chat UI：会话列表 / 时间线 / composer /           │
│   run 过程展开（assistant 消息派生，无右侧常驻栏）          │
└───────────────────────▲─────────────────────────────────┘
                        │ HTTP + SSE
┌───────────────────────┴─────────────────────────────────┐
│ apps/api（应用层）                                        │
│   会话/run API、SSE 推送、鉴权、用例编排、DTO 映射          │
│   组装 composition root：注入 repository、streamFn、工具集 │
└───────────▲──────────────────────────▲──────────────────┘
            │                          │
┌───────────┴───────────┐   ┌──────────┴──────────────────┐
│ packages/agent         │   │ packages/database           │
│ ≈ pi-agent-core        │   │   线性 message + run 表、     │
│   agentLoop /          │   │   compaction message、       │
│   agentLoopContinue、  │   │   run_events 持久化          │
│   AgentTool 执行、     │   └─────────────────────────────┘
│   loop hooks           │
└───────────▲────────────┘
            │ stream(model, context, options)
┌───────────┴─────────────────────────────────────────────┐
│ packages/ai（新建，≈ pi-ai）                              │
│   Message 类型族、stream / streamSimple、provider 适配、  │
│   compat 归一化、AssistantMessageEvent / EventStream      │
└─────────────────────────────────────────────────────────┘

能力包（保留并回迁到新 loop 的工具/上下文挂载点上）：
  packages/rag（附件 grounding，经 transformContext / 工具接入）
  packages/report、packages/workflow（报告生成与 PDF，作为工具/子流程）
  packages/mcp（MCP 工具桥接为 AgentTool）
  packages/eval（评测，跑在新 loop 之上）
  packages/trace（事件类型契约 + 脱敏工具，职责收窄；去留见 01 取舍论证）

注：packages/tools 仍保留为独立 workspace package，但其 registry/executor/
工具实现已对齐 `packages/agent` 的 `AgentTool` 接口；approval 权限门已删除
（zod schema + 超时/重试/deadline 语义随迁），论证见 01 取舍论证。
```

依赖方向严格向下：`packages/ai` 不依赖任何本项目包；`packages/agent` 只依赖
`packages/ai` 和类型包；能力包被 `apps/api` 组装，不被内核反向依赖。

## 文档阅读顺序

按依赖顺序阅读，前一篇是后一篇的前提：

1. [01 目标架构](01-target-architecture.md) — 总体分层、包边界、迁移后的目录形态。
2. [02 LLM 抽象（packages/ai）](02-llm-abstraction.md) — Message 类型族、
   stream/streamSimple、compat、事件流，对照 pi-ai。
3. [03 Agent Loop（packages/agent）](03-agent-loop.md) — agentLoop/agentLoopContinue、
   AgentTool、loop hooks、事件模型，对照 pi-agent-core。
4. [04 扩展机制](04-extensibility.md) — transformContext/convertToLlm/
   beforeToolCall/afterToolCall/prepareNextTurn/shouldStopAfterTurn 各 hook 的
   本项目用法（观测、block、compaction 触发、RAG 注入）。
5. [05 Postgres 持久化](05-persistence.md) — 线性消息 + run 的新 schema、
   compaction message、旧 schema 废弃。
6. [06 能力包接入](06-capability-integration.md) — RAG、report/workflow、MCP、eval
   如何挂到新 loop 与工具接口上。
7. [07 分阶段实施计划](07-migration-plan.md) — 6 个阶段的任务拆分、依赖、验收标准。
8. [08 目标提示词](08-goal-prompts.md) — 与当前改造配套的目标模式提示词模板。

除 README、07 与 08 外，每篇结构统一为：`## 现状` → `## pi 参照` → `## 目标设计`
（含关键类型/接口签名草案）→ `## 取舍论证` → `## 删除清单`。

## 阶段划分索引

与 07 的 6 个阶段一一对应，阶段间严格串行（每阶段交付可验证的中间态）：

| 阶段 | 内容 | 主要落地文档 |
| --- | --- | --- |
| 1 | 新建 `packages/ai`：LLM 抽象层 | 02 |
| 2 | agent loop + tool：`packages/agent` 重写为 ReAct 内核 | 03、04 |
| 3 | Postgres 新 schema + API/SSE 改造 | 05 |
| 4 | 前端：会话/run UI 对接新 API 与事件流 | 01、03 |
| 5 | 能力包回迁：RAG、report/workflow、MCP、eval | 06 |
| 6 | 删除遗留代码 + 文档同步 | 各篇删除清单 |

阶段 6 的删除清单汇总自 02～06 各篇，重点包括：旧 intent-router 三分支流水线、
approval/permission 全链路（executor 权限门、approval-repository、审批 API、审批 UI、
相关 trace 事件）、旧 `LlmClient` 封装、旧会话 schema。

## 术语表（中英对照，对齐 pi 命名）

| 中文 | 英文 / 符号 | 出处 | 含义 |
| --- | --- | --- | --- |
| 消息 | `Message` | `packages/ai/src/types.ts` | LLM 上下文中的统一消息类型（user/assistant/toolResult 的联合） |
| 用户消息 | `UserMessage` | 同上 | 用户输入消息 |
| 助手消息 | `AssistantMessage` | 同上 | 模型输出，content 为文本/thinking/toolCall 块数组 |
| 工具结果消息 | `ToolResultMessage` | 同上 | 工具执行结果，回填进上下文 |
| 流式调用 | `stream` / `streamSimple` | `packages/ai/src/compat.ts` | 统一 LLM 流式入口，simple 版屏蔽 provider 细项 |
| 兼容层 | `compat` | `packages/ai/src/compat.ts` | 各 provider 请求/响应差异归一化 |
| 助手消息事件 | `AssistantMessageEvent` | `packages/ai/src/types.ts` | 流式过程中产出的增量事件（文本增量、toolCall 等） |
| 事件流 | `EventStream` / `AssistantMessageEventStream` | `packages/ai/src/utils/event-stream.ts` | 可异步迭代的事件流，带最终结果 |
| Agent 循环 | `agentLoop` / `agentLoopContinue` | `packages/agent/src/agent-loop.ts` | 多轮 ReAct 循环入口；continue 用于不重加消息的续跑/重试 |
| Agent 工具 | `AgentTool` | `packages/agent/src/types.ts` | 带执行函数的工具定义（本项目 schema 仍用 zod） |
| 上下文转换 | `transformContext` | `AgentLoopConfig` | 送 LLM 前对消息序列做变换（裁剪/compaction/RAG 注入挂载点） |
| LLM 消息转换 | `convertToLlm` | `AgentLoopConfig` | 把 agent 消息序列转成可发 LLM 的 `Message[]` |
| 工具调用前钩子 | `beforeToolCall` | `AgentLoopConfig` | 工具执行前拦截；本项目仅作观测/block，不做审批 |
| 工具调用后钩子 | `afterToolCall` | `AgentLoopConfig` | 工具执行后可改写结果 |
| 下一轮准备 | `prepareNextTurn` | `AgentLoopConfig` | 每轮结束后调整上下文 |
| 停止判定 | `shouldStopAfterTurn` | `AgentLoopConfig` | 自定义 loop 终止条件 |
| 轮次 | turn | — | 一次 LLM 调用 + 其触发的工具执行 |
| 运行 | run | 本项目 | 一次用户消息触发的完整 agentLoop 执行（持久化单位） |
| 压缩 | compaction | 本项目 | 上下文超长时摘要压缩，以特殊 message 类型落线性表 |
| 流函数 | `StreamFn` | `packages/agent/src/types.ts` | 注入 loop 的 LLM 流式函数类型，便于测试替换 |
