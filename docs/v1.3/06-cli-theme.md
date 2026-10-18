# 06 · CLI 终端样式改造（复刻 Claude Code 风格）

> 目标：把 `apps/ohna-cli` 的终端输出从「纯文本 + `────` 分隔线」升级为 Claude Code 风格的视觉语言
> （ANSI 颜色 + `⏺`/`⎿` 符号 + `✻` spinner + 边框输入区），同时保证**非 TTY / 管道场景逐字节兼容现状**。
> 本方案已过评审（含测试锚定分析），待实现。

---

## 1. 现状基线（已探明）

- CLI 输出为纯文本，全仓无 chalk / picocolors / spinner 依赖。样式触点：

| 文件 | 职责 | 现状样式 |
|---|---|---|
| `apps/ohna-cli/src/render.ts` | 事件渲染（唯一入口，本地与 `--web` 共用） | `▸ 调用 tool(...)` / `✓ 完成` / `✖ 失败` / 流式裸 delta / diff 预览 / 折叠 / cost 小结 |
| `apps/ohna-cli/src/welcome.ts` | 欢迎头 + `/help` 文案 | `────` 分隔线 |
| `apps/ohna-cli/src/slash.ts` | 命令分发输出 | 纯文本 |
| `apps/ohna-cli/src/confirm.ts` | y/n 确认提示 | 纯文本 |
| `apps/ohna-cli/src/repl.ts` / `web-entry.ts` | prompt `你> `、run 状态行 | 纯文本 |

- 渲染管线硬约束：
  - `renderEvent` 必须保持**同步**（diff 预览同步读盘，render.ts:317 注释明确）；
  - REPL 在 run 期间 `rl.pause()`，confirm 闸门复用主 readline 的 `question`（隐式 resume）——重绘类改动必须与 pause/resume 协调；
  - `repl.ts` 与 `web-entry.ts` 的 line/queue 循环完全同构，prompt / 欢迎改动需两处同步。

## 2. 测试锚定（高危清单，改造时必须同步）

| 来源 | 被锚定的输出 |
|---|---|
| `apps/ohna-cli/test/render.test.mjs` | `✓ bash 完成：`、`✖ bash 失败：`、`▸ 调用 write(`、折叠提示、diff **deepEqual 精确行** |
| `test/verify-ohna-m2.mjs` | `⏹ 已停止：…`、`累计 token N`、捕获组 `/累计用量：token (\d+).*?成本 \$([\d.]+)/`、`模型调用失败`、doesNotMatch `▸ 调用` |
| `test/verify-ohna-m3.mjs` | `会话内命令：` / `当前模型：`、diff `-hello` / `@@ -1 +1 @@`、折叠三断言、`search_filings（MCP）`、`累计用量：…` 捕获组 |

**红线**：数字捕获组骨架（`累计 token` / `成本 $`）与 diff 行内容**不得进入 ANSI 码**；
符号类断言（`▸ 调用`、`✓/✖` 等）随本次改造同步更新。
verify 脚本跑在管道（非 TTY）模式——TTY 门控后自动走纯文本路径，逐字节兼容现状。

## 3. 设计决策

1. **零依赖手写 ANSI**（约 60 行 theme 模块），与 `diff.ts` 零依赖哲学一致，不引入 chalk。
2. **TTY 全量门控**：颜色 / 符号 / spinner 仅在
   `stdout.isTTY && !NO_COLOR && TERM !== "dumb" && !--no-color` 时生效；
   管道 / CI / verify 脚本自动降级为现状纯文本。
3. **保持同步渲染**：theme 只是字符串包装；spinner 独立模块（`setInterval` + `\r` 单行重写），
   流式 delta 到来时先 `\r\x1b[K` 清行再写正文，避免撕裂。
4. **符号升级为 Claude Code 集**：`⏺`（助手 / 工具）、`⎿`（工具结果缩进）、
   `✻ ✽ ✶ ✳`（spinner 帧）、折叠提示 `… +N 行 (ctrl+o 展开)`；中文文案保留。

## 4. 交付清单（文件级）

1. `apps/ohna-cli/src/theme.ts`（新）
   - `supportsAnsi()` 探测矩阵（isTTY / NO_COLOR / TERM=dumb / `--no-color`，模块级可注入覆盖便于测试）；
   - 色板：accent（Claude 橙 208）、dim、success、error、warn、info、bold、italic；
   - `paint()` 安全包装（非 ANSI 返回原串）；符号常量（`⏺ ⎿ ✻ ⏹ …`）。
