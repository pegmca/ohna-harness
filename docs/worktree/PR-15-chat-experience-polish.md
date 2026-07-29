# PR-15：停止、动效与 Agent Chat 收口

## 目标与启动条件

依赖 PR-11 至 PR-14 全部合并。从最新 `origin/master` 创建
`feat/chat-experience-polish`。本 PR 不新增业务能力，统一取消竞态、Pending 动效、消息宽度、
滚动与可访问性，并承担 PR-11～PR-15 的最终集成验证。

## 取消协议与竞态

- 运行中发送按钮切换为 Stop。点击后调用 `DELETE /api/runs/:runId`；只有服务端确认终态或
  返回终态快照后，浏览器才 abort 当前 SSE。
- POST 创建尚未返回 accepted 时，Stop 只记录 `cancelRequested`，不得中止创建请求并假设
  服务端未落库；accepted 到达后必须先按取得的 runId 调用 DELETE，再关闭 SSE。该路径保留
  Composer 草稿，并用新 clientMessageId 重试，避免命中已取消 Run 的幂等终态。
- canonical 取消终态不是新事件类型：服务端 append 既有 `run_error`，其中
  `error.code = request_cancelled`，Run 投影为 `cancelled`，SSE 随终态关闭。
- DELETE 与自然 `run_result` 竞争以数据库行锁/CAS 为准。若成功/失败终态已提交，取消不得
  再写 `run_error`，DELETE 返回现有终态；客户端按返回快照展示真实结果。
- 重复 DELETE 幂等：对当前用户已终态 Run 返回相同快照，不新增事件。未知/他人 Run 继续
  返回 not found，避免存在性泄漏。
- DELETE 网络失败或超时时，浏览器继续消费原 SSE，Stop 恢复可点击并展示非终态错误；不能
  仅 abort 浏览器后把后台 Run 留在运行。由于 accepted Run 仍继续执行，此分支按正常
  accepted 语义清理本次已提交草稿，避免终态成功后重复提交相同任务。
- 若 DELETE 已成功但响应丢失，SSE/replay 中的 terminal `run_error` 仍可使客户端收敛到
  cancelled。执行体迟到的 result/error 由终态 CAS 丢弃。

## 视觉、滚动与可访问性

- Pending assistant 品牌标记缓慢旋转；`prefers-reduced-motion: reduce` 下关闭旋转。
- User/Assistant 外层使用同一时间线宽度约束；assistant 内容稳定占满可用列，不因详情有无
  改变宽度。长文本、代码和附件名不得撑破容器。
- 新 live event 到达时，只有用户原本接近底部才自动跟随；用户向上阅读时显示“回到底部”，
  不抢滚动位置。切换会话重置该判断。
- Stop、发送、加号、灵感和模型控件有明确 accessible name、focus-visible 和 disabled
  状态；pending/cancelled 用 `aria-live` 的简短状态，不朗读全部 Trace。

## 包含与排除

包含取消协议修正、客户端 Stop、动效、宽度、自动滚动、响应式和无障碍收口。不包含暂停/
恢复 Run、后台任务队列、token streaming、全新视觉品牌或右侧永久调试栏。

## 目标模块

- `apps/api`：Run cancel service/route 与 SSE 终态关闭。
- `packages/database`：既有 Run append/CAS 行为及竞态集成测试；无新 migration。
- `apps/web`：run stream client、Workbench active Run 编排、Chat 样式和 Playwright/Vitest。
- 根 `test/`：跨 API、重连、取消竞争和响应式人工/自动验证入口。

## 测试与验收

- cancel-before-success、success-before-cancel、重复 cancel、响应丢失后 replay 四种竞态均
  只有一个 canonical 终态。
- DELETE 失败时 SSE 保持连接；成功后 UI 显示 cancelled 而非网络错误。
- 切换会话不把迟到事件写入新会话；断线重连后 Stop 仍绑定正确 runId。
- 桌面/360px 移动端消息宽度一致；长内容无横向溢出。
- reduced motion、键盘 focus、aria-live 和滚动跟随行为有自动或 Playwright 证据。
- 执行 `pnpm architecture:check`、`pnpm typecheck`、`pnpm test`、`pnpm build`；
  可用环境执行数据库竞态集成测试和 `pnpm smoke:compose`。

## 文档、提交与 PR

同步 README 用户流程、Run/SSE 与 Composer notes、路线图 acceptance evidence。提交建议：
`feat(chat): finalize run controls and experience`。

PR 描述必须汇总 PR-11～PR-15 的 API/migration、全链路测试、截图/录屏、未执行项和回滚方式。
Review Agent 重点检查终态 CAS、失败时继续 SSE、滚动不抢占和 reduced-motion。该 PR 通过前
不得宣称新 Composer 流程已完成收口。
