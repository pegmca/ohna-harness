# 08 · 各阶段 goal 模式提示词

> 用法：按 07 的阶段顺序，每个阶段（或阶段 5 的每个能力）单独启动一次 goal 模式，
> 把对应小节的提示词原文粘贴为 goal。阶段间严格串行：前一个 goal 完成、人工评审
> merge 后再启动下一个。回滚点即该阶段 PR 的 merge commit（07 有逐阶段回滚说明）。
>
> 所有提示词共享的前提（已写进每条提示词，粘贴时不用额外补充）：
> - 设计文档：`docs/worktree/01`～`07`（pi 化改造系列），决策口径以 README「已确认决策」为准；
> - pi 参照仓库：`https://github.com/badlogic/pi-mono`（badlogic/pi-mono 浅克隆）；
> - 内部命名与 pi 一致，工具 schema 保留 zod，彻底删除 approval/permission 体系，接受完全不兼容改造；
> - 工程约束遵循仓库根 `AGENTS.md`（中文 JSDoc、单文件约 500 行、migration 字段必带中文 `COMMENT ON COLUMN`、文档同步要求）。

---

## 阶段 1：`packages/ai` 落地 + 协议 adapter 单测

```text
实施 docs/worktree/07-migration-plan.md 的阶段 1：新建 packages/ai（LLM 抽象层）。

设计依据：docs/worktree/02-llm-abstraction.md（详细方案）、docs/worktree/01-target-architecture.md
（包边界与禁止依赖规则）。pi 参照仓库在 https://github.com/badlogic/pi-mono，内部命名与 pi-ai
完全一致（Message / UserMessage / AssistantMessage / ToolResultMessage / Context /
stream / streamSimple / compat / AssistantMessageEvent / EventStream）。裁剪范围按 02 的
取舍论证：只接入 OpenAI 兼容链路（对齐 packages/ai/src/providers/openai.ts），anthropic /
google adapter 只留目录与类型桩；不搬 OAuth、*.lazy.ts 懒加载、models.generated 生成管线、
images API。

改动范围：只新增 packages/ai（types.ts、utils/event-stream.ts、compat.ts、
providers/openai.ts、openai-completions 协议 adapter、utils/retry.ts、
utils/abort-signals.ts）。不修改 packages/agent 与任何调用方；本阶段 packages/ai
无人 import，纯粹可测试地落地。packages/ai 不得依赖本项目内任何其他包（只允许 dev
依赖类型）。

完成标准：
1. 07 阶段 1「改动范围」列出的文件全部落地；
2. 单测以 mock fetch（录制的 SSE 字节流）驱动，覆盖：纯文本流式回复、单/多 tool_call
   增量拼接、错误响应（4xx/5xx → 结构化 error event）、AbortSignal 中断收尾、usage 透传；
   事件序列与 pi AssistantMessageEvent 协议逐字段一致；
3. pnpm --filter @aiagent/ai build && pnpm --filter @aiagent/ai test 通过；
4. pnpm typecheck && pnpm lint && pnpm architecture:check 全绿。

阻塞规则：若发现必须让 packages/ai 依赖项目内其他包、或必须改动 07 的阶段划分，
停下来报告，不擅自扩大范围。
```

---

## 阶段 2：agent loop + tool 层（内存态）

