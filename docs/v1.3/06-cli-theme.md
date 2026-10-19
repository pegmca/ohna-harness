# 06 · CLI 终端样式改造（复刻 Claude Code 风格）· v2

> **范围声明**：本方案只覆盖**视觉层**——ANSI 颜色、`⏺`/`⎿` 符号、`✻` spinner、输入区样式。
> 与 Claude Code 的**功能层差距**（权限三选项、Esc 中断、queued 回显、ctrl+o 展开、thinking 展示、
> Task 子 agent、命令补全等）统一收敛到 `07-cli-feature-parity.md`；其中 **ctrl+o 展开与 thinking 展示
> 涉及 render.ts 同一段代码**，实现顺序上建议 06 与 07 的批次 B1 协同交付，避免二次返工。
>
> v2 修订依据：2025-10 专家评审（P0×2 / P1×3 / P2×5），逐条吸收；v1 中「ctrl+o 展开」承诺、
> 多行边框输入区、「非 TTY 逐字节兼容」表述均已按评审结论修正。

---

## 1. 现状基线（已探明）

- CLI 输出为纯文本，全仓无 chalk / picocolors / spinner 依赖。样式触点：

| 文件 | 职责 | 现状样式 |
|---|---|---|
| `apps/ohna-cli/src/ui/render.ts` | 事件渲染（唯一入口，本地与 `--web` 共用） | `▸ 调用 tool(...)` / `✓ 完成` / `✖ 失败` / 流式裸 delta / diff 预览 / 折叠 / cost 小结 |
| `apps/ohna-cli/src/ui/welcome.ts` | 欢迎头 + `/help` 文案 | `────` 分隔线 |
| `apps/ohna-cli/src/commands/slash.ts` | 命令分发输出 | 纯文本 |
| `apps/ohna-cli/src/permission/confirm.ts` | y/n 确认提示 | `? 是否允许 …(y/N)` |
| `apps/ohna-cli/src/input/repl.ts` / `web-entry.ts` | prompt `你> `、run 状态行 | 纯文本 |

- 渲染管线硬约束：
  - `renderEvent` 必须保持**同步**（diff 预览同步读盘，render.ts:317 注释明确）；
  - REPL 在 run 期间 `rl.pause()`（repl.ts:255），confirm 闸门复用主 readline 的 `question`
    （隐式 resume，confirm.ts:7-10 注释）——spinner 类定时写入必须与 pause/resume/question 协调；
  - `repl.ts` 与 `web-entry.ts` 的 line/queue 循环同构双维护，prompt / 欢迎改动需两处同步；
  - **web 模式差异（评审新发现）**：`web-entry.ts` 的 `processLine` 不 `rl.pause()`（对比
    repl.ts:255），浏览器发起的 run 期间 prompt 仍活跃——spinner 接入前必须先对齐（§3.3）。

- 折叠数据流（评审核实）：`tool_execution_end.result` 携带**全量文本**（agent/types.ts:196），
  折叠是渲染层行为（`foldOutput`，render.ts:289-298）——**数据完整性已在内核**，展开交互是
  07-F3 的功能项，06 不碰折叠语义，只改折叠提示文案。

## 2. 测试锚定（v2 修正）

| 来源 | 被锚定的输出 |
|---|---|
| `apps/ohna-cli/test/render.test.mjs` | `✓ bash 完成：`（:51）、`✖ bash 失败：`（:62）、`▸ 调用 write(`（:99）、折叠提示（:31、:52）、diff `assert.match` 精确行（:71-100） |
| `test/verify-ohna-m2.mjs` | `⏹ 已停止：…`、`累计 token N`、捕获组 `/累计用量：token (\d+).*?成本 \$([\d.]+)/`（:584）、`模型调用失败`、doesNotMatch `▸ 调用`（:436） |
| `test/verify-ohna-m3.mjs` | `会话内命令：` / `当前模型：`、diff `-hello` / `@@ -1 +1 @@`、折叠三断言（:239-241）、`search_filings（MCP）`、`累计用量：…` 捕获组（:296） |

