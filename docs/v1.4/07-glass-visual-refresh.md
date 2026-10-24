# 07 · Glass Depths 视觉刷新落地方案（设计稿 → 代码）

> **来源**：`docs/design/` 下三份已评审通过的高保真设计稿——
> - `docs/design/glass-tokens.md`：收敛后的**唯一颜色/尺度权威来源**（2026-10-24 评审通过）；
> - `docs/design/ohna-glass-web.html`：Web 双主题高保真交互稿（含 token 面板、侧栏分组、transcript、权限卡、Trace 抽屉、JsonViewer、设置弹窗）；
> - `docs/design/ohna-glass-cli.html`：CLI/TUI 终端稿（含 24-bit → 256 → NO_COLOR 三级降级 + token 映射表）。
>
> **目标**：把评审通过的「09 玻璃 Glass Depths」视觉语言**逐字抄录**进代码——
> `apps/ohna-web/src/styles.css`（`--md-*` 覆盖 + 玻璃浮层 + 语法色）与
> `apps/ohna-cli/src/ui/theme.ts`（`PALETTE` / `BACKGROUND`）。
> **本文只做「视觉层改造方案」，不改信息架构、不改组件结构、不改任何业务逻辑。**

---

## 0. 一句话结论

当前代码仍是「Meridian 墨绿 + Amberwood 暖橙」的旧视觉；设计稿已收敛为「中性近黑画布 + 青绿统一强调 `#89D7B7` + 无硬边框的玻璃分层」。本方案把两套旧色值**整体替换**为 Glass Depths token，Web 侧**断开 `system.css` 共享、token 全部自持**并叠加「玻璃浮层变量 + 双档语法色」，CLI 侧平移为「4 档纯色表面 + 青绿语义色」。玻璃拟态经用户授权可以使用（仅限浮层）。

---

## 1. 现状锚点（本轮读码确认，实施时按此验证）

### 1.1 Web 侧现状

| 事实 | 位置 | 含义 |
|---|---|---|
| `styles.css` 首两行 `@import "tailwindcss"` + `@import "../../../system.css"`，之后只有 `:root` 设了 `color` / `background` / `font-family`，**没有任何 `--md-*` 定义块** | `apps/ohna-web/src/styles.css:1-10` | 当前 Web 的 `--md-*` 全部来自 `system.css`；要「不共享」必须先删除 `@import system.css` 并把用到的 token 自持 |
| `styles.css` 全站引用的 `--md-*` 变量约 48 个（颜色 24 + 字体 2 + 字号 6 + 间距 8 + 圆角 5 + 动效/focus-ring/shadow 等）；其中 `--md-market-up/down` 仅被死样式 `.market-*` 类消费，随类一并清理 | `apps/ohna-web/src/styles.css`（`grep var(--md-` 去重） | 删除 import 后这些变量必须全部在 `styles.css` 内重新定义，否则全站塌陷；market token 例外——确认无用后删除 |
| `--md-shadow-lg` 被 3 处引用但 `system.css` 与 `styles.css` **均未定义**（既有隐患） | `styles.css:842/1339/3000` | 本次搬移时补定义（Glass 稿的 `--shadow` 即为此值） |
| `system.css` 是 `apps/finance-web` 与 `ohna-web` 共享的 Meridian 基座（`finance-web/src/styles.css` 也 import） | `system.css` / `apps/finance-web/src/styles.css:2` | 两个产品**不是同一领域**，不应共用一套设计语言；本次 `ohna-web` 断开，`system.css` 与 `finance-web` 不动 |
| `theme.tsx` 已用 `data-theme="dark\|light"` 写根节点，localStorage key `ohna.theme`，字号 `ohna.ui.fontSize` | `apps/ohna-web/src/app/theme.tsx` | 主题切换机制**已就绪**；而 `system.css` 暗档走 `@media (prefers-color-scheme: dark)`、亮档走 `:root[data-theme="light"]`，机制与 ohna 的 `data-theme` **不一致**——这是「不该共享」的深层原因 |
| 现有组件已按结构就位：`sidebar.tsx` / `TraceDrawer.tsx` / `SettingsDialog.tsx` / `JsonViewer` / `run-details.tsx` | `apps/ohna-web/src/features/*` | 玻璃稿对应的组件**都已存在**（v1.4 03 已落地），本次只换视觉 token，不新增/删除组件 |
| `tailwindcss` import 不引用任何 `md-*`（无 tailwind 配置、main/App 无引用） | `apps/ohna-web`（无 `tailwind.config.*`） | 删除 `@import system.css` 对 tailwind 无影响 |

### 1.2 CLI 侧现状

