# 玻璃 Glass Depths · Token 规格文档

> 来源稿：`docs/design/ohna-glass-web.html`（双主题）、`docs/design/ohna-glass-cli.html`（终端，纯深色）。
> 用途：把评审通过的高保真交互稿收敛成**可抄录**的设计 token，便于落到 `apps/ohna-web/src/styles.css`（`--md-*`）与 `apps/ohna-cli/src/ui/theme.ts`（`PALETTE` / `BACKGROUND`）。
> 状态：**已评审通过（2026-10-24）**，可作为代码落地的唯一颜色/尺度权威来源。

---

## 1. 设计决策（沉淀）

1. **中性近黑画布，无绿调**：初版墨绿 `#080C0B` / `#0A0F0D` 被反馈"太绿"。收敛为中性近黑（暗 `#18191A`，比 `system.css` 的 `#161e17` 更中性一档），不再用品牌绿做大块背景。
2. **青绿统一主强调 `#89D7B7`**：CLI 原橙色系（`#E8623C`/`#E07B39`/`#D9A441`/`#C98A5E`）整体换青绿系；`#89D7B7` 本就是 `system.css` 的 `primary-dark`，Web/CLI 共用。
3. **语义色对齐 `system.css` 暗档**：danger `#D36A5F`、warn `#D9A441`、info `#428475`、success = primary `#89D7B7`。
4. **区域无硬边框（浑然一体）**：经调研（Apple HIG、Pando、Linear/Raycast 系、design-review 共识），大区域**不靠边框分隔**，改用**表面明度分级 + 留白**；暗模式阴影弱，浮层（侧栏/抽屉/弹窗）靠 glass blur + 极淡内高光 `inset 0 1px 0 rgba(255,255,255,.05)` 维持"玻璃浮起"层次。控件级边框（输入框、卡片、按钮）保留。
5. **深浅双主题**：Web 支持 `data-theme="dark|light"`，localStorage 持久化（`ohna-theme`）。亮模式 accent 用设计系统深薄荷 `#2F6F63`（白底对比达标），暗模式保留 `#89D7B7`。
6. **亮模式可读性**：代码/diff/JSON 语法前景色**双档分别配色**——暗档亮彩、亮档深彩，避免浅底隐形。

---

## 2. 颜色 Token（Web 双主题）

所有值直接取自稿子，无手写偏差。

### 2.1 表面 / 底（Surface Tiers）

| Token | Dark | Light | 映射 `system.css` | 说明 |
|---|---|---|---|---|
| `--canvas` | `#18191A` | `#FBFAF9` | `--md-color-canvas` | 画布（最底） |
| `--canvas-deep` | `#121314` | `#F0EFEC` | — | 更深的凹陷面（代码块底等） |
| `--solid` | `#1E2120` | `#FFFFFF` | `--md-color-surface` | 实色面（卡片/输入框/主区） |
| `--solid-2` | `#232726` | `#F4F4F2` | `--md-color-elevated` | 浮起面（composer-box 等） |
| `--solid-3` | `#2A2E2C` | `#ECECEA` | — | 最高实色面（按钮 hover 等） |
| `--glass-1` | `rgba(255,255,255,.04)` | `rgba(0,0,0,.025)` | — | 玻璃一档（浮层微染） |
| `--glass-2` | `rgba(255,255,255,.06)` | `rgba(0,0,0,.04)` | — | 玻璃二档 |
| `--glass-3` | `rgba(255,255,255,.095)` | `rgba(0,0,0,.06)` | — | 玻璃三档（亮模式改深色微染，白底白玻璃不可见） |
| `--stroke` | `rgba(255,255,255,.10)` | `rgba(0,0,0,.10)` | `--md-color-border` | 控件级描边 |
| `--stroke-strong` | `rgba(255,255,255,.16)` | `rgba(0,0,0,.16)` | `--md-color-border-strong` | 强描边（输入框焦点等） |
| `--hairline` | `rgba(255,255,255,.05)` | `rgba(0,0,0,.05)` | — | **仅浮层极淡边**（弹窗）；区域分隔已不用线 |
| `--overlay` | `rgba(12,13,14,.68)` | `rgba(0,0,0,.40)` | `--md-color-overlay` | 弹窗遮罩 |

### 2.2 玻璃浮层底（Glass Surfaces，仅浮层用，内容区不用）