**v1 表述修正**（评审指出）：diff 断言是 `assert.match` 而非 deepEqual，且子串正则本身对
包一层 ANSI 是免疫的（`\x1b[31m-hello\x1b[39m` 仍匹配 `/-hello/`）——真正字节级易碎的只有
**两个数字捕获组**（verify-m2:584、verify-m3:296）。红线据此收窄（见 §3.2）。

**折叠文案断言**（v1 遗漏，评审补）：折叠提示从 `…[输出已折叠，省略 N 行]` 改为 `… +N 行`
会命中 render.test.mjs:31、:52 与 verify-m3:239 三处，必须列入同步清单。

**红线（v2 收窄）**：`累计 token N` / `成本 $X` 数字骨架与 diff 行内容（`-hello`、`@@ -1 +1 @@`）
**不得进入 ANSI 码**；符号类断言（`▸ 调用`→`⏺`、`✓/✖` 形态、折叠文案）随本次改造同步更新。
verify 脚本跑在管道（非 TTY）模式，TTY 门控后颜色自动降级；符号按 §3.2 裁决无条件替换，
故 v1 的「逐字节兼容」修正为「**行为兼容**：非 TTY 输出无任何 `\x1b` 转义序列，符号为新集合」。

## 3. 设计决策（v2）

### 3.1 零依赖手写 ANSI（保留）

约 60 行 theme 模块，与 `diff.ts` 零依赖哲学一致，不引入 chalk。

### 3.2 门控范围裁决（消解 v1 内部矛盾）

v1 的 3.2「符号仅 TTY 生效」与 4.7「同步更新测试断言」相互矛盾（测试跑非 TTY）。v2 裁决：

- **符号（`⏺ ⎿ ⏹ …`）无条件替换**：管道模式也用新符号，全部测试断言统一指向新符号集合；
- **颜色 / spinner / 整屏 TUI（含输入区边框）**仅 TTY 生效：`stdout.isTTY && !NO_COLOR && TERM !== "dumb"`；
- 红线收窄为：数字骨架与 diff 行内容不进 ANSI（§2）。

### 3.3 spinner：单写者协议（v2 重设计）

- **单 `✻` + 动词文案 + 已耗时秒数**（对齐 Claude Code 真实形态，弃 v1 的 `✻ ✽ ✶ ✳` 换帧）：
  `✻ 思考中… (3s)` / `✻ 执行 bash… (2s)`；
- **单写者协议**：spinner 帧与 `renderEvent` 的正文写入互斥——任何正文写入前先 stop&clear
  （`\r\x1b[K`），写完在空闲窗重启帧；confirm `question` 挂起前 suspend、resolve 后按需重启；
  abort / error / hook 抛错路径走 finally 停帧；
- **撕裂防护**：流式 delta 期间不启动帧（首帧延迟至 N ms 无输出后），避免 `\r\x1b[K` 清掉
  无换行结尾的 delta 尾部；长行 soft wrap 残迹同理规避；
- **web 模式对齐**：`web-entry.ts` 的 `processLine` 补 `rl.pause()`（对齐 repl.ts:255 语义），
  保证本地与 web 两种托管下 spinner 与 prompt 不打架；
- 挂接点收敛在**事件流**（agent_start 启动、tool_execution_start 换动词、message_update 抑制、
  agent_end 停帧），repl.ts / web-entry.ts 共用同一份，不做两处循环各自挂。

### 3.4 整屏 TUI 输入区（v3，取代 v2 的 readline 降级方案）

v2 曾因「readline 无法在光标活动行下方作画」而降级为「打印式顶线 + 单行 `│ > ` prompt 」，
放弃底部边框，并把 resize 重印列为可选增强。实测该方案在真实终端**不可用**：顶线打印后就固化
在滚动历史里，resize 时无法安全重绘，曾引发无限重绘风暴（屏幕上刷出成千上万行 `╭─ ohna ─╮`）。
因此 v3 改为**整屏 TUI**，对齐 pi-tui 的成熟模型：

- TTY 下由 `packages/term` 接管：`RawTerminal`（raw mode + bracketed paste + resize 监听）+
  `Screen`（**节流 + 幂等全量重绘**：`requestRender` 去抖、`doRender` 先 `clearScreen()` 再写整帧）；
- 输入区是 `box([editor.render(width - 2)], { title: "ohna" })`——上下边框与左右竖线宽度严格对齐
  （`box` 的显式 `width` 是硬约束，超长内容按可见列截断），不再是「顶线 + 单行 prompt」的拼装；
