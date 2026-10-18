# 06 能力包接入（RAG / Report / MCP / Eval / Filings）

本文是工程化改造系列的第 6 篇，描述五个既有能力包如何接入 pi 风格的新 agent loop（`agentLoop` + hook，见 01 目标架构与 04 工具/扩展文档）。前提决策（全系列口径一致）：

- LLM 层完全按 pi-ai 改造，内部命名与 pi 一致（`Message` / `AssistantMessageEvent` / `agentLoop` / `AgentTool` / `transformContext` 等）。
- 会话存储为线性消息 + run，compaction 是特殊 message 类型。
- approval/permission 体系彻底删除，`beforeToolCall` 仅作观测/block 挂载点。
- 保留：RAG grounding、report/workflow（含 PDF）、MCP 工具接入、eval；工具保留 zod 校验与超时/重试/deadline，接口形状对齐 pi 的 `AgentTool`。

## 1. RAG 附件 grounding

### 现状

- grounding 在 API 层、loop 之外完成：`apps/finance-api/src/application/run-service.ts:333` 的 `retrieveAttachmentGrounding` 用 `DataSourceRuntime.search`（`packages/rag/src/data-source-runtime.ts`）按附件 documentIds 检索 topK=5，把结果拼成纯文本 context + citations。
- 检索结果通过 `AgentRequest.groundingContext / groundingCitations` 传入 loop（`packages/agent/src/agent-loop.ts:160`），loop 的 chat 路径把它内联拼接进用户消息（`packages/agent/src/agent-loop.ts:375-426`，`<evidence>` 标签包裹）。
- 安全封装已存在但未用于 attachment grounding 主路径：`packages/agent/src/security.ts:29` 的 `assessPromptInjection`（四信号正则评估）与 `security.ts:48` 的 `assembleUntrustedContext`（`<untrusted_context>` 封装 + block 占位符 + security trace 事件）。
- RAG 包公共入口：`packages/rag/src/index.ts`（re-export `retrieval.ts` / `answer.ts` / `data-source-runtime.ts` 等）。

### pi 参照

- pi 没有内置 RAG，但它给了标准挂载点：`transformContext?: (messages: AgentMessage[], signal?) => Promise<AgentMessage[]>`（`packages/agent/src/types.ts:195`），在每次模型调用前、`convertToLlm` 之前执行（`packages/agent/src/agent-loop.ts:290-291`）。这正是"context 注入类能力"的 pi 原生位置。
- pi 的 `AgentMessage` 即 `Message` 联合类型（`UserMessage` / `AssistantMessage` / `ToolResultMessage`，`packages/ai/src/types.ts:393/399/414/432`），所以 transform 注入的内容就是一条普通 `UserMessage`，天然落进线性消息表。
- 注意：pi 对 prompt injection 的官方立场是"本地 agent 风险，不内建防护"（`packages/coding-agent/docs/security.md`）。我们的 `security.ts` 是超出 pi 范围的自留模块，改造中不丢。

### 目标设计

grounding 从"API 层预检索 + 请求字段透传"改为"loop 的 `transformContext` hook"，与 pi 的机制一一对应：

```ts
// packages/rag/src/grounding-hook.ts（新增）
import type { AgentMessage } from "@aiagent/agent"; // 即 pi 的 Message 联合类型
import type { DataSourceRuntime, Citation } from "./index.js";

export interface GroundingHookOptions {
  /** RAG 检索入口（复用现有 DataSourceRuntime）。 */
  runtime: DataSourceRuntime;
  /** 本次 run 的附件 documentId 快照（来自 messages 表的 attachments 快照，见下）。 */
  attachmentDocumentIds: readonly string[];
  ownerUserId: string;
  /** topK，默认 5，与现状一致。 */
  topK?: number;
}

/**
 * 生成 transformContext hook：每轮模型调用前检索附件相关片段，
 * 经 prompt injection 评估后封装为 <untrusted_context> UserMessage 注入上下文。
 *
 * @returns 直接传给 agentLoop config.transformContext 的函数。
 */
export function createGroundingTransformContext(
  options: GroundingHookOptions
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
```

