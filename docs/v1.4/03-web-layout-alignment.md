# 03 · ohna-web 布局对齐：工作区分组会话 + Trace 右侧抽屉 + 设置入口

> **需求来源**（用户决策，2026-10-20）：ohna-web 与预想有三处出入——
> ① 左侧会话需要展示 CLI 在**不同目录**产生的会话，并**按工作区分组**；
> ② 中间时间线**暂不调整**；
> ③ Trace 更像**排查问题的工具**，应做成 chat 页**右侧可折叠面板**，而不是独立三栏页；
> 另外 web 需要**设置入口**。
>
> **参考调研**（本轮实际探查结论，实施时按此对齐）：
> - **DeepSeek Harness（dsh）web**（0.1.6-alpha.1 / 0.1.7-rc.1 公开资料）：`Choose workspace` 多工作区选择；Settings 页配模型/工作区（即时生效）；**Trajectory** 运行轨迹（JSON 可展开/复制、PTC 代码、调用结果、恢复耗时）——定位与 ohna 的 trace 一致，是「排查工具」而非主时间线；侧栏 Terminal（多标签/刷新恢复）与 Office 预览为其工作台扩展，本期不对标。
> - **dsh 无独立后端服务（关键结论，见 §0.3）**：`npx @deepseek-ai/dsh web` 启动的 Web 服务器本身就是应用主体（默认 `127.0.0.1:3080`），内部是「Host/Worker + 一切皆插件（Cordis）」的单进程 Node.js 单体，没有独立的后端进程；会话以 append-only `SessionEvent` 日志持久化，LLM 历史由 `deriveMessages()` 派生而非单独存储。**这一形态与 ohna 完全一致**，证明 ohna 当前「CLI 进程内嵌 serve 提供 API + 托管静态 web」的单进程架构是正确路线，无需拆独立后端。
> - **CodeBuddy Remote Control**（`127.0.0.1:60545` 实测）：主聊天界面无全量文件树；设置页 = 左侧分区导航（连接状态/外观/通知/AI 同事/模型选择/权限模式/…）+ 右侧锚点内容区 + 顶部搜索框，连接状态展示「已连接 + 会话ID」；会话以智能体为中心分组；编辑器页 = 源代码管理（git 变更中心）。
> - 与 `02-web-llm-trace.md` 的关系：02 交付的 trace 采集/存储/SSE 能力**全部保留复用**；本文只改 **web 层的信息架构**（数据从哪展示、以什么形态展示）。
>
> 核心结论（本文要落地的三件事）：
> 1. **工作区分组是纯展示层工作**：`SessionMeta.workspaceRoot` 已随会话落盘（多 CLI 实例共享 `~/.ohna` dataDir，任一 web 实例能看到全部会话），只需 DTO 透出 + 侧栏分组渲染。
> 2. **Trace 从独立页降级为 chat 页右侧抽屉**：数据管线（`trace-projection` / `trace-client` / run-v2 SSE）原样复用，抽 hook 后供抽屉消费；`/trace` 路由与 `TracePage` 组件**直接删除**（阻断性升级，无深链兼容）。
> 3. **设置页走「本地只读 + UI 偏好本地持久化」路线**：连接状态/模型目录/权限模式来自 serve 只读端点；外观（主题/字号）存 localStorage；不新增任何写配置端点。
>
> 执行纪律：沿用 02 的七步法——每阶段「窄切片 + 可验收」、跑 §10 验收总闸相关子集、同步本文状态表 + `docs/v1.4/README.md` 配套计划句。
>
> **⚠️ 阻断性升级（2026-10-21 用户决策）**：当前项目无实际使用，不做向后兼容。由此简化的点：
> - `ConversationDto.workspaceRoot` 设**必填** `string`，不做空串兜底；`session-store` 读取时缺该字段的行**按坏行跳过**（删除空串兜底 `:78`）。
> - 侧栏分组**不做「早期会话」组**（无旧数据，空串不会出现）。
> - `/trace` 深链**直接删除**，不做重定向；`TracePage.tsx` 直接退役删除（其测试迁移到 hook/drawer）。
> - 旧数据迁移、兼容分支全部砍掉，D1/D6 中「空串兜底 / 深链保留」措辞作废，以本节为准。

---

## 0. 需求与现状锚点

### 0.1 需求判定

| 编号 | 需求 | 判定 |
|---|---|---|
| R1 | 会话侧栏展示 CLI 不同目录的会话，按工作区分组 | DTO 透出 `workspaceRoot` + 侧栏分组渲染；不新增 serve 分组 API |
| R2 | 中间时间线不做调整 | 本计划所有阶段不触碰 `chat.tsx` 时间线渲染与 `live-run-projection` |
| R3 | Trace 改为 chat 页右侧折叠展开面板 | 抽 `use-trace-stream` hook，新增 `TraceDrawer`；`/trace` 路由删除 |
| R4 | web 增加设置入口 | 新增 `/settings` 路由 + 导航 tab；分区布局对齐 CodeBuddy（分区导航 + 内容区） |

### 0.2 现状锚点（本轮探查结论，实施时按此验证）