- 底部边框由整屏渲染天然提供，不再是「放弃项」；
- **resize 由 Screen 幂等重绘处理**：连续 / 高频 resize 只触发一次节流重绘，画的是同一帧，
  永不可能风暴——`TuiApp` 里没有任何 resize 代码；
- 光标由编辑器用 reverse video（`\x1b[7m`）呈现，硬件光标在整屏下隐藏，`stop()` 时归还
  （关 bracketed paste、恢复光标、还原 raw mode）；
- 对话输出经 `render.ts` 的 `write()` + `setOutputSink()` 注入对话内容模型；**任何绕过 `write()`
  的直写会被下一帧 `clearScreen()` 抹掉**（这是 v3 踩到的真实 bug：未知命令提示等在 TTY 下不可见）；
- **非 TTY 保持原滚动输出**：默认 sink 就是 `process.stdout.write`，管道输出不含 `\x1b`、不走整屏。

### 3.5 ⏺ 懒打点（v2）

assistant 正文的 `⏺` 不在 `message_start` 打，而在**首个 `text_delta` 到达时**打——纯 tool-call
消息（无文本内容）不产生悬空 `⏺` 行（对齐 Claude Code 行为）。thinking 增量的展示归 07-F3
（spinner 文案 / verbose 灰色 italic），06 不渲染 thinking。

### 3.6 ANSI 探测的时序约束（v2，评审 P2-2）

ESM import 链（index→harness→turn→render→theme）会在 `parseArgs` **之前**求值模块级常量。因此：

- theme 探测必须**惰性求值**（`supportsAnsi()` 每次调用现查环境）；
- 提供 `configure({ forced })` 显式覆盖与 `resetForTest()` 复位钩子（测试注入用）——
  注入覆盖若不复位，会让后续「非 TTY 无 `\x1b`」断言假绿；
- **裁决：不引入 CLI `--no-color` 参数**。色彩关闭依赖自动降级三件套
  （非 TTY / `NO_COLOR=1` / `TERM=dumb`），theme 的 `configure` / `resetForTest` 仅作测试注入入口。

## 4. 交付清单（v2）

1. `apps/ohna-cli/src/ui/theme.ts`（新）
   - 惰性 `supportsAnsi()` + `configure()` / `resetForTest()`；
   - 色板：accent（Claude 橙 208）、dim、success、error、warn、info、bold、italic；
   - `paint()` 安全包装（非 ANSI 返回原串）；符号常量（`⏺ ⎿ ✻ ⏹ …`）。
2. `apps/ohna-cli/src/ui/render.ts` 重排（保持同步，预计 ~430 行）
   - assistant：首个 `text_delta` 时打 `⏺`（accent，懒打点），流式 delta 顺排，`message_end` 收行；
   - 工具：`⏺ Tool(args)`（工具名 bold、args dim）替代 `▸ 调用`；结果 `⎿  …`（dim、缩进 2 格），
     失败 `⎿  ✖ …`（error 色）；折叠提示 `… +N 行`（dim，**不带 ctrl+o 提示**——文案待 07-F3
     落地后追加）；
   - diff 预览：`+` 绿、`-` 红、`@@` 头 accent（仅 TTY；diff 行内容本身不进 ANSI，红线见 §2）；
   - cost / 停止原因 / 错误行套色；数字骨架原样。
3. `apps/ohna-cli/src/ui/welcome.ts`：`✻ Welcome to ohna!` + 一次性边框面板（工作目录 / 模型 /
   工具数与 MCP 来源 / 命令 tips），TTY 门控；非 TTY 保持现纯文本头。
4. `apps/ohna-cli/src/ui/spinner.ts`（新，TTY only）：§3.3 单写者协议 + 动词文案 + confirm 挂起联动。
5. `apps/ohna-cli/src/input/repl.ts` / `web-entry.ts`：TTY 下改走整屏 TUI（§3.4，`packages/term` 的
   `Screen` + `TuiApp`），输入区为 `box` 包起来的完整边框；非 TTY 保留原 readline 路径。