| Token | Dark | Light | 说明 |
|---|---|---|---|
| `--sidebar-bg` | `rgba(24,27,26,.62)` | `rgba(244,244,242,.72)` | 侧栏玻璃底 |
| `--inspector-bg` | `rgba(24,27,26,.78)` | `rgba(255,255,255,.82)` | Trace 抽屉玻璃底 |
| `--surface-panel` | `rgba(24,27,26,.84)` | `rgba(255,255,255,.90)` | 设置弹窗玻璃底 |
| `--surface-float` | `rgba(24,27,26,.90)` | `rgba(255,255,255,.92)` | toast 浮层底 |
| `--surface-sunken` | `rgba(18,20,21,.62)` | `rgba(0,0,0,.035)` | llm-call 等内嵌块底 |
| `--app-shell-bg` | `rgba(20,22,23,.88)` | `rgba(255,255,255,.86)` | 主壳背景 |
| `--hover-wash` | `rgba(255,255,255,.03)` | `rgba(0,0,0,.035)` | 行/卡片 hover 微洗 |
| 内高光 | `inset 0 1px 0 rgba(255,255,255,.05)` | 同左 | 浮层顶边高光（替代硬边框做层次） |

### 2.3 文本

| Token | Dark | Light | 映射 `system.css` | 说明 |
|---|---|---|---|---|
| `--text` | `#EDE6DA` | `#1A1A18` | `--md-color-text-primary` | 主文本（暖中性，非纯白） |
| `--text-2` | `#B9BCB7` | `#5C5C58` | `--md-color-text-secondary` | 次级 |
| `--text-3` | `#868C88` | `#868C88` | `--md-color-text-muted` | 三级 |
| `--text-4` | `#5C625F` | `#A8A8A4` | `--md-color-text-disabled` | 占位/禁用 |

### 2.4 品牌 / 语义

| Token | Dark | Light | 映射 `system.css` | 说明 |
|---|---|---|---|---|
| `--accent` | `#89D7B7` | `#2F6F63` | `--md-color-primary` | **青绿主强调**（亮模式深薄荷保对比） |
| `--accent-ink` | `#0E1512` | `#FFFFFF` | `--md-color-text-inverse` | 青绿按钮上的字色 |
| `--accent-soft` | `rgba(137,215,183,.12)` | `rgba(47,111,99,.12)` | `--md-color-primary-soft` | 青绿软底 |
| `--accent-line` | `rgba(137,215,183,.30)` | `rgba(47,111,99,.30)` | — | 青绿描边（焦点环等） |
| `--accent-hover` | `#9BE2C5` | `#356F63` | `--md-color-primary-hover` | 主按钮 hover |
| `--danger` | `#D36A5F` | `#B4232F` | `--md-color-danger` | 危险/错误 |
| `--danger-soft` | `rgba(211,106,95,.14)` | `rgba(180,35,47,.12)` | `--md-color-danger-soft` | 危险软底 |
| `--danger-line` | `rgba(211,106,95,.38)` | `rgba(180,35,47,.32)` | — | 危险描边 |
| `--warn` | `#D9A441` | `#8A5200` | `--md-color-warning` | 警告 |
| `--warn-soft` | `rgba(217,164,65,.14)` | `rgba(138,82,0,.12)` | `--md-color-warning-soft` | 警告软底 |
| `--success` | `#89D7B7` | `#056626` | `--md-color-success` | 成功（= 青绿） |
| `--success-soft` | `rgba(137,215,183,.10)` | `rgba(5,102,38,.10)` | `--md-color-success-soft` | 成功软底 |
| `--info` | `#428475` | `#2F6F63` | `--md-color-info` | 信息类别 |
| `--info-soft` | `rgba(66,132,117,.16)` | `rgba(47,111,99,.12)` | `--md-color-info-soft` | 信息软底 |

### 2.5 代码 / Diff / JSON 语法（双档分别配色，关键可读性）

> 暗档亮彩；亮档深彩（浅底上必须深）。**不要共用一套**。

