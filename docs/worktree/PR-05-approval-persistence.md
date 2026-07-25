# PR-05：Approval 持久化

## 目标与启动条件

依赖 PR-03 已合并，可与 PR-04 并行。从最新 `origin/master` 创建
`feat/postgres-approval`，使用 `0040_approval.sql`，替换 API 中三个 Approval 内存 Map。

## 数据与状态机

`tool_approvals`：

- approval/run/trace/user ID
- tool name、permission level、reason/reason code
- input digest、脱敏 input preview JSONB
- status：pending、approved、rejected、expired
- requested/decided/expires 时间、reviewer user ID、reviewer note

索引覆盖 `(user_id,status,requested_at)` 和 `run_id`。所有字段逐列中文注释。

创建 Approval 对相同 approval ID + input digest 幂等。决定操作使用
`UPDATE ... WHERE status='pending' AND input_digest=$expected AND user_id=$reviewer`：
相同决定重试返回既有结果，不同决定或 digest 不符返回 conflict；过期 pending 原子转为
expired。Approval decision 与对应 canonical/trace event 在同一应用事务边界提交。

repository port 放在工具权限领域，不放 API route。查询和决定同时校验 user、run、
request 和 digest，不能只凭 approval ID。

## 测试与验收

- API 重启后 pending Approval 仍可决定。
- 并发 approved/rejected 只有一个状态迁移成功。
- 相同决定幂等，不同决定 conflict。
- digest/request/run/user 任一不匹配均拒绝且不泄漏资源存在。
- 过期 Approval 不执行工具。
- 内存 Approval Map 全部移除或仅保留明确的测试 adapter。
- 运行 tools/API/database tests、相关 typecheck、根级 test/typecheck/build。

## 提交与 PR

提交建议：`feat(tools): persist approval decisions`。

同步安全 note/威胁模型中审批持久化证据。Review Agent 重点检查 replay 防护、CAS 条件、
过期竞态和 reviewer 身份来源。

