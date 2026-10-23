# v1.4 · 功能 / 改动请求记录

> 本文记录 v1.4 阶段提出的**功能改动 / 交互调整请求**（区别于 `04-bug-tracking.md` 的缺陷记录）。
> 每条包含**编号 + 标题、需求描述、现状、涉及改动范围**；只记录、不承诺排期，实现时再落到对应实施计划。

---

## FR-001 · 设置入口改为左下角按钮 + 就地弹窗（去掉独立路由）

> 状态：✅ 已实现（2026-10-22）。落地说明见文末「实现记录」，设计侧同步见 `03-web-layout-alignment.md` §D4 / §Phase L3 / §9.1。

### 需求描述

- 设置功能入口放到**主区左下角**（聊天主区域底部角落）。
- 设置内容改用**弹窗（Modal/Dialog）**呈现，不再跳转到独立的 `/settings` 路由页面。

### 现状

设置当前是**独立路由页**，由顶部主导航的「设置」tab 进入：

- 路由：`apps/ohna-web/src/app/router.tsx` 注册了 `/settings`（lazy 加载 `SettingsPage`）。
- 顶部导航：`apps/ohna-web/src/app/workbench-nav.tsx` 的 `WorkbenchNav` 渲染「对话」「设置」两个 tab，「设置」用 `NavLink to="/settings"`。
- 页面：`apps/ohna-web/src/features/settings/SettingsPage.tsx` 为两栏全屏页（左分区锚点导航 + 右内容区），内部用 `WorkbenchNav active="settings"`。
- 数据：`useSettingsHealth()`（`settings-health.ts`）探针 + 五个分区组件（`ConnectionSection` / `AppearanceSection` / `ModelsSection` / `PermissionSection` / `AboutSection`），均为只读展示 + 本地偏好（主题/字号写 localStorage）。

### 涉及改动范围（实现时再细化）

1. **新增弹窗容器**：把 `SettingsPage` 的分区内容（`SectionBody` + 五个分区组件 + 左侧分区导航）包进一个居中 `dialog`（遮罩 + 关闭按钮 + ESC/点击遮罩关闭）。分区组件与 `useSettingsHealth` 可原样复用。
2. **左下角入口**：在 `chat-main` 主区底部角落（composer 区域下方或左下角固定位）加一个「设置」按钮，点击打开弹窗。
3. **移除旧入口**：删除 `/settings` 路由（`router.tsx`）、`WorkbenchNav` 里的「设置」tab，以及 `SettingsPage.tsx`（或将其退化为被弹窗复用的内容组件）。
4. **CSS**：新增弹窗样式（遮罩 / 居中面板 / 响应式）与左下角按钮样式；弹窗内沿用现有 `.settings-*` 类。
5. **测试**：`router.test.ts`（移除 `/settings` 断言）、`SettingsPage.test.tsx`（改为弹窗的渲染/开关/关闭/只读边界回归）、`Workbench` 相关测试（设置按钮开弹窗）。
6. **文档**：同步 `03-web-layout-alignment.md` 中 L3「设置页」的描述（从独立路由改为就地弹窗）。

### 备注

- 弹窗需挂在 `ThemeProvider` 下（主题/字号偏好上下文），复用现有 `useUiPreferences`。
- 弹窗打开期间的健康探针 fetch 建议随弹窗关闭（组件卸载）用 AbortController 中止，避免不必要的只读请求。

---

### 实现记录（2026-10-22）

| 改动项 | 落地 |
|---|---|
| 弹窗容器 | `apps/ohna-web/src/features/settings/SettingsDialog.tsx`：`role="dialog"` + `aria-modal` + `aria-labelledby`；遮罩、右上角关闭按钮、ESC、遮罩点击四种关闭方式；打开时焦点移入面板、关闭后归还触发按钮、Tab 在面板内循环；`isOpen=false` 时整体不渲染，分区组件与 `useSettingsHealth` 随之卸载（探针 AbortController 中止，满足备注第 2 条）。分区组件与 `useSettingsHealth` 原样复用，未改动。 |
| 左下角入口 | `apps/ohna-web/src/features/workbench/chat-main.tsx`（新）：把 `chat-main` 网格抽成 `ChatMain`，在 composer 同一底行右侧放 `.settings-entry-button`（`aria-haspopup="dialog"`）。底行 `grid-template-columns: minmax(0, 1fr) max-content`，composer 限宽 `min(100%, 1028px)`，保证 860px 内容光轴居中、按钮落在左下角且不遮挡消息；<900px 只留图标。 |
| 移除旧入口 | `router.tsx` 只剩 `*` → Workbench；`WorkbenchNav` 删除「设置」tab（组件不再自带 `<nav>`，chat 头部统一包 `工作台导航` landmark），签名简化为无参；`SettingsPage.tsx` 删除（内容并入弹窗）。 |
| CSS | 新增 `.chat-main-footer` / `.settings-entry-button` / `.settings-dialog{,-backdrop,-header,-title-group,-layout}`；`.chat-composer` 不再承担边框/背景/内边距（上移到底行），退役 `.settings-page` / `.settings-header` / `.settings-layout`。移动端弹窗全屏、底行只留设置图标。 |
| 测试 | `app/router.test.ts` 改写（断言不再注册 `/settings`，只剩 `*`）；`SettingsDialog.test.tsx`（15 例，含开关 / 三种关闭 / 卸载中止探针 / 焦点归还 / 只读边界）；`Workbench.settings.test.tsx`（2 例：左下角入口开弹窗、导航无设置 tab）；`Workbench.trace.test.tsx` 头注释同步。 |
| 文档 | 本文、`03-web-layout-alignment.md`（§D4、§Phase L3 + FR-001 修订记录、§状态表、§2 用例清单 TC-FR-001、§9 实施记录）、`docs/v1.4/README.md`、`AGENTS.md` `apps/ohna-web` 段。 |

**验证**：`pnpm --filter @aiagent/ohna-web test`（18 文件 / 128 例全过）、`typecheck`、`build`；另用无头 Chrome 在 1440 / 1024 / 760 三档视口实测：按钮与 composer 同底行（不重叠、不压消息）、弹窗完整落在视口内、焦点开入关出正确。

**遗留**：弹窗内的分区锚点仍是 `href="#settings-<id>"` 的页内跳转（沿用原实现，作用在可滚动的 `.settings-content` 上）；若后续要支持浏览器后退栈内关闭弹窗，需要引入 history 状态，本期不做。
