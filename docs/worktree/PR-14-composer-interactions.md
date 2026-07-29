# PR-14：Composer 快捷交互

## 目标与启动条件

依赖 PR-11、PR-12 的 DTO/API 已合并。从最新 `origin/master` 创建
`feat/composer-interactions`。遵循根 `DESIGN.md`、`system.css` 和
`docs/IMMERSIVE_PRODUCT_DESIGN.md`，只调整 Composer 展示和浏览器草稿编排。

## 交互契约

- 左侧加号打开 Popover，包含“上传文件”和 Report Mode Switch；上传使用 PR-12 API，
  Report Mode 映射到下一次 Run 的 `mode: report`，发送后开关状态保持不变。
- 灵感按钮在 hover、focus、click 时可打开提示词列表；选择后填入 textarea、关闭 Popover
  并恢复焦点，不自动发送。
- 模型按钮展示 PR-11 当前选择；目录加载失败时禁用发送并给出可重试状态，不能构造未知 ID。
- textarea 高度随内容增长，最大 144px，之后内部滚动。Enter 发送，Shift+Enter 换行；
  `isComposing` 时 Enter 不发送。
- 圆形 ArrowUp 为发送；空白输入、模型未就绪、附件 uploading/failed 时禁用。运行中按钮
  由 PR-15 切换为 Stop。
- 附件 chip 展示 uploading/indexed/failed，支持失败重试与移除；最多 5 个、类型和大小先
  在浏览器提示，服务端仍重复验证。

组件使用现有或 Radix primitives 提供 focus management、Escape、outside click、ARIA
label/state。样式只使用 `system.css` token；全局 CSS 仍只导入一次。

## 模块与状态边界

PR-11/PR-12 只提供已经合并的无状态 API clients，本 PR 是所有 Composer Web 状态与控件的
唯一实现者：新增模型目录/偏好状态、附件草稿/上传/重试 hook、模型选择器、附件 chips 和
最终布局。不得在本 PR 改写前置 DTO、HTTP 路径、幂等或授权契约；发现缺口时停止并退回对应
前置 PR 修复。

`Workbench` 只编排会话和提交；模型目录与附件草稿/上传状态放入独立 hook；纯展示控件、
类型和 reducer 分文件。不得把 RAG、模型解析或附件授权逻辑搬到 Web。

API 失败使用现有 `ApiResult`/结构化错误映射。草稿上传失败不得清空用户文本；Run 被接受后
才清空已提交文本/附件，创建会话或 Run 失败时保留可重试状态和 client IDs。

## 包含与排除

包含模型选择器及 localStorage 偏好、附件草稿 hook/chips/重试移除、Popover、Switch、
快捷键、自增高和响应式工具栏。不包含重写 PR-11/PR-12 clients/API/DTO，也不包含拖拽上传、
粘贴图片、语音输入、Markdown 编辑器、提示词管理后台和移动端原生选择器。

## 目标模块

- `apps/web/src/features/workbench`：Composer 壳、展示子组件、草稿 hook、类型和组件测试。
- `apps/web/src/shared/api`：只消费 PR-11/PR-12 已有 client；除测试修正外不改其契约。
- `apps/web/src/styles.css`：基于 `system.css` token 的响应式样式和 reduced motion。
- `packages/*`、`apps/api`：原则上不改；契约缺口退回 PR-11/PR-12 修复。

## 测试与验收

- Enter、Shift+Enter、IME composition、空白和附件阻塞条件均有组件测试。
- Popover 支持键盘打开、Escape 关闭、焦点恢复和 screen reader 名称。
- 模型目录失败、附件失败、重试/移除、Report mode 请求值有确定性测试。
- 360px 宽度无横向溢出，长文件名截断但 title/accessible name 可读。
- axe/现有无障碍门禁无新增严重问题。
- 运行 Web 定向测试、`pnpm typecheck`、`pnpm test`、`pnpm build`。

## 文档、提交与 PR

同步 Composer 学习 note、用户可见行为和路线图证据。提交建议：
`feat(web): improve chat composer interactions`。

PR 描述必须包含交互矩阵、截图或录屏、API 依赖、测试结果和剩余浏览器差异。Review Agent
重点检查 IME、焦点、失败草稿保留和组件文件职责。
