# Immersive Product Design

> 2026-07 工作台更新：界面采用 Kimi 式左侧会话导航、中央 Agent Chat 和按需右侧运行详情面板；支持浅色、深色与跟随系统主题。工具、检索、行情和 workflow 过程由 SSE 实时进入 assistant 消息，点击步骤后在右侧查看结构化详情。行情详情使用明确标记的 Mock OHLCV 与 A 股红涨绿跌 K 线。

## 产品定位

Immersive 是面向股票研究、公告分析、财务指标查询和研报生成 Workflow 的金融研究 Agent 工作台。界面应像研究员每天使用的专业工具，而不是营销官网、聊天玩具或通用后台模板。

本文件只描述 Immersive 的产品体验、信息架构和业务页面模式。通用视觉系统、设计 token、组件视觉语言和 CSS 实现请阅读根目录 `DESIGN.md` 和 `system.css`。

## 核心体验

- 用户可以快速提出金融研究问题，并在同一页面看到回答、工具调用、trace、数据来源和后续研报 Workflow 状态。
- UI 要帮助用户判断答案是否可信：展示意图、工具、耗时、错误、引用和中间步骤，而不是只展示一段模型文本。
- 页面信息密度偏高，但层级清楚，适合长时间扫描、对比和调试。
- 视觉风格遵循 Meridian 设计系统：克制、专业、稳定、数据优先。

## 产品气质

关键词：

- 专业投研
- 可追溯
- 高信息密度
- 冷静可信
- 工程可解释
- 演示友好

不要使用：

- 大面积营销 landing page hero。
- 装饰性渐变球、bokeh、纯氛围背景图。
- 过度圆角、玻璃拟态、强烈霓虹色。
- 单一蓝紫色系铺满整个页面。
- 为了“高级感”牺牲可读性的低对比度文字。

## 当前设计状态与改进优先级

当前页面已经从“开发调试台”重构为 Agent Chat 基础形态：左侧持久化会话列表，中间简洁对话流，底部 composer，运行状态、工具调用和 trace 作为 assistant 消息内的可展开派生信息。会话选择写入稳定 URL state，刷新后可恢复；live Run 仍是消息派生状态，不作为历史第二事实源。

身份入口采用无用户名模式：首次进入由浏览器指纹恢复或创建稳定 `userId`，设置页展示当前 userId、统一 QQ Bot 状态和一次性绑定码。身份初始化失败时阻断工作台并提供重试，避免在未确认 userId 时产生无法归属的运行数据。

优先级：

1. **继续完善金融语义**：在 assistant 消息和 run details 中逐步加入 ticker context、指标摘要、引用/证据列表和风险提示。
2. **增强 Report Workflow**：把 planning、collecting、analysis、writing、citation check 和 export 状态作为消息派生内容展示。
3. **推进组件复用**：后续可把 `ConversationSidebar`、`ChatTimeline`、`ChatComposer`、`RunDetails`、`ToolCallsList`、`TraceTimeline`、`JsonDetails` 拆到独立文件，降低 `App.tsx` 体积。
4. **扩展会话能力**：在保持 API contract 清晰的前提下，引入真实多轮上下文和持久化会话历史。

当前设计债务：

- App 入口已改为 React Router lazy feature 边界，HTTP/SSE 已进入 `shared/api`；Workbench 内的业务视图仍需继续按 `chat`、`run-details`、`data-sources` 和 `report` 拆细。
- 会话与终态消息已从服务端历史恢复；Run、streaming assistant 消息与 trace 的完整恢复仍等待后续持久化任务。
- Report Mode 现在通过 canonical Run 触发完整 Workflow，不再由浏览器调用独立 Workflow API。
- 工具调用和 trace 已有摘要和二级 JSON 折叠，后续应补充金融引用、证据质量和风险提示。

## 技术约束

前端固定使用：

- Vite + React + TypeScript。
- Tailwind CSS v4。
- shadcn/ui 风格的本地基础组件。
- Radix UI 作为无样式交互原语。
- lucide-react 作为图标来源。

禁止新增第二套 UI 体系：

- 不引入 Ant Design、MUI、Chakra、Mantine 等完整组件库。
- 不把运行时 Agent、Tool、Trace 逻辑移动到 `apps/web`。
- 不在业务组件中重复实现共享 API DTO。

基础组件放在：

```text
apps/web/src/components/ui
```

业务页面可以组合基础组件，但不要把所有样式都堆在单个页面文件里。常用控件应沉淀为 `Button`、`Badge`、`Panel`、`Tabs`、`Textarea`、`Timeline`、`MetricCard`、`JsonBlock` 等小组件。

## 页面结构

默认主页面是 Agent Chat 布局，而不是左右调试工作台：

```text
左侧会话栏：新建会话、历史会话、本地运行状态
中央对话区：消息流、assistant 回答、消息内 run details、底部输入框
输入框派生区：Report Mode、提交状态、错误提示、starter prompts
```

