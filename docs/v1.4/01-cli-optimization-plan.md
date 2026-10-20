# 01 · ohna CLI/TUI 优化实施计划

> **口径**：基于 `docs/v1.4/README.md`（opencode v2.0.32 ↔ ohna v1.3 收尾状态差异对比）整理的实施计划。
> 对比文档只记差异；本文是**依赖有序、可独立验收**的分阶段改造方案，每个阶段有文件级交付清单 + 验收命令 + 完成判据。
>
> 核心判断：v1.4 对比文档中 B 类（同层能力差异）与 C 类（表现差异）差异，大部分共享同一个卡点——**ohna 的对话模型是"预合成 ANSI 字符串数组"（`contentLines: string[]`，`ui/tui/tui-app.ts:124`）+ 事件直接写渲染层（`ui/render.ts`）**。语义条目化是一切结构性优化的前置；渲染内核（行差分）是语义条目化的地基。因此顺序固定为 **C0 渲染内核 → C1 语义条目模型 → C2 命令注册表/输入路由 → C3 权限卡与 Toast → C4 长会话预算 → C5 主题 token**，测试基建（C6）随 C0/C1 同步铺设。
>
> 执行纪律（沿用 `docs/v1.3/04-development-plan.md` 头部声明与 `设计演进记录` §3 七步法）：
> - 每阶段只做「窄切片 + 可验收」，禁止无验收的大爆炸重写。
> - 每个阶段跑完本文 §11 验收总闸的**相关子集**再进入下一阶段。
> - 文档同步：每完成一阶段，更新本文状态表 + ``（新建）+ `设计演进记录` 对应产出。
> - 归因：opencode 为 MIT（`opencode/LICENSE`，含 `packages/tui`），凡参考实现的源文件在文件头注明 `ported from opencode (<path>)`，取舍记录进 ``（先例：v1.3 对 pi-monorepo 的参考实现）。

---

## 0. 阶段总览与依赖

```
C0  packages/term 行差分渲染 + 光标原语（独立，渲染地基）
 │
C1  ohna-cli 语义条目模型 + TuiState 统一 + 行投影（最大重构；B 类差异公共根因）
 │   ├──  语义模型/差分渲染学习点（随做随记）
 │   └── C6-a reducer/classifier/rows 单测 + 整帧快照（随 C1 交付）
 │
 ├─► C2  命令/键位单一注册表 + 模式栈输入路由（与 C1 都改 tui-app.ts，必须排在 C1 后）
 │
 ├─► C3  权限卡 composer 替换 + Toast 层（依赖 C1 entry 模型 + C2 模式栈）
 │
 ├─► C4  长会话预算（权重挂载依赖 C1 组权重；session-store 尾部加载可独立先行）
 │
 └─► C5  主题状态色 + 表面（独立小件，可与 C3/C4 并行）
```

- C0 与 C1 无文件交集（C0 改 `packages/term`，C1 改 `apps/ohna-cli/src/ui`），但 C1 的验收依赖 C0 的差分体验；**建议串行**。
- C2 必须晚于 C1：两者都大幅改写 `tui-app.ts` 的不同侧面（C1 改帧合成、C2 改输入分派），并行会冲突。
- C3 依赖 C1（权限卡是 entry/overlay 之外的第一种"非对话流内容"）与 C2（confirm 需要成为顶栈模式）。
- C4 的 `session-store` 尾部加载可随时插入（与 C1~C3 无文件冲突），但权重挂载部分必须在 C1 之后。

---

## 1. 设计决策（本轮拍板，实现时不再逐项讨论）

