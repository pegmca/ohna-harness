# PR-02：Conversation API 与 Web 历史

## 目标与启动条件

依赖 PR-01 已合并。从最新 `origin/master` 创建 `feat/conversation-history-ui`。本 PR 不新增
migration，不修改 Run 持久化；只把会话列表和消息时间线接到已存在的 repository。

## API 与 DTO

在共享类型中增加小型 Conversation/Message DTO 和 cursor page：

- `POST /api/conversations`
- `GET /api/conversations?cursor=&limit=`
- `GET /api/conversations/:conversationId/messages?cursor=&limit=`
- `PATCH /api/conversations/:conversationId`，仅支持 title 或 archive

所有 route 从 session 获取 `userId` 并传给 application service/repository；无权资源统一
返回 `not_found`。limit 有稳定默认值和上限，非法 cursor 返回 `bad_request`。

## Web 行为

- 左侧会话列表由 API 驱动，支持初始加载、加载更多、空态、错误重试和归档。
- 选择会话时加载消息 timeline；切换会话要取消旧请求，防止响应串写。
- 当前 conversation ID 放入可刷新路由或稳定 URL state，刷新后恢复选择。
- composer 为每次用户提交生成稳定 `clientMessageId`；网络重试复用同一个 ID。
- 本 PR 只展示数据库中已完成/失败消息，不自行实现 Run 入库；与现有 Run 提交流程保持兼容。
- 遵守 `DESIGN.md` 和现有 Workbench 结构，不创造新的视觉体系。

## 测试与验收

- API 覆盖创建、分页、归档、非法 cursor、两个用户隔离。
- Web 覆盖加载/空/错、快速切换会话、分页追加、刷新恢复、重复重试 client ID。
- 手工验证桌面/移动、浅色/深色和现有 composer 行为。
- 运行 API/Web 窄测、相关 typecheck、根级 `pnpm typecheck` 和 `pnpm build`。

## 提交与 PR

提交建议：`feat(web): persist conversation history`。

同步 README 中会话历史行为和 API 示例。Review Agent 重点检查 Web 是否仍保留第二事实源、
请求竞态、DTO 是否混入数据库 row，以及用户隔离测试。