| Token | Dark | Light | 说明 |
|---|---|---|---|
| `--c-code` | `#B8C5BF` | `#2C2C28` | 代码块正文 |
| `--c-diff-add` | `#A9E2C9` | `#0F7A52` | diff 新增行前景 |
| `--c-diff-del` | `#F09A92` | `#B4232F` | diff 删除行前景 |
| `--c-diff-ctx` | `#84918B` | `#6A6A66` | diff 上下文 |
| `--diff-add-bg` | `rgba(137,215,183,.10)` | `rgba(15,122,82,.12)` | 新增行底 |
| `--diff-del-bg` | `rgba(232,117,107,.10)` | `rgba(180,35,47,.10)` | 删除行底 |
| `--c-keyword` | `#C6A9E8` | `#6B3FA0` | 关键字 |
| `--c-string` | `#A8D6BE` | `#1F7A4D` | 字符串 |
| `--c-fn` | `#8FC4E5` | `#1E6FA8` | 函数名 |
| `--c-comment` | `#64746D` | `#8A8A85` | 注释 |
| `--c-json-key` | `#8FC4E5` | `#1E6FA8` | JSON key |
| `--c-json-string` | `#9ED0B6` | `#1F7A4D` | JSON string |
| `--c-json-number` | `#E5B567` | `#8A5200` | JSON number |
| `--c-json-bool` | `#C6A9E8` | `#6B3FA0` | JSON boolean |
| `--c-json-null` | `#E36B60` | `#B4232F` | JSON null |
| `--c-inline` | `#BBD9CB` | `#2F6F63` | 行内 code |
| `--c-error` | `#F0B0AA` | `#B4232F` | 错误文本 |
| `--c-settings-code` | `#B5C8BF` | `#2F6F63` | 设置内代码 |

---

## 3. 尺度 Token（双主题共用）

| Token | 值 | 映射 `system.css` | 说明 |
|---|---|---|---|
| `--r-sm` | `8px` | `--md-radius-sm` | 小圆角（卡片/标签） |
| `--r-md` | `12px` | `--md-radius-md` | 中圆角（输入框/composer） |
| `--r-lg` | `14px` | `--md-radius-lg` | 大圆角（弹窗/抽屉） |
| `--s-1` | `4px` | `--md-space-1` | 间距 |
| `--s-2` | `8px` | `--md-space-2` | 间距 |
| `--s-3` | `12px` | `--md-space-3` | 间距 |
| `--s-4` | `16px` | `--md-space-4` | 间距 |
| `--s-6` | `24px` | `--md-space-6` | 间距 |
| `--s-8` | `32px` | `--md-space-8` | 间距 |
| `--ease` | `cubic-bezier(.22,1,.36,1)` | `--md-ease` | 缓动（带减速的浮出） |
| `--fast` | `160ms` | `--md-motion-base` | 基础动效 |
| `--slow` | `240ms` | `--md-motion-slow` | 慢动效 |
| `--shadow` | Dark `0 18px 48px rgba(0,0,0,.45)`<br>Light `0 18px 48px rgba(0,0,0,.12)` | `--md-shadow-lg` | 大柔阴影（仅浮层） |
| `--shadow-small` | Dark `0 12px 28px rgba(0,0,0,.28)`<br>Light `0 12px 28px rgba(0,0,0,.08)` | `--md-shadow-popover` | 小阴影（仅浮层） |

---

## 4. 分层策略（"浑然一体"的实操规则）

1. **区域（侧栏 / 主区 / header / composer / timeline）**：**不用任何边框**。靠 surface 明度差 + 留白区分。
   - 侧栏 = glass 浮层（`--sidebar-bg`，blur 微提亮） vs 主区 = 画布 → 已分离。
   - composer 融入画布（透明底），唯一浮起的是内部 `composer-box`（实色 `--solid-2`）。
   - header / timeline 直接落在画布上，无框。
2. **浮层（侧栏 / Trace 抽屉 / 设置弹窗 / toast）**：用 glass blur + `--shadow` + 内高光 `inset 0 1px 0 rgba(255,255,255,.05)`。抽屉/弹窗的"边缘"用 `--hairline`（极淡）而非强描边。
3. **控件（输入框 / 按钮 / 卡片 / 徽标 / 代码块 / JSON viewer）**：保留 `--stroke` / `--stroke-strong`，因为它们是同色 flush 控件，需要明确边界。
4. **暗模式特别提醒**：阴影在暗底上几乎不工作，层次主要依赖**表面明度差**（canvas `#18191A` → solid `#1E2120` → solid-2 `#232726` → solid-3 `#2A2E2C`，每档约 +4 明度）与浮层内高光。