配套约定：

- **安全模块独立保留**：`security.ts` 从 `packages/agent` 移出为独立模块（建议 `packages/security`，仅依赖 trace 接口），`assessPromptInjection` / `assembleUntrustedContext` 签名不变；grounding hook 与 MCP 工具输出的二次封装都复用它。`<untrusted_context>` 封装语义不变：永远生成 data-only user 消息，block 内容只留占位符。
- **注入去重**：hook 内部按 run 记忆已注入的 chunk id 集合，只在首轮或有新附件时追加消息，避免多轮 loop 每轮重复注入（pi 的 transformContext 每轮都会跑，这是与现状"单次注入"的关键行为差异）。
- **attachments 快照进 messages 表**：创建 run 时把 `attachmentDocumentIds` 与检索命中的 chunk/citation 快照作为 user message 的 metadata 持久化（线性消息表，复用现有附件链路 `packages/rag` 检索 + `attachmentDocumentIds` 传参），重放会话时 grounding 上下文可直接从消息还原，不依赖当时的向量库状态。citation 仍经 `createCitationFromRetrievedChunk`（`packages/rag/src/answer.ts:15`）落到 assistant message。
- retrieval trace 事件（`"retrieval"`）改由 hook 写入 run_events，事件名不变。

### 取舍论证

- 选 `transformContext` 而非"把 RAG 注册成工具"：附件 grounding 是用户显式提供材料后的**必然检索**，让模型决定是否调用检索工具只会增加漏检与 token 成本；pi 的 hook 机制本来就是为这类确定性上下文注入设计的。检索作为工具（`search_filings`）仍保留，面向模型主动扩展检索的场景，两者不冲突。
- 选 hook 而非继续 API 层预检索：注入内容成为普通 `UserMessage` 后自动进入线性消息表与 compaction 视野（compaction 是 message 类型，能看到并压缩它），API 层不再持有 prompt 组装逻辑，符合"runtime 行为下沉到 package"的边界规则。

### 删除清单

- `AgentRequest.groundingContext / groundingCitations` 字段（`packages/agent/src/types.ts`）。
- `run-service.ts` 中 `retrieveAttachmentGrounding` 及 run 执行前的预检索段（`run-service.ts:171-180, 333-358`）。
- agent-loop chat 路径中的 `<evidence>` 内联拼接分支（`agent-loop.ts:375-426`，随旧 loop 整体删除）。

## 2. Report / Workflow（含 PDF）

### 现状

- 触发在 API 层：`apps/finance-api/src/application/run-service.ts:377` 的 `maybeRunReport` 在 agent 响应后检查 `response.reportPlan?.status === "ready"`，成立则同步跑 `runReportWorkflow`（`packages/report/src/run-report-workflow.ts`）。report 意图由请求字段 `mode === "report"` + `reportTriggerSource`（button/toggle）传入（`run-service.ts:185-188`），loop 内的 `runReportSkillPath`（`packages/agent/src/agent-loop.ts:179`）只产出 plan。
- workflow 节点链：collector → analyzer → risk_checker → citation_verifier → writer → pdf_exporter（见 `packages/report/src/nodes/`），节点事件以 `"workflow_node"` / `"pdf_export"` trace 事件上报。
- workflow 状态类型：`packages/report/src/workflow-types.ts:26` 的 `ReportWorkflowState`；结果 DTO 走 `sink.saveWorkflow / saveArtifact`（`run-service.ts:404-406`）。
- pdf_exporter 目前会生成 workflow 级 approvalRequest（`run-service.ts:394-403` 还专门为它补 inputDigest）——approval 体系删除后此逻辑整体移除。

### pi 参照

- pi 中"多步骤产物生成"就是一个工具：`AgentTool`（`packages/agent/src/types.ts:380`）的 `execute(toolCallId, params, signal, onUpdate)` 可以是任意长的异步过程，中间进度经 `onUpdate` 以 `AgentToolUpdateCallback` 流出；工具结果统一为 `ToolResultMessage` 进入上下文。
- pi 的工具由模型自主调用，loop 不理解"report 模式"这类上层语义——模式差异只体现在 system prompt 与工具集。