| 事实 | 位置 | 含义 |
|---|---|---|
| `theme.ts` 的 `PALETTE` 仍是 Amberwood 暖橙系（accent `#e8623c`、user `#e07b39`、string `#d9a441`、property `#c98a5e`、error `#e2553d`…） | `apps/ohna-cli/src/ui/theme.ts:36-51` | 设计稿已定「橙系整体换青绿系」，需逐 role 替换 |
| `BACKGROUND` 仍是暖棕（canvas `#180F0D`、panel `#1B1310`、toolCard `#241A14`、stroke `#38291F`） | `apps/ohna-cli/src/ui/theme.ts:60-69` | 需替换为中性近黑 4 档（`#14171A`/`#1E2120`/`#262A28`/`#3A3F3D`） |
| `ThemeRole` 联合类型 14 个 role 与设计稿 role 完全一致（无需增删 role） | `apps/ohna-cli/src/ui/theme.ts:16-30` | 只改色值，不改类型与 API 签名 |
| 降级机制 `supportsAnsi()` / `configure()` / `resetForTest()` 已就绪（非 TTY / NO_COLOR / TERM=dumb 零转义） | `apps/ohna-cli/src/ui/theme.ts:100-130` | 设计稿的「NO_COLOR 信息靠符号存活」已实现，无需改动 |

### 1.3 玻璃拟态的授权（用户已拍板：可以用玻璃拟态）

`DESIGN.md` 原先将「glassmorphism」列入 **Avoid**（旧文 "Excessive glassmorphism, heavy neon, exaggerated shadows…"）。**用户 2026-10-24 已明确授权：玻璃拟态可以使用**，本轮已将 `DESIGN.md` 相应条款修订为「**克制玻璃拟态允许，仅限浮层（侧栏/抽屉/弹窗/toast），不用于滚动内容面**」，并同步 `AI Prompt Template` 段的提示词。

**裁决（本方案拍板，落地时不再逐项讨论）**：
1. **玻璃拟态是本次视觉的核心语言**：`glass-tokens.md` §2.2 的玻璃浮层底（`--sidebar-bg` / `--inspector-bg` / `--surface-panel` / `--surface-float` 等）与 §4 的「浮层 glass blur + 内高光」分层规则**照单落地**，不再视为冲突。
2. **边界仍是「浮层限定」**：`glass-tokens.md` §4 明确「内容区（transcript/header/timeline）不用 blur，用表面明度分级」——这是设计稿自身的克制，与「允许玻璃拟态」一致：**blur 只在浮层，滚动内容用实色表面**。这既满足「可以用玻璃拟态」，又避免长对话滚动时的对比度/性能退化。
3. **画布中性近黑 `#18191A` 取代墨绿 `#161e17`**：`glass-tokens.md` §1 决策 1 的结论（「不再用品牌绿做大块背景」），保留。
4. **`DESIGN.md` 暗档数值回填**：`DESIGN.md` 暗档 `canvas #181817 / surface #121212` 与 Glass Depths 的 `#18191A / #1E2120` 不同，§7 回填为 Glass Depths 值并标注「以 docs/design/glass-tokens.md（2026-10-24 评审稿）为准」，避免两套权威打架。
5. **语法色双档（暗亮彩/亮深彩）** 保留：`DESIGN.md` 未覆盖，属产品级增强，直接落在 `styles.css` 自持 token 内（不再有「共享基座不可改」的顾虑，因为已断开 `system.css`）。

---

## 2. 架构决策（本轮拍板）