---

## 5. CLI（终端）Token —— 映射到 `theme.ts`

终端为纯深色（玻璃质感在终端平移为纯色表面，详见 `ohna-glass-cli.html` 顶部说明）。下列值直接对齐 Web 暗档，便于双端统一。

| theme.ts Role | 值（hex） | 256 | 说明 |
|---|---|---|---|
| `BACKGROUND.canvas` | `#14171A` | — | 终端画布（比 Web 略深，终端偏好实底） |
| `BACKGROUND.panel` | `#1E2120` | — | 卡片/输入框/面板（= Web `--solid`） |
| `BACKGROUND.toolCard` | `#262A28` | — | 工具卡片底 |
| `BACKGROUND.stroke` | `#3A3F3D` | — | 细描边（玻璃高光→实线，不发光） |
| `PALETTE.foreground` | `#EDE6DA` | 254 | 助手正文/标题 |
| `PALETTE.accent` | `#89D7B7` | 115 | ⏺ 工具名/强调（青绿，与 Web 统一） |
| `PALETTE.user` | `#BFE3D2` | 158 | ❯ 用户标签（浅薄荷） |
| `PALETTE.string` | `#A6E6CC` | 121 | 命令/工具参数 |
| `PALETTE.property` | `#9AA8A2` | 151 | 文件路径/属性（中性灰绿） |
| `PALETTE.success` | `#89D7B7` | 115 | ✓ / diff + |
| `PALETTE.error` | `#D36A5F` | 167 | ✗ / diff - / 危险（= Web danger） |
| `PALETTE.warn` | `#D9A441` | 221 | ⚠ 警告 |
| `PALETTE.info` | `#428475` | 23 | ℹ 信息类别 |
| `PALETTE.note` | `#9AA8A2` | 151 | 注释/次要 |
| `PALETTE.dim` | `#5C625F` | 239 | 系统行/次要文本 |
| `PALETTE.selected` | `#2E3331` | 236 | 选中行底 |
| `PALETTE.selectedText` | `#EDE6DA` | 254 | 选中行字 |
| `PALETTE.focused` | `#BFE3D2` | 158 | 焦点/确认态边框 |

> `PALETTE` 现有 16 个 role（`theme.ts`）：foreground / accent / user / string / property / success / error / warn / info / dim / note / selected / selectedText / focused / selected-? / …。落地时按上表覆盖 hex 即可；**新增的 ⏺ 工具名 accent 从原橙 `#E8623C` 改为青绿 `#89D7B7`** 是本次最大变更。
> 终端**必须保留**非 TTY / `NO_COLOR` / `TERM=dumb` 的零转义降级（信息靠符号/缩进/前缀存活，不得只编码在颜色里）——见 `theme.ts` 现有降级机制。

---

## 6. 可直接抄录的代码片段

### 6.1 `apps/ohna-web/src/styles.css`（暗档新增/覆盖）