### 目标设计

```ts
// packages/report/src/report-tool.ts（新增）
import type { AgentTool } from "@aiagent/agent"; // pi 形状，zod schema 经适配层暴露
import type { DataSourceRuntime } from "@aiagent/rag";
import type { RunEventSink } from "@aiagent/agent"; // run_events 写入抽象（写入端口见 05 文档）

export interface ReportToolOptions {
  dataSourceRuntime?: DataSourceRuntime;
  /** 节点事件统一写入 run_events，类型 "workflow_node" / "pdf_export" 保持不变。 */
  sink: RunEventSink;
  deadlineMs?: number;
}

/**
 * 把 report workflow 注册为 loop 工具 `generate_report`：
 * 参数为研究主题/范围，内部跑完整六节点 workflow，末端 pdf_exporter 不变。
 * 工具结果为 ToolResultMessage：草稿 markdown + 各章节 + artifact 引用 + citations。
 *
 * @returns 可直接放入 agentLoop config.tools 的 AgentTool。
 */
export function createReportTool(options: ReportToolOptions): AgentTool;
```

- **workflow 引擎不变**：`runReportWorkflow` 与六个节点保持现有实现，仅事件出口从 TraceRecorder 换成 run_events sink；`workflow_node` / `pdf_export` 事件名、payload 形状不变，前端与 eval 无需改消费端。
- **PDF 导出**：仍是 workflow 末端节点 `pdf_exporter`（`packages/report/src/pdf.ts` + `nodes/`），产物经 `saveArtifact` 持久化，行为不变；区别只是不再有 approval 门——导出直接执行。
- **report 按钮 UX 保留**：前端 report 按钮/toggle 不再产生 `mode: "report"` 分支请求，而是在 user message metadata 里带 `hint: "report"`；system prompt 声明"用户显式要求研报时必须调用 `generate_report`"。模型自主触发与按钮确定性通过提示约束 + eval report 用例回归共同保证。

### 取舍论证

**方案 A（推荐）：report 注册为 loop 工具，模型自主触发。**

- 与 pi 架构同构：loop 只有一种"做事"方式——工具调用；report 的进度天然经 `tool_execution_start/end` + `onUpdate` 进入 run_events，不需要第二条事件通道。
- 触发上下文完整：模型在多轮对话中决定何时出研报，能把前面轮次收集的事实直接写进工具参数；API 层触发只能在 loop 结束后拿到最终响应。
- approval 删除后，`maybeRunReport` 只剩"plan ready 则跑"一层薄判断，保留它等于保留一条平行的控制流，违背最小改造。

**方案 B（放弃）：保留 API 层 `maybeRunReport`。**

- 优点仅是对现有 HTTP 响应 DTO（`reportWorkflow` 字段）零改动；代价是 loop 外多一个隐式执行阶段，run 状态机要继续区分"agent 完成 / workflow 完成"两个终态，且 plan 生成仍要 loop 内的 report planner 特例分支（`runReportSkillPath`）——等于把 report 拆在两层维护。
- 结论：选 A；HTTP 层 `reportWorkflow` 字段改为从 run_events/消息投影派生（05 文档的读模型职责）。

### 删除清单

- `maybeRunReport` 及其 workflow approval digest 补齐逻辑（`run-service.ts:194-196, 377-408`）。
- `reportMode / reportTriggerSource` 请求字段与 `runReportSkillPath` 特例路径（`agent-loop.ts:179` 起）、`report-planner.ts` 中仅服务于该路径的部分。
- workflow approvalRequest 生成（pdf_exporter 节点）与 `RunReportWorkflowOptions.approvalDecisions`（`workflow-types.ts:46`）。

## 3. MCP 工具接入

### 现状