- **D1 · 删除 `@import system.css`，token 全部自持**：`ohna-web` 与 `finance-web` 不是同一领域产品，不共用一套设计语言。删除 `styles.css` 第 2 行 `@import "../../../system.css"`，把 `styles.css` 用到的**全部** `--md-*` 变量（颜色 24 + 字体 2 + 字号 6 + 间距 8 + 圆角 5 + `--md-border-width`/`--md-focus-ring`/`--md-shadow-popover`/`--md-shadow-lg`/`--md-motion-*`/`--md-ease`）**内联到 `styles.css` 自持**，颜色类按 Glass Depths 值、其余按 `system.css` 原值搬运（见 §3 Phase G1 完整清单）。`--md-market-up/down` **不搬运**（连同死样式 `.market-*` 类一起清理）。`system.css` 与 `finance-web` **零改动**。
- **D2 · 自持 token 的 Glass 值 = 设计稿 §6.1 精确抄录**：`glass-tokens.md` §6.1 已给出可直接抄录的 CSS 块（暗/亮双档 + 玻璃浮层 + 语法色），实施时**逐字对齐**，不增不减、不改数值。新增的玻璃浮层别名（`--md-glass-sidebar` / `--md-glass-inspector` / `--md-glass-panel` 等）与语法色（`--md-code-fg` / `--md-diff-add` / `--md-kw` 等）是原 `system.css` 没有的增量，一并加进自持块。
- **D3 · CLI 只换色值、不动 API**：`PALETTE` / `BACKGROUND` 的键名、`ThemeRole` 类型、`paint`/`paintBg`/`surface`/`paintOnSurface` 签名**全部不动**，只把 14 个 role 的 RGB 三元组与 4 个背景 hex 换成 Glass Depths 值。256 降级表（`theme.ts` 若存在 `paint256` 或近似色逻辑）按 `ohna-glass-cli.html` 的 `c256` 列同步；NO_COLOR 降级零改动。
- **D4 · 玻璃质感在终端平移为纯色**：终端无法 blur/阴影/光斑（`packages/term` 只提供 `RawTerminal` + `Screen` + `box` 细圆角），设计稿 §「玻璃 → 终端平移」已明确「玻璃层→4 档纯色、高光→stroke 1px 实线、青绿→accent」。CLI 侧**不引入**任何发光/玻璃特效，只对齐纯色语义。
- **D5 · 分层规则落进 Web 样式**：`glass-tokens.md` §4 的「区域无硬边框 / 浮层 glass blur + 内高光 / 控件保留 stroke」需转成具体 CSS 规则（见 §4.1-4.3），这是本次视觉改造的核心增量，不是简单换色。

---

## 3. 改造范围（文件级交付清单）

### Phase G1 · Web 断开 system.css + 自持 token（`apps/ohna-web/src/styles.css`）

1. **删除共享 import**：删掉 `styles.css` 第 2 行 `@import "../../../system.css";`（保留第 1 行 `@import "tailwindcss";`）。
2. **自持全部 token 块**（在文件顶部 `:root { … }` 之后、`* { box-sizing }` 之前插入，替换掉原来那行空 `:root` 的定位）：
   - **基建 token（双主题共用）**：字体 `--md-font-ui` / `--md-font-mono`；字号 `--md-text-{page-title,section-title,body,body-sm,label,code}-*`；间距 `--md-space-1..16`；圆角 `--md-radius-sm/md/lg/xl/full`；`--md-border-width`、`--md-motion-fast/base/slow`、`--md-ease`、`--md-container-max`、`--md-container-pad`。**按 `system.css` 原值搬运**（这些不是颜色，不受 Glass 覆盖影响）。
   - **颜色 token（Glass Depths 值）**：`--md-color-{canvas,surface,elevated,muted,overlay,border-subtle,border,border-strong,text-primary,text-secondary,text-muted,text-disabled,text-inverse,primary,primary-hover,primary-pressed,primary-soft,success,success-soft,warning,warning-soft,danger,danger-soft,info,info-soft}` —— **逐字抄 `glass-tokens.md` §6.1 暗档值**。
   - **focus-ring / shadow（Glass 值）**：`--md-focus-ring`（用 `rgba(137,215,183,.26)` 对齐 Glass 主强调）、`--md-shadow-popover`（Glass `--shadow-small`）、**补定义 `--md-shadow-lg`**（Glass `--shadow`，暗 `0 18px 48px rgba(0,0,0,.45)` / 亮 `0 18px 48px rgba(0,0,0,.12)`，修复既有 3 处未定义引用）。
   - **market token：清理，不搬运**（用户 2026-10-24 拍板）：`--md-market-up` / `--md-market-down` 及 `.market-up` / `.market-down` / `.market-chart` / `.market-chart-card` 系列是早期从 finance 借鉴的死样式——已确认 `styles.css:356-374` 只有定义、**无任何 TSX 组件引用**。实施 G1 时**连同这些 `.market-*` / `.market-chart-*` 类一起删除**，不再自持 `--md-market-up/down` token。
   - **玻璃浮层别名 + 语法色**（Glass 增量，原 `system.css` 没有）：见本 Phase 第 3、4 条。
3. **暗/亮双档主题块**：
   - `:root, [data-theme="dark"] { … }`：暗档 Glass 值 + 玻璃浮层别名 + 语法色暗档（亮彩）。**逐字抄 `glass-tokens.md` §6.1 暗档块。**
   - `[data-theme="light"] { … }`：亮档 Glass 值（canvas `#FBFAF9`、primary `#2F6F63`、danger `#B4232F`、warn `#8A5200`、success `#056626`、info `#2F6F63` 等）+ 玻璃浮层别名亮档 + 语法色亮档（深彩）。**逐字抄 §6.1 亮档块。**
   - 说明：`system.css` 的暗档走 `@media (prefers-color-scheme: dark)`、亮档走 `:root[data-theme="light"]`，与 ohna 的 `data-theme="dark|light"` 机制不一致；自持后统一为 `data-theme` 双档，交由 `theme.tsx` 控制。