- **D1 · 不收敛 A 类差异**：不引入组件树/渲染框架、不做鼠标支持、不引入 Effect 式 DI、不做多端共享 client 投影。这些是结构差异（对齐对比文档 §三.A），对单仓学习型 CLI 性价比为负。
- **D2 · 包边界**：`packages/term` 只加**终端渲染原语**（光标移动、行差分）；对话领域模型（entry/组/折叠/verbosity）是 ohna 的产品概念，归 `apps/ohna-cli/src/ui`。term 保持"无业务语义"的包边界规则。
- **D3 · 单一事件归约器 + 双 presenter**：run 事件 → entry 的归约逻辑只写一份；非 TTY / readline 降级路径是**打印 presenter**（现 render.ts 的行为原样保留），TUI 是**投影 presenter**。行为对非 TTY 用户零变化。
- **D4 · 无兼容约束**：开发验证阶段，`contentLines` 链路、`render.ts` 模块级全局、字符串权限协议都**直接替换不留兼容层**（先例：v1.3 D9）。
- **D5 · 状态统一是 C1 的完成判据，不是顺手项**：`render.ts` 5 个模块级全局（`assistantDotPrinted / verbose / thinkingBlockOpen / thinkingHintPrinted / recentFolded`）与 `spinner.ts` 模块级状态必须收编进 `TuiState` 或 presenter 内部。验收方式：`src/ui` 下 grep 无 `^let` 模块级可变全局（print presenter 内部局部状态除外）。
- **D6 · verbosity 作为分类期旋钮**：布尔 `verbose` 升级为 `low / medium / high` 三档（对应 opencode：low = 全部非文本 entry 折进 activity；medium = 分组但折叠；high = 分组且默认展开）。在归约/分类阶段生效，投影层零 verbosity 条件分支。
- **D7 · 权限确认升级为结构化协议**：`confirm(question: string) => Promise<string|null>` 升级为 `confirmToolCall(info: { tool; summary; diff? }) => Promise<"allow"|"session"|"deny"|null>`。`packages/serve` 的 SSE AskAdapter（`routes/confirmations.ts`）**不在本期改动**，保留其字符串问答协议。
- **D8 · 全帧模型内的"合成槽"**：Toast、权限卡都在 `buildFrame` 的固定槽位合成（`requestRender` → 全帧重算 → C0 差分输出），不引入备用屏/浮层/zIndex——这是全帧同步测量架构的后发优势。
- **D9 · 键位先行、覆盖配置缓行**：先做单一键位定义表 + 帮助/palette 从表生成；用户自定义键位（YAML 覆盖）与 leader 前缀列为远期，不进本期范围。
- **D10 · 渲染安全的既有不变量保持**：每行仍经 `truncateToWidth`（ANSI/CJK 感知）、普通输出不可含尾随换行的现状语义、16ms 节流保持。

---

## Phase C0 · packages/term 行差分渲染 + 光标原语

**目标**：流式渲染的 stdout 量从「每次清屏 + 整帧全写」降到「只写变化的行」，消除 flicker；为 C1 语义模型提供渲染底座。`tui-app.ts:11` 头注释标注的 Phase B2「流式原地刷新」由本阶段的差分机制天然达成，无需 app 侧改动。

**现状**：`packages/term/src/screen.ts` 171 行，`doRender` = `clearScreen()` + 全帧 join 写出；`terminal.ts` 已有 `hideCursor/showCursor/clearLine`，无光标定位原语。

**交付清单（文件级）**：

1. `packages/term/src/terminal.ts`：`Terminal` 接口与 `RawTerminal` 增加光标原语（带中文 JSDoc）：
   - `moveCursorUp(n)` / `moveCursorDown(n)` / `moveCursorToColumn(n)`（`\x1b[{n}A` 等系列，供差分定位用）。
2. `packages/term/src/screen.ts`：
   - 保留 `RenderFn` 契约不变（调用方仍返回**整帧最终行**）——差分是 Screen 内部优化，调用方零感知。
   - `doRender` 改为差分：保留 `prevFrame: string[]`；逐行比对，只对变化的行做「`\r` 回行首 + `clearLine` + 重写」；行数减少时清除末尾多余行。
   - **resize（宽或高变化）与首帧强制全量重绘**（clearScreen 路径保留，维持现幂等语义）；首次渲染后记录尺寸。
   - `MIN_RENDER_INTERVAL_MS = 16` 节流逻辑不动。
   - 差分必须逐字节比较含 ANSI 的最终串（`stripAnsi` 不参与，避免"颜色变了但内容没变"误判）。
3. `packages/term/test/screen.test.mjs`：扩展（用假终端捕获 write 序列）：
   - 两帧内容相同时第二次输出为空；仅最后一行变化时只重写该行；
   - 行数减少时多余行被清除；resize 后触发全帧重绘。

**验收**：

```bash
pnpm --filter @aiagent/term test
pnpm typecheck
```

手工：`pnpm --filter @aiagent/ohna-cli dev`，流式输出一次长回复，肉眼确认无闪屏（另一终端 `script` / 计数 stdout 字节数可选）。

**完成判据**：流式期间每次 render 只写变化行，屏幕无残留/错位；`tui-app.ts` 与 `render.ts` 无需任何改动即为真（差分对调用方透明）。

---

## Phase C1 · 语义条目模型 + TuiState 统一 + 行投影（最大重构）

**目标**：把「事件 → 预合成 ANSI 行」改为「事件 → 语义 entry → 纯投影出可见行」。解锁：组级折叠（ctrl+o 原地展开/收起）、活动摘要（"3 commands, 1 edit"）、verbosity 三档、消息显式状态（streaming/done/error）、以及 C4 的权重挂载与 C3 的 overlay 模型。同时收编四处分散状态（`TuiApp` 私有字段 / `LineEditor` 字段 / `render.ts` 5 全局 / `spinner.ts` 6 全局）。