- `packages/mcp/src/tool-adapter.ts:91` 的 `createMcpTool` 用 zod input/output schema 把 MCP tool 包装成本项目 `Tool` 接口（`permissionLevel: "safe"`、`traceEventType: "mcp_tool_call"`）；已知三个包装器 `createMcpSearchFilingsTool` / `createMcpFinancialMetricsTool` / `createMcpMarketDataTool`（`tool-adapter.ts:37/53/69`），未知工具按名称白名单跳过（`wrapDiscoveredMcpTool`，`tool-adapter.ts:195`）。
- discovery 入口 `createMcpToolRegistry`（`tool-adapter.ts:143`）产出独立 ToolRegistry 并写 `mcp_tool_discovered` 事件。
- 路由层有 MCP/mock 双轨：`intent-router.ts:25` 的 `preferMcpTools` 决定同一意图路由到 MCP 工具还是 mock 工具（`intent-router.ts:71-106`）；executor 有 `allowedTools` 最小授权白名单（`packages/tools/src/executor.ts:48`，loop 里逐工具收窄，`agent-loop.ts:323`）。

### pi 参照

- pi 的工具集就是 `AgentContext.tools?: AgentTool[]`（`packages/agent/src/types.ts:412`），一次性交给 `agentLoop`；loop 不做工具名白名单，也不区分工具来源。coding-agent 侧把自家工具统一定义为 `Tool = AgentTool<any>`（`packages/coding-agent/src/core/tools/index.ts:81`），扩展经 `ToolDefinition`（`packages/coding-agent/src/core/extensions/types.ts:449`）/`ExtensionRunner` 注册进同一工具集。

### 目标设计

```ts
// packages/mcp/src/tool-adapter.ts（改造）
import type { AgentTool } from "@aiagent/agent";
import type { McpClient, McpToolSummary } from "./client.js";

/**
 * 通用 MCP 工具包装：保留 zod inputSchema 校验与 outputSchema 返回校验，
 * 输出 pi 形状的 AgentTool（execute 抛错由 loop 统一转 ToolResultMessage 错误，
 * 不再经 ToolRegistry 的 ToolExecutionFailure）。
 * 超时/重试/deadline 由 execute 内部复用现有 reliability 策略，AbortSignal 透传 loop。
 */
export function createMcpAgentTool<TInput, TOutput>(
  client: McpClient,
  name: string,
  description: string,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>
): AgentTool;

/**
 * discovery + 适配：返回可直接并入 agentLoop config.tools 的 AgentTool 数组。
 * mcp_tool_discovered 事件改写入 run_events；失败仍返回结构化错误，不抛异常。
 */
export function discoverMcpAgentTools(
  client: McpClient,
  options?: { trace?: RunEventSink }
): Promise<{ tools: AgentTool[]; toolNames: string[]; ok: boolean; error?: { code: string; message: string } }>;
```

- 已知工具的 zod schema（`packages/mcp/src/schemas.ts`）原样复用；schema → JSON Schema 的暴露方式遵循 03 文档的 `convert.ts` 转换点（zod 保留为校验层，接口形状对齐 `AgentTool`）。
- 工具来源合并：MCP 工具、内置工具、filings 扩展工具全部进入同一个 `tools` 数组交给 `agentLoop`，模型按 description 自主选择；不再存在 MCP registry 与 REST registry 的合并问题。

### 取舍论证

- 移除 `preferMcpTools`：双轨路由是 mock 时代的产物，同一意图两个工具名让 eval 与前端都要处理分支；新 loop 由模型按工具描述选择，mock 工具若仍需要（离线开发），以同名工具的备选实现注入，而不是第二个名字。
- 移除 `allowedTools`：它是 permission 体系的一环（随体系整体删除）；新 loop 的"哪些工具可用"由组装 `tools` 数组时决定——白名单语义从运行时拦截前移到装配期，更简单且可静态检查。`beforeToolCall` 仅保留观测/block 挂载点（安全模块可在此 block 可疑调用）。

### 删除清单

- `preferMcpTools` 及其全部分支（`packages/agent/src/intent-router.ts:25, 71-106, 215-268` 的 `build*Args(preferMcpTools)` 双形态参数构造）。
- `ToolExecutionContext.allowedTools` 与 executor 白名单检查（`packages/tools/src/types.ts:27`、`packages/tools/src/executor.ts:48`）。
- `createMcpToolRegistry` / `McpToolRegistryResult` / `toMcpToolNames` 的 ToolRegistry 形态（由 `discoverMcpAgentTools` 替代）。
- `Tool.permissionLevel` / `traceEventType` 字段（权限体系删除；trace 统一走 run_events）。