4. **补玻璃浮层别名**：`--md-glass-sidebar` / `--md-glass-inspector` / `--md-glass-panel` / `--md-glass-float` / `--md-glass-sunken` / `--md-app-shell-bg` / `--md-hover-wash` / `--md-inset-highlight` / `--md-hairline`（设计稿 web 稿 `:root` 里的派生表面别名，映射到 `--md-glass-*` 命名，见 §4.2）。
5. **补语法色 token**：`--md-code-fg` / `--md-diff-add` / `--md-diff-del` / `--md-diff-ctx` / `--md-kw` / `--md-str` / `--md-fn` / `--md-comment` / `--md-json-key` / `--md-json-string` / `--md-json-number` / `--md-json-bool` / `--md-json-null` / `--md-inline-code` / `--md-error-fg` + 新增/删除行底 `--md-diff-add-bg` / `--md-diff-del-bg`。
6. **把浮层组件从 `--md-color-surface` 切到玻璃别名**（仅浮层，内容区不动）：
   - 侧栏 `.sidebar`（或 `styles.css` 对应类）→ `background: var(--md-glass-sidebar)` + `backdrop-filter: blur(18px) saturate(150%)` + `box-shadow: inset 0 1px 0 rgba(255,255,255,.05)`；
   - Trace 抽屉 `.trace-drawer` / inspector → `--md-glass-inspector`；
   - 设置弹窗 `.settings-dialog` → `--md-glass-panel` + `--md-hairline` 边；
   - toast → `--md-glass-float`。
7. **移除/弱化区域硬边框**（`glass-tokens.md` §4 规则 1）：侧栏/主区/header/composer 与画布之间**去掉 1px 边框**，改用表面明度差 + 留白；控件级（输入框/卡片/按钮/代码块/JSON viewer）保留 `--md-color-border`。
8. **暗档层次核对**（§4.3）：确认 `--md-color-canvas → surface → elevated` 每档 +4 明度的顺序在 Glass 值中成立（`#18191A → #1E2120 → #232726 → #2A2E2C`），浮层内高光 `--md-inset-highlight` 用于替代硬边框。

**不触碰**：`system.css`（保持不动，供 `finance-web` 继续用）、`tailwindcss` import、组件 TSX 结构、`theme.tsx` 机制（`data-theme` 已就绪）。

> **自持后的 token 完整清单**（`grep var(--md-` 去重结果，全部需在本 Phase 内定义）：颜色 24（canvas/surface/elevated/muted/overlay/border-subtle/border/border-strong/text-primary/text-secondary/text-muted/text-disabled/text-inverse/primary/primary-hover/primary-soft/danger/danger-soft/warning/warning-soft/success/success-soft/info/info-soft）+ 字体 2（font-ui/font-mono）+ 字号 6（text-body-sm-size/text-code-size/text-section-title-size 等）+ 间距 8（space-1..8）+ 圆角 5（radius-sm/md/lg/xl/full）+ 动效 4（motion-fast/base/slow/ease）+ 杂项（border-width/focus-ring/shadow-popover/shadow-lg）。**market-up/market-down 不在此清单——随 `.market-*` 死样式删除。实施时以此清单逐项校验「无遗漏、无未定义引用」。**

### Phase G2 · 玻璃浮层落点微调（纯 CSS，不动 TSX）

对照 `ohna-glass-web.html` 的六处界面，确认现有组件类名与设计稿结构的对应关系，仅补「背景/描边/阴影」缺失项：

| 设计稿组件 | 现有实现 | 需补的 CSS |
|---|---|---|
| 侧栏（glass blur） | `features/workbench/sidebar.tsx` | 玻璃底 + blur + 内高光 |
| Trace 抽屉（inspector-bg） | `features/trace/TraceDrawer.tsx` | 玻璃底 + 左侧投影 `-18px 0 48px` + 内高光 |
| 设置弹窗（surface-panel） | `features/settings/SettingsDialog.tsx` | 玻璃底 + `--md-hairline` + 内高光 |
| JsonViewer（code 底 + 语法色） | `features/json-viewer/*` | `--md-json-*` 语法色 + `--md-code-fg` |
| diff 渲染（双档色） | `run-process.tsx` / diff 展示处 | `--md-diff-add/del/ctx` + 底 |
| 权限卡（warn/danger 软底） | `features/workbench/confirmation-cards.tsx` | 对齐 `--md-warning-soft` / `--md-danger-soft` |

> 注意：本 Phase 是**视觉对齐核查**，不是重写组件。若某组件当前类名与设计稿不一致，只补 token 引用，不改 DOM。