1. **workspaceRoot 已落盘但未透出**：`packages/serve/src/store/session-store.ts:118`（`create` 写入）、`:78`（读取时旧数据兜底空串 `""`——阻断性升级将改为必填校验）；`packages/serve/src/routes/conversations.ts:70` 创建时传入 `deps.workspaceRoot`。但 `ConversationDto`（`packages/types/src/conversation.ts:19-27`）**没有**该字段——缺的只是 DTO 透出。
2. **多 CLI 实例天然共享数据目录**：serve 默认 `dataDir = ~/.ohna`（`packages/serve/src/index.ts:144`），`web-host.ts` 不覆盖。每个 CLI 进程各起一个 serve（端口自动 +1），但 conversations/runs JSONL 共享——**任一 web 实例的 `GET /api/conversations` 已能拿到所有工作区的会话**。分组不需要跨实例聚合。
3. **CLI 会话的只读语义已存在**：CLI host 会话标题 `CLI · <sessionId 前 8>`，observe 型 run 不写会话消息；chat 页已有 `showCliHint` 提示。跨工作区会话的交互边界可复用该模式（D2）。
4. **主题偏好已有现成实现**：`apps/ohna-web/src/app/theme.tsx`（localStorage `ohna.theme`，light/dark/system，挂载前恢复防闪烁）——设置页「外观」分区直接接入，不需要新机制。
5. **Trace 数据管线可整体复用**：`TracePage.tsx` 的会话/run/事件三层状态、`trace-projection.ts`（`projectTraceRows` 纯函数）、`trace-client.ts`（`listConversationRuns`）、`run-stream-client.ts`（replay/follow）均为组件外可复用单元；只有「三栏编排」是页面私有的。`Workbench.tsx` 已有 `has-detail-panel` 四列网格先例（`RunDetailPanel`），抽屉布局沿用同一模式。
6. **`/api/health` 返回 `workspaceRoot`**（`routes/health.ts:19`），`shared/mode.ts` 的 `fetchLocalMode` 已封装——设置页「连接状态」分区数据现成。
7. **文件树面板刚被移除**（commit `1711459`）：`features/files/` 已删、后端 `GET /api/local/fs` 保留。本计划不恢复文件树，也不动该端点。
8. **导航现状**：`app/workbench-nav.tsx` 只有「对话 / Trace」两个 tab——R3 落地后 Trace tab 语义变化、R4 需增「设置」tab，该文件是唯一改动点（router 在 `app/router.tsx`）。

---

### 0.3 后端服务形态结论：dsh 无独立后端，ohna 的「CLI 内嵌 serve」是正确路线

用户问题（本轮）：**dsh 有没有单独的后端服务？`apps/ohna-api/` 原本是给 `apps/ohna-web/` 提供接口的子包，要不要保留独立后端？**

**dsh 侧结论（已调研，非推断）：**

- dsh 只有一个入口命令 `npx @deepseek-ai/dsh web`，它直接启动 Web 应用（默认 `http://127.0.0.1:3080`）。仓库根目录甚至有过 `"cleanup: remove TUI package and legacy dsh entrypoints"` 的提交——**dsh 主动删掉了 TUI，只留 web 一种形态**。
- 架构是**单进程 Node.js 单体**：底层 Cordis 插件框架，内部用 Host/Worker 组织（Host 注册 HTTP 路由，Worker 承担计算），但**不存在独立的、需要单独部署的后端服务进程**。web 服务器就是应用本身。
- 会话持久化是 append-only `SessionEvent` 日志（JSONL），LLM 消息由 `deriveMessages()` 派生，服务通过 `SessionPersistence` seam 抽象（当前文件存储，可替换数据库）——**「同一份事件日志既是真源、也是 UI 与持久化的共享面」这一设计，与 ohna 的 serve 会话存储完全同构**。

**ohna 现状锚定（本轮读码确认）：**

| 事实 | 位置 | 含义 |
|---|---|---|
| `apps/ohna-api/` 是**薄入口**，只有 `index.ts`（进程生命周期 + 浏览器打开）+ `args.ts`（参数解析）两个源文件 | `apps/ohna-api/src/` | 它**不实现任何业务逻辑**，全部复用 `@aiagent/serve` 的 `createOhnaServer` |
| `ohna-api` 的 serve 装配与 `ohna-cli --web` 的 `hostOhnaWeb` **重复** | `apps/ohna-api/src/index.ts:115` vs `apps/ohna-cli/src/cli/web-host.ts:76` | 两处都在起 `createOhnaServer`，只是参数来源不同 |
| `ohna-cli` **已经是唯一主入口**：`--web` 走 `web-entry.ts → hostOhnaWeb`（进程内起 serve），默认走 TUI 本地执行 + 进程内 serve 只做镜像观测 | `apps/ohna-cli/src/cli/web-host.ts` / `web-entry.ts` | 后端能力已收敛到 `@aiagent/serve` 包，由 CLI 进程内嵌 |
| serve 是纯库（`createOhnaServer` 返回可 listen/close 的 Fastify 实例 + 会话句柄） | `packages/serve/src/index.ts` | 它是「能力包」，不是「服务进程」 |

**结论与取舍：**

1. **dsh 没有独立后端，ohna 也不应该有。** 两者的后端都应当是「CLI 进程内嵌的服务能力」，而不是单独部署的进程。ohna 的 `@aiagent/serve` 包 + CLI 内嵌起 serve 的现状，与 dsh 的 Cordis 插件内嵌 web 是同构的正确路线，无需为了对齐 dsh 而拆出独立后端。

2. **`apps/ohna-api/` 是历史遗留的「独立后端」入口，应当退役，而不是继续维护。** 它的功能已被 `ohna-cli --web`（`hostOhnaWeb`）完整覆盖，且是重复代码。保留它会造成两个装配点、两套参数面、两个启动横幅的分叉。建议：
   - **短期（本轮不做，另立项）**：把 `ohna-api` 标记 deprecated，README/help 引导用户用 `ohna --web`；保留 `ohna-cli` 作为唯一「CLI + 内嵌 serve」入口。
   - **中期**：删除 `apps/ohna-api/`（若确认无外部依赖 `ohna-api` 这个 bin）。
   - **本轮 web 布局对齐不依赖 `ohna-api`**：L1–L4 全部改在 `apps/ohna-web`（前端）+ `packages/serve`（DTO 透出）层，`ohna-api` 零改动。