**现状**：`ui/render.ts` 529 行（`renderEvent` 直接 `write()` ANSI 字符串；`recentFolded` FIFO 8 块支撑 ctrl+o"重打全文"）；`tui-app.ts` 571 行（`contentLines: string[]` 追加式 + `buildFrame` 尾部截取）。

**交付清单（文件级，新目录 `ui/stream/` + `ui/tui/` 内拆分，守 ≤500 行规则）**：

1. `apps/ohna-cli/src/ui/stream/entries.ts`（新）：语义条目类型（唯一契约，勿在别处重复定义）：
   ```ts
   export type TuiEntryKind = "user" | "assistant" | "reasoning" | "tool" | "error" | "notice";
   export type TuiEntryStatus = "streaming" | "running" | "done" | "error";
   // 每条 entry 有稳定 id（折叠/展开状态的 key），文本字段存**未上色原文**；
   // 上色是投影层职责（rows.ts / print.ts 各自决定），归约层不产 ANSI。
   export interface TuiEntry { id: string; kind: TuiEntryKind; status: TuiEntryStatus; text: string; meta?: … }
   ```
2. `apps/ohna-cli/src/ui/stream/reducer.ts`（新）：`StreamReducer` 消费与现 `renderEvent` 同源的事件流（event + tracker），产出/修补 entry 序列。吸收 render.ts 的时序状态：流式 `tool_execution_start` 置 running、`end` 置 done；`assistant` 条目在 streaming 期间只 patch `text`；`message_end` stopReason=error → status=error。**移除**：`assistantDotPrinted`（隐式在 assistant 条目）、`recentFolded`（折叠改为组模型查询）、`verbose`（移入 state.verbosity）。
3. `apps/ohna-cli/src/ui/stream/print.ts`（新）：非 TTY 打印 presenter——现 render.ts 的 `write()` 行为（含 `foldOutput` 1200 字符/40 行截断、40 行 diff 折叠）**原样迁移**为 entry → 行的降级格式化。非 TTY 行为零变化。
4. `apps/ohna-cli/src/ui/render.ts`：退化为 re-export 壳（`renderEvent` 等入口签名不动，内部转调 reducer + 参数指定 presenter），`repl.ts` 等调用方零修改或最少修改。开发验证阶段允许直接替换内部实现（D4）。
5. `apps/ohna-cli/src/ui/tui/grouping.ts`（新，参考实现）：opencode `routes/session/grouping/tree.ts` 的纯分组树（111 行，MIT，文件头标注 ported from opencode）——相邻同 kind 合并 + `size`（后代叶子数）+ `mergeGroups/splitGroups` 保留对象身份便于差分。
6. `apps/ohna-cli/src/ui/tui/classifier.ts`（新，参考分类规则）：`entryPath(entry, verbosity): GroupKind[]`，参考 opencode `grouping/session.ts` 的 `partPath`，按 ohna 工具表适配：
   - `read / grep / find / ls` → `["exploration"]`；`bash / write / edit` → `["activity"]`（ohna 无 instructions 合成消息，**起步三类：reasoning / exploration / activity**，medium/high 生效；low 档所有非文本条目统一 `["activity"]` 前缀，整轮折叠为一行）。
   - `activitySummary` 参考 `activity-summary.ts`（`:61-95`）：只计**已完成**条目（运行中走 busyLabel，如 "Running bash…"），格式 `${n} ${label}` 连接："3 commands, 1 edit, 2 thoughts, 4 reads"。
7. `apps/ohna-cli/src/ui/tui/rows.ts`（新）：`projectRows(entries, { verbosity, expanded, width }) → string[]` 纯投影：
   - entry 序列 → 分组树 → 每组渲染策略（折叠=摘要头 1 行；展开=子项行）→ 上色 → `truncateToWidth`；
   - 折叠状态 `expanded: Map<groupID, boolean>`，`groupID = 组首叶子 id + kind`（对齐 opencode `anchors.ts` 的稳定锚点思路）；
   - verbosity 语义（D6）：low=一律 activity 组；medium=reasoning/exploration 分组且折叠、activity 逐条；high=同 medium 且 exploration 默认展开；reasoning 非 verbose 档仍可整组隐藏（保留现有"✻ 思考中…"提示行策略）。
   - 长文本行内截断沿用头/尾折叠（head 15 + tail 10），但**缓存内容在 entry 上，不在折叠缓存**。
8. `apps/ohna-cli/src/ui/tui/state.ts`（新）：`TuiState`——`{ entries, verbosity, expanded, toast 队列预留(C3), confirm 预留(C3) }` + 订阅 `onChange → requestRender`。**D5 验收点**：
   - `spinner.ts`：stdout 写逻辑删除，保留帧序列常量与 `interval`；spin 帧由 state.runTimer 驱动（"running" entry 的旋转帧在 rows 投影时取），spinner tick → `requestRender`。
   - `tui-app.ts`：删除 `contentLines / buffer`，改为持有 state；`append(s)` 变为「delta → reducer.patch → requestRender」。