### Phase G3 · CLI token 平移（`apps/ohna-cli/src/ui/theme.ts`）

1. `PALETTE` 14 个 role 的 RGB 三元组按 `ohna-glass-cli.html` `PALETTE` 逐项替换：
   - `foreground [0xED,0xE6,0xDA]`、`accent [0x89,0xD7,0xB7]`、`user [0xBF,0xE3,0xD2]`、`string [0xA6,0xE6,0xCC]`、`property [0x9A,0xA8,0xA2]`、`success [0x89,0xD7,0xB7]`、`error [0xD3,0x6A,0x5F]`、`warn [0xD9,0xA4,0x41]`、`info [0x42,0x84,0x75]`、`dim [0x5C,0x62,0x5F]`、`note [0x9A,0xA8,0xA2]`、`selected [0x2E,0x33,0x31]`、`selectedText [0xED,0xE6,0xDA]`、`focused [0xBF,0xE3,0xD2]`。
2. `BACKGROUND` 4 个 hex 替换：`canvas #14171A`、`panel #1E2120`、`toolCard #262A28`、`stroke #3A3F3D`。
3. 更新文件头注释（当前写「Amberwood 色板」/「Claude Code 风格复刻」→「Glass Depths 玻璃青绿系 · 中性近黑画布」）。
4. 若 `theme.ts` 或 `diff.ts` 存在 256 降级表/近似色逻辑，按 `ohna-glass-cli.html` 的 `c256` 列（foreground 231 / accent 115 / user 158 / string 121 / property 151 / success 115 / error 167 / warn 221 / info 23 / dim 59 / note 151 / selected 102 / selectedText 231 / focused 158）同步。**若当前无 256 逻辑则此项跳过**（实施时先 `grep` 确认）。
5. **零改动**：`ThemeRole` 类型、`paint`/`paintBg`/`surface`/`paintOnSurface`/`inputTopBar`/`inputBottomBar` 签名、`supportsAnsi`/`configure`/`resetForTest` 降级机制、`DOT`/`HOOK`/`STOP`/`SPIN`/`CROSS`/`ELLIPSIS` 符号常量。

### Phase G4 · 测试与文档同步

1. **测试**：
   - `apps/ohna-cli` 现有 `test/theme.test.mjs` 或等价单测：断言 `paint`/`paintBg`/`surface` 输出仍为合法 24-bit SGR，且 role → RGB 三元组与 Glass Depths 值一致（改色后色值断言需同步更新）。
   - `apps/ohna-web`：新增/更新样式级快照或 vitest 断言——确认 `data-theme="dark"` 下 `--md-color-canvas` 计算值为 `#18191A`、`data-theme="light"` 下为 `#FBFAF9`（用 `getComputedStyle` 或 token 常量断言）。
2. **文档同步**（见 §7）：本文状态表 + `docs/v1.4/README.md` 配套计划句 + `DESIGN.md` 暗档 surface 表回填 + `AGENTS.md` `apps/ohna-web` 段补一句「Glass Depths 视觉」。

---

## 4. 落地细则

### 4.1 Web 自持 token 块的插入位置与结构

在 `styles.css` 顶部 `:root { … }`（第 4-10 行）之后、`* { box-sizing }`（第 12 行）之前，插入自持 token 块（删除第 2 行 `@import system.css` 后，这些是唯一 token 来源）。下方代码块为 Glass 颜色/玻璃浮层/语法色的核心部分；基建 token（字体/字号/间距/圆角/动效）按 `system.css` 原值补齐，完整清单见 §3 Phase G1 末尾注。

