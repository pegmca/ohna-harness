# v1.4 · opencode 与 ohna 差异整理

> **口径**：opencode v2.0.32（`https://github.com/sst/opencode`）对比 ohna 当前实现（v1.3 收尾状态）。
> 本文**只记录差异**，不含实施方案、里程碑与排期。
>
> 配套实施计划：`01-cli-optimization-plan.md` —— 将本文 §二/§三 的 B/C 类差异整理为依赖有序、可独立验收的 CLI/TUI 改造阶段（C0 渲染内核 → C1 语义条目模型 → C2 命令注册表/输入路由 → C3 权限卡与 Toast → C4 长会话预算 → C5 主题 token），含文件级交付清单与验收判据；`02-web-llm-trace.md` —— CLI 启动同步拉起 Web 观测台 + LLM 请求/响应全程追踪（W1 采集层 → W2 serve 观测面 → W3 CLI 接线 → W4 web Trace 页），含 `LlmCallRecordDto` 契约与 `observeRun` 镜像语义；`03-web-layout-alignment.md` —— ohna-web 布局对齐（L1 会话按工作区分组 → L2 Trace 右侧抽屉 → L3 设置页 → L4 验证同步），调研对标 dsh web 与 CodeBuddy Remote Control（L1–L4 已全部完成，实施记录与验收结果见该文 §8/§9）；`04-bug-tracking.md` —— v1.4 阶段发现的 bug 跟踪记录（编号 + 标题、现象描述、原因定位、修复建议）；`05-feature-requests.md` —— v1.4 阶段提出的功能 / 改动请求记录（编号 + 标题、需求描述、现状、涉及改动范围；FR-001「设置改为左下角按钮 + 就地弹窗」已实现，含实现记录）；`06-two-end-alignment.md` —— 双端对齐改造：对标 CodeBuddy / ACP，把「双执行线 + 只读镜像」收敛为「单执行引擎 + 单事件总线 + 多端订阅」（A 系列：补 `--web` 预算 → 默认模式切托管 → 持久化收敛；U 系列：`user_message` 协议补齐 → Web 时间线以服务端为准；A4 止血：`/api/health` 透出 `observeOnly`）。含对 02 D1 的 supersede 说明。
>
> 范围：整体架构 + CLI/TUI 表现。产品定位、团队规模、发布方式不在对比范围内。

---

## 一、架构差异

### 1.1 总览

| 维度 | opencode | ohna |
|---|---|---|
| 语言/运行时 | TypeScript + Bun；Effect-TS（Service / Layer / Schema / Stream） | TypeScript + Node；显式组合根，无 DI 框架 |
| 分层 | `schema → core → protocol → server → client → UI` | `packages/{types,ai,agent,tools,coding,trace,serve,term}` + `apps/*` |
| 契约 | Effect `HttpApiGroup` 单一契约，client 由脚本生成 | 手写 DTO（`@aiagent/types`）+ Fastify 路由 + 手写客户端调用 |
| 服务端 | `@opencode/server` 装配 core，SSE EventFeed | `packages/serve`（`createOhnaServer`）+ `apps/ohna-api` 薄入口 |
| 客户端状态 | `@opencode/client` 的 `createData`：事件投影进 Solid store | CLI 直接消费事件渲染；Web 侧自行从 run 事件推导视图 |
| 会话存储 | SQLite + Drizzle；durable event + projection 读模型 | JSONL（首行 meta + 每行 message），原子替换写入 |
| 会话模型 | admission（inbox：steer / queue）+ 独立 execution | `agentLoop` 内存 ReAct + `getSteeringMessages` / `getFollowUpMessages` 钩子 |
| 执行恢复 | process-global execution + write-ahead claim + 启动恢复 | 进程内单次 run；`--resume` 加载历史，无执行 claim |
| 多端 | TUI / Web / Desktop / App 共用 client 与投影 | CLI + 本地 Web，各自消费 run 事件 |
| 扩展 | 服务端插件 + TUI 插件（路由、Slot、Markdown 渲染器） | MCP 工具 + Team 子代理；无 UI 插件机制 |
| CLI 命令框架 | `effect/cli` Spec 树 + 懒加载 handler | 手写 `parseArgs` + `commands/slash.ts` 解析分发 |