6. 符号触点补全（v1 遗漏，评审 P2-1）：`confirm.ts:52`（`▸ --yes 自动放行`）、`confirm.ts:58`
   （`✖ 已拒绝`）、`web-entry.ts:378-384`（`⏹ run 已中断。` / `✖ run 失败。`）全部换新符号。
7. **裁决（事后记录）**：`--no-color` CLI 参数**不交付**。色彩关闭由自动降级覆盖（非 TTY /
   `NO_COLOR=1` / `TERM=dumb`），见 §3.6；`configure` / `resetForTest` 保留为测试注入机制。
8. 测试：
   - 新增 `theme.test.mjs`（探测矩阵 + paint 降级 + configure/resetForTest）、
     `welcome.test.mjs`（TTY / 非 TTY 双路径）；
   - 更新 `render.test.mjs`：符号断言（`▸ 调用`→`⏺`、`✓/✖`→`⎿` 形态）+ 折叠文案（:31、:52）+
     新增「非 TTY 输出不含 `\x1b`」断言；
   - `test/verify-ohna-m2.mjs` / `m3.mjs`：同步符号类断言与折叠断言（m3:239-241），
     **两个数字捕获组（m2:584、m3:296）不动**。
9. 文档：`` 记录主题层 / TTY 门控 / 单写者协议取舍；`docs/v1.3/README.md` 状态表同步。

## 5. 风险与对策（v2）

| 风险 | 对策 |
|---|---|
| spinner 与流式 delta / confirm question 竞争 stdout | §3.3 单写者协议（写入前 stop&clear、question 挂起 suspend、finally 停帧）；web-entry 先补 pause 对齐 |
| 多行 prompt 与 readline 重绘错位 | §3.4 改为整屏 TUI（`Screen` 幂等重绘），不再依赖 readline 重绘，风险消除 |
| resize 重绘风暴 | §3.4 整屏 TUI：`requestRender` 节流 + `doRender` 幂等清屏重画，连续 resize 只画同一帧 |
| ANSI 码破坏测试捕获组 | 红线收窄为两个捕获组 + diff 行内容；「非 TTY 无 `\x1b`」断言兜底 |
| theme 模块级状态导致测试间泄漏 | 惰性求值 + resetForTest；每个注入用例 afterEach 复位 |
| 旧符号触点漏改导致新旧混排 | §4.6 显式清单（confirm.ts / web-entry.ts 三处）+ 全仓 grep `▸\|✓\|✖` 验收步骤 |
| 单文件 500 行上限 | theme / spinner / welcome 拆分后 render.ts 预计 ~430 行；若 07-F3 同批改 render.ts 需复估 |

## 6. 验收

```bash
pnpm --filter @aiagent/ohna-cli build && pnpm --filter @aiagent/ohna-cli test
node test/verify-ohna-m2.mjs && node test/verify-ohna-m3.mjs
pnpm typecheck && pnpm architecture:check && pnpm build && pnpm test && pnpm lint
```

- **自动化**：以上全绿；`render.test` 含「非 TTY 输出无 ANSI」断言；verify 脚本符号与折叠断言已同步；
  全仓 grep 无残留旧符号（`▸ 调用` / `✓ … 完成` / `✖ … 失败` 形态）。
- **人工（TTY）**：真终端（非管道）跑 REPL（ohna 恒为编码助手），逐项目检：
  - 欢迎头 `✻` + 边框面板；输入区是完整边框（上下边框与左右竖线对齐）+ 反色光标；
  - **拖动窗口改变列宽：输入框随新宽度重绘且无刷屏（resize 不风暴）**（这是 v2 降级方案踩过的坑）；
  - 助手 `⏺` + 流式正文（懒打点，纯工具轮无悬空 `⏺`）；工具 `⏺ Tool(args)` + `⎿` dim 结果 + 折叠提示；
  - diff 预览红绿；`✻` spinner 动词文案与耗时；run 中触发 y/n 确认时 spinner 挂起、提示不被帧覆盖；
  - `--web` 模式：浏览器发起 run 期间终端 prompt 不与 spinner 打架；
  - `NO_COLOR=1` 下恢复无色输出；管道模式输出无 `\x1b`。
- 执行方式：沿用 **coder 实现 → reviewer 验证**（重点跑单测 + 2 个 verify 脚本 + TTY 目检清单）。