```css
/* Glass Depths 自持 token（docs/design/glass-tokens.md §6.1 逐字抄录） */
:root,
[data-theme="dark"] {
  /* —— 表面层 —— */
  --md-color-canvas: #18191A;
  --md-color-surface: #1E2120;
  --md-color-elevated: #232726;
  --md-color-muted: #2A2E2C;
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
  /* —— 玻璃浮层底（仅浮层用，内容区不用）—— */
  --md-glass-sidebar: rgba(24,27,26,.62);
  --md-glass-inspector: rgba(24,27,26,.78);
  --md-glass-panel: rgba(24,27,26,.84);
  --md-glass-float: rgba(24,27,26,.90);
  --md-glass-sunken: rgba(18,20,21,.62);
  --md-app-shell-bg: rgba(20,22,23,.88);
  --md-hover-wash: rgba(255,255,255,.03);
  --md-hairline: rgba(255,255,255,.05);
  --md-inset-highlight: inset 0 1px 0 rgba(255,255,255,.05);
  /* —— 语法色（暗档亮彩）—— */
  --md-code-fg: #B8C5BF;
  --md-diff-add: #A9E2C9; --md-diff-del: #F09A92; --md-diff-ctx: #84918B;
  --md-diff-add-bg: rgba(137,215,183,.10); --md-diff-del-bg: rgba(232,117,107,.10);
  --md-kw: #C6A9E8; --md-str: #A8D6BE; --md-fn: #8FC4E5; --md-comment: #64746D;
  --md-json-key: #8FC4E5; --md-json-string: #9ED0B6; --md-json-number: #E5B567;
  --md-json-bool: #C6A9E8; --md-json-null: #E36B60;
  --md-inline-code: #BBD9CB; --md-error-fg: #F0B0AA;
}
[data-theme="light"] {
  /* —— 亮档覆盖（浅底深彩）—— */
  --md-color-canvas: #FBFAF9;
  --md-color-surface: #FFFFFF;
  --md-color-elevated: #F4F4F2;
  --md-color-muted: #ECECEA;
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
  --md-glass-float: rgba(255,255,255,.92);
  --md-glass-sunken: rgba(0,0,0,.035);
  --md-app-shell-bg: rgba(255,255,255,.86);
  --md-hover-wash: rgba(0,0,0,.035);
  --md-hairline: rgba(0,0,0,.05);
  --md-inset-highlight: inset 0 1px 0 rgba(255,255,255,.05);
  --md-code-fg: #2C2C28;
  --md-diff-add: #0F7A52; --md-diff-del: #B4232F; --md-diff-ctx: #6A6A66;
  --md-diff-add-bg: rgba(15,122,82,.12); --md-diff-del-bg: rgba(180,35,47,.10);
  --md-kw: #6B3FA0; --md-str: #1F7A4D; --md-fn: #1E6FA8; --md-comment: #8A8A85;
  --md-json-key: #1E6FA8; --md-json-string: #1F7A4D; --md-json-number: #8A5200;
  --md-json-bool: #6B3FA0; --md-json-null: #B4232F;
  --md-inline-code: #2F6F63; --md-error-fg: #B4232F;
}
```

> 说明：`--md-color-muted` 在设计稿 §6.1 未显式列出，此处映射到 `solid-3 #2A2E2C`（暗）/ `#ECECEA`（亮）以保持 `system.css` 的 token 命名完整；`--md-color-border-subtle`（`system.css` 独有、`styles.css` 大量引用）继续沿用 `system.css` 原值或按 hairline 对齐，实施时以「不破坏现有组件」为准。

### 4.2 玻璃浮层别名 → `system.css` 既有 token 的映射（设计稿 §2.2）

| Glass token | 语义 | 落点（`styles.css`） |
|---|---|---|
| `--sidebar-bg` | 侧栏玻璃底 | `--md-glass-sidebar` |
| `--inspector-bg` | Trace 抽屉玻璃底 | `--md-glass-inspector` |
| `--surface-panel` | 设置弹窗玻璃底 | `--md-glass-panel` |
| `--surface-float` | toast 浮层底 | `--md-glass-float` |
| `--surface-sunken` | llm-call 等内嵌块底 | `--md-glass-sunken` |
| `--app-shell-bg` | 主壳背景 | `--md-app-shell-bg` |
| `--hover-wash` | 行/卡片 hover 微洗 | `--md-hover-wash` |
| 内高光 | 浮层顶边高光替代硬边框 | `--md-inset-highlight` |
| `--hairline` | 弹窗极淡边 | `--md-hairline` |

### 4.3 分层规则转 CSS（`glass-tokens.md` §4）

1. **区域无硬边框**：`.sidebar` / `.chat-main` / `.chat-header` / `.composer-dock` / `.timeline` 删除 `border: 1px solid var(--md-color-border)`（若存在），改用表面明度差；侧栏与主区之间靠 `--md-glass-sidebar` 半透明 blur 与 `--md-color-canvas` 的明度差区分。
2. **浮层 blur + 内高光**：`.sidebar` / `.trace-drawer` / `.settings-dialog` / `.toast` 统一 `backdrop-filter: blur(18px) saturate(150%)` + `box-shadow: var(--md-shadow-lg, …), var(--md-inset-highlight)`；抽屉/弹窗边缘用 `--md-hairline` 而非强描边。
3. **控件保留描边**：输入框/按钮/卡片/代码块/JSON viewer 继续 `--md-color-border` / `--md-color-border-strong`，不做 blur。
4. **暗档层次核对**：自持后 `canvas #18191A → surface #1E2120 → elevated #232726 → muted #2A2E2C` 严格 +4/+5 明度递增，浮层靠 blur + 内高光提层，不再依赖阴影（暗底阴影几乎不可见）。

---

## 5. 不做清单（明确排除，防止范围膨胀）