### 1.2 契约与类型

- opencode：`protocol` 只定义端点、Schema、错误与中间件；`server` 用 `HttpApiBuilder` 实现；`client` 由 `packages/client/script/build.ts` 生成。同一契约产出服务端校验、OpenAPI、客户端类型。
  - `opencode/packages/protocol/src/api.ts:138`
  - `opencode/packages/client/package.json`（`generate` / `check:generated`）
- ohna：`@aiagent/types` 收纳跨边界 DTO；`packages/serve` 手写路由；Web/CLI 各自 import 类型。没有生成步骤，也没有 OpenAPI 产出。

### 1.3 会话状态

- opencode 采用“事件不可约 + 投影补齐”：
  - durable events 只记录不可再推导的新事实；
  - `SessionProjector` 把事件增量写入 SQLite 读模型（会话、用量、消息、inbox）；
  - 读侧永远读投影，不重放事件。
  - `opencode/packages/core/src/session/projector.ts`、`AGENTS.md` 的 “Session Core” 规则
- ohna 采用“消息即状态”：
  - JSONL 直接保存 `AgentMessage[]` 与 meta；
  - compaction 作为一条消息类型持久化；
  - 没有事件日志、投影层与回放能力。
  - `apps/ohna-cli/src/session/session-store.ts`

### 1.4 执行模型

- opencode：
  - `Session.prompt` 只做准入：准备输入 → 写 `session_inbox` → `execution.wake`；
  - 执行器按 session 协调，**一步 = 一次 `llm.stream`**，每步从重载历史继续；
  - 单步 outcome 显式枚举：`Completed / Retry / Continue / RecoverFull / Compacted / OutputLimit`；
  - 有 max-steps 提示、流中断续写、输出上限续写、上下文溢出压缩。
  - `opencode/packages/core/src/session/session.ts:155`、`runner/llm.ts`、`runner/step.ts`
- ohna：
  - `agentLoop` 在内存中完成 ReAct 双循环；
  - steer / follow-up 通过两个回调在循环边界拉取；
  - 长任务治理在 run 外层（`--max-turns` / `--deadline-ms` / `--max-cost` + compaction）；
  - 没有“单步可恢复”与 outcome 分类。
  - `packages/agent/src/agent-loop.ts:217,310,314`

### 1.5 并发与恢复

- opencode：
  - `SessionExecution` 进程级、按 sessionID 协调；
  - `SessionRunCoordinator` 合并同会话唤醒、允许不同会话并发；
  - write-ahead execution claim 标记进程内忙碌期，崩溃后启动扫描恢复；
  - 注释明确 claim 不是集群锁、不承诺 exactly-once。
  - `opencode/packages/core/src/session/execution.ts`、`run-coordinator.ts`
- ohna：
  - 一次只跑一个 run；中断即结束本次执行；
  - 恢复依赖 `--resume` 重新加载历史，没有“未完成执行”标记与自动续跑。

### 1.6 客户端状态

- opencode：`createData` 把服务端事件应用进 Solid store，并缓存 API 读取；失效读串行重验，避免旧响应覆盖新响应；重连只失效缓存，由活跃 UI 决定重新同步什么。
  - `opencode/packages/client/src/solid/data.ts:1`
- ohna：
  - CLI 没有客户端 store，事件直接进渲染层；
  - Web 侧用自己的状态管理从 run 事件推导时间线；
  - 两端对“排队/运行/工具状态”的推导规则不共享。

### 1.7 扩展机制

- opencode：
  - 服务端插件可注册工具、命令、provider、agent 等；
  - TUI 插件可注册路由、具名 Slot（`sidebar.content` / `composer.footer` 等）与 Markdown 渲染器；
  - 插件崩溃由 ErrorBoundary 隔离为单条 toast。
  - `opencode/packages/tui/src/plugin/render.tsx`
- ohna：
  - 扩展面是 MCP server、Team 子代理、工具注册表；
  - 没有 UI 级扩展点（无法在不改源码的情况下增加面板/命令/渲染器）。