2. `apps/ohna-cli/src/render.ts` 重排（保持同步，预计 ~430 行）
   - assistant：`message_start` 打 `⏺`（accent），流式 delta 顺排，`message_end` 收行（现补 `\n` 逻辑保留）；
   - 工具：`⏺ Tool(args)`（工具名 bold、args dim）替代 `▸ 调用`；
     结果 `⎿  …`（dim、缩进 2 格），失败 `⎿  ✖ …`（error 色）；
     折叠提示 `… +N 行 (ctrl+o 展开)`（dim）；
   - diff 预览：`+` 绿、`-` 红、`@@` 头 accent（仅 TTY；纯文本模式逐字节不变）；
   - cost / 停止原因 / 错误行套色；`累计 token N … 成本 $X` 数字骨架原样。
3. `apps/ohna-cli/src/welcome.ts`
   - `✻ Welcome to ohna!` + 圆角边框面板（工作目录 / 模型 / 工具数与 MCP 来源 / 命令 tips），TTY 门控；
   - 非 TTY 保持现纯文本头。
4. `apps/ohna-cli/src/spinner.ts`（新，TTY only）
   - `startSpinner(verb)` / `stopSpinner()`；frames `✻ ✽ ✶ ✳`，120ms 间隔 + 已耗时秒数；
   - 挂接点：`turn.ts` 的 run 开始 / 结束与 `web-entry.ts` 的 run 订阅；`message_update` delta 前清行；
   - 异常路径（abort / error / hook 抛错）必须 `stopSpinner`（finally 语义）。
5. `apps/ohna-cli/src/repl.ts` / `web-entry.ts`
   - `rl.setPrompt` 升级为带边框输入区（`╭─…─╮\n│ > `，宽度随终端列数），run 结束重印；
   - `confirm.ts` y/n 提示套色（非 TTY block 语义不变）。
6. `apps/ohna-cli/src/args.ts` / `index.ts`：新增 `--no-color`；help 更新。
7. 测试：
   - 新增 `theme.test.mjs`（探测矩阵 + paint 降级）、`welcome.test.mjs`（TTY / 非 TTY 双路径）；
   - 更新 `render.test.mjs`：旧符号断言（`▸ 调用`→`⏺`、`✓/✖`→`⎿` 形态）+ 新增「非 TTY 输出不含 `\x1b`」断言；
   - `test/verify-ohna-m2.mjs` / `m3.mjs`：仅同步符号类断言，捕获组与 diff 行断言不动。
8. 文档：`` 记录主题层 / TTY 门控取舍；根 `README.md` 补 `--no-color`；
   `docs/v1.3/README.md` 状态表同步。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| spinner 与流式 delta 竞争 stdout | 单一写入顺序（先清行再写）+ TTY 门控；管道模式不可见 |
| 多行 setPrompt 与 pause/resume 冲突 | 改动仅限 prompt 字符串与欢迎调用；running 标志 / pending 队列 / EOF 短路语义不动 |
| ANSI 码破坏测试捕获组 | 数字骨架不进色；`render.test` 新增「非 TTY 无 `\x1b`」断言兜底 |
| 单文件 500 行上限 | theme / spinner / welcome 拆分后 render.ts 预计 ~430 行 |

## 6. 验收

```bash
pnpm --filter @aiagent/ohna-cli build && pnpm --filter @aiagent/ohna-cli test
node test/verify-ohna-m2.mjs && node test/verify-ohna-m3.mjs
pnpm typecheck && pnpm architecture:check && pnpm build && pnpm test && pnpm lint
```

- **自动化**：以上全绿；`render.test` 含「非 TTY 输出无 ANSI」断言；verify 脚本符号断言已同步。
- **人工（TTY）**：真终端（非管道）跑 `--mode coding` REPL，逐项目检：
  - 欢迎头 `✻` + 边框面板；输入区 `│ > `；
  - 助手 `⏺` + 流式正文；工具 `⏺ Tool(args)` + `⎿` dim 结果 + 折叠提示；
  - diff 预览红绿；`✻` spinner 动画与耗时；Ctrl-C / y/n / /cost 等套色；
  - `--no-color` 与 `NO_COLOR=1` 下恢复纯文本。
- 执行方式：沿用 **coder 实现 → reviewer 验证**（重点跑 48 单测 + 2 个 verify 脚本 + TTY 目检清单）。