3. **「按工作区分组」因此更简单**：既然后端是每个 CLI 实例内嵌、共享 `~/.ohna` dataDir，任一 web 实例的 `GET /api/conversations` 已能拿到所有工作区的会话（见 §0.2 锚点 2），分组不需要「聚合多个后端」——**只有一个逻辑后端（共享 dataDir），多个 CLI 进程只是它的宿主**。

> 记档：`apps/ohna-api/` 的去留是独立的架构决策，本方案 §4「不做清单」与 §5「开放项」补充对应条目，但不阻塞 L1–L4 的实施。

---

## 1. 架构决策（本轮拍板，实现时不再逐项讨论）

- **D1 · 分组是展示层，不改存储**：`ConversationDto` += `workspaceRoot: string`（**必填**，serve conversations 路由的 DTO 映射透出 `SessionMeta.workspaceRoot`）。web 侧栏按 `workspaceRoot` 分组，组头显示目录 basename（hover 展示全路径），组内按 `lastMessageAt` 倒序。**不做** serve 端 group-by 端点（数据量本地级，客户端分组足够）。
- **D2 · ~~跨工作区会话只读~~（已被 docs/v1.4/04 BUG-002 supersede，2026-10-21 留档，勿按原文实现）**：原文为「当前实例 workspaceRoot（来自 `/api/health`）与会话 `workspaceRoot` 不一致时，composer 禁用并提示『该会话属于其他工作区（<root>），请在对应目录的 ohna 会话中继续』——防止把消息发进错误工作区的 agent 上下文（消息存储共享但 agent 上下文是实例本地的）」。
  **现行语义**：跨工作区会话**可直接续写**。服务端 `RunManagerOptions.resolveWorkspace` 在 `createRun` 时按会话持久化的 `workspaceRoot` 动态装配编码工具与系统提示词（解析失败静默回退实例工作区，不阻断 run）；前端因此删除 `crossWorkspaceReadOnly` 守卫、composer 的 `readOnly` 入参与只读提示条，也不再按 `?workspaceRoot=` 拉本工作区会话列表——`submitAgentMessage` 直接用侧栏全量 `conversations` 查找目标会话。CLI observe 会话沿用现有 `showCliHint`。分组头可点击折叠（记忆在组件 state，不持久化）。
- **D3 · Trace 抽屉化，数据逻辑抽 hook**：
  - 新增 `features/trace/use-trace-stream.ts`：把 TracePage 内的会话列表加载 / run 列表加载 / 事件 replay-follow 续传 / 终态兜底逻辑抽成 hook，返回 `{conversations, runs, activeRun, rows, …, actions}`；
  - `TraceDrawer`（新组件）：挂在 Workbench 右侧，默认收起；chat 头部加「Trace」切换按钮；展开时 `agent-app-shell` 追加 `has-trace-panel` 列（复用 `has-detail-panel` 的四列网格模式，二者互斥时让位规则见 L2）；
  - 抽屉内数据**跟随当前会话**（不重复做会话选择），run 列表来自 `GET /api/conversations/:id/runs`；
  - `/trace` 路由**直接删除**，`TracePage.tsx` 组件退役删除（阻断性升级，无深链重定向）；「Trace」入口改为 Workbench 内的抽屉切换按钮。
- **D4 · 设置 = 本地只读信息 + UI 偏好**（docs/v1.4/05 FR-001 修订，2026-10-22）：~~路由 `/settings` + `WorkbenchNav` 增「设置」tab~~ → **chat 主区左下角入口 + 就地弹窗**（`SettingsDialog`，无独立路由）。布局仍对齐 CodeBuddy：左侧分区锚点导航 + 右侧内容区，只是内容从整页收进居中 `role="dialog"`。分区清单（本地版务实裁剪，全部无写端点）：
  1. **连接状态**（只读）：serve 端口/URL、workspaceRoot、dataDir 提示、observeOnly/autoApprove（来自 `/api/health` 与 `fetchLocalMode`）；
  2. **外观**：界面主题（接 `theme.tsx` 现有三态）、界面字号（`document.documentElement.style.fontSize` 缩放，localStorage `ohna.ui.fontSize`）；
  3. **模型**（只读）：复用 composer 的 `/api/models` 目录展示（名称/provider/能力），注明「模型由启动 ohna 时的 CLI 参数决定」；
  4. **权限模式**（只读）：展示当前 observeOnly / autoApprove 语义说明；
  5. **关于**：版本信息（`package.json` version 注入或 health 返回）。
  设置持久化只用 localStorage（`ohna.ui.*` 命名空间）；**不做**任何服务端配置写入（模型 key、CLI 参数都在进程侧，web 无法也不应改）。
- **D5 · 视觉沿用既有体系**：全部样式走 `DESIGN.md` / `system.css` tokens；抽屉/分区导航复用 `run-details`、`confirmation-card` 的既有视觉语言；不发明第二套面板样式。
- **D6 · TracePage 三栏编排退役，路由删除**：`/trace` 深链与 `TracePage` 组件**直接删除**（阻断性升级，无兼容负担）；`WorkbenchNav` 的「Trace」tab 语义改为「展开/收起 Trace 抽屉」（激活态 = 抽屉展开）。

---

## Phase L1 · 会话侧栏按工作区分组

**目标**：侧栏会话按 workspaceRoot 分组展示，~~跨工作区会话只读保护~~ → **跨工作区会话可直接续写**（D2 已被 docs/v1.4/04 BUG-002 supersede）。验收后 CLI 在任意目录起的会话都能在同一个 web 里按目录归位，并可在当前 web 实例中直接继续对话。

**交付清单（文件级）**：