## 4. Eval 回归

### 现状

- 数据集 `datasets/eval-financial-v1.json`：schema 1.0.0、30-50 条、四种 mode（chat/rag/report/failure），每条带 `expectedFacts / expectedCitations / expectedWorkflow / expectedSections` 与确定性 `fixture`。
- 跑法：`packages/eval/src/automation.ts:71` 的 `runAutomationEval` 纯 fixture 打分（citationCoverage、financialAccuracy、sourceGroundedness、workflowCompletion 等七项），`DEFAULT_REGRESSION_THRESHOLDS`（`automation.ts:49`）做回归门禁；`loadEvalDataset`（`automation.ts:56`）校验 schema。另有 RAG 专项 runner `runRagEval`（`packages/eval/src/runner.ts:28`）。
- 关键事实：当前 eval **不跑真 loop**，fixture 是预先录制的证据；因此改造的风险是"新 loop 跑出来的证据形态与 fixture/断言口径脱节"。

### pi 参照

- pi 的 loop 事件流是完整自描述的：`agent_start / turn_start / message_end / tool_execution_start / tool_execution_end / agent_end`（`packages/agent/src/types.ts:424-435`），eval 可以直接消费事件流断言行为，不需要 trace 侧信道。
- pi 提供 `setDefaultStreamFn`（`packages/agent/src/stream-fn.ts`）可注入确定性 model 响应流——这是让"真 loop + 确定性输出"成立的关键机制。

### 目标设计

- **跑法升级**：新增 `runLoopEval`（packages/eval），用 `setDefaultStreamFn` 注入按 dataset seed 确定的 mock 模型流（工具调用序列从 fixture 的 workflow/工具期望推导），跑真 `agentLoop`，从 run_events 收集证据后用现有 `scoreCase` 指标函数打分——指标与门禁口径不变，数据集 v1.0.0 继续有效。
- **事件映射表**（断言从旧 trace 事件迁到新 loop 事件）：

| 旧 trace 事件 | 新 run_events / loop 事件 | 说明 |
|---|---|---|
| `intent_routed` | 删除 | 意图路由器随旧 loop 删除，无对应物 |
| `model_call` | `message_end`（AssistantMessage） | 含 usage，token 统计来源 |
| `tool_call` | `tool_execution_start` / `tool_execution_end` | 一对一映射 |
| `agent_step` | `turn_start` | 步数预算按 turn 计数 |
| `retrieval` | 同名（grounding hook 写入） | 事件名保留 |
| `workflow_node` / `pdf_export` | 同名（report 工具 sink 写入） | 事件名保留 |
| `security` | 同名（security 模块写入） | 事件名保留 |
| `mcp_tool_discovered` | 同名（discovery 写入） | 事件名保留 |
| `report_plan` / `report_skill_activation` | 删除 | planner 特例路径删除 |
| `final_response` | `agent_end` | run 终止证据 |
| `approval` | 删除 | 审批体系删除 |

- **多轮 loop 预算**（防止 mock 失效时 eval 失控，也作为产品默认值基准）：

| mode | maxTurns | token 预算（input+output 合计） | 依据 |
|---|---:|---:|---|
| chat | 2 | 8k | 一轮问答 + 一次兜底续轮 |
| rag | 4 | 24k | grounding 注入 + 至多 2 次工具检索轮 |
| report | 10 | 80k | 检索轮 + `generate_report` 长工具 + 总结轮 |
| failure | 3 | 16k | 必须触达结构化错误并终止 |

预算落在 `agentLoop` config（`shouldStopAfterTurn` + `maxTurns` 参数，03 文档）与 eval runner 的硬上限双层；超预算记 `ok=false` 并归入 `failure` 根因。

### 取舍论证