```text
实施 docs/worktree/07-migration-plan.md 的阶段 2：packages/agent 重写为 pi-agent 形态的
多轮 ReAct loop，内存态跑通多轮 tool calling（含 compaction）。

设计依据：docs/worktree/03-agent-loop.md（loop 与 AgentTool 详细方案）、
docs/worktree/04-extensibility.md（hook 本项目用法）。pi 参照仓库在
https://github.com/badlogic/pi-mono，命名对齐 pi-agent：agentLoop / agentLoopContinue /
AgentTool / AgentContext / AgentLoopConfig 及全部 hook（transformContext / convertToLlm /
beforeToolCall / afterToolCall / prepareNextTurn / shouldStopAfterTurn）。工具 schema
保留 zod（zod → JSON Schema 转换收敛在 convert.ts 一处，见 03）；beforeToolCall 仅作
观测/block 挂载点，不接任何审批逻辑。LLM 调用走阶段 1 落地的 packages/ai
（stream / streamSimple）。

改动范围：
- packages/agent：重写 agent-loop.ts、types.ts；删除 src/llm-client.ts、src/llm/ 整目录、
  src/intent-router.ts（旧意图路由能力由 loop + system prompt 承接，迁移说明写入 PR 描述）；
- packages/tools：工具接口改为 AgentTool 形状（zod schema 保留，超时/重试/deadline 语义
  迁自 executor.ts:145-240），权限门与 approval-repository 删除；
- compaction：transformContext 内实现，定义 CompactionMessage 类型与纯函数
  compact(messages, summary)（落库形态属阶段 3）；
- apps/finance-api：run 执行切到新 loop，消息内存累积不落新表，保证 pnpm dev 可用。
不建任何新数据库表（属阶段 3）；不做前端改动（属阶段 4）。

完成标准：
1. 单测：mock streamSimple 驱动 agentLoop 完成 ≥3 轮 tool calling，含并行 tool call、
   beforeToolCall block、prepareNextTurn 注入、shouldStopAfterTurn 提前退出各一例；
2. compaction 单测：超阈值上下文断言摘要消息替换前缀、toolCalls 与 ToolResultMessage
   同进同出不被截断；
3. pnpm --filter @aiagent/agent test && pnpm --filter @aiagent/tools test 通过；
4. pnpm test && pnpm typecheck && pnpm lint && pnpm architecture:check && pnpm smoke:compose 全绿；
5. 内存态手工冒烟：pnpm dev 发起一次需要工具调用的提问，trace 可见完整多轮。

阻塞规则：若 hook 语义与 03/04 文档冲突、或必须保留旧 runAgent 才能跑通，停下来报告。
```

---

## 阶段 3：Postgres 线性持久化 + API/SSE 切换

```text
实施 docs/worktree/07-migration-plan.md 的阶段 3：会话存储推倒重来为线性消息 + run 的
新 schema，API 与 SSE 全面切换到新事件协议。

设计依据：docs/worktree/05-persistence.md（schema 与读写端口详细方案）、
docs/worktree/01-target-architecture.md（依赖规则：database 不依赖 agent/ai，
消息表与 pi 类型同构但独立定义，映射层在 conversation 包）。不采用 pi 的 entry 树结构。

改动范围：
- packages/database：新 migration（编号接续 0100，如 0110_linear_messages.sql）新建
  conversations / messages（线性，content jsonb，compaction 为特殊 message 类型）/ runs /
  run_events（append-only，SSE 重放源），所有字段带中文 COMMENT ON COLUMN；旧表本阶段
  不 drop（阶段 6 统一删）；message-repository / run-repository 重写；
- apps/finance-api：run-service.ts、ordered-run-event-stream.ts 重写（AssistantMessageEvent →
  run_events 落库 + SSE fan-out，断线重放以 run_events.sequence 为准）；conversations /
  runs 路由切新 schema；删除 http/routes/approvals.ts 与
  adapters/in-memory-approval-repository.ts（packages/database 侧的 approval repository
  留到阶段 6，本阶段仅解除路由引用）。
不做前端改动（属阶段 4）。

完成标准：
1. 全新数据库 pnpm db:up && pnpm db:migrate 从零建表成功，migration-lint 通过；
2. 集成测试（apps/finance-api/test）：发起 run 后 messages 表出现 user/assistant/toolResult
   线性序列，run_events 与 SSE 实际输出逐条一致；kill 后按最后序号续传不丢不重；
3. compaction 跨进程生效：触发压缩后重启服务，继续对话上下文从压缩消息重建；
4. pnpm --filter @aiagent/database test && pnpm --filter @aiagent/finance-api test 通过；
5. pnpm typecheck && pnpm lint && pnpm architecture:check 全绿；
6. pnpm dev 手工走查：新会话 → 多轮工具调用 → 刷新页面 → 消息与 run 状态完整恢复。

阻塞规则：07「风险与开放问题」第 1 条（旧数据是否导出存档）默认不导出；若实施中
发现必须导出旧数据才能继续，停下来报告等拍板。run_events 保留策略默认全部保留。
```