9. `apps/ohna-cli/src/ui/tui/tui-app.ts`：`buildFrame` 改为纯合成：`[projectRows(...)尾部, 行内进行中的 assistant/reasoning 行, 输入框(现 box), ★后续槽位(toast/permission 卡 C3), panel, status 行]`。目标 ≤400 行：panels（palette/file palette/session picker 调度）拆出到 `ui/tui/panels.ts`（现有 picker/palette 本就是独立文件，只拆组合逻辑）。
10. ctrl+o 语义升级（改动点：`render.ts:113-125` 的 `reprintRecentFolded` 删除，`commands/slash.ts` 的 `resetFoldCache` 删除，`tui-app.ts` 的 `onVerboseToggle` 改为切换 `expanded` 组开关）：ctrl+o 从「重打全文」升级为原地开关**最近一个折叠组**；多组导航列入 C2 键位表。
11. 测试（C6 随做）：
    - `test/stream-reducer.test.mjs`：事件序列 → entry 断言（running→done、error、流式 patch、thinking 状态）；
    - `test/classifier.test.mjs`：相邻合并、summary 计数（command/edit/read/thought）、low/medium/high 分类差异；
    - `test/tui-rows-snapshot.test.mjs`：固定 fixture 会话 + width 80/120 → `projectRows` 金样快照（C6-a）。

**验收**：

```bash
pnpm --filter @aiagent/ohna-cli test
pnpm typecheck && pnpm architecture:check
test/verify-ohna-m3.mjs   # 非行为回归：slash/diff/folding 端到端仍绿
```

手工：`pnpm --filter @aiagent/ohna-cli dev` 跑一次含 read ×2 + bash 的编码任务，验证 exploration 组摘要行、ctrl+o 原地展开/收起、verbosity 三档切换（Shift+Tab 循环模式不变，/verbose 变 /verbosity 或复用）。

**完成判据**：
- `grep -nE "^let " apps/ohna-cli/src/ui/*.ts` 无模块级可变全局残留（print presenter 内部局部状态除外）；
- ctrl+o 是原地组开关（不再向对话流追加全文）；
- 非 TTY 打印输出与改造前等价（test/verify-ohna-m3.mjs + render 降级对比用例）。

---

## Phase C2 · 命令/键位单一注册表 + 模式栈输入路由

**目标**：消除命令元数据五处手工同步（`SlashCommandName` union + `SLASH_COMMANDS` + `COMMAND_ALIASES` + `SlashHandlers` + `MAX_PALETTE_ITEMS=12`）与 `handleInput` 的 4 级 if 链；帮助、palette、解析全部从一张表派生。新增命令 = 只改一处。

**现状**：`commands/slash.ts` 186 行（四张表三处脱节风险）；`tui-app.ts:332-368` 分派链 = sessionPicker → panel → filePalette → editor 逐级 fall-through。

**交付清单（文件级）**：

1. `apps/ohna-cli/src/commands/registry.ts`（新）：
   ```ts
   export interface CommandDef {
     id: string;                    // "session.exit"
     title: string;
     description: string;
     slash?: { name: string; aliases?: string[] };  // 并入原 COMMAND_ALIASES，含 /help /? 等非面板项
     keys?: string;                 // 全局键位描述（"ctrl+o"），帮助生成用
     panel?: boolean;               // 是否出现在 / 面板（"/verbose" 等隐藏命令用 panel:false）
     run?: (ctx: CommandContext, arg: string) => Promise<boolean> | void;  // 返回 true=已处理
   }
   ```
   `SlashHandlers` 结构并入 `CommandContext`；`parseSlashCommand / filterSlashCommands / printUnknownCommand` 全部改为消费注册表。
2. `apps/ohna-cli/src/ui/tui/keymap.ts`（新）：全局键位单一表（现 ctrl+o / Shift+Tab / Esc / 双 Esc / ctrl+c / ↑↓历史 散落于 `tui-editor.ts:151-227` 与 `tui-app.ts handleInput`），字段 `{ id, keys, description, when?: "always"|"running"|"confirm" }`；`/help`、palette footer、welcome 键位提示从本表生成（一处来源）。leader 前缀不做（D9 远期）。
3. `apps/ohna-cli/src/ui/tui/input-router.ts`（新）：模式栈：
   ```ts
   interface InputMode { id: "confirm" | "session-picker" | "palette" | "file-palette" | "editor" | … ;
                        handle(data: string): boolean; }  // true=已消费
   ```
   `TuiApp.handleInput` → `router.dispatch(data)`：顶栈 enabled 模式先消费，未消费才穿透到下一层。现有 4 级优先链与其 `panelOpen()` 字符串判断（`v.startsWith("/") && !/\s/`）消除；confirm / picker / palette / file-palette 各自注册 mode。
   - 语义区分：picker/palette 是「打开-关闭」的弹栈模式；editor 是常驻底栈模式。
