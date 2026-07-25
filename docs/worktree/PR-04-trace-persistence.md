# PR-04：Trace 持久化

## 目标与启动条件

依赖 PR-03 已合并。从最新 `origin/master` 创建 `feat/postgres-trace`，使用
`0030_trace.sql`。Trace 是可观测事实，Run event 是客户端投影，两者不能各自生成不同事件。

## 数据与接口

`traces` 保存 trace/request/run/user ID、状态、duration、model/tool/retrieval/error count、
token 汇总和开始/结束时间。`request_id` 唯一，`run_id` 唯一。

`trace_events` 保存 UUID、trace/run/user ID、sequence、event type、span/parent span、
stage、脱敏 JSONB payload 和 created_at；唯一 `(trace_id,sequence)`。

在 `packages/trace` 保持 `TraceStore` port，并扩展为增量 append/finalize/query。PostgreSQL
adapter 位于 database package。Recorder 先完成 PII redaction，再调用 store；同一操作将
trace event 投影到 PR-03 的 Run event append，不能维护第二套内存事实源。

`GET /api/traces/:requestId` 必须按 session user 查询；无权资源返回 not found。事件较多时
内部 repository 支持 sequence cursor，现有 DTO 可继续返回完整 Trace，分页 API 留后续。

Trace 写失败不能泄漏 raw exception。对主流程的策略固定为：记录结构化内部告警并继续
Agent，但最终 Run 结果标记 `tracePersistence: degraded` 的诊断信息；不能伪装完整成功。

## 测试与验收

- 重启后按 requestId 读取 Trace，summary 与事件一致。
- 并发事件 sequence 稳定，Run 投影与 Trace 内容来自同一事件。
- 两个用户完全隔离。
- token、session、secret、PII 和未经截断的文档正文不入库。
- Trace 数据库故障不打断 Agent 主结果，但产生明确降级证据。
- 运行 trace/API/database tests、相关 typecheck、根级 test/typecheck/build。

## 提交与 PR

提交建议：`feat(trace): persist observable run traces`。

同步 trace note 和 ARCHITECTURE。Review Agent 重点检查脱敏发生在写库前、Trace 与 Run
事件没有双写漂移、降级语义没有向 UI 泄漏内部异常。