### 1.8 CLI 启动与命令

- opencode：命令树是声明式 Spec；`Runtime.handlers` 把每个命令映射到动态 import，只有命中命令才加载实现。
  - `opencode/packages/cli/src/index.ts:28`、`framework/runtime.ts`
- ohna：`cli/args.ts` 手写解析 + `commands/slash.ts` 自行维护 12 条命令与别名；命令描述、键位提示、`/help`、`/` 面板由不同位置维护。

---

## 二、CLI / TUI 差异

### 2.1 技术栈与渲染

| 维度 | opencode | ohna |
|---|---|---|
| 渲染框架 | OpenTUI + SolidJS，组件树 + 60fps renderer | 零依赖手写：`RawTerminal` + `Screen` 全量重绘 |
| 布局方式 | Flexbox 风格（`box` / `scrollbox` / `padding` / `border`） | 手算行数：对话区 + 输入框 + 面板 + 状态行 |
| 重绘 | 差量渲染 + 组件级更新 | 节流 + 幂等全屏重绘（先清屏再写整帧） |
| 鼠标 | 支持（点击、滚轮、拖拽分栏） | 不支持 |
| 宽度处理 | 组件测量 + `visibleWidth` 工具 | `visibleWidth` / `truncateToWidth` 手算 |
| 代码规模 | session 路由单文件约 3.6k 行，40+ Context Provider | `tui-app.ts` 571 行，状态集中 |

### 2.2 主题

| 维度 | opencode | ohna |
|---|---|---|
| 结构 | 分层语义树：`text / background / border / scrollbar / diff / syntax / markdown / hue` | 11 个平铺 role + 4 个背景常量 |
| 色阶 | 9 档 hue（100–900）× 语义色 + 明暗两套 | 固定 24-bit RGB，单套暗色 |
| 状态色 | `$hovered / $focused / $pressed / $selected / $disabled` | 无状态色 |
| 引用 | `$hue.neutral.200` 等引用可递归解析并检测循环 | 无引用机制 |
| 表面 | `theme.surface("dialog")` 重解析抬升表面 | 无表面概念 |
| 系统主题 | 读取终端 16 色调色板，按亮度判明暗并生成灰阶/diff 底色 | 无 |
| 主题文件 | JSON 主题文档 + 多套内置主题 + 自定义目录发现 | 代码内常量 |
| 降级 | `NO_COLOR` / 无 TTY 时不输出 ANSI | 同（`supportsAnsi()` + `paint()` 门控） |

参考：`opencode/packages/theme/src/tui/schema.ts`、`resolve.ts`；`opencode/packages/tui/src/theme/system.ts`；ohna `apps/ohna-cli/src/ui/theme.ts`。

### 2.3 布局

| 维度 | opencode | ohna |
|---|---|---|
| 侧栏 | 固定 42 列，可拖拽，范围 5–72，宽屏自动显示 | 无侧栏 |
| 断点 | 内容最小 44 / 偏好 64；分屏要求两者都放得下 | 无内容宽度概念，只按终端高度裁剪 |
| 面板 | 右侧可切换 sidebar / terminal / plugin panel | 仅输入框下方的命令/文件/会话面板 |
| 弹层 | 宽度三档 60 / 88 / 116，最大屏宽 - 2，内缩 3 | 无独立弹层 |
| 状态行 | 底部状态 + toast + 侧栏 footer | 左下权限模式 + 右下模型/上下文占比 |

参考：`opencode/packages/tui/src/ui/layout.ts`；ohna `ui/tui/tui-app.ts:249`。

### 2.4 对话呈现

| 维度 | opencode | ohna |
|---|---|---|
| 中间模型 | 语义 entry → row / group（可折叠） | `contentLines: string[]` 直接追加 |
| 分组 | `reasoning / exploration / activity / instructions` 四类 | 无分组 |
| 摘要 | `3 commands, 1 edit, 2 thoughts, 4 reads`；运行中 `Running command…` | 无摘要 |
| 折叠 | 组级折叠；`ctrl+o` 展开/收起；折叠组只占 1 行 | `ctrl+o` 重打最近折叠块的全文 |
| 工具输出 | 结构化部件（参数、结果、diff、状态） | 文本行 + 头尾截断折叠 |
| verbose | 三档 verbosity（low / medium / high） | 布尔 `verbose` 开关 |
| 消息状态 | streaming / running / done / error 显式状态 | 由事件顺序隐式表达 |