4. `apps/ohna-cli/src/commands/slash.ts`：退化为注册表消费者（或并入 registry），`SlashCommandName / SLASH_COMMANDS / COMMAND_ALIASES / SlashHandlers` 删除（D4）。
5. `apps/ohna-cli/src/ui/tui/tui-app.ts`：palette 高度改为按 buildFrame 可用高度裁剪候选（复用现有截断；`MAX_PALETTE_ITEMS` 常量删除，12 上限不再静默吞命令）。
6. 测试：`test/registry.test.mjs`（别名解析/过滤/帮助生成/panel 可见性）、`test/input-router.test.mjs`（模式优先级、穿透、弹栈恢复）。

**验收**：

```bash
pnpm --filter @aiagent/ohna-cli test
pnpm typecheck
```

手工：`/per` 补全 Tab/Enter、Esc 关闭 palette 后编辑器内容保留、confirm 期间按键全被 confirm 模式消费。

**完成判据**：`grep -rn "SLASH_COMMANDS\|COMMAND_ALIASES\|SlashHandlers\|MAX_PALETTE_ITEMS" apps/ohna-cli/src` 无残留；新增一条命令只改 registry 一处；`/help` 与 palette 键位提示同源。

---

## Phase C3 · 权限卡 composer 替换 + Toast 层

**目标**：落 v1.4 对比文档 §2.6 / §2.7 的两项交互差异。权限确认从「对话流内 1/2/3 文字问答（`confirm.ts:102-128` 字符串解析 + Esc=deny hack）」升级为「输入区替换的权限卡」；瞬时提示从「追加进对话流」升级为 Toast。这是体验跃迁最明显的阶段。

**现状**：权限问题经 `tui.confirm → confirmResolver` 占用普通编辑器输入；"已排队 / verbose 提示 / 模式切换 / 自动放行日志"都写进对话流。

**交付清单（文件级）**：

1. `apps/ohna-cli/src/permission/confirm.ts`：ask 协议升级（D7）：
   - `askToolCall(info: { tool: string; summary: string; diff?: string }) => Promise<"allow" | "session" | "deny" | null>`；
   - `parsePermissionAnswer` 的字符串协议随 readline 降级路径保留（非 TTY 三选一文本交互不变）；TUI 路径改走新协议；
   - `packages/serve` AskAdapter 不动（D7）；simulate 团队 subagent 复用同一闸门（`agent/src/team/` beforeToolCall 继承链不动）。
2. `apps/ohna-cli/src/ui/tui/permission-card.ts`（新）：
   - 渲染：标题行（工具 + 摘要，复用 `describeToolCall`）+ diff 预览（复用 `ui/diff.ts` unified；**>120 列侧侧分栏列为远期**，diff.ts 仅 unified）+ 选项行 `[1] 允许一次  [2] 本会话一律  [3] 拒绝`；
   - 按键：`1/2/3` 或 `y/a/n` 直选，`↑↓+Enter` 也可，`Esc = deny`（对齐 opencode 语义：拒绝是显式选项，不再是 hanging promise hack）；
   - 高度预算：diff 预览行数受输入区高度分配约束（复用 buildFrame 高度分配，超长 diff 走现有头尾折叠）。
3. `apps/ohna-cli/src/ui/tui/toast.ts`（新）：队列 + 可暂停计时器（参考 opencode `ui/toast.tsx` 的 queue/pause 语义，MIT 归因）：
   - `push({ text, duration=5000, action? })`；显示中新 toast 未暂停且队列为空 → 直接替换，否则入队；超时后 `pop` 显示下一条，渲染 "+"N more；
   - 渲染槽：输入框上方 1 条（D8 合成槽，最多同屏 1 条）。
4. `apps/ohna-cli/src/ui/tui/input-router.ts`：新增 `"confirm"` 模式（权限卡激活时压栈，压栈期间该模式独占按键）；批处理/`--auto-approve` 直通路径不走卡片。
5. 现有追加式提示迁移为 toast：排队"» 已排队（#N）"、verbose/模式切换提示、`message_end` stopReason=error 摘要（详情仍留在对话流 entry）、`--yes 自动放行` 日志（`confirm.ts:132-144`）。对话流只保留正式结果。
6. 测试：`test/toast.test.mjs`（替换/排队/超时/暂停与恢复）、`test/permission-card.test.mjs`（渲染宽度截断/按键解析/diff 高度预算）。

**验收**：

```bash
pnpm --filter @aiagent/ohna-cli test
pnpm typecheck
```