1. `packages/types/src/conversation.ts`：`ConversationDto` += `workspaceRoot: string`（必填，JSDoc：产生该会话的 serve 实例工作区根）。`CreateConversationRequestDto` 不变（创建方一律服务端填充）。
2. `packages/serve/src/routes/conversations.ts`：列表/详情的 DTO 映射透出 `meta.workspaceRoot`；`getRunSnapshot` 等复用同一映射的点同步。
3. `packages/serve/src/store/session-store.ts`：`toSessionLine` 的 `workspaceRoot` 空串兜底 `:78` 改为**必填校验**（缺字段/空串的行按坏行跳过）——阻断性升级，无历史数据需兼容。
4. `apps/ohna-web/src/features/workbench/sidebar.tsx`：
   - 按 `workspaceRoot` 分组（`useMemo` 客户端 group-by；组内按 `lastMessageAt` 倒序，组间按组内最新时间倒序）；
   - 组头：目录 basename + 相对时间徽标（可选），title 属性挂全路径；
   - 组头点击折叠/展开（组件 state）。
5. `apps/ohna-web/src/features/workbench/Workbench.tsx`：~~D2 只读保护——`localMode.workspaceRoot !== activeConversation.workspaceRoot` 时 composer 禁用 + 提示行~~ → **已删除**（BUG-002）：composer 不再有 `readOnly` 入参，跨工作区会话直接可输入、可 `submitAgentMessage`。
6. 测试：
   - `packages/serve/test/`（现有 conversation 测试文件内补用例）：DTO 含 workspaceRoot、缺字段行被跳过；
   - `apps/ohna-web/src/features/workbench/sidebar`（vitest）：多工作区 fixture → 分组渲染顺序、折叠交互；
   - `apps/ohna-web/src/features/workbench/Workbench.cross-workspace.test.tsx`（原 `Workbench.readonly.test.tsx`，BUG-002 后改名改写）：跨工作区会话 textarea 未禁用、无只读提示、可直接发送，且不再发出带 `?workspaceRoot=` 的列表请求。

**验收**：

```bash
pnpm --filter @aiagent/types typecheck && pnpm --filter @aiagent/serve test
pnpm --filter @aiagent/ohna-web test && pnpm typecheck && pnpm architecture:check
```

**完成判据**：在 `~/code/a` 与 `~/code/b` 各跑一次 `ohna`（各产生 1 个 CLI 会话）→ 任一端口的 web 侧栏出现两个分组，会话各归其位；选中另一工作区的会话时 composer 呈只读态且原当前工作区会话不受影响。

---

## Phase L2 · Trace 右侧抽屉

**目标**：trace 成为 chat 页右侧可折叠面板，跟随当前会话；`/trace` 路由与 `TracePage` 组件删除。验收后排查一个 run 的 LLM 请求/响应不需要离开对话页。

**交付清单（文件级）**：

1. `apps/ohna-web/src/features/trace/use-trace-stream.ts`（新）：从 `TracePage.tsx` 抽出数据编排——`loadConversations`（抽屉场景退化为只加载当前会话的 runs）/ `loadRuns(conversationId)` / 事件 replay + follow 续传（AbortController 生命周期）/ `terminalFallback` 合成 / `projectTraceRows` 消费。hook 契约：
   ```ts
   export function useTraceStream(conversationId: string | undefined): {
     runs: RunMetaDtoV2[];
     activeRunId: string;
     rows: TraceRow[];
     isLoading: boolean;
     error: string | undefined;
     selectRun(runId: string): void;
   }
   ```
   抽屉场景**不需要** conversations 列表状态（Workbench 已有），hook 只收 conversationId。
2. `apps/ohna-web/src/features/trace/TraceDrawer.tsx`（新）：右侧面板壳——头部（标题「Trace · <conversation 标题>」+ 收起按钮 + run 选择下拉/列表）+ `TraceStream` 复用（事件行渲染、`LlmCallBlock` 一等公民、复制 JSON 原样保留）。空态：会话无 run 时提示「本会话还没有运行记录」。
3. `apps/ohna-web/src/features/workbench/Workbench.tsx`：
   - `isTraceOpen` 状态（初始收起，不读 URL）；chat 头部 actions 区加 Trace 切换按钮（`ChatHeader` 增加 `traceToggle` 插槽或复用 `nav` 插槽旁的动作位）；
   - 布局：`agent-app-shell` 追加 `has-trace-panel`；与 `has-detail-panel` 同现时 trace 优先、detail 关闭（互斥规则：打开 Trace 抽屉收起 RunDetailPanel，反之亦然——二者都是「右侧排查位」）；
   - 会话切换时抽屉保持展开态、数据随 conversationId 切换（hook 内部处理竞态）。
4. `apps/ohna-web/src/app/router.tsx` + `workbench-nav.tsx`：**删除 `/trace` 路由**（router 只留 `*` → Workbench）；`workbench-nav.tsx` 删「Trace」独立 tab，改为 Workbench 内的抽屉切换按钮（阻断性升级，无深链）。
5. 删除 `TracePage.tsx` 与 `TracePage.test.tsx`（其测试迁移到 hook + drawer）；`TraceStream.tsx` / `trace-projection.ts` / `trace-client.ts` / `LlmCallBlock.tsx` 不动。
6. `styles.css`：`has-trace-panel` 列宽与响应式（对齐 `has-detail-panel` 模式）；移动端抽屉改全屏 overlay（沿用 sidebar drawer 先例）。
7. 测试：
   - `use-trace-stream` hook 测试：run 加载、replay/follow 续传、terminalFallback、conversationId 切换竞态（复用 TracePage 现有 fixture）；
   - `TraceDrawer` 渲染测试：run 列表、事件行、空态；
   - `Workbench.test.tsx`：按钮切换、detail/trace 互斥。

**验收**：

```bash
pnpm --filter @aiagent/ohna-web test && pnpm --filter @aiagent/ohna-web build
```

**完成判据**：CLI 跑一个含工具调用的任务 → chat 页点「Trace」展开抽屉 → 当次 run 出现在列表，`llm_call` 可展开看到 providerPayload 与响应；刷新后抽屉默认收起（无 URL 状态），展开后 replay 恢复完整事件；`/trace` 路由已不存在。