参考：`opencode/packages/tui/src/routes/session/grouping/session.ts`、`activity-summary.ts`、`message-parts.tsx`；ohna `ui/render.ts`。

### 2.5 长会话

| 维度 | opencode | ohna |
|---|---|---|
| 挂载策略 | 尾部 40 个“渲染条目”，向上每次回填 60 | 按终端高度取尾部行，历史全量保留 |
| 权重 | 折叠组恒为 1；展开组按子项数 | 无权重概念 |
| 分页读取 | 消息页 20 条，翻页时补全被切断的分组 | 会话整体加载 |
| 跳转 | 支持锚点、按消息导航、回到底部 | 无 |

参考：`opencode/packages/tui/src/routes/session/mount-budget.ts`、`routes/session/index.tsx:142`；ohna `ui/tui/tui-app.ts:274`。

### 2.6 权限

| 维度 | opencode | ohna |
|---|---|---|
| 卡片位置 | 替换输入区，占满会话主区 | 在对话流中提问 |
| diff 预览 | 卡片内展示，宽度 > 120 自动 split，否则 unified | 工具执行前先打印 diff，再进入确认 |
| 选项 | 允许 / 始终允许 / 拒绝 | 允许 / 本次会话允许 / 拒绝 |
| 拒绝流程 | 第二阶段可填拒绝理由 | 直接返回 |
| 状态呈现 | 被阻塞的工具在时间线中保留 pending 位置 | 无 |

参考：`opencode/packages/tui/src/routes/session/permission.tsx`；ohna `permission/confirm.ts`。

### 2.7 提示与弹层

| 维度 | opencode | ohna |
|---|---|---|
| 一次性提示 | Toast：右上角浮层、排队、悬停暂停、可带 action | 追加到对话流 |
| 错误详情 | 独立 Dialog + 可复制 | 结构化错误文本 |
| 选择器 | 统一 Dialog 组件（宽度三档） | 输入框下方列表 |
| 帮助 | 键位表由命令目录生成 | 固定文案 |

参考：`opencode/packages/tui/src/ui/toast.tsx`、`ui/dialog.tsx`。

### 2.8 动效

| 维度 | opencode | ohna |
|---|---|---|
| spinner | 单单元格动画，按 levels 调透明度，序列化 intro/pace | 多帧字符动画 |
| 文本出现 | fade-in 扫入（200ms） | 无 |
| 标题 | shimmer 高光扫过 | 无 |
| 开关 | 统一 `animations` 配置，关闭后退化为静态 | spinner 有 TTY 门控，无统一动画开关 |

参考：`opencode/packages/tui/src/component/{one-cell-spinner,shimmer-text,fade-in-text}.tsx`；ohna `ui/spinner.ts`。

### 2.9 键位与命令

| 维度 | opencode | ohna |
|---|---|---|
| 定义方式 | 单一 `Definitions` 表：默认键 + 描述 + 可覆盖 | 键位散落在 `handleInput` / `handlePanelKey` |
| leader | `ctrl+x` 前缀组合 | 无 |
| 命令目录 | 键位、命令面板、斜杠命令共享命名空间 | `SLASH_COMMANDS` 只服务 `/` 面板与 help |
| 命令面板 | `ctrl+p`，支持搜索与执行 | `/` 前缀过滤，最多 12 条 |
| 可配置 | 用户配置覆盖每个命令的键位 | 无 |

参考：`opencode/packages/tui/src/config/keybind.ts:44`、`context/keymap.tsx`；ohna `commands/slash.ts`、`ui/tui/tui-app.ts`。

### 2.10 测试方式

