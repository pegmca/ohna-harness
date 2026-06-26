# Immersive Product Design

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

## 当前设计诊断与改进优先级

当前 Week 1 页面已经具备工作台雏形：左侧对话、右侧 run summary / tool calls / trace timeline、底部输入区、深色主题和基础按钮组件。下一轮视觉改进不应重做成营销页，而应把“金融研究证据链”做得更清楚。

优先级：

1. **先改善信息分区**：把对话、研究上下文、工具证据和 trace 调试拆成稳定面板，减少所有内容都像 JSON 调试块的感觉。
2. **再改善金融语义**：增加 ticker context、指标摘要、引用/证据列表、风险提示，让页面一眼像投研工具。
3. **然后改善组件复用**：把 `RunSummary`、`ToolPanel`、`TracePanel`、`JsonBlock` 逐步拆到 `apps/web/src/components`，基础视觉控件沉淀到 `apps/web/src/components/ui`。
4. **最后做视觉润色**：增加状态 badge、紧凑 tabs、分段筛选、hover/focus 微交互和 skeleton，但不引入大面积装饰背景。

当前设计债务：

- `styles.css` 中存在 radial / linear 背景，后续应控制在轻量氛围层级，不能演变成装饰性主视觉。
- 右侧面板在移动端会下移但缺少 tabs / accordion 级别的信息组织。
- 工具调用和 trace 目前偏原始 JSON，应默认展示摘要，把完整 JSON 作为二级调试入口。
- demo prompt chip 内容较长，后续应改为“问题类型 + 示例短句”的紧凑结构。

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

默认主页面是工作台布局：

```text
左侧主工作区：对话、研究问题、报告预览、引用结果
右侧调试/证据区：run summary、tool calls、trace timeline、JSON details
底部或局部输入区：研究问题输入、Report Mode、提交操作
```

推荐结构：

```text
Top bar:
  产品名 / 当前会话状态 / Report Mode / 运行状态

Main workspace:
  左侧 60%-70%：研究问题、对话回答、报告预览、引用证据
  右侧 30%-40%：Run Summary、Tool Evidence、Trace Timeline

Input dock:
  多行研究问题输入 / 示例问题 / 提交按钮 / 错误提示
```

后续进入 Report Workflow 后，可以改成三栏：

```text
左栏：会话与研究 brief
中栏：报告正文、指标、引用
右栏：workflow steps、tool calls、trace
```

桌面端：

- 最大宽度可以约束在 `1440px` 到 `1600px`。
- 使用两栏或三栏布局，右侧面板宽度保持稳定，避免随着内容跳动。
- 重要状态永远在首屏可见：当前意图、Report Mode、请求状态、最新工具调用。
- 主对话区需要足够宽度承载长文本和表格。

移动端：

- 优先单列布局。
- 右侧调试面板应下移为折叠区、tabs 或分段内容。
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

不要隐藏调试信息，但也不要让 JSON 淹没主体验。默认显示摘要，细节用折叠面板或 `details` 展开。

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

- **Research Brief Bar**：展示 ticker、公司名、市场、报告期、数据更新时间、当前意图。
- **Answer Workspace**：展示最终回答、关键结论、引用编号和可继续追问入口。
- **Evidence Drawer**：展示公告、财报、工具结果、引用可靠性和缺口。
- **Tool Evidence Panel**：展示工具名、参数摘要、返回摘要、耗时、错误状态。
- **Trace Timeline Panel**：展示 agent / model / tool 事件，用摘要作为默认视图，JSON 作为展开详情。
- **Report Workflow Rail**：展示规划、收集、分析、写作、引用校验、导出等步骤。
- **Risk & Uncertainty Block**：展示模型不确定性、数据缺口、时间敏感性和免责声明。

## 当前页面下一步设计建议

如果只做一轮 UI 改造，推荐范围如下：

1. 把顶部 header 改成紧凑工作台 top bar：左侧产品和当前 run 状态，右侧 Report Mode 与 request 状态。
2. 把 demo prompt chip 改成四个“任务类型”按钮：营收变化、指标查询、公告检索、研报生成。
3. 给右侧 `Run State` 增加 badge 化状态：intent、ok/failed、report mode、trace count。
4. 把 `Tools` 默认从 JSON 块改成摘要卡，JSON 放到展开详情。
5. 把 `Trace Timeline` 加上事件状态点、事件类型 badge 和耗时 badge。
6. 移动端把 Summary / Tools / Trace 放进 tabs，避免调试区过长。

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
- 右侧面板移动端有合理展示方式。
- loading、error、empty 状态可读。

## Codex 前端任务提示词模板

后续让 Codex 开发 Immersive UI 时，可以使用：

```text
请先阅读 README.md、DESIGN.md、docs/IMMERSIVE_PRODUCT_DESIGN.md、相关 docs/implementation 任务卡和 apps/web 当前代码。

目标：实现/改进一个专业金融研究 Agent 工作台页面，不要做营销 landing page。

技术约束：
- React + TypeScript + Tailwind CSS v4
- shadcn/ui 风格本地组件
- Radix UI 交互原语
- lucide-react 图标
- 不引入 Ant Design、MUI、Chakra 等第二套 UI

设计要求：
- 遵循 DESIGN.md 的 Meridian 通用视觉系统
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
Create a professional financial research agent workspace for a web desktop app.

PLATFORM: Web, desktop-first with responsive mobile behavior.

PAGE STRUCTURE:
1. Header:
   Compact workspace top bar with product name, current run status, report mode switch, and request state indicator.
2. Primary Workspace:
   Split-view layout. The main column contains a research question composer, conversation timeline, assistant answer area, and a compact research brief bar with ticker/company/market/reporting period metadata.
3. Evidence and Debug Area:
   Right-side panel with three stacked sections: run summary, tool evidence cards, and trace timeline. Each section shows concise summaries by default and supports expandable technical details.
4. Financial Research Modules:
   Include metric grid, citation/evidence list, risk and uncertainty block, and report workflow step rail placeholders.
5. States:
   Include empty, loading, failed, disabled, and long-content states. Long request IDs, ticker symbols, JSON, and trace paths must not break the layout.
6. Mobile:
   Convert the right-side evidence/debug area into tabs or accordion sections below the main workspace.
```

Stitch / v0 结果只能作为视觉参考。落地到本仓库时，Codex 必须使用本地 `apps/web/src/components/ui` 基础组件、共享 DTO 和真实 API 数据重写。

## 文档维护规则

当 Immersive 产品设计方向变化时，优先更新本文件。只有通用视觉语言、token、组件视觉规范或 CSS 实现变化时，才更新根目录 `DESIGN.md` 和 `system.css`。

需要同步更新本文件的情况：

- 新增 Report Workflow、Citation Checker、Eval Report 等主要页面。
- 改变 Agent run、tool calls、trace 的展示方式。
- 新增金融指标、图表、表格或 PDF 预览规范。
- 改变产品级信息架构、页面模块或核心用户流程。

