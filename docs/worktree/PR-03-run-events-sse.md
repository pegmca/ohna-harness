# PR-03：Run / RunEvent 持久化与 SSE Replay

## 目标与启动条件

依赖 PR-01 已合并，可与 PR-02 并行。从最新 `origin/master` 创建
`feat/postgres-run-events`，使用 `0020_runs.sql`。

## 数据模型

`agent_runs` 保存当前投影：ID、request/user/conversation/message 关联、mode/source/status、
intent、trace/workflow ID、脱敏错误、version 和生命周期时间。`request_id` 唯一；按用户、
会话和非终态更新时间建立索引。

`run_events` 保存 canonical event：UUID、run/user/conversation/trace ID、run 内 sequence、
event type、已校验且脱敏的 JSONB payload、created_at；唯一 `(run_id,sequence)`。

为 PR-01 的 `messages.run_id` 增加 FK/部分唯一约束时，必须在本 migration 完成并更新字段
中文注释。Run 状态保留现有终态；重启遗留运行态通过结构化 `run_interrupted` 错误进入
`failed`，不新增未经共享 DTO 支持的状态。

## 应用与 SSE

- 将 `RunStore` 拆成用户限定查询、创建 Run、原子 append event 和合法状态迁移。
- Run 创建事务验证 conversation owner，幂等关联用户消息并预留 assistant message。
- append 在事务中锁定 Run、分配 sequence、插入事件、更新投影和 version；终态不可回退。
- 数据库提交后才调用内存 event bus；bus 只负责 live fan-out。
- SSE 接受 `Last-Event-ID` 或 `afterSequence`。先回放数据库事件，订阅 live 后再次补查以
  关闭竞态窗口，按 sequence 去重。
- 查询、取消、订阅全部要求 `userId`；猜测 ID 统一返回 not found。
- 启动恢复扫描只处理超过阈值的旧非终态 Run，避免误伤当前实例刚创建的任务。

## 测试与验收

- 并发 append sequence 唯一、连续，取消与成功竞争只能保留一个终态。
- 重复 Run 创建不会生成第二条用户消息或第二个执行。
- SSE 重连补齐事件，无缺口、无重复业务事件；终态回放后关闭。
- API 重启后终态可读，陈旧运行态产生可解释失败事件。
- 两个用户不能读取、取消或订阅对方 Run。
- 运行 API/database integration tests、相关 typecheck、根级 test/typecheck/build。

## 提交与 PR

提交建议：`feat(api): persist runs and replay sse events`。

同步 canonical event ADR、ARCHITECTURE 和 Run 学习 note。Review Agent 重点检查事务边界、
replay/live 竞态、终态 CAS、全局 Promise queue 是否已不再承担并发正确性。