推荐结构：

```text
App Shell:
  Sidebar:
    New Chat
    Conversation List
    Local status

  Chat Main:
    Header:
      产品名 / 当前会话标题 / Report Mode / 最新运行状态

    Message Timeline:
      用户消息
      assistant 回答
      assistant 消息内 RunDetails / ToolCalls / TraceTimeline

    Composer Dock:
      多行研究问题输入 / 示例问题 / 提交按钮 / 错误提示 / 请求进度
```

后续进入 Report Workflow 后，仍优先保持会话型体验：

```text
左栏：会话列表
中栏：对话、报告正文、引用证据、workflow 派生状态
消息内或抽屉：工具调用、trace、JSON details
```

只有当用户显式打开“调试详情”或“证据抽屉”时，才临时展示辅助面板；默认首屏不放独立右侧调试栏。

桌面端：

- 左侧会话栏宽度保持稳定，建议 `260px` 到 `300px`。
- 中央对话区最大阅读宽度建议 `760px` 到 `900px`。
- 页面不再使用独立右侧 Run State / Tools / Trace 面板。
- 重要状态在对话 header、composer 和 assistant 消息内可见：Report Mode、请求状态、当前 intent、工具调用数量。
- 主对话区需要足够宽度承载长文本、表格、引用和折叠 run details。

移动端：

- 优先单列布局。
- 会话栏默认收起为 drawer。
- Run details、工具调用和 trace 留在 assistant 消息内折叠展示。
- 输入框和提交按钮不能挤压到不可用。
- 长 ticker、requestId、traceId、JSON path 必须允许换行或横向滚动。

## Agent Run 信息架构

每个 Agent run 至少应该能表达这些信息：

- 用户问题。
- Agent 最终回答。
- intent：`chat`、`tool`、`report_skill` 等。
- requestId / traceId。
- steps：路由、模型调用、工具选择、工具执行、最终响应。
- tool calls：工具名、参数、结果摘要、错误、耗时。
- trace timeline：事件类型、时间、耗时、结构化错误。
- Report Mode 状态和后续 Workflow 占位。

不要隐藏调试信息，但也不要让 JSON 淹没主体验。默认显示摘要，细节用 assistant 消息内折叠面板或 `details` 展开。`Run State`、工具调用和 trace 不应作为默认右侧栏存在。

Assistant 消息按“用户可读过程 → 回答正文 → 回答操作”组织。回答正文不使用带边框卡片；完成后的过程收敛为可折叠单行摘要，展开后只展示“理解问题、检索资料、查询数据、生成回答、执行研究流程”等产品语义。Steps、Tools、Trace、requestId 和 traceId 收进二级“开发者详情”，默认隐藏。每条已结束回答末尾固定提供复制与重新生成小图标；Approval 和 Report Workflow 会影响用户决策或交付物，继续作为独立业务入口展示。

## 金融研究专用 UI 模式

优先建设这些模式：

- 公司/标的上下文条：ticker、公司名、市场、报告区间、数据更新时间。
- 指标卡：营收、净利润、ROE、毛利率、现金流、同比/环比。
- 证据列表：来源、标题、日期、引用编号、可信度。
- 工具调用卡：工具名、参数、返回摘要、耗时、错误。
- 研报 Workflow steps：规划、收集、分析、写作、引用校验、导出。
- 风险提示区：模型不确定性、数据缺口、免责声明。
- 引用检查区：结论、来源、校验状态。

这些模式比泛用 marketing card 更重要。

## 推荐屏幕模块

后续页面改版时，优先按以下模块组合，而不是从空白页面自由发挥：

- **Conversation Sidebar**：展示新建会话、本地会话列表、最后消息摘要和最新运行状态。
- **Chat Header**：展示产品名、当前会话标题、Report Mode 和最新请求状态。
- **Chat Timeline**：展示用户消息、assistant 回答、消息级运行详情和错误状态。
- **Chat Composer**：展示多行输入、提交按钮、Report Mode 快捷控制、请求进度和错误提示。
- **Run Details**：作为 assistant 消息的派生内容，展示 intent、status、steps、tool calls、trace events 和 requestId。
- **Research Brief Bar**：展示 ticker、公司名、市场、报告期、数据更新时间、当前意图。
- **Answer Workspace**：展示最终回答、关键结论、引用编号和可继续追问入口。
- **Evidence Drawer**：展示公告、财报、工具结果、引用可靠性和缺口。
- **Tool Calls List**：展示工具名、参数摘要、返回摘要、耗时、错误状态，默认放在 `Run Details` 内。
- **Trace Timeline**：展示 agent / model / tool 事件，用摘要作为默认视图，JSON 作为展开详情，默认放在 `Run Details` 内。
- **Report Workflow Rail**：展示规划、收集、分析、写作、引用校验、导出等步骤。
- **Risk & Uncertainty Block**：展示模型不确定性、数据缺口、时间敏感性和免责声明。