- **不改 `system.css`**：它是 `apps/finance-web` 的 Meridian 基座，产品 A「保持不动、独立演进」；`ohna-web` 本次**删除对它的 import**，改用自持 token（D1）。
- **不改 `apps/finance-web`**：只断开 ohna-web 的引用，finance-web 继续用 `system.css`，零改动。
- **不改信息架构 / 组件结构**：侧栏分组、Trace 抽屉、设置弹窗、JsonViewer 等组件在 v1.4 03 已落地，本次零 TSX 结构改动（仅可能补 CSS token 引用）。
- **不新增组件 / 不新增路由**：玻璃稿的六处界面组件全部已存在。
- **不引入任何新依赖**：纯 CSS + 常量替换，零依赖变化。
- **CLI 不引入玻璃特效**：终端无 blur/阴影，玻璃质感平移为纯色表面（D4）。
- **不动 `theme.tsx` 机制**：`data-theme` / localStorage 已就绪，自持 token 后仍由 `theme.tsx` 控制明暗。
- **不做 Figma 同步**：`ohna-glass-index.html` 的 Figma 待办（需要先连 Figma MCP）不在本文范围，属独立任务。
- **清理死样式 `.market-*`（明确要做）**：删除 `styles.css` 第 356-374 行的 `.market-chart-card` / `.market-chart` / `.market-up` / `.market-down` 及 `--md-market-up/down` 引用——已确认无 TSX 组件引用（`grep -rn market apps/ohna-web/src` 仅命中 styles.css 自身），属 finance 借鉴残留。

---

## 6. 风险与缓解

| 风险 | 说明 | 缓解 |
|---|---|---|
| 删除 import 后 token 塌陷 | `styles.css` 引用了约 50 个 `--md-*`，删除 `@import system.css` 后若漏搬则全站样式塌陷 | §3 G1 已列「自持 token 完整清单」，实施时逐项 `grep var(--md-` 校验「无遗漏、无未定义引用」；`pnpm build` 后人工走查明暗两档 |
| 全局换色影响 finance-web | `system.css` 被 finance-web 共享 | D1 只改 ohna-web 的 `styles.css`（删除 import + 自持），`system.css` 与 finance-web 零改动 |
| `--md-shadow-lg` 未定义（既有隐患） | 3 处引用但无定义 | 本次补定义（Glass `--shadow`），一并修复 |
| 暗档 `#18191A` 与 `DESIGN.md` `#181817` 打架 | 两套权威数值不同 | §7 回填 `DESIGN.md` 暗档 surface 表为 Glass Depths 值，明确「以玻璃稿为准」 |
| 玻璃化违反 `AGENTS.md` 反玻璃约束 | 旧 `DESIGN.md` 曾 Avoid 玻璃拟态 | 已修订：用户授权玻璃拟态，`DESIGN.md` 现为「克制玻璃拟态允许，仅限浮层」；方案 §1.3 已同步 |
| 自持后个别组件硬编码了旧色 | 实施中需排查 | `grep` 扫描 `styles.css` 内硬编码 `#161e17`/`#fff4e1` 等旧值，一并替换为 token |
| CLI 256 降级表存在与否未知 | `theme.ts` 当前只见 24-bit | 实施时先 `grep "256\|c256\|xterm"` 确认，存在则同步、不存在则跳过 |
| diff 语法色当前可能硬编码在组件内 | 语法色是新 token | 实施时 `grep` diff/JSON 渲染处的硬编码色，替换为 `--md-diff-*` / `--md-json-*` |
| market 死样式误删 | 若未来有隐藏引用会报错 | 已确认 `grep -rn market apps/ohna-web/src` 仅命中 styles.css 自身；删除后 `pnpm --filter @aiagent/ohna-web build` + 全仓 typecheck 兜底 |

---

## 7. 文档同步清单

落地完成后同步以下文档（与代码同一任务内完成）：

1. `docs/v1.4/07-glass-visual-refresh.md`（本文）§8 状态表更新为「✅ 已完成」+ 实施记录。
2. `docs/v1.4/README.md`：§配套计划段 += 「07-glass-visual-refresh.md —— 把 docs/design 的 Glass Depths 高保真稿逐字落到 ohna-web（断开 system.css 共享、token 自持）与 ohna-cli theme.ts（中性近黑画布 + 青绿统一强调 + 仅浮层玻璃分层 + 双档语法色）」。
3. `DESIGN.md`：已在本轮修订「玻璃拟态允许，仅限浮层」（§1.3）；落地时再把暗档 `colors` 表的 `dark-canvas`/`dark-surface`/`dark-secondary`/`dark-text-primary` 回填为 Glass Depths 值，并加一句「暗档以 docs/design/glass-tokens.md（2026-10-24 评审稿）为准」。
4. `AGENTS.md`：`apps/ohna-web` 段补一句「Glass Depths 视觉（docs/v1.4/07）：中性近黑画布 + 青绿强调，浮层用克制的 glass blur 分层，语法色双档；`styles.css` 不再 `@import system.css`，token 自持」。
5. `docs/design/glass-tokens.md` §7 待办：把「是否对齐 system.css 精确值」开放项标记为「已裁决：ohna-web 断开 system.css、token 自持，不再对齐」；「CLI 是否浅色」维持「暂不做」。