```css
:root,
[data-theme="dark"] {
  --md-color-canvas: #18191A;
  --md-color-surface: #1E2120;
  --md-color-elevated: #232726;
  --md-color-border: rgba(255,255,255,.10);
  --md-color-border-strong: rgba(255,255,255,.16);
  --md-color-text-primary: #EDE6DA;
  --md-color-text-secondary: #B9BCB7;
  --md-color-text-muted: #868C88;
  --md-color-text-disabled: #5C625F;
  --md-color-primary: #89D7B7;
  --md-color-primary-hover: #9BE2C5;
  --md-color-text-inverse: #0E1512;
  --md-color-primary-soft: rgba(137,215,183,.12);
  --md-color-danger: #D36A5F;
  --md-color-danger-soft: rgba(211,106,95,.14);
  --md-color-warning: #D9A441;
  --md-color-warning-soft: rgba(217,164,65,.14);
  --md-color-success: #89D7B7;
  --md-color-success-soft: rgba(137,215,183,.10);
  --md-color-info: #428475;
  --md-color-info-soft: rgba(66,132,117,.16);
  --md-color-overlay: rgba(12,13,14,.68);
  /* 玻璃浮层底 */
  --md-glass-sidebar: rgba(24,27,26,.62);
  --md-glass-inspector: rgba(24,27,26,.78);
  --md-glass-panel: rgba(24,27,26,.84);
  /* 语法色（暗档亮彩） */
  --md-code-fg: #B8C5BF;
  --md-diff-add: #A9E2C9; --md-diff-del: #F09A92;
  --md-kw: #C6A9E8; --md-str: #A8D6BE; --md-fn: #8FC4E5; --md-comment: #64746D;
  /* 浮层内高光（替代硬边框分层） */
  --md-inset-highlight: inset 0 1px 0 rgba(255,255,255,.05);
}
[data-theme="light"] {
  --md-color-canvas: #FBFAF9;
  --md-color-surface: #FFFFFF;
  --md-color-elevated: #F4F4F2;
  --md-color-border: rgba(0,0,0,.10);
  --md-color-border-strong: rgba(0,0,0,.16);
  --md-color-text-primary: #1A1A18;
  --md-color-text-secondary: #5C5C58;
  --md-color-text-muted: #868C88;
  --md-color-text-disabled: #A8A8A4;
  --md-color-primary: #2F6F63;
  --md-color-primary-hover: #356F63;
  --md-color-text-inverse: #FFFFFF;
  --md-color-primary-soft: rgba(47,111,99,.12);
  --md-color-danger: #B4232F;
  --md-color-danger-soft: rgba(180,35,47,.12);
  --md-color-warning: #8A5200;
  --md-color-warning-soft: rgba(138,82,0,.12);
  --md-color-success: #056626;
  --md-color-success-soft: rgba(5,102,38,.10);
  --md-color-info: #2F6F63;
  --md-color-info-soft: rgba(47,111,99,.12);
  --md-color-overlay: rgba(0,0,0,.40);
  --md-glass-sidebar: rgba(244,244,242,.72);
  --md-glass-inspector: rgba(255,255,255,.82);
  --md-glass-panel: rgba(255,255,255,.90);
  /* 语法色（亮档深彩，浅底可读） */
  --md-code-fg: #2C2C28;
  --md-diff-add: #0F7A52; --md-diff-del: #B4232F;
  --md-kw: #6B3FA0; --md-str: #1F7A4D; --md-fn: #1E6FA8; --md-comment: #8A8A85;
  --md-inset-highlight: inset 0 1px 0 rgba(255,255,255,.05);
}
```

### 6.2 `apps/ohna-cli/src/ui/theme.ts`（PALETTE / BACKGROUND 覆盖草图）

```ts
// 仅展示变更：把 Amberwood 暖橙系替换为玻璃青绿系 + 中性近黑底。
export const BACKGROUND = {
  canvas:   "#14171A", // 画布（玻璃 canvas 平移，中性近黑）
  panel:    "#1E2120", // 会话面板 / 卡片 / 输入框正文
  toolCard: "#262A28", // 工具卡片底色
  stroke:   "#3A3F3D", // 细描边
} as const;

export const PALETTE = {
  foreground: "#EDE6DA",
  accent:     "#89D7B7", // ⏺ 工具名/强调：青绿（原 #E8623C 橙 → 青绿）
  user:      "#BFE3D2", // ❯ 用户标签：浅薄荷
  string:    "#A6E6CC", // 命令/工具参数（原 #D9A441 橙 → 青绿）
  property:  "#9AA8A2", // 文件路径/属性（原 #C98A5E 橙 → 中性灰绿）
  success:   "#89D7B7",
  error:     "#D36A5F", // ✗/diff-/危险（原 #E8756B → 统一 danger）
  warn:      "#D9A441",
  info:      "#428475",
  note:      "#9AA8A2",
  dim:       "#5C625F",
  selected:  "#2E3331",
  selectedText: "#EDE6DA",
  focused:   "#BFE3D2",
} as const;
// 256 降级表与 NO_COLOR 降级符号见 ohna-glass-cli.html 顶部映射表，按上表 hex 同步即可。
```

---

## 7. 待办 / 开放项

- [ ] 是否把暗模式画布对齐到 `system.css` 精确值 `#161e17`（当前 `#18191A` 更中性一档，评审已认可）。
- [ ] CLI 是否也需要浅色主题（当前纯深色；Web 已双主题）。
- [ ] 代码落地时，把 `--md-glass-*` / 语法色变量接入实际组件（侧栏、Trace 抽屉、设置弹窗、diff 渲染、JSON viewer）。
- [ ] `theme.ts` 的 `PALETTE` 现有 16 role 名称以实际源码为准，上表为对齐目标值。