---

## 阶段 4：前端适配

```text
实施 docs/worktree/07-migration-plan.md 的阶段 4：apps/finance-web 渲染新 Message content 块与
SSE 协议，删除审批 UI。

设计依据：DESIGN.md（根目录设计系统）、docs/IMMERSIVE_PRODUCT_DESIGN.md、
docs/worktree/01-target-architecture.md（依赖规则：apps/finance-web 不得直接依赖
packages/ai、packages/agent、packages/database，只消费 apps/finance-api 的事件流 DTO）。
布局口径：左会话列表、居中时间线、底部 composer；run 状态/工具调用/trace 为
assistant 消息派生的可展开内容，不做常驻右栏；thinking 块默认折叠可展开。

改动范围：
- apps/finance-web/src/features/workbench/：chat.tsx、run-process.tsx、run-details.tsx 重写
  消息渲染（text / thinking / toolCall / toolResult 分类型渲染，tool call 默认折叠、
  可展开查看参数与结果）；
- SSE 客户端切到 AssistantMessageEvent 协议，断线重连按序号续传；
- 删除审批相关 UI 与状态（approval 分支、审批按钮、审批轮询）；
- apps/finance-web/e2e 与 apps/finance-web/test 同步更新。
不改后端接口（协议已在阶段 3 稳定）；视觉遵循 DESIGN.md 的 system.css 与 tokens，
不另造视觉风格。

完成标准：
1. pnpm --filter @aiagent/finance-web build && pnpm --filter @aiagent/finance-web test（vitest）通过；
2. pnpm test:e2e（Playwright）通过，覆盖：流式回复渲染、tool call 展开/折叠、
   刷新后历史完整、多轮含附件提问；
3. grep 确认 apps/finance-web/src 中 approval 零残留（e2e 删除用例的反向断言除外）；
4. pnpm typecheck && pnpm lint 全绿；pnpm dev 对照 DESIGN.md 人工走查通过。

阻塞规则：若后端事件协议缺字段导致 UI 无法实现，停下来报告并列出缺失字段，
不擅自改 apps/finance-api。
```

---

## 阶段 5：能力包逐个回迁（四个独立子 goal，按序执行）

> 每个能力一个独立 goal、独立 commit/PR，单独可回滚。公共前提写进每条提示词。
> 全部四个完成后再统一跑一次累计验证（见阶段 5 收尾）。

### 5a. RAG 附件 grounding

```text
实施 docs/worktree/07-migration-plan.md 阶段 5 的 RAG 回迁：附件与检索结果以
grounding 上下文注入新 agent loop。

设计依据：docs/worktree/06-capability-integration.md 第 1 节（RAG 接入方案）、
docs/worktree/03-agent-loop.md（transformContext / prepareNextTurn 挂载点）、
docs/worktree/04-extensibility.md（hook 用法）。security.ts 已按 06 决策独立为
packages/security，grounding 的 <untrusted_context> 封装语义不变（永远生成 data-only
user 消息，block 只留占位符）。

改动范围：packages/rag、packages/database/src/rag-*.ts、apps/finance-api/src/http/routes/rag.ts
与 attachments.ts。检索/附件上下文经 transformContext 或 prepareNextTurn 注入；
retrieval 事件名不变，改写 run_events。不改 report/MCP/eval（后续子任务）。

完成标准：
1. packages/rag 现有测试不回归；
2. pnpm typecheck && pnpm lint && pnpm architecture:check 全绿；
3. 手工冒烟：带附件提问 → 引用落库 → 回答含 citation。

阻塞规则：若 grounding 注入点与 03 的 hook 契约冲突，停下来报告。
```