手工：默认权限模式下让 agent write 一个文件——卡片替换输入区出现（diff 预览在卡内）、`2` 一次记住本会话、`Esc` 显式拒绝且 conversation 流获得结构化 deny 结果、ctrl+c 期间不挂起。

**完成判据**：对话流中不再出现权限问题文本行与 1/2/3 应答；`confirmResolver` 机制删除；权限 denies 语义与 readline 路径一致。

---

## Phase C4 · 长会话预算（权重挂载 + 存储尾部加载）

**目标**：长会话初始加载快（只读尾部）、渲染预算随折叠组提升显示容量（折叠组恒 1 行）。落对比文档 §2.5。

**现状**：`session-store.ts` 全量加载（config 启动 + `--resume`）；`buildFrame` 只按终端高度取尾部行，组权重概念不存在。

**交付清单（文件级）**：

1. `apps/ohna-cli/src/session/session-store.ts`：`loadSessionTail(id, n)`——从文件**尾部倒读**（fd + 反向 Buffer 扫描，遇换行收集至 n 条），返回 (messages, hasMore)。`--resume` 与 `/resume` 默认 tail 加载（n=80），全量读取保留给 `/export` 等需要完整历史的场景。
2. `apps/ohna-cli/src/ui/tui/rows.ts`：`rowWeight(group)`——折叠组=1、展开组=`1+Σ子权重`、平条目=1（概念参考 `mount-budget.ts`；全帧模型下同步测量，**无需 opencode 的 afterLayout 补偿滚动**——这是架构差异红利，写进 ``）。
3. `apps/ohna-cli/src/ui/tui/mount.ts`（新）：`TRANSCRIPT_TAIL_ROWS=40` / `BACKFILL_CHUNK=60`；上滚键（键位表注册 `session.scroll.up/down`，默认 PageUp/PageDown）在顶行时回填一批；滚到底 `session.toBottom`；上/下滚出现历史窗口时状态行显示 "↑ 历史 N 条"。
4. 渲染：rows 按预算切片后从尾部对齐显示；折叠组权重为 1 的效果 = 同屏可见的对话深度显著提升（对照测试：终端高 ~80 行、纯折叠组形态下同屏可见 ~8 组）。
5. 测试：`test/session-store-tail.test.mjs`（大 JSONL 倒读、损坏行跳过、n > 总量边界）、`test/mount.test.mjs`（切片边界、backfill 后窗口不跳变）。

**验收**：

```bash
pnpm --filter @aiagent/ohna-cli test
pnpm typecheck
```

手工：用 `test/verify-ohna-m2.mjs` 生成的长会话 resume，首帧加载时间与内存稳定；PageUp 回填可见历史不跳变。

**完成判据**：resume 大会话初始加载只解码尾部 n 条；全帧行数 ≤ 终端高度恒成立。

---

## Phase C5 · 主题状态色 + 表面（最小 token 落地）

**目标**：落对比文档 §2.2 中**成本最低的三块**：状态色（selected/focused）、表面（消费预留的 `BACKGROUND` 常量）、语义可解析的角色。不追完整 9 档 hue 树。

**现状**：`theme.ts` 11 个平铺 role + `BACKGROUND {canvas,panel,toolCard,stroke}` 四常量**无人消费**（`theme.ts:53-62`）；选中/高亮靠反转视频。

**交付清单（文件级）**：

1. `apps/ohna-cli/src/ui/theme.ts`：
   - 新增 role：`selected` / `selectedText`（面板高亮、picker 选中行、palette 当前行）；`focused`（确认中的权限卡边框/accent，与 `warn` 区分）；
   - 新增 `surface(name)`：`"panel" | "toolCard" | "stroke" | "canvas"` 从 `BACKGROUND` 解析并按 `supportsAnsi()` 门控——panel/palette/session picker 背景与边框开始有视觉分层；
   - 色值仍为代码内常量（主题文件/JSON 文档与系统 16 色检测为远期，不进本期）。
2. `packages/term/src/index.ts`：光标/清屏已具备，**不加语义色板**（包边界规则保持——`term` 只有 ANSI 原语，色板语义归 app `theme.ts`）。
3. 测试：`test/theme.test.mjs` 扩展（新 role 存在性、`NO_COLOR` 门控双通道输出不变）。

**验收**：`pnpm --filter @aiagent/ohna-cli test && pnpm typecheck`，手工看 palette 选中行、面板底色、权限卡边框。

**完成判据**：`BACKGROUND` 四常量至少被 `surface()` 消费两处；palette/picker 不再依赖反转视频单独标记选中。

---

## Phase C6 · 测试基建（随 C0/C1 铺设，不单独成期）

**目标**：补 v1.4 对比文档 §2.10 的缺口，给 C1 大重构提供回归保险。