| 维度 | opencode | ohna |
|---|---|---|
| TUI 测试 | 真实组件的 fixture story，按键切换状态，可指定 story 启动 | 纯函数单测（palette / 折行）+ 端到端脚本 |
| 覆盖点 | 窄屏/宽屏布局、交互状态组合 | 命令解析、渲染文本、CLI 验证脚本 |
| 快照 | 组件级渲染测试 | 无整屏快照 |

参考：`opencode/packages/tui/src/feature-plugins/system/storybook`；ohna `test/verify-ohna-m*.mjs`。

---

## 三、差异性质归类

### A. 结构性差异（由产品阶段决定，短期不会收敛）

- 依赖注入与运行时：Effect-TS vs 显式装配。
- 会话状态：事件溯源 + 投影 vs 消息快照。
- 多端形态：TUI/Web/Desktop 共用 client vs CLI + 本地 Web 各自消费事件。
- 扩展体系：UI 插件/Slot vs 仅 MCP + 工具注册表。
- 发布与生态：多包发布 + codegen vs 单仓应用 + 手写契约。

### B. 同层能力差异（技术栈不同，但能力可以对标）

- 语义化对话模型（分组/摘要/折叠） vs 扁平行。
- 渲染预算与分页 vs 全量历史。
- 分层主题 token 与系统主题 vs 平铺色位。
- 命令/键位单一目录 vs 多处维护。
- 权限卡内 diff 预览 vs 执行前打印。
- Toast / Dialog 层 vs 追加式提示。

### C. 表现差异（纯视觉/交互）

- 侧栏、分屏、鼠标、拖拽。
- 三档弹层宽度与内缩。
- shimmer / fade / 单单元格 spinner。
- 状态行内容与位置（权限模式 + 模型/占比）。

---

## 四、不构成差异的项

| 项 | 说明 |
|---|---|
| 产品定位 | opencode 是通用编码 Agent + 多端生态；ohna 是学习型本地 Agent，且与金融 SaaS 并行 |
| 工具集 | 两者都走“工具注册表 + 权限闸门”，ohna 另接 MCP 与 Team |
| 存储介质 | SQLite 与 JSONL 是规模选择差异，不是能力高低 |
| 加密/鉴权 | opencode 面向本地服务 + 配对；ohna 为本地单用户，威胁模型不同 |
| 许可与分发 | 不在本次技术对比范围 |

---

## 五、参考文件索引

### opencode

| 主题 | 路径 |
|---|---|
| 协议契约 | `packages/protocol/src/api.ts`、`groups/session.ts` |
| 会话与投影 | `packages/core/src/session/{session,inbox,projector,execution,run-coordinator}.ts` |
| 单步执行 | `packages/core/src/session/runner/{llm,step,max-steps}.ts` |
| 服务端事件流 | `packages/server/src/event-feed.ts` |
| 客户端投影 | `packages/client/src/solid/data.ts` |
| 主题 | `packages/theme/src/tui/*`、`packages/tui/src/theme/*` |
| 时间线 | `packages/tui/src/routes/session/{grouping,activity-summary,mount-budget,message-parts}` |
| 交互组件 | `packages/tui/src/{ui/dialog,ui/toast,routes/session/permission}.tsx` |
| 键位 | `packages/tui/src/config/keybind.ts`、`context/keymap.tsx` |
| CLI 框架 | `packages/cli/src/{index.ts,framework/runtime.ts,commands/commands.ts}` |

### ohna

| 主题 | 路径 |
|---|---|
| 组合根 | `apps/ohna-cli/src/cli/harness.ts`、`runtime/turn.ts` |
| 会话存储 | `apps/ohna-cli/src/session/session-store.ts` |
| 事件渲染 | `apps/ohna-cli/src/ui/render.ts` |
| TUI | `apps/ohna-cli/src/ui/tui/{tui-app,tui-editor}.ts` |
| 主题 | `apps/ohna-cli/src/ui/theme.ts`、`ui/diff.ts` |
| 命令 | `apps/ohna-cli/src/commands/slash.ts` |
| 排队 | `apps/ohna-cli/src/input/follow-up.ts` |
| 服务端 | `packages/serve/src` |
| 终端原语 | `packages/term/src` |
| 内核 | `packages/agent/src/agent-loop.ts` |
