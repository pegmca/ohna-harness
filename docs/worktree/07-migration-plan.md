# 07 · 分阶段实施计划与验收

本文是 pi 化改造（参照 badlogic/pi-mono，`https://github.com/badlogic/pi-mono`，下称 pi 仓库）的落地计划。前置设计口径见本目录 01–06 各篇：LLM 层完全对齐 pi-ai（`Message` / `stream` / `streamSimple` / `compat` / `AssistantMessageEvent` / `EventStream`）、agent loop 对齐 pi-agent（`agentLoop` / `agentLoopContinue` / `AgentTool` / `transformContext` / `convertToLlm` / `beforeToolCall` / `afterToolCall` / `prepareNextTurn` / `shouldStopAfterTurn`）、会话存储改为线性消息 + run 的 Postgres 新 schema、彻底删除 approval/permission 体系。用户已接受完全不兼容改造，不做双写、不做旧协议兼容层。

通用约束（每个阶段都必须满足）：

- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check` 全绿才允许进入下一阶段。
- 每个阶段一个可独立评审的 PR，回滚点即该 PR 的 merge commit。
- 验证命令以仓库根 `package.json` 现有脚本为准：`pnpm typecheck`（`pnpm -r typecheck`）、`pnpm build`（`pnpm -r build`）、`pnpm test`（`pnpm -r --if-present test`，各包为 `node --test`，`apps/web` 为 vitest）、`pnpm dev`（并行起 `@aiagent/api` + `@aiagent/web`）、`pnpm db:migrate`、`pnpm eval`、`pnpm test:e2e`、`pnpm smoke:compose`。

---

## 阶段 1：`packages/ai` 落地 + 协议 adapter 单测

**目标**：新建 `packages/ai`，内部命名与 pi-ai 完全一致；先只接入当前生产实际使用的 provider（OpenAI 兼容链路，对齐 `packages/ai/src/providers/openai.ts`），anthropic / google adapter 只留目录与类型桩（是否本阶段启用见「风险与开放问题」）。

**改动范围（包级）**：

- 新增 `packages/ai`：
  - `src/types.ts` — `Message` / `UserMessage` / `AssistantMessage` / `ToolResultMessage` / `Context` / `Model` / `Api` / `AssistantMessageEvent` / `ToolCall` 等（对齐 pi 仓库 `packages/ai/src/types.ts`）。
  - `src/utils/event-stream.ts` — `EventStream` / `AssistantMessageEventStream`（对齐 `packages/ai/src/utils/event-stream.ts`）。
  - `src/compat.ts` — OpenAI/Anthropic 兼容配置类型（对齐 `packages/ai/src/compat.ts:515` 起）。
  - `src/providers/openai.ts` — `stream` / `streamSimple` 入口（对齐 `packages/ai/src/compat.ts:250`、`:275` 的分发形态）。
  - 协议 adapter：`openai-completions`（请求构造 + SSE 增量解析 → `AssistantMessageEvent`），含 tool_call 增量拼接、usage/finish 处理。
  - `src/utils/retry.ts`、`src/utils/abort-signals.ts`（对齐 pi 同名文件，保留本项目超时/deadline 语义）。
- 不动 `packages/agent`、不动任何调用方；`packages/ai` 此阶段无人 import，纯粹可测试地落地。

**验收标准**：

- 单测以 mock `fetch`（返回录制的 SSE 字节流）驱动，覆盖：纯文本流式回复、单/多 tool_call 增量拼接、错误响应（4xx/5xx → 结构化 error event）、中断（AbortSignal → 半条消息收尾）、usage 透传。事件序列断言与 pi `AssistantMessageEvent` 协议逐字段一致。
- `packages/ai` 自身 `pnpm --filter @aiagent/ai test` 与 `typecheck` 通过；不依赖项目内其他包（只允许 dev 依赖类型）。

**验证命令**：

```bash
pnpm --filter @aiagent/ai build
pnpm --filter @aiagent/ai test
pnpm typecheck
```

**回滚点**：整包删除 `packages/ai` 即可，无其他改动。

---

## 阶段 2：agent loop + tool 层（内存态）

**目标**：`packages/agent` 重写为 pi-agent 形态，内存态跑通多轮 tool calling，含 compaction。

**改动范围（包级）**：

- `packages/agent`：
  - `src/agent-loop.ts` — `agentLoop` / `agentLoopContinue`（对齐 pi `packages/agent/src/agent-loop.ts:31`、`:64`）。
  - `src/types.ts` — `AgentTool`、`AgentContext`、`AgentLoopConfig` 及全部 hook：`transformContext` / `convertToLlm` / `beforeToolCall` / `afterToolCall` / `prepareNextTurn` / `shouldStopAfterTurn`（对齐 pi `packages/agent/src/types.ts:92-286`）。`beforeToolCall` 仅作观测/block 挂载点，不接任何审批逻辑。
  - `packages/tools` 工具接口改为 pi `AgentTool` 形状（参数 schema 仍用 zod，执行层保留现有超时/重试/deadline，语义来源是 `packages/tools/src/executor.ts`（145–240 行），迁移到新执行包装；`reliability.ts` 是多模型 fallback，属 02 篇 LLM 层删除范围）。
- **删除** `packages/agent/src/llm-client.ts`、`packages/agent/src/llm/` 整目录、`packages/agent/src/intent-router.ts`（旧意图路由路径；其能力由 loop + system prompt 承接，迁移说明写入 PR 描述）。
- compaction：`transformContext` 内实现，产出特殊 `CompactionMessage` 类型（落库形态在阶段 3 定义，本阶段只定义消息类型与纯函数 `compact(messages, summary)`）。
- 调用方暂以内存 harness 适配：`apps/api` 的 run 执行切到新 loop，但消息仍在内存累积（不落新表），保证 `pnpm dev` 可用。

**验收标准**：

- 单测：mock `streamSimple` 驱动 `agentLoop` 完成 ≥3 轮 tool calling（含并行 tool call、`beforeToolCall` block、`prepareNextTurn` 注入、`shouldStopAfterTurn` 提前退出各一例）。
- compaction 单测：构造超阈值上下文，断言摘要消息替换前缀、工具调用配对不被截断（`AssistantMessage.toolCalls` 与其 `ToolResultMessage` 同进同出）。
- 内存态手工冒烟：`pnpm dev` 发起一次需要工具调用的提问，trace 可见完整多轮。

**验证命令**：

```bash
pnpm --filter @aiagent/agent test
pnpm --filter @aiagent/tools test
pnpm test && pnpm typecheck && pnpm smoke:compose
```

**回滚点**：本阶段 PR 的 merge commit；因已删除旧 llm-client / intent-router，回滚即整 PR revert。

---

## 阶段 3：Postgres 线性持久化 + API/SSE 切换

**目标**：会话存储推倒重来为线性消息 + run 的新 schema；API 与 SSE 全面切换到新事件协议。

**改动范围（包级）**：

- `packages/database`：
  - 新 migration（编号接续 `migrations/0100_message_attachments.sql`，如 `0110_linear_messages.sql`）：`conversations`（新）、`messages`（线性，`role` + `content` jsonb + `tool_calls`/`tool_call_id` 列，`compaction` 以特殊 message 类型落表）、`runs`、`run_events`（SSE fan-out 源，有序）。旧表（`packages/database/migrations/0000–0100` 对应表）**不在本 migration 删除**，阶段 6 统一 drop；新 schema 所有字段按 AGENTS.md 要求带 `COMMENT ON COLUMN` 中文注释。
  - 新 repository：`message-repository.ts`、`run-repository.ts` 重写（旧文件同阶段删除替换），每方法映射一类 `Message` 的读写；不用 pi 的 entry 树结构。
- `apps/api`：
  - `src/application/run-service.ts`、`ordered-run-event-stream.ts` 重写：`AssistantMessageEvent` → `run_events` 落库 + SSE fan-out（断线重放以 `run_events` 序号为准）。
  - `src/http/routes/conversations.ts`、`runs.ts` 切新 schema；消息列表接口直接返回线性 `Message[]`（content 块原样透传）。
  - 删除 `src/http/routes/approvals.ts` 及 `src/adapters/in-memory-approval-repository.ts`（approval HTTP API 本阶段下线；`packages/database/src/approval-repository.ts`、`approval-decision.ts` 留到阶段 6 随表一起删，中间不再被路由引用）。

**验收标准**：

- 全新数据库执行 `pnpm db:migrate` 从零建表成功；`packages/database` 的 migration-lint 通过。
- 集成测试（`apps/api/test`）：发起 run → 断言 `messages` 表出现 `user/assistant/toolResult` 线性序列、`run_events` 与 SSE 实际输出逐条一致；kill 后重放（按最后序号续传）不丢不重。
- compaction 跨进程生效：触发压缩后重启服务，继续对话时上下文从压缩消息重建。

**验证命令**：

```bash
pnpm db:up && pnpm db:migrate
pnpm --filter @aiagent/database test
pnpm --filter @aiagent/api test
pnpm dev  # 手工：新会话 → 多轮工具调用 → 刷新页面 → 消息与 run 状态完整恢复
```

**回滚点**：`0110` migration 为纯新增表，回滚 = revert PR + `DROP TABLE` 新表（提供 down 脚本或手工 SQL）；旧表此时尚未删除，旧代码回滚后仍可用。

---

## 阶段 4：前端适配

**目标**：`apps/web` 渲染新 `Message` content 块与 SSE 协议，删除审批 UI。视觉与交互遵循 `DESIGN.md`（根目录）与 `docs/IMMERSIVE_PRODUCT_DESIGN.md`：左会话列表、居中时间线、底部 composer；run 状态/工具调用/trace 为 assistant 消息派生的可展开内容，不做常驻右栏。

**改动范围（包级）**：

- `apps/web/src/features/workbench/`：`chat.tsx`、`run-process.tsx`、`run-details.tsx` 重写消息渲染 —— content 块分类型渲染（text / thinking / toolCall / toolResult），tool call 默认折叠、可展开查看参数与结果。
- SSE 客户端切到 `AssistantMessageEvent` 协议（替代旧 run-events 形状），断线重连按序号续传。
- **删除**审批相关 UI 与状态（上述文件中 approval 分支、审批按钮、审批轮询）。
- `apps/web/e2e` 与 `apps/web/test` 同步更新。

**验收标准**：

- `pnpm --filter @aiagent/web test`（vitest）与 `pnpm test:e2e`（Playwright）通过；e2e 覆盖：流式回复渲染、tool call 展开/折叠、刷新后历史完整、多轮含附件提问。
- 全仓 grep 无残留：`approval` 在前端 src 中零命中（除 e2e 删除用例的反向断言）。

**验证命令**：

```bash
pnpm --filter @aiagent/web build
pnpm --filter @aiagent/web test
pnpm test:e2e
pnpm dev  # 对照 DESIGN.md / docs/IMMERSIVE_PRODUCT_DESIGN.md 人工走查
```

**回滚点**：本阶段 PR 的 merge commit；后端协议在阶段 3 已稳定，前端可独立回滚重发。

---

## 阶段 5：RAG / report / MCP / eval 逐个回迁

**目标**：被保留的四大能力逐个适配新消息协议与新持久化，每能力一个独立子验收、独立可回滚 commit。

**改动范围与子验收**：

1. **RAG 附件 grounding**（`packages/rag` + `packages/database/src/rag-*.ts` + `apps/api/src/http/routes/rag.ts`、`attachments.ts`）：附件与检索结果以 grounding 上下文注入（`transformContext` 或 `prepareNextTurn` 挂载）。子验收：`packages/rag` 现有测试不回归；手工冒烟「带附件提问 → 引用落库 → 回答含 citation」。
2. **report / workflow（含 PDF）**（`packages/report`、`packages/workflow`、`apps/api/src/application/artifact-service.ts`）：report 各节点改为消费新 `Message` 流与 run 上下文；PDF 生成链路不变。子验收：`packages/report` 测试通过；手工跑一次完整研报 run，产物与引用持久化正确。
3. **MCP 工具接入**（`packages/mcp`）：`tool-adapter.ts` 输出改为 pi `AgentTool` 形状。子验收：`packages/mcp` 测试通过；接一个真实 stdio MCP server 手工调用一轮。
4. **eval**（`packages/eval`，`datasets/eval-financial-v1.json`）：runner 切新 loop 与新持久化读取。子验收：`pnpm eval` 跑通，指标与改造前基线对比无显著回退（回退阈值沿用 `packages/eval` 现有口径；如需更新基线用 `pnpm eval:update-baseline` 并在 PR 说明原因）。

**验证命令**（各子项完成后累计执行）：

```bash
pnpm test
pnpm eval
pnpm typecheck && pnpm lint && pnpm architecture:check
```

**回滚点**：每个能力一个 commit/PR，单独 revert 不影响其他能力。

---

## 阶段 6：删除遗留 + 文档同步

**目标**：清空旧世界残余，文档与代码终态一致。

**改动范围**：

- 删除 approval 全套：`packages/database/src/approval-repository.ts`、`approval-decision.ts`、`migrations/0040_approval.sql` 对应表（新 migration drop）、trace 中的审批事件类型、残留的 in-memory adapter 引用。
- 删除旧 schema：旧 conversations/runs/trace 相关表与 repository（新 migration drop），`packages/database/src/schema.ts` 重写为新表集合。
- 确认已删：`packages/agent/src/llm-client.ts`、`llm/`、`intent-router.ts`（阶段 2 已删，本阶段仅全仓 grep 复核零引用）。
- trace 事件集收敛为 `AssistantMessageEvent` 派生 + run 生命周期事件，`packages/trace` 类型同步裁剪。

**文档同步清单**（同一 PR 内完成）：

- [x] `ARCHITECTURE.md` — 包职责与数据流重写（新增 `packages/ai`、loop/持久化形态、删除 approval）。
- [x] `README.md` — 架构描述、scripts 说明。
- [x] `AGENTS.md` — Repository Structure 增加 `packages/ai`；删除/修订与 approval、intent-router 相关的规则表述；Coding Rules 中接口描述对齐新边界。
- [x] `notes/` 受影响条目：`approval-persistence.md`（标注已移除并简述去向）、`durable-agent-runs.md`（线性消息 + run_events 新形态）、`trace-persistence.md`、`postgresql-usage.md`（新 schema）、`architecture-refactoring.md`（本次改造结论）、`agent-chat-composer.md`（若协议字段有变）；并新增一篇 pi 化改造总览笔记（技术焦点、关键取舍、验证方式、学习检查点）。
- [x] `docs/LEARNING_AND_EVOLUTION_ROADMAP.md` — 对应阶段证据更新为本次改造的验收记录（命令 + 结果）。
- [x] `docs/worktree/README.md` — 索引补 07、08。

**验收标准**：全仓 grep `approval|intent-router|llm-client` 仅命中历史文档的「已删除」说明；`pnpm typecheck && pnpm build && pnpm test && pnpm lint && pnpm architecture:check` 全绿；`pnpm dev` 全流程人工走查通过。

**验证命令**：同上五条 + `pnpm smoke:compose`。

**回滚点**：不适用整体回滚（删除性变更）；单项误删通过 git 历史恢复。

---

## 风险与开放问题（需用户拍板）

1. **旧数据是否导出**：阶段 3 新 schema 上线后旧表保留至阶段 6 drop。是否需要从旧表导出历史会话为文件存档？默认不做（用户已接受不兼容改造），如需导出请在阶段 3 开工前拍板。
2. **anthropic / google adapter 启用时机**：阶段 1 只落 OpenAI 兼容链路 + 类型桩。是否要求阶段 1 即交付 anthropic/google adapter 的 mock fetch 单测？这会显著扩大阶段 1 范围，默认推迟到改造完成后按需启用。
3. **eval 基线**：新 loop 的提示词与上下文组装变化可能导致 eval 指标漂移。若阶段 5 出现回退，是调提示词追平基线还是接受新基线，需届时拍板。
4. **断线重放的保留窗口**：`run_events` 表保留策略（全部保留 vs 按时间清理）未在决策中明确，默认全部保留、后续加清理任务。
5. **thinking 块展示**：`AssistantMessage` 的 thinking/reasoning content 块前端是否默认展示（pi 系产品通常折叠）？默认折叠可展开，如需默认展开属 `docs/IMMERSIVE_PRODUCT_DESIGN.md` 变更，请确认。