---

## 8. 状态表

| 阶段 | 内容 | 状态 |
|---|---|---|
| G1 | Web `--md-*` 覆盖 + 玻璃浮层别名 + 语法色（`styles.css`） | ✅ 已完成 |
| G2 | 玻璃浮层落点微调 + 分层规则转 CSS | ✅ 已完成 |
| G3 | CLI `PALETTE`/`BACKGROUND` 青绿平移（`theme.ts`） | ✅ 已完成 |
| G4 | 测试 + 文档同步 | ✅ 已完成 |

### 实施记录

- **Web（G1/G2）**：`apps/ohna-web/src/styles.css` 已删除 `@import "../../../system.css"`，全部 `--md-*` token 自持（基建 token 按 `system.css` 原值搬运、颜色/玻璃浮层/语法色逐字抄 `glass-tokens.md` §6.1）。暗档画布 `#18191A`、亮档 `#FBFAF9` 双档就绪；玻璃浮层别名（`--md-glass-sidebar/-inspector/-panel/-float/-sunken` 等）与内高光 `--md-inset-highlight` 已接入侧栏 / Trace 抽屉 / 设置弹窗（Web 无独立 toast 组件，不造无引用类）；分层规则落地为「区域无硬边框、浮层 glass blur + 内高光、控件保留描边」。`system.css`、`finance-web`、组件 TSX 结构、`theme.tsx` 机制均零改动。
- **CLI（G3）**：`apps/ohna-cli/src/ui/theme.ts` 的 `PALETTE` 14 个 role 与 `BACKGROUND` 4 档已从 Amberwood 暖橙系整体平移为 Glass Depths 青绿系 + 中性近黑（`canvas #14171A` / `panel #1E2120` / `toolCard #262A28` / `stroke #3A3F3D`）。`ThemeRole` 类型、`paint`/`paintBg`/`surface`/`paintOnSurface`/`inputTopBar`/`inputBottomBar` 签名、`supportsAnsi`/`configure`/`resetForTest` 降级机制、符号常量全部零改动；终端不引入任何玻璃/发光特效。
- **测试（G4）**：Web 新增 `apps/ohna-web/.../styles-glass.test.ts`（断言 `data-theme="dark"` 下 `--md-color-canvas` 计算值为 `#18191A`、亮档为 `#FBFAF9`，以及玻璃浮层/语法色 token 存在）；CLI 测试同步覆盖 `apps/ohna-cli/test/theme.test.mjs` 色值断言 + `tui-session-picker` / `permission-card` / `tui-app` 三处派生颜色断言（`selected`/`selectedText`/`focused`/`panel` 字节级断言已同步为 Glass Depths 值）。
- **文档同步（G4）**：本文状态表已更新、本实施记录已补；`docs/v1.4/README.md` 配套计划段已追加 07 说明；`DESIGN.md` 暗档 colors 已回填为 Glass Depths 值并标注「以 glass-tokens.md 评审稿为准」；`AGENTS.md` `apps/ohna-web` 段已补 Glass Depths 视觉说明；`docs/design/glass-tokens.md` §7 待办已裁决/标注。

---

## 9. 验收总闸

```bash
# Web：样式构建 + 测试
pnpm --filter @aiagent/ohna-web test
pnpm --filter @aiagent/ohna-web build

# CLI：主题单测
pnpm --filter @aiagent/ohna-cli test

# 全仓回归（换色不影响逻辑，但需确认架构/类型）
pnpm typecheck
pnpm architecture:check
pnpm build
```

**人工走查**：
- `pnpm --filter @aiagent/ohna-cli dev` 起 CLI → 确认欢迎态/整屏 TUI/权限卡/代码块/diff 的颜色为青绿系（非旧橙），NO_COLOR 降级信息靠符号存活；
- `pnpm --filter @aiagent/ohna-web dev` 起 Web → 切 `data-theme="dark"` / `"light"`，确认画布为中性近黑 `#18191A` / 暖白 `#FBFAF9`、侧栏/Trace 抽屉/设置弹窗有 glass blur、语法色双档可读、控件描边保留。