### 5b. report / workflow（含 PDF）

```text
实施 docs/worktree/07-migration-plan.md 阶段 5 的 report/workflow 回迁：报告生成改造为
loop 工具 generate_report，各节点消费新 Message 流与 run 上下文。

设计依据：docs/worktree/06-capability-integration.md 第 2 节（方案 A：report 降级为
loop 工具，API 层 maybeRunReport 删除；reportWorkflow 字段改从 run_events/消息投影派生）、
docs/worktree/04-extensibility.md（research-report skill）。PDF 生成链路（report/pdf.ts）
不变；workflow_node / pdf_export 事件名不变，改写 run_events；前端 report 按钮改为
user message metadata 带 hint: "report"，由 system prompt 约束模型必须调用 generate_report。

改动范围：packages/report、packages/workflow、apps/finance-api/src/application/artifact-service.ts
与 run-service.ts（删除 maybeRunReport 及 plan ready 分支）。不动 RAG/MCP/eval。

完成标准：
1. packages/report 测试通过；
2. pnpm typecheck && pnpm lint && pnpm architecture:check 全绿；
3. 手工跑一次完整研报 run：产物 PDF 与引用持久化正确，事件流含完整节点事件。

阻塞规则：若「模型自主触发 + hint 约束」在冒烟中不可靠（该调不调/乱调），停下来报告，
不擅自复活 API 层触发分支。
```

### 5c. MCP 工具接入

```text
实施 docs/worktree/07-migration-plan.md 阶段 5 的 MCP 回迁：packages/mcp 的
tool-adapter.ts 输出改为 pi AgentTool 形状。

设计依据：docs/worktree/06-capability-integration.md 第 3 节。保留 zod input/output
schema 校验（schemas.ts 原样复用），schema → JSON Schema 走 03 的 convert.ts 转换点；
删除 Tool.permissionLevel / traceEventType 字段与 allowedTools 白名单（权限体系已删）；
mcp_tool_discovered 事件改写 run_events；discovery 产出直接可并入 agentLoop
config.tools 的 AgentTool 数组；MCP 工具输出经 packages/security 二次封装。

改动范围：仅 packages/mcp 及其 apps/finance-api 装配点。不动 RAG/report/eval。

完成标准：
1. packages/mcp 测试通过；
2. pnpm typecheck && pnpm lint && pnpm architecture:check 全绿；
3. 手工接一个真实 stdio MCP server 完成一轮工具调用，事件落 run_events。

阻塞规则：若某个 MCP server 的 schema 无法经 zod → JSON Schema 转换表达，停下来
报告具体 schema，不擅自放宽校验。
```

### 5d. eval

```text
实施 docs/worktree/07-migration-plan.md 阶段 5 的 eval 回迁：packages/eval 的 runner 切到
新 agentLoop 事件流与新持久化读取。

设计依据：docs/worktree/06-capability-integration.md 第 4 节。保留 deterministic fixture
打分（llmJudge: false 口径不变）；setDefaultStreamFn 注入 mock 流；断言从旧 trace 事件
迁移到 06 的事件映射表（agent_start / turn_* / tool_execution_* / retrieval /
workflow_node / security 等）；删除 intent_routed / report_plan / approval / agent_step
相关断言与 fixture 字段；预算走 agentLoop config 的 shouldStopAfterTurn + maxTurns
与 runner 硬上限双层。

改动范围：packages/eval、datasets/eval-financial-v1.json（fixture 字段随映射表迁移）。
不动其他能力包。

完成标准：
1. pnpm eval 跑通；
2. 指标与改造前基线对比无显著回退（阈值沿用 packages/eval 现有口径）；
3. pnpm typecheck && pnpm lint 全绿。

阻塞规则：若指标回退超阈值，不擅自调提示词追平或更新基线——按 07「风险与开放问题」
第 3 条停下来报告，等拍板（追平基线 vs 用 pnpm eval:update-baseline 接受新基线）。
```

