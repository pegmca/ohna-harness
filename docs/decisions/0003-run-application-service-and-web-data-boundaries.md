# Run application service and Web data boundaries

## Status

Accepted

## Context

Web 和 API 入口曾同时承担 transport、状态、SSE、Agent/Report 编排和视图映射，导致入口文件过大，也阻止 Run store 与执行机制独立替换。

## Decision

- Web 使用 React Router lazy feature 边界；全局 Provider、feature UI/model 和 `shared/api` 分离。
- HTTP 创建/查询/取消 Run，canonical SSE 只传递有序过程事件和终态。
- API 使用 `RunApplicationService` 管理 Run 状态机，并依赖 `RunStore`、`RunEventBus`、`RunScheduler` 和 `RunExecutionRegistry` port。
- 可序列化 snapshot 与进程内 `AbortController`、实时订阅者严格分离。
- Report Workflow 只能由 Run application service 启动；删除同步 Agent 和浏览器手动编排接口。

## Consequences

- 阶段二可替换数据库、队列和事件总线，而不修改 HTTP route 或 Agent runtime。
- Web 断线可按 sequence 重放，并在重连耗尽后读取 snapshot。
- 请求协议发生破坏性变化，旧 Demo 和 smoke test 必须同步迁移。