---

## Phase L3 · 设置（就地弹窗）

**目标**：web 有设置入口，布局对齐 CodeBuddy（分区导航 + 内容区），本地只读信息 + UI 偏好本地持久化。

> **FR-001 修订（2026-10-22）**：入口从「顶部导航设置 tab + 独立 `/settings` 路由页」改为「chat 主区左下角按钮 + 就地弹窗」。下方交付清单为初版记录，现行形态以 §FR-001 修订说明与 `05-feature-requests.md` 为准。

**交付清单（文件级，初版）**：

1. ~~`apps/ohna-web/src/app/router.tsx`：`/settings` 路由；`workbench-nav.tsx` += 「设置」tab。~~（FR-001 已删除）
2. ~~`apps/ohna-web/src/features/settings/SettingsPage.tsx`（新）：页面壳~~ → `SettingsDialog.tsx`（FR-001）：左分区锚点导航（连接状态/外观/模型/权限/关于）+ 右内容区；标题 + 说明行（「适用于当前 ohna 进程 · 由启动参数决定」）。
3. `apps/ohna-web/src/features/settings/`（按分区拆纯展示子组件，壳组件只做编排）：
   - `ConnectionSection.tsx`：`fetchLocalMode` + health 数据展示（URL/workspaceRoot/observeOnly/autoApprove/dataDir 提示）；
   - `AppearanceSection.tsx`：主题三态切换（接 `useTheme`）；界面字号（小/标准/大/特大 → 根字号缩放，localStorage `ohna.ui.fontSize`，`applyInitialTheme` 同款挂载前恢复防闪烁）；
   - `ModelsSection.tsx`：复用 composer 的模型目录接口（只读列表：label/provider/能力徽标）；
   - `PermissionSection.tsx`：observeOnly / autoApprove 语义说明 + 当前值；
   - `AboutSection.tsx`：版本信息。
4. `apps/ohna-web/src/app/theme.tsx`：扩展为 `ui-preferences`（主题 + 字号），保持 `ohna.theme` key 兼容；字号应用点在根 `html` style。
5. 测试（vitest，fixture mock health/models 接口）：分区渲染、主题切换写入 localStorage、字号持久化、models 只读列表、导航 tab 激活态。

**验收**：

```bash
pnpm --filter @aiagent/ohna-web test && pnpm --filter @aiagent/ohna-web build
```

**完成判据**：五个分区可导航，主题/字号改后刷新保持；不出现任何可写服务端配置的控件；对话页与 Trace 抽屉在字号调整后无布局破损（手工抽查）。

### FR-001 修订记录（2026-10-22）

设置改为**主区左下角按钮 + 就地弹窗**，不再有独立路由页：

- 新增 `features/settings/SettingsDialog.tsx`：居中 `role="dialog"`（`aria-modal`），遮罩 / 右上角关闭 / ESC / 遮罩点击均可关闭；打开时焦点移入面板、关闭后归还触发按钮、Tab 在面板内循环；`isOpen=false` 时整体不渲染，分区组件与 `useSettingsHealth` 随之卸载（探针 `AbortController` 随之中止）。
- 新增 `features/workbench/chat-main.tsx`：把原 `chat-main` 网格抽成 `ChatMain` 组件，并在 composer 同一底行右侧放置 `.settings-entry-button`（`aria-haspopup="dialog"`）。底行 `grid-template-columns: minmax(0, 1fr) max-content`，composer 限宽 `min(100%, 1028px)`，保证 860px 内容光轴居中、按钮落在左下角且不遮挡消息。
- 删除 `/settings` 路由（`router.tsx` 只剩 `*` → Workbench）、`WorkbenchNav` 的「设置」tab（组件不再自带 `<nav>`，由 chat 头部统一包 `工作台导航` landmark）、`SettingsPage.tsx`。
- 测试：`router.test.ts`（断言不再注册 `/settings`）、`SettingsDialog.test.tsx`（15 例：分区渲染 / 开关 / 三种关闭 / 卸载中止探针 / 焦点归还 / 只读边界）、`Workbench.settings.test.tsx`（左下角入口开弹窗 + 导航无设置 tab）。
- CSS：`.chat-main-footer` / `.settings-entry-button` / `.settings-dialog*`；原 `.settings-page` / `.settings-header` / `.settings-layout` 全屏页样式退役。

---

## Phase L4 · 验证脚本与文档同步

1. `test/verify-ohna-web-layout.mjs`（根 test/，人工调试入口合规）：
   - 两个临时工作区目录各起一个 serve stub（注入不同 workspaceRoot 的会话）→ 断言 `GET /api/conversations` 返回的 DTO 携带各自 workspaceRoot；
   - web dist 存在时 `GET /settings`、`GET /trace` 均回落 200（路由已删，命中 `*` → Workbench）。
2. 文档同步：本文 §状态表 + `docs/v1.4/README.md` 配套计划句 += 本文 + `AGENTS.md` `apps/ohna-web` 段（Trace 抽屉 / 设置页 / 会话分组一句，落地后同步，不在启动前改）。

---

## 2. 测试用例清单（编号可逐条验收）