### 阶段 5 收尾（四个子 goal 全完成后执行一次）

```text
阶段 5 累计验证：pnpm test && pnpm eval && pnpm typecheck && pnpm lint &&
pnpm architecture:check 全绿。确认四个能力（RAG / report / MCP / eval）在同一工作区
联合工作无冲突。有任何一个红灯则定位到对应子项修复后重跑。
```

---

## 阶段 6：删除遗留 + 文档同步

```text
实施 docs/worktree/07-migration-plan.md 的阶段 6：清空旧世界残余，文档与代码终态一致。

设计依据：docs/worktree/05-persistence.md 删除清单、docs/worktree/01-target-architecture.md
删除清单、07 阶段 6「文档同步清单」。

改动范围：
- 删除 approval 全套：packages/database/src/approval-repository.ts、approval-decision.ts、
  0040_approval 对应表（新 migration drop）、trace 中审批事件类型、残留 in-memory
  adapter 引用；
- 删除旧 schema：旧 conversations/runs/trace 相关表与 repository（新 migration drop），
  packages/database/src/schema.ts 重写为新表集合；
- 全仓 grep 复核 packages/agent 的 llm-client.ts、llm/、intent-router.ts 零引用（阶段 2 已删）；
- packages/trace 类型裁剪为 AssistantMessageEvent 派生 + run 生命周期事件；
- 文档同步（同一 PR 内）：ARCHITECTURE.md、README.md、AGENTS.md（增加 packages/ai、
  删除 approval/intent-router 相关表述）、notes/ 受影响条目（approval-persistence.md 标注
  已移除、durable-agent-runs.md、trace-persistence.md、postgresql-usage.md、
  architecture-refactoring.md 等）+ 新增一篇 pi 化改造总览笔记、
  docs/LEARNING_AND_EVOLUTION_ROADMAP.md 验收证据更新、docs/worktree/README.md 索引补 07、08。

完成标准：
1. 全仓 grep "approval|intent-router|llm-client" 仅命中历史文档的「已删除」说明；
2. pnpm db:migrate 在全新数据库从零执行成功（含 drop migration）；
3. pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm architecture:check &&
   pnpm smoke:compose 全绿；
4. pnpm dev 全流程人工走查通过；
5. 07 阶段 6 文档同步清单逐项完成。

阻塞规则：grep 复核若发现旧符号仍有活引用（非历史文档），先修复引用再删除；
无法定位归属的残留停下来报告，不强行删除。
```

---

## 执行顺序速查

| 序 | goal | 主设计文档 | 关键验收 |
| --- | --- | --- | --- |
| 1 | 阶段 1：packages/ai | 02 | mock fetch 单测 + 事件协议逐字段一致 |
| 2 | 阶段 2：agent loop 内存态 | 03、04 | ≥3 轮 tool calling 单测 + compaction 单测 |
| 3 | 阶段 3：持久化 + API/SSE | 05 | 集成测试 + 断线续传 + compaction 跨进程 |
| 4 | 阶段 4：前端 | 01、DESIGN.md | vitest + Playwright + approval 零残留 |
| 5a–5d | 能力回迁 ×4 | 06 | 各子验收 + 累计验证 |
| 6 | 阶段 6：删除 + 文档同步 | 01、05 | 全仓 grep + 五条验证命令全绿 |

需用户拍板的开放问题见 07「风险与开放问题」（默认口径已写进对应提示词的阻塞规则）：
旧数据导出（默认不做）、anthropic/google adapter 时机（默认推迟）、eval 基线漂移
（默认停下来拍板）、run_events 保留窗口（默认全保留）、thinking 块展示（默认折叠）。