**交付清单（与 C0/C1 同步交付）**：
1. `packages/term/test/screen.test.mjs`：差分行为（C0）。
2. `apps/ohna-cli/test/tui-editor.test.mjs`（新）：`LineEditor` 键位矩阵（历史/光标/paste/左裁剪）、**CSI 跨 chunk 截断缓冲**（修 `readEscapeSequence` 丢弃不完整序列的缺陷：不完整序列缓冲到下一 chunk 拼装，跨 chunk 用例覆盖）。
3. `apps/ohna-cli/test/tui-rows-snapshot.test.mjs`：整帧金样（fixture 会话 × width 80/120），布局回归显性化。
4. `packages/term/test/visible-width.test.mjs`（新）：组合字符/emoji 边界、`truncateToWidth` 颜色闭合。

**完成判据**：上述四个测试文件存在且全绿；`tui-app.test.mjs` 现有帧宽不变量用例继续通过。

---

## 8. 参考来源与许可

- 来源：`https://github.com/sst/opencode`，**MIT License**（`LICENSE`，Copyright (c) 2025 opencode；`packages/tui` 同 MIT）。
- 本计划中的具体参考点（均做适配/改造，见对应阶段）：

| 参考项（目标包名） | opencode 源 | 阶段 |
|---|---|---|
| 语义分组树（相邻同 kind 合并 / 对象身份保留 / `merge/split`） | `packages/tui/src/routes/session/grouping/tree.ts` | C1 |
| 分类规则 `partPath`（按 ohna 工具表适配为三类） | `packages/tui/src/routes/session/grouping/session.ts` | C1 |
| 活动摘要计数（已完成项只计、busyLabel 防闪烁） | `packages/tui/src/routes/session/activity-summary.ts` | C1 |
| verbosity 三档分类语义 | `grouping/session.ts` + `index.tsx` 默认展开逻辑 | C1 |
| 挂载预算权重（`rowWeight / rowsBefore / rowsAfter` 概念） | `packages/tui/src/routes/session/mount-budget.ts` | C4 |
| Toast 队列 + 可暂停计时行为 | `packages/tui/src/ui/toast.tsx` | C3 |
| 权限卡 composer 替换模式（替换区优先级 Switch：排队提示 → 权限卡 → 普通输入框） | `routes/session/index.tsx:1462-1531` + `permission.tsx` | C3 |
| 权限卡内 diff 预览（≤120 列 unified；>120 列侧侧分栏为远期） | `routes/session/permission.tsx` | C3（分栏远期） |
| 键位/命令单一注册表模式（默认键描述表 / 共享 dispatch / palette-slash-keymap 单命名空间） | `packages/tui/src/config/keybind.ts` + `context/keymap.tsx` | C2 |

- 归因要求：参考实现的文件头标注 `ported from opencode <路径> (MIT)`，取舍记录进 ``。

---

## 9. 不做清单（明确排除，防止范围膨胀）

- 组件树 / flexbox 布局 / Solid 式细颗粒差分渲染 —— A 类差异（对比文档 §三.A）。
- 鼠标支持、备用屏缓冲、浮动 zIndex 弹层 —— 全帧模型下无收益。
- 用户自定义键位覆盖（YAML）、leader 前缀（`ctrl+x` + 后继键的定时前缀序）—— 远期，见 D9。
- 主题 JSON 文件与系统终端 16 色明暗检测 —— 远期。
- 权限卡 >120 列侧侧分栏 diff —— 远期，见 C3 交付清单说明。
- `packages/serve` SSE AskAdapter 协议升级 —— serve 侧独立演进，本期只动 CLI 侧（D7）。
- K4 checkpoint/rewind、steering 实装 —— 已在 `` §7 列为「后续可选」，归路线图主线处理，不混入本计划（但 C1 的稳定 entry id / 组锚点为其预留定位基础）。

---

## 10. Line-count / 包边界自查（每阶段收尾跑一次）

```bash
# 单文件 ≤500 行
find apps/ohna-cli/src/ui apps/ohna-cli/src/commands packages/term/src -name "*.ts" -not -path "*/dist/*" \
  | xargs wc -l | sort -rn | head -8
# 状态统一（C1 后应无输出）
grep -nE "^let " apps/ohna-cli/src/ui/*.ts apps/ohna-cli/src/ui/tui/*.ts apps/ohna-cli/src/ui/stream/*.ts
# 命令元数据唯一来源（C2 后应无输出）
grep -rn "SLASH_COMMANDS\|COMMAND_ALIASES\|SlashHandlers\|MAX_PALETTE_ITEMS" apps/ohna-cli/src
# 架构依赖方向
pnpm architecture:check
```

---

## 11. 验收总闸（每个 Phase 跑相关子集）

```bash
pnpm --filter @aiagent/term test
pnpm --filter @aiagent/ohna-cli test
pnpm typecheck
pnpm architecture:check
pnpm build
```

端到端（每阶段完成时手工 + 现有脚本）：