| ID | 阶段 | 用例 | 关键断言 |
|---|---|---|---|
| TC-L1-01 | L1 | DTO 透出 | `GET /api/conversations` 每项含 `workspaceRoot`；缺字段行被跳过 |
| TC-L1-02 | L1 | 分组渲染 | 两个工作区 fixture → 两个组、组内倒序 |
| TC-L1-03 | L1 | 折叠交互 | 组头点击折叠/展开，仅影响该组 |
| TC-L1-04 | L1 | 跨工作区续写（原「跨工作区只读」，BUG-002 supersede） | 激活会话 workspaceRoot ≠ 当前实例 → composer 可输入、无只读提示、可直接发送；同工作区不受影响；不再发出带 `?workspaceRoot=` 的列表请求 |
| TC-L2-01 | L2 | hook 数据编排 | run 加载 / replay 恢复 / follow 续传 / terminalFallback / 切换会话竞态丢弃 |
| TC-L2-02 | L2 | 抽屉渲染 | run 列表 + 事件行 + LlmCallBlock 展开 + 空态文案 |
| TC-L2-03 | L2 | 路由删除 | `/trace` 路由已移除，访问回落到 Workbench |
| TC-L2-04 | L2 | 右侧位互斥 | 打开 Trace 收起 RunDetailPanel，反之亦然 |
| TC-L3-01 | L3 | 分区导航 | 五分区锚点导航 + 内容区渲染（弹窗内） |
| TC-L3-02 | L3 | 外观持久化 | 主题/字号写入 localStorage 并在挂载前恢复 |
| TC-L3-03 | L3 | 只读边界 | 设置弹窗无任何写配置请求发出（断言 fetch 调用集合） |
| TC-FR-001 | FR-001 | 弹窗形态 | 左下角入口开弹窗；关闭按钮 / 遮罩 / ESC 均可关闭；关闭即卸载内容中止探针；焦点开入关出；导航无设置 tab；路由无 `/settings` |
| TC-L4-01 | L4 | 端到端 | 两工作区 stub → DTO 字段正确；`/settings`、`/trace` 兜底 200 |

---

## 3. 参考对照表（调研结论 → 本方案取舍）

| 参考（dsh web / CodeBuddy） | 能力 | 本方案取舍 |
|---|---|---|
| dsh `Choose workspace` | 多工作区选择与切换 | **不照搬**：ohna 的多工作区来自多 CLI 实例共享 dataDir，web 做「分组展示」而非「切换执行上下文」（D2 只读边界） |
| dsh Trajectory | JSON 展开/复制、调用结果、耗时 | **已具备**：02 的 `LlmCallBlock` + `TraceStream` 等价能力，L2 仅换展示位置 |
| dsh Settings | 配模型/工作区，即时生效 | **裁剪**：本地版凭据与模型在 CLI 进程侧，设置页只读展示（D4） |
| CodeBuddy 设置页布局 | 分区锚点导航 + 内容区 + 搜索 | **采纳布局**；搜索框本期不做（分区少，收益低，开放项） |
| CodeBuddy 连接状态 | 已连接 + 会话 ID | **采纳**：展示 serve URL / workspaceRoot / 模式 |
| CodeBuddy 侧栏 Terminal / 资源管理器 | 工作台工具面板 | **不做**（开放项 §5-4/5） |

---

## 4. 不做清单（明确排除，防止范围膨胀）

- **不动中间时间线**：`chat.tsx` 时间线渲染、`live-run-projection`、确认卡片逻辑零 diff（R2）。
- **不做服务端分组/聚合端点**：分组在客户端 `useMemo` 完成（D1）。
- **不做跨实例写操作**：~~跨工作区会话只读~~ → 跨工作区会话可在当前实例续写（D2 已由 BUG-002 supersede），但仍不做「远程接管另一个 serve 进程」（不向其他实例发请求，也不切实例的 `dataDir` / 端口）。
- **不做设置写端点**：模型、权限、CLI 参数均在进程侧，web 设置只读 + UI 偏好本地化（D4）。
- **不恢复文件树 / 不新增 Terminal 面板**：刚移除的全量文件树不回退；dsh 式侧栏 Terminal 属工作台扩展，开放项。
- **不删 `/api/local/fs`**：后端只读能力保留（与文件树解耦）。
- **不动 `apps/ohna-api/`**：本轮 L1–L4 零改动该入口；其退役是独立架构决策（§0.3 结论 2），不并入本计划。

---

## 5. 开放项（本期不实施，留档案）

1. 工作区注册中心：serve 侧维护「活跃实例列表」（心跳 + workspaceRoot + 端口），web 可展示「哪些工作区正在运行」并深链——多实例发现需要新端点，本期用共享 dataDir 的隐式聚合即可。
2. 设置页搜索框（分区增多后引入，对齐 CodeBuddy）。
3. 通知/语言分区（CodeBuddy 有；本地版当前无通知系统，i18n 未立项）。
4. 侧栏 Terminal / Office 预览（dsh 0.1.7 对标项，依赖 xterm.js 与文档解析，另立计划）。
5. Trace 抽屉内跨 run 搜索/过滤（02 开放项 §8-5 的延续，抽屉化后更顺手）。
6. 「对话内显示文件变更」摘要行（CodeBuddy 设置项；依赖 edit/write 工具结果中的 diff 详情，需先确认工具 details 契约）。
7. `apps/ohna-api/` 退役：deprecated 引导 → 确认无外部依赖后删除（`ohna-cli --web` 已是唯一「CLI + 内嵌 serve」入口，二者 serve 装配重复，见 §0.3）。独立立项，不阻塞本文。

---

## 6. 风险与缓解

| 风险 | 说明 | 缓解 |
|---|---|---|
| workspaceRoot 缺失的旧数据 | 02 之前的会话行无该字段 | 阻断性升级：`toSessionLine` 缺字段行直接跳过（必填校验），不做空串兜底与「早期会话」组 |
| 跨实例 JSONL 并发写 | 多 CLI 实例同写 `~/.ohna`（现状已如此） | 本方案不改变写入拓扑；分组只读消费。风险转记开放项 §5-1（注册中心顺带解决隔离） |
| 抽屉与 detail 面板布局冲突 | 两者都是右侧位 | 互斥规则（D3/L2-3）+ TC-L2-04 |
| `/trace` 深链被删 | 阻断性升级，删除路由与 TracePage | 无兼容负担；`workbench-nav.tsx` 同步移除该 tab（TC-L2-03） |
| hook 抽取回归 | TracePage 逻辑迁移可能丢终态兜底/竞态处理 | hook 测试沿用 TracePage 现有 fixture 全量迁移（TC-L2-01），TracePage 原测试不删只改挂载点 |
| 设置页变成伪需求 | 本地版可配置项少 | 分区全部来自既有只读端点与已有 theme 实现，增量成本低；写配置明确不做（D4） |