- 保留 deterministic fixture 打分而非引入 LLM judge：学习项目要求可复现，`llmJudge: false` 是既有口径；`setDefaultStreamFn` 注入 mock 流让我们在不改变指标定义的前提下把"被测对象"从录制数据换成真 loop，回归价值更高而成本可控。
- 事件名能保留的尽量保留（retrieval/workflow_node/security 等）：前端 run_events 消费端与文档已围绕这些名字稳定，迁移成本集中在已删除的体系（intent/approval/planner）上。

### 删除清单

- eval 中对 `intent_routed` / `report_plan` / `approval` / `agent_step` 事件的任何断言与 fixture 字段（随映射表迁移）。
- `packages/eval/src/cli.ts` 中只服务旧 trace 采集的参数（如有），并入 `runLoopEval` 入口。

## 5. Filings：extension 工具包示例

### 现状

- `packages/parsing/src/index.ts` 是纯解析/摄取库：`ingestDocument`（index.ts:135）、`parseMarkdownBlocks` / `parseTxtBlocks`、`detectDocumentFileType`，产出 `DocumentIngestionResult` 结构化结果；没有任何工具包装，目前只被数据摄取链路使用。`packages/parsing` 只提供通用文档解析，本节的 filings 域工具包未来独立成包、消费 `packages/parsing`。
- 04 文档定义了新架构的 extension 机制（对齐 pi 的 `ToolDefinition` / `ExtensionRunner`，`packages/coding-agent/src/core/extensions/types.ts:449`、`runner.ts:267`）：extension 是"产出 AgentTool 集合 + 可选 hook 的装配单元"。

### pi 参照

- pi 扩展的工具与内置工具同形，经 ExtensionRunner 注册进会话工具集（`packages/coding-agent/src/core/extensions/runner.ts:267`）；工具定义即 `AgentTool`，无额外适配层。

### 目标设计

```ts
// 示例：filings 域 extension 工具包（未来独立包，非 packages/parsing）
import type { AgentTool } from "@aiagent/agent";
import type { DataSourceRuntime } from "@aiagent/rag";

export interface FilingsExtensionOptions {
  /** 摄取结果写入的 RAG runtime（chunk + 向量化由 rag 包负责）。 */
  runtime: DataSourceRuntime;
  ownerUserId: string;
}

/**
 * filings extension：把公告/披露文件能力注册为三个 AgentTool。
 * - ingest_filing：解析 + 切块 + 入库（复用 ingestDocument），返回 documentId。
 * - search_filings：按 documentId/来源检索片段，输出经 <untrusted_context> 安全封装。
 * - get_filing_outline：返回已摄取文件的分块大纲，供模型规划引用。
 *
 * @returns 04 文档 extension 协议所需的工具集合；hook 为空。
 */
export function createFilingsExtension(options: FilingsExtensionOptions): {
  name: "filings";
  tools: AgentTool[];
};
```

- 解析/切块逻辑零改动，extension 只做 AgentTool 形状适配与错误结构化（沿用 `DocumentIngestionError` 的 code 体系）。
- 检索输出一律过 security 模块封装（与 RAG grounding 同一 `<untrusted_context>` 约定），作为"工具输出即不可信内容"的示例实现。

### 取舍论证

- filings 作为首个 extension 示例而非内置工具：它同时覆盖"纯函数包装成工具""工具输出安全封装""与 RAG runtime 协作"三个扩展场景，是验证 04 文档 extension 协议的最小完整样本；内置工具集保持最小（grounding hook + report + MCP 发现的工具）。

### 删除清单

- 无（filings 本体现有 API 全部保留）；仅删除对旧 `Tool` 接口的任何潜在依赖。

## 附：跨能力包汇总删除清单

- 请求/路由层：`groundingContext`、`groundingCitations`、`reportMode`、`reportTriggerSource`、`preferMcpTools`、`allowedTools`。
- 控制流：`maybeRunReport`、`runReportSkillPath`、report planner 特例路径、`<evidence>` 内联拼接。
- 体系：workflow approvalRequest、executor 权限门、`Tool.permissionLevel`。
- 事件：`intent_routed`、`report_plan`、`report_skill_activation`、`approval`、`agent_step`（映射表见第 4 节）。