## 当前页面下一步设计建议

如果只做一轮 UI 改造，推荐范围如下：

1. 把页面改成左侧会话列表 + 中央对话流 + 底部 composer。
2. 删除右侧 `Run State` / `Tools` / `Trace Timeline` 独立面板。
3. 把 demo prompt chip 改为空状态 starter prompts 或 composer 上方的紧凑建议。
4. 把 `activeRun` 从全局右侧状态改成 assistant message 的 `run` 派生数据。
5. 新增消息内 `RunDetails`：默认 badge 摘要，展开后显示 steps、tools、trace、JSON details。
6. 移动端把会话列表收起为 drawer，run details 仍在消息内折叠展示。

## 响应式验收

每次改 UI 后至少检查：

- 桌面宽屏：`1440x900`。
- 笔记本：`1280x800`。
- 移动端：`390x844` 或相近尺寸。

重点检查：

- 没有文字重叠。
- 没有按钮文字溢出。
- trace JSON 不撑破页面。
- 输入区始终可用。
- 会话栏移动端可收起，且不会遮挡输入框。
- assistant 消息内 run details 展开后仍不造成横向滚动。
- loading、error、empty 状态可读。

## Codex 前端任务提示词模板

后续让 Codex 开发 Immersive UI 时，可以使用：

```text
请先阅读 README.md、DESIGN.md、docs/IMMERSIVE_PRODUCT_DESIGN.md、docs/LEARNING_AND_EVOLUTION_ROADMAP.md 的相关阶段和 apps/web 当前代码。

目标：实现/改进一个专业金融研究 Agent Chat 页面，不要做营销 landing page，也不要保留独立右侧调试栏。

技术约束：
- React + TypeScript + Tailwind CSS v4
- shadcn/ui 风格本地组件
- Radix UI 交互原语
- lucide-react 图标
- 不引入 Ant Design、MUI、Chakra 等第二套 UI

设计要求：
- 遵循 DESIGN.md 的 Meridian 通用视觉系统
- 左侧会话列表，中间简洁对话流，底部输入框
- Run State、工具调用和 trace 作为 assistant 消息内派生内容
- 高信息密度但层级清楚
- 深色专业工作台风格
- 避免装饰性渐变球、过度圆角和大面积单色主题
- 展示真实 Agent/Tool/Trace 数据，不硬编码假状态
- 覆盖 loading、empty、error、disabled 状态
- 移动端不能文字溢出或控件重叠

完成后：
- 运行最窄有用验证
- 做文档影响检查
- 如改动前端视觉，请用浏览器截图或说明未执行的原因
```

## Stitch / v0 生成提示词模板

用于 Stitch、v0 或其他 AI UI 工具生成视觉参考时，必须只描述布局、内容和交互结构。若工具项目已有 design system，不要在生成提示词里写 hex、字体名、圆角数值或主题 token。

```text
Create a professional financial research agent chat application for a web desktop app.

PLATFORM: Web, desktop-first with responsive mobile behavior.

PAGE STRUCTURE:
1. Header:
   Compact chat top bar with product name, current conversation title, report mode switch, and latest request state indicator.
2. Sidebar:
   Left conversation list with new chat action, conversation titles, last message previews, timestamps, and local run status.
3. Primary Chat:
   Centered conversation timeline with user bubbles, assistant answers, and a bottom composer.
4. Run Details:
   Agent run state, tool calls, trace timeline, citation evidence, and JSON details appear as expandable sections inside assistant messages, not as a separate right sidebar.
5. Financial Research Modules:
   Include compact ticker context, metric snippets, citation/evidence list, risk and uncertainty block, and report workflow placeholders inside the chat flow.
6. States:
   Include empty, loading, failed, disabled, and long-content states. Long request IDs, ticker symbols, JSON, and trace paths must not break the layout.
7. Mobile:
   Collapse the conversation sidebar into a drawer. Keep run details as expandable sections inside assistant messages.
```

Stitch / v0 结果只能作为视觉参考。落地到本仓库时，Codex 必须使用本地 `apps/web/src/components/ui` 基础组件、共享 DTO 和真实 API 数据重写。

## 文档维护规则

当 Immersive 产品设计方向变化时，优先更新本文件。只有通用视觉语言、token、组件视觉规范或 CSS 实现变化时，才更新根目录 `DESIGN.md` 和 `system.css`。

需要同步更新本文件的情况：

- 新增 Report Workflow、Citation Checker、Eval Report 等主要页面。
- 改变 Agent run、tool calls、trace 的展示方式。
- 新增金融指标、图表、表格或 PDF 预览规范。
- 改变产品级信息架构、页面模块或核心用户流程。