---

## 7. 验收总闸（每个 Phase 跑相关子集）

```bash
pnpm --filter @aiagent/types typecheck
pnpm --filter @aiagent/serve test
pnpm --filter @aiagent/ohna-web test
pnpm typecheck
pnpm architecture:check
pnpm build
```

端到端（L2/L4 完成时）：

```bash
test/verify-ohna-web-layout.mjs
pnpm --filter @aiagent/ohna-cli dev   # 手工：两个目录各起一次 CLI → 分组/抽屉/设置三链路走查
```

---

## 8. 状态表（随阶段完成更新）

| 阶段 | 内容 | 状态 |
|---|---|---|
| L1 | 会话侧栏按工作区分组 + ~~跨工作区只读~~ → 跨工作区续写（BUG-002 supersede） | ✅ 已完成（2026-10-21；只读守卫于 BUG-002 修复时移除） |
| L2 | Trace 右侧抽屉（hook 抽取 + `/trace` 删除） | ✅ 已完成（2026-10-21） |
| L3 | 设置（分区导航 + 只读信息 + UI 偏好）；FR-001 后为左下角入口 + 就地弹窗，无独立路由 | ✅ 已完成（2026-10-21；2026-10-22 按 FR-001 修订） |
| L4 | 验证脚本 + 文档同步 | ✅ 已完成（2026-10-21） |
| L5 | 后续修复（实施中发现，见 §9） | ✅ 已完成（2026-10-21） |

---

## 9. 实施记录（2026-10-21）

### 9.1 落地文件（相对交付清单的偏差已注明原因）

| 阶段 | 文件 | 说明 |
|---|---|---|
| L1 | `packages/types/src/conversation.ts` | 新增 `WorkspaceConversationDto extends ConversationDto`（`workspaceRoot` 必填）**替代**原计划「给 `ConversationDto` 加必填字段」——见 §9.2-① |
| L1 | `packages/serve/src/routes/conversations.ts` | DTO 映射透出 `workspaceRoot`；**新增可选 `?workspaceRoot=` 过滤**（见 §9.2-②） |
| L1 | `packages/serve/src/store/session-store.ts` | `workspaceRoot` 必填校验，缺字段/空串按坏行跳过（删空串兜底） |
| L1 | `apps/ohna-web/src/features/workbench/sidebar.tsx` | `groupConversationsByWorkspace` 纯函数 + 组头折叠（`aria-label="工作区 <名>（N 个会话）"`，title 挂全路径） |
| L1 | `apps/ohna-web/src/features/workbench/{Workbench,chat,composer-controls}.tsx` | ~~跨工作区只读：提示条 + textarea/发送双禁用 + `submitAgentMessage` 兜底拦截~~ → **BUG-002 已全部移除**（`crossWorkspaceReadOnly` / `readOnly` 入参 / 只读提示条 / `?workspaceRoot=` 列表请求）；现为跨工作区直接续写。相关测试改名 `Workbench.cross-workspace.test.tsx` |
| L2 | `apps/ohna-web/src/features/trace/use-trace-stream.ts`（新） | 会话 → run 列表 → replay/follow → 刷新 → terminalFallback；`enabled` 参数支持抽屉收起零请求；代次号丢弃迟到响应 |
| L2 | `apps/ohna-web/src/features/trace/TraceDrawer.tsx`（新） | 抽屉壳 + run 选择条 + `TraceStream` 复用；空态「本会话还没有运行记录。」 |
| L2 | `apps/ohna-web/src/features/trace/{TracePage.tsx,TracePage.test.tsx}` | **已删除**（用例迁移到 `use-trace-stream.test.tsx` / `TraceDrawer.test.tsx`，fixture 抽到 `trace-fixtures.ts`） |
| L2 | `apps/ohna-web/src/app/{router,workbench-nav}.tsx` | 删除 `/trace` 路由与 Trace tab；新增 `TraceToggle`（`aria-expanded` / `aria-pressed` 反映抽屉态） |
| L2 | `apps/ohna-web/src/features/workbench/Workbench.tsx` | `isTraceOpen`（不读 URL）+ `has-trace-panel` + 与 `RunDetailPanel` 双向互斥 |
| L3 | `apps/ohna-web/src/app/theme.tsx` | 扩展为 UI 偏好（主题 + 字号 `ohna.ui.fontSize`），保留 `ohna.theme` key 与 `useTheme` 别名 |
| L3 | `apps/ohna-web/src/features/settings/*`（新） | `SettingsPage` 壳 + `ConnectionSection` / `AppearanceSection` / `ModelsSection` / `PermissionSection` / `AboutSection` + `settings-primitives` / `settings-health` |
| FR-001 | `apps/ohna-web/src/features/settings/{SettingsDialog.tsx,SettingsDialog.test.tsx}`（新） | 就地弹窗壳（focus 移入/归还、Tab 环、ESC/遮罩/按钮三种关闭、`isOpen=false` 不渲染）；接替 `SettingsPage.tsx` + `SettingsPage.test.tsx`（已删除） |
| FR-001 | `apps/ohna-web/src/features/workbench/{chat-main.tsx,Workbench.settings.test.tsx}`（新） | `ChatMain`：`chat-main` 网格 + 与 composer 同底行的左下角 `.settings-entry-button`；`composer-controls` 增 `formId`（发送键 `form` 关联，停止态改为 `type="submit"` + `preventDefault`） |
| FR-001 | `apps/ohna-web/src/app/{router,workbench-nav}.tsx` | 删除 `/settings` 路由（只剩 `*` → Workbench）与「设置」tab；`WorkbenchNav` 退化为 tab 片段（不再自带 `<nav>`），chat 头部统一包 `工作台导航` landmark |
| L3 | `apps/ohna-web/vite.config.ts` + `src/vite-env.d.ts` | `__OHNA_WEB_VERSION__` 构建期注入（关于分区版本号，不新增端点） |
| L3 | `apps/ohna-web/{test/setup.ts,tsconfig.json}` | 该 jsdom 构建缺 `localStorage` / `matchMedia`，补齐测试垫片；声明 vitest globals |
| L4 | `test/verify-ohna-web-layout.mjs`（新） | 双工作区共享 dataDir 的 DTO / 分组 / 过滤断言 + `/settings` 200 + `/trace` 回落 200 + 构建产物无 TracePage chunk |
| L4 | `apps/ohna-cli/src/ui/welcome.ts` | 观测台提示改为「对话页右上「Trace」抽屉」，不再指向已删除的 `/trace` |

