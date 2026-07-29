# PR-13：渐进式 Run 事件投影

## 目标与启动条件

依赖 PR-03、PR-04、PR-10 已合并。从最新 `origin/master` 创建
`feat/progressive-run-events`。不新增 canonical event 类型，只把既有 Run/Trace events
确定性投影为六个 UI 活动类别。

## Canonical Event 映射

按事件的 canonical `sequence` 处理，映射固定如下：

| UI 类别 | Trace event type |
| --- | --- |
| Routing | `request_received`、`intent_routed`、`security` |
| Model | `model_call` |
| Retrieval | `retrieval` |
| Tools | `tool_call`、`mcp_tool_discovered`、`mcp_tool_call` |
| Workflow | `approval`、`report_skill_activation`、`report_plan`、`workflow_node`、`citation_verifier`、`pdf_export` |
| Finalizing | 其他已知或未来未知的 `trace_event` |

`run_status` 不生成类别行，只更新 pending/running 状态；`run_result` 完成所有已出现类别并切换
到持久化 Run details；`run_error` 将当前活动类别标记失败，并按错误码进入 failed/cancelled。
未知 event type 不丢弃、不抛错，归入 Finalizing，并保留可打开的原始详情。

## 类别状态机、折叠与 Replay

每个类别状态为 `active | completed | failed | cancelled`。事件列表为空时没有类别行；任一
时刻最多一个类别为 active。客户端维护按首次出现顺序排列的类别 Map，并按以下 reducer
处理每个 `trace_event`：

1. 忽略 `sequence <= lastSequence` 的重复事件。
2. 按上表求 target category。若 target 已是 active，只更新其 latest event/count。
3. 若 target 不同于当前 active，先把当前 active 标记 completed，再把 target 标记 active；
   target 若首次出现则追加到列表末尾，若曾 completed 则在原位置重新激活，不改变首次顺序。
4. target 的 `count += 1`，保存 first/latest sequence。重新激活不会清零 count。
5. `run_result` 把当前 active 标记 completed；`run_error` 把当前 active 标记 failed，错误码为
   `request_cancelled` 时标记 cancelled。没有类别行时，终态不凭空创建 Finalizing。
6. SSE 重连按 sequence 回放并使用同一 reducer；reducer 不读取墙钟时间或 React state 闭包。

确定性示例：

- Routing → Model → Tools：`Routing(completed), Model(completed), Tools(active)`。
- Routing → Model → Tools → Model：顺序仍为 Routing、Model、Tools；最终状态为
  `Routing(completed), Model(active), Tools(completed)`。
- 上述序列后 `run_result`：三个类别全部 completed。
- 上述序列后普通 `run_error`：Model failed；之前类别保持 completed。
- 上述序列后取消错误：Model cancelled；之前类别保持 completed。

UI 每类始终最多一行，展示 label、latest summary 和 count；完整事件仍由 canonical Run/Trace
持久化并在详情中查看，不能用折叠投影替代事实源。

## Mock 延迟边界

`AIAGENT_MOCK_STEP_DELAY_MS` 只允许注入 Mock agent/trace 事件产生器或 Mock scheduler，在产生
不同语义步骤之间等待；默认测试为 0，演示建议 300～800ms，上限 3000ms。严禁在通用
`RunStore.append`、数据库事务、event bus、SSE replay 或真实 LLM 路径 sleep。数据库 append
必须保持低延迟，sequence 由原有事务分配。

## 包含与排除

包含纯 reducer、live UI、Mock 产生端延迟、pending 动效所需状态。不包含 token streaming、
新事件类型、跨实例 fan-out、修改 Trace schema 或人为拖慢真实 provider。

## 目标模块

- `apps/web`：纯事件投影 reducer、Chat pending 视图与 reducer tests。
- `apps/api`：仅负责把 Mock 延迟配置注入 Mock runtime。
- `packages/agent` 或专用 Mock adapter：事件产生端节奏；不得修改通用 store。
- `packages/types`：原则上不变；若发现需要新 canonical type，应停止并先修订任务卡。

## 测试与验收

- 为映射表每个事件类型和未知类型写参数化测试。
- 同类 20 个事件仍只有一行，count/first/latest sequence 正确。
- 顺序、交错重入、成功、失败、取消均严格匹配状态机示例，且任一中间状态最多一个 active。
- 完整流与“断线、重复 replay、继续 live”的最终投影深度相等。
- result/error/cancelled 状态更新确定，终态后完整 Run details 可读。
- fake timer 证明 Mock 延迟发生在产生端；spy 证明 store append/replay 没有等待。
- 运行 Trace/API/Web 定向测试及根级 `pnpm typecheck`、`pnpm test`、`pnpm build`。

## 文档、提交与 PR

同步 Run/SSE note 和路线图证据。提交建议：`feat(web): project progressive run events`。
PR 描述必须附映射表、reducer 测试和 Mock 延迟位置。Review Agent 重点检查 replay 等价性、
未知事件兼容和通用持久化路径是否被阻塞。