```bash
test/verify-ohna-m2.mjs          # 会话持久化 / compaction 回归
test/verify-ohna-m3.mjs          # slash / diff / folding 非行为回归
pnpm --filter @aiagent/ohna-cli dev   # TUI 手工验收（见各 Phase 手工项）
```

---

## 12. 风险与缓解

| 风险 | 说明 | 缓解 |
|---|---|---|
| C1 状态收编牵动面大 | render.ts/spinner.ts/tui-app.ts/confirm.ts 四处共享时序状态；漏一处即出现"幽灵行/不折叠" | D5 列为完成判据（grep 验证）；C6 快照先行固定基线；非 TTY print presenter 保持行为零变化以缩小爆炸半径 |
| 行差分边界态 | 行数减少（折叠）与 resize 竞态 | resize 与首帧强制全帧（保留现幂等语义）；screen.test 覆盖减少行清尾 |
| 权限卡与 abort 竞态 | run 中断时卡片挂起 | Card resolve 走 `waitAbort` 同款 `Promise.race`（现 `confirm.ts:249-267` 的机制保留）；Esc/deny 是显式选项 |
| 键位表与 editor 冲突 | editor 目前直接消费 ctrl+o / Shift+Tab，与全局键抢按键 | C2 模式栈下全局键由 router 统一裁决，editor 不再按键优先消费；回归用 test/input-router 覆盖 |
| palette 高度可变 | palette 高度随候选数变，帧尾部布局重排 | 差分渲染对此透明；tui-app.test 帧宽不变量继续守护 |

---

## 13. 状态表（随阶段完成更新）

| 阶段 | 内容 | 状态 |
|---|---|---|
| C0 | term 行差分渲染 + 光标原语 | ✅ 已完成（2026-10-19）：光标原语 + `Screen` 行差分（首帧/resize 全量、相同帧零写入、减行清尾）；term 35/35、typecheck 通过 |
| C1 | 语义条目模型 + TuiState 统一 + 行投影 | ✅ 已完成（2026-10-20）：`ui/stream/{entries,reducer,print,print-format}.ts` + `ui/tui/{grouping,classifier,rows,state,panels,frame}.ts`；`render.ts` 退化为薄壳；ctrl+o 原地组开关；非 TTY 打印逐字节等价 |
| C2 | 命令/键位单一注册表 + 模式栈输入路由 | ✅ 已完成（2026-10-20）：`commands/registry.ts` + `ui/tui/{keymap,input-router}.ts`；旧四张表与 `MAX_PALETTE_ITEMS` 删除；`/help`/palette/欢迎头同源 |
| C3 | 权限卡 composer 替换 + Toast 层 | ✅ 已完成（2026-10-20）：`ui/tui/{permission-card,permission-request,toast,composer}.ts`；`askToolCall` 结构化协议（serve 未改）；Toast 队列可暂停；旧 `confirmResolver` 删除 |
| C4 | 长会话预算（尾部加载 + 权重挂载） | ✅ 已完成（2026-10-20）：`session-tail.ts` 逆序读取 + `ensureFullHistory` 防截断 + `ui/tui/{mount,transcript}.ts` 权重挂载与 PageUp/PageDown 回填 |
| C5 | 主题状态色 + 表面 | ✅ 已完成（2026-10-20）：`selected/selectedText/focused` + `surface()/paintOnSurface()/paintBg()`；palette/picker/权限卡消费；非 TTY 零 ANSI |
| C6 | 测试基建（随 C0/C1 同步） | ✅ 已完成：`screen.test.mjs`（差分）、`visible-width.test.mjs`、`tui-editor.test.mjs`（CSI 跨 chunk）、`tui-rows-snapshot.test.mjs`，另含 reducer/classifier/registry/input-router/input-assembler/toast/permission-card/mount/session-store-tail 单测 |

**验收总闸（2026-10-20 复核）**：term 35/35、ohna-cli 283/283、`pnpm typecheck`、`pnpm architecture:check`（627 modules 无违规）、`pnpm build`、`pnpm test`，以及 `test/verify-ohna-m2.mjs` / `test/verify-ohna-m3.mjs` 全绿。

**评审结论**：独立 reviewer 两轮只读审查；首轮 2 个 Blocker（reasoning 条目无终态、ESC 跨 chunk 被输入路由抢先裁决）与若干 Major/Minor 已全部修复并有回归测试，复审结论「无阻塞，可合并」。

**已知取舍**：`pnpm lint` 全仓仍红（29 error），其中 10 项来自未改动的历史测试文件（`packages/term/test/{box,truncate}.test.mjs`、`screen.test.mjs` 旧用例），本次新增测试沿用同样风格；仓库验证闸门（typecheck/build/test/architecture）全绿，lint 不作为本计划验收条件（后续可单独清理）。