### 9.2 实施中的决策与修正

1. **`ConversationDto` 不加必填字段**：直接加字段会让产品 A（`apps/finance-api` / `finance-web`）编译失败，而该产品线「保持不动、独立演进」且没有「工作区」概念。改为新增 `WorkspaceConversationDto extends ConversationDto`，ohna 侧（serve 路由 + ohna-web）全部切到子类型；金融侧零改动。03 原决策「`ConversationDto += workspaceRoot` 必填」从这一角度作废，其余（无空串兜底）保持不变。
2. **新增 `?workspaceRoot=` 过滤而非纯前端守卫**（**已被 BUG-002 supersede**，保留历史理由）：当时只读保护只靠 UI 存在一条漏洞——侧栏 `loadConversationPage` 的**分页追加**不走 `listConversations` 的首屏过滤，深页里会混入其他工作区会话，`submitAgentMessage` 找不到会话时会**自动新建一条并发消息**。彼时 composer 通过 `?workspaceRoot=` 维护本工作区候选列表，跨工作区会话不在候选里，`submitAgentMessage` 另有 `crossWorkspaceReadOnly` 兜底。
   **现行做法**：只读语义整体取消后，这条漏洞的前提（「会话不该出现在候选里」）不复存在——web 不再发 `?workspaceRoot=` 列表请求，`workspaceConversations` state、`appendWorkspaceConversation` 与该 effect 一并删除；`submitAgentMessage` 直接在侧栏全量 `conversations` 中查找目标会话（侧栏即唯一事实源：会话要么从侧栏选中，要么新建后 prepend）。服务端 `?workspaceRoot=` 过滤端点保留（CLI / 脚本仍可用），只是 web 不再消费。
3. **hook 契约扩了一点**：`useTraceStream` 额外返回 `activeRunMeta`（抽屉头部展示 mode/source/modelId/requestId）与 `enabled` 入参；D3 约定的五个字段全部保留。
4. **run 选择条取代 run 列表**：抽屉宽度有限，run 列表改为横向 chip（状态徽标 + 相对时间，title 挂完整 runId），点击切换；`TraceStream` 与 `LlmCallBlock` 零改动。
5. **互斥实现**：`toggleTrace()` 打开抽屉时清空 `selectedRunDetail`，`openRunDetail()` 打开详情时清空 `isTraceOpen`；二者都映射到 `agent-app-shell` 的列位 class，故同一时刻最多一个右侧面板。

### 9.3 验收结果

```bash
pnpm --filter @aiagent/types typecheck       # ✅
pnpm --filter @aiagent/serve test            # ✅ 39 passed（含 workspaceRoot DTO / 坏行跳过 / 过滤）
pnpm --filter @aiagent/ohna-web test         # ✅ 90 passed（14 files）
pnpm typecheck                               # ✅
pnpm architecture:check                      # ✅ no dependency violations (684 modules)
pnpm test                                    # ✅ 全仓通过
pnpm build                                   # ✅ 全仓通过
node test/verify-ohna-web-layout.mjs         # ✅ 7 条断言全过
```

对照 §2 用例清单：TC-L1-01 ✅（serve 测试 + 验证脚本）、TC-L1-02 ✅（`groupConversationsByWorkspace`）、TC-L1-03 ✅（`sidebar.test.tsx`）、TC-L1-04 ✅（**BUG-002 后改写为跨工作区续写断言**：`Workbench.cross-workspace.test.tsx`，原 `Workbench.readonly.test.tsx`）、TC-L2-01 ✅（`use-trace-stream.test.tsx` 9 例）、TC-L2-02 ✅（`TraceDrawer.test.tsx` 8 例）、TC-L2-03 ✅（`router.test.ts` + 构建产物）、TC-L2-04 ✅（`Workbench.trace.test.tsx`）、TC-L3-01/02/03 ✅（`SettingsPage.test.tsx` 8 例 → FR-001 后迁移为 `SettingsDialog.test.tsx` 15 例 + `Workbench.settings.test.tsx` 2 例）、TC-FR-001 ✅（同上，2026-10-22）、TC-L4-01 ✅（验证脚本）。

### 9.4 遗留与风险

- L2 完成判据中的「刷新后 replay 恢复完整事件」「字号调整后手工抽查布局」属人工走查项，本次只跑了自动化验收；
- ~~侧栏分页追加仍可能把跨工作区会话混入侧栏全量列表，但已不影响 composer 的会话归属~~：BUG-002 后侧栏全量列表**就是** composer 的候选源（跨工作区会话本就允许续写），此项不再是风险；
- `apps/ohna-api/` 去留仍未决（§5-7）。
