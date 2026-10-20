# 07 · CLI 功能对齐 Claude Code（差距清单 + 编码建议）

> 定位：承接 2025-10 专家评审的差距分析，把「ohna-cli vs Claude Code」的功能层差距**依次立项**。
> 视觉层（颜色 / 符号 / spinner / 输入区样式）归 `06-cli-theme.md`，本方案不重复。
>
> **内核改动授权**：允许对 `packages/*` 做破坏式修改（不留兼容层），但公共接口变更必须在同一任务内
> 更新全部调用方与文档（AGENTS.md 约定）。设计总诉求：**内核能力通用、易拓展**——内核产出可组合的
> 领域原语与钩子，CLI 只是其中一个宿主；`ohna-web` / `finance-api` 等其它宿主零成本复用。

---

## 0. 设计原则（内核通用性的三条判据）

所有 K 项（内核改动）设计时必须过这三条判据，评审时逐条对照：

1. **副作用声明进工具契约（单一事实源）**：审批依据从「各 app 硬编码工具名单」改为工具自声明
   元数据。新增工具（含 MCP、未来扩展）自动进入权限体系，无需改任何 app 的名单常量。
2. **策略在内核包、问询 UI 在组合根**：领域策略（规则组合 / 会话记忆 / 模式预设）做成纯对象放
   `packages` 领域模块（先例：`packages/agent/src/team/`——loop 内核不 import 它，组合根装配）；
   CLI 的 readline 问询、serve 的 SSE 确认卡片都只是「ask 适配器」。
3. **内核钩子优先于 app 层补丁**：能挂内核既有挂载点（`beforeToolCall` / `getSteeringMessages` /
   `getFollowUpMessages`，agent/types.ts:153-165）解决的，不在 app 层模拟。内核已备而 app 未用的
   能力优先接线（本方案 K2 即典型）。

**内核现状盘点（差距分析的重要前提，已逐行核实）**：

| 内核能力 | 状态 | 证据 |
|---|---|---|
| thinking 流式事件 | **已有**，CLI 未渲染 | `thinking_start/delta/end`（ai/types.ts:215-217）；CLI 明确跳过（render.ts:130） |
| 工具结果全文 | **已有**，折叠是渲染层行为 | `tool_execution_end.result` 全量（agent/types.ts:196）；`foldOutput` 截断（render.ts:289-298） |
| 运行中注入钩子 | **已有，未接线** | `getSteeringMessages` / `getFollowUpMessages`（agent/types.ts:153-156）；turn.ts createConfig 未配置 |
| 子 agent 原语 | **已有，未接线** | `TeamCreate` / `SendMessage` 工厂 + controller 句柄（agent/team/tools.ts:50/86）；ohna-cli 零引用 |
| 多模态消息类型 | **已有** | `UserMessage.content` 支持 `ImageContent`（ai/types.ts:149）——图片输入的类型层已备 |
| 审批挂载点 | **已有** | `beforeToolCall`（agent/types.ts:163），但策略本体重复散落两处（下文 K1） |
| Web 异步确认 | **已有** | serve confirm-gate：`confirmation_requested` 事件 + SSE + 路由（confirm-gate.ts） |

## 1. 差距总览矩阵

差距等级：**核心**（交互手感 / 信任模型的实质缺失）、**重要**（明显体验差）、一般。
「内核需求」列为空 = 纯 CLI 层改动；`K n` 引用 §2 的内核改动项。

### 1.1 输入体验

| 能力 | Claude Code | ohna 现状 | 等级 | 内核需求 | 批次 |
|---|---|---|---|---|---|
| 运行中排队 + `» queued` 回显 | 排队可见，run 间隙注入继续跑 | 队列完全静默（repl.ts:333-336），run 结束后才串行处理 | 核心 | **K2** | B1 |
| Esc 中断当前 run | Esc 即中断 | 仅 Ctrl-C（repl.ts:341-355）；中断语义本身已有（AbortController） | 核心 | 无（raw-mode keypress） | B1 |
| 双击 Esc 回退 / 编辑历史消息 | rewind 菜单 | 无 | 核心 | K4（远期） | 远期 |
| Shift+Tab 模式切换 | default / acceptEdits / plan 循环 | 无；只有 `--yes` 全放行（args.ts） | 核心 | **K1**（模式=策略预设） | B2 |
| `/` 命令补全菜单 | 即输即显 | 无 completer（repl.ts:84-88），回车后才解析 | 核心 | 无（readline completer） | B3 |
| `@` 文件引用补全 | 内联补全 + 读入上下文 | 无 | 核心 | 无（`UserMessage.content` 数组已支持多块） | B3 |
| `!` bash 直通 / `#` 快速记忆 | 有 | 无（repl.ts:326-339 仅 line 事件） | 重要 | 无 | B3 |
| vim mode / 图片粘贴 / Ctrl+R 搜索 | 有 | 无（图片类型层已备：ImageContent） | 一般 | 无 | 远期 |

### 1.2 输出体验

| 能力 | Claude Code | ohna 现状 | 等级 | 内核需求 | 批次 |
|---|---|---|---|---|---|
| ctrl+o verbose 展开 | 全局折叠/展开切换 | 折叠单向截断不可展开（render.ts:289-298）；事件流已是全文 | 核心 | 无（渲染层缓存 + 开关） | B1 |
| thinking 展示 | 灰色 italic 思考流 | 明确不渲染（render.ts:130）；事件协议已有 | 重要 | 无 | B1 |
| `⏺`/`⎿` 符号、`✻` spinner | 有 | 06 方案覆盖 | — | — | 06 |

### 1.3 权限与会话

| 能力 | Claude Code | ohna 现状 | 等级 | 内核需求 | 批次 |
|---|---|---|---|---|---|
| 确认三选项 + 会话记住 | Yes / Yes-don't-ask-again / No | 单问 y/N（confirm.ts:62），无记住、无规则 | 核心 | **K1** | B2 |
| allow/deny 规则 + /permissions 管理 | 规则文件 + 运行时管理 | 无；`--yes` 全放行（confirm.ts:51-54）与逐次确认两极 | 核心 | **K1** | B2 |
| /resume 会话 fork | 切换时可 fork | 列表 + 切换，无 fork（repl.ts:180-213） | 一般 | 无 | B3 |
| /rewind checkpoint 回退 | 代码 + 会话快照 | 无 | 核心 | K4 | 远期 |
| /export 导出 | markdown 导出 | 无（JSONL 可手 cat） | 一般 | 无 | B3 |

### 1.4 斜杠命令

ohna 8 个（slash.ts:13-21：help/clear/cost/exit/model/compact/tools/resume）vs Claude Code 25+。
缺：`/permissions`（依赖 K1）、`/status`、`/config`、`/mcp`、`/memory`、`/init`、`/doctor`、
`/rewind`（K4）、`/export`、`/review`、`/agents`、`/hooks`、`/statusline`、`/vim`、`/add-dir`。
已达标：`/compact`（含前后 token 报告）、`/model`、`/cost`、`/resume`、`/clear`。
**判断**：命令数量是表症，实质是背后的权限（K1）/ 诊断 / 记忆子系统缺失；命令随子系统落地逐个补。

### 1.5 高级能力

| 能力 | Claude Code | ohna 现状 | 等级 | 内核需求 | 批次 |
|---|---|---|---|---|---|
| Task 子 agent | Task 工具 spawn 隔离上下文 | 原语已有未接线（team/tools.ts）；缺策略继承与渲染 | 核心 | **K3** | B3 |
| TodoWrite 任务清单 | 有 | 无 | 重要 | K5（可选） | B3/远期 |
| hooks / 自定义命令 / statusline | 有 | 无 | 重要 | — | 远期 |
| MCP 管理面 | /mcp 列表 + 启停 | 接入有（mcp-config.ts），管理面无 | 一般 | 无 | B3 |
| headless `-p` + JSON 输出 | 有 | `--prompt` 单次模式基本等价，无 JSON 输出 | 一般 | 无 | 远期 |

### 1.6 上下文管理（已达标，不立项）

`/compact` 手动压缩、三层自动压缩（run 内 transformContext + 会话级落盘压缩 + 硬收敛）、
AGENTS.md/DESIGN.md 项目记忆注入、`--resume`。此域与 Claude Code 对齐度最高，无内核改动。

## 2. 内核改动设计（K 项）

### K1 权限策略内核（packages/tools + packages/agent/src/permission/，批次 B2）

**现状问题**：审批名单硬编码两处且不一致地演化——CLI `CONFIRM_TOOL_NAMES`（confirm.ts:17）与
serve `MUTATING_TOOLS`（confirm-gate.ts:68）；「会话记住 / 规则 / 模式」无处安放，CLI 与 serve
两套 ask 实现无法共享策略演进。

**设计**（过 §0 三条判据）：

1. **`AgentTool` 增加副作用元数据**（packages/tools，破坏式）：
   ```ts
   interface AgentTool<...> {
     ...
     /** 副作用声明：read 工具直接放行，mutate 工具进入权限策略。MCP 工具缺省 mutate（保守）。 */
     effect?: "read" | "mutate";
   }
   ```
   内置 7 工具全部补标注（read/grep/find/ls → read；write/edit/bash → mutate）。
   **单一事实源**：新增工具自动进入权限体系，删除两处名单常量。

2. **`packages/agent/src/permission/` 领域模块**（新，loop 内核不 import，组合根装配——对齐
   `team/` 范式；`beforeToolCall` 挂载点语义不变，agent/types.ts:160-163 的「loop 不接审批」
   边界保持）：
   ```ts
   /** 权限请求：工具名 + 校验后参数 + 副作用声明。 */
   interface PermissionRequest { toolName: string; args: unknown; effect: "read" | "mutate" }
   /** 策略裁决：allow 直接放行；deny 直接拒绝（plan 模式用）；ask 转问询 UI。 */
   type PermissionDecision =
     | { outcome: "allow" }
     | { outcome: "deny"; reason: string }
     | { outcome: "ask"; summary: string };

   /** 可组合策略：规则查询是纯函数；会话记忆（allowlist）由 PolicyState 承载。 */
   interface PermissionPolicy {
     decide(request: PermissionRequest, state: PolicyState): PermissionDecision;
   }
   /** 会话级记忆：按工具名 / 工具名+路径前缀记住「本会话一律允许」。 */
   interface PolicyState {
     allow(toolName: string, target?: string): void;
     isAllowed(toolName: string, target?: string): boolean;
     rules(): readonly PermissionRule[];   // /permissions 展示与删改用
   }

   /** 预设 = 策略组合（对齐 Claude Code Shift+Tab 循环）：
    *  default       mutate → ask
    *  acceptEdits   write/edit → allow，bash → ask
    *  plan          mutate → deny（不询问），且装配层不注册 mutating 工具
    *  bypass        全放行（对齐 --yes / serve --auto-approve）
    */
   function createPresetPolicy(preset: PermissionPreset): PermissionPolicy;
   function composePolicy(...policies: PermissionPolicy[]): PermissionPolicy;  // 用户规则叠加预设

   /** 组装成 beforeToolCall 钩子：ask 分支委托 UI 适配器，answer 决定是否写 PolicyState。 */
   type AskAdapter = (
     request: PermissionRequest, decision: { outcome: "ask"; summary: string }, signal?: AbortSignal,
   ) => Promise<"allow" | "allow-session" | "deny">;
   function createPermissionGate(
     policy: PermissionPolicy, state: PolicyState, ask: AskAdapter,
   ): (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
   ```

3. **宿主接线（破坏式替换，不留兼容层）**：
   - CLI：`confirm.ts` 的 `createToolConfirmGate` 重写为 readline 三选项 AskAdapter
     （`1. 允许一次  2. 本会话一律允许  3. 拒绝`；非 TTY 保持「默认拒绝」语义，confirm.ts:56-60），
     名单常量删除；`--yes` 改为 `bypass` 预设。
   - serve：`confirm-gate.ts` 的 Promise 挂起 + 超时 / abort 清理保留为实现细节，改造为 SSE
     AskAdapter（复用既有 `confirmation_requested` 事件 + confirmations 路由 + 待确认卡片），
     `--auto-approve` 改为 `bypass` 预设。
   - `PolicyState` 持久化由宿主决定：CLI 挂在 session meta（可选），serve 挂 RunManager 生命周期。

**验收**：同一 `createPresetPolicy("default")` + 同一 PolicyState 在 CLI（readline）与 serve（SSE）
产生相同 decision 序列；plan 预设下 write/edit/bash 直接 deny 且零询问；新增一个 mutate 工具
（无 effect 标注的 MCP 工具）自动触发确认，不改编译期之外的任何宿主代码。

### K2 排队与 steering 接线（内核已备，apps/ohna-cli 接线，批次 B1）

- **`getFollowUpMessages`**（agent/types.ts:155-156：run 将结束时拉取，有则注入并继续跑）：
  `turn.ts` 的 `createConfig` 接入——REPL 的 `pending` 队列（repl.ts:81）从「run 结束后串行新开
  run」改为「注入当前 run 继续跑」，行为对齐 Claude Code 的 queued 消息；
- **`getSteeringMessages`**（agent/types.ts:153-154：下一轮 LLM 调用前注入）用于**运行中纠偏**
  （用户补充「改用 X 方案」，不中断 run 立即生效）；
- 两个钩子的分工写进 `设计笔记`：follow-up =「排队等当前 run 收尾」，steering =「正在跑也要立即看到」；
- CLI 回显：入队时 `» 已排队（#N）`；steering 注入时 `» 已注入当前运行`；
- `runTurn` 的 history 并入逻辑不动（follow-up 消息由 loop 并入 agent_end.messages 增量）。
- web-entry 的同构队列同步改造（web 模式浏览器 composer 的排队语义与本地一致）。

### K3 子 agent（Task）接线（packages/agent/team 已备 + 装配层，批次 B3）

- `harness.ts` 装配：构造 TeamController，把 `createTeamCreateTool` / `createSendMessageTool`
  （team/tools.ts:50/86）注册进 coding 工具表；`--no-team` 可关（默认开）；
- **策略继承（K1 通用性的直接验收场景）**：`runMember` 装配子代理 loop 时必须传入与 supervisor
  相同的 `createPermissionGate` 产物——子代理的 write/bash 同样受审、同样写共享 PolicyState；
- 渲染零改造：TeamCreate/SendMessage 的结果按普通工具事件走 `⏺ Task(...)` / `⎿` 摘要
  （`SubagentResult.summary` 即摘要文本），无需事件冒泡；
- 成本护栏沿用 team 包已有的 budget/slo（team/budget.ts）。

### K4 checkpoint / rewind（远期，先立契约）

- 文件 journal：coding 工具执行前记录 `(path, oldContent)` 反操作对；
- 会话截断：session store 支持按 runId / sequence 截断重放（serve 的 JSONL 已可重放，
  CLI session-store 对齐该契约）；
- 双击 Esc 菜单消费 journal + 截断：回代码、回会话、两者都回。
- 落地前先在 `设计笔记` 写契约设计，不急于实现。

### K5 TodoWrite（可选，批次 B3 或远期）

- `packages/coding` 新增 todo 工具（读写 `.ohna/todos.json`，会话工作区内）；渲染层按普通工具
  出 `⎿` 摘要即可。**不做**内核事件广播——等第二个宿主（web UI 任务面板）真需要时再升级为事件，
  避免过度设计。

## 3. CLI 功能项（F 项）

- **F-1 权限三选项**（依赖 K1）：readline 三选项 AskAdapter + 「本会话一律允许」写 PolicyState；
  非 TTY 默认拒绝语义不变。
- **F-2 Esc 中断 + queued 回显**（依赖 K2）：`readline.emitKeypressEvents` + raw-mode 监听 Esc →
  `controller.abort()`（中断语义复用 repl.ts:341-347 的 Ctrl-C 路径）；`» 已排队` 回显；
  双击 Esc（500ms 窗口）先占位为「编辑上一条输入」，rewind（K4）落地后升级为回退菜单。
- **F-3 ctrl+o verbose + thinking 展示**（零内核依赖，与 06 协同）：
  - render 层缓存最近 N 个折叠块全文；ctrl+o 全局切换 verbose 并重打最近折叠块（对齐 CC 的全局
    切换语义，不是逐块展开）；06 的折叠文案 `(ctrl+o 展开)` 在本项落地后才追加；
  - `thinking_delta`：默认进 spinner 文案（`✻ 思考中…`）；verbose 模式下渲染灰色 italic 块
    （事件协议已有，render.ts:130 的跳过分支改为按开关分派）；
  - `Usage.reasoning`（ai/types.ts:134）已含推理 token 计数，`/cost` 顺带展示。
- **F-4 Task 子 agent**（依赖 K3）：`--no-team` 参数 + /tools 展示 Team 来源标注。
- **F-5 `/` 命令补全**：readline completer（slash.ts 命令表 + 参数提示），Tab 触发；
  菜单式（即输即显）需要 raw-mode 输入层，作为远期与 vim/图片输入共同的地基。
- **F-6 `@` 文件引用**：completer 补全 workspace 相对路径（复用 coding 路径策略做过滤）；
  选中后构造 `UserMessage.content` 数组（文件内容作为独立 TextContent 块，类型已支持）。
- **F-7 `!` bash 直通 / `#` 记忆**：`processLine` 前缀分派——`!` 直接调 bash 工具（**过权限 gate**，
  不绕过 K1）；`#` 追加 AGENTS.md 用户段并提示（复用 project-context 注入链）。
- **F-8 命令补表**：`/permissions`（K1 的 PolicyState 展示 + 规则增删）、`/status`（模型 / 会话 /
  MCP / 预算快照）、`/mcp`（server 与工具清单）、`/export`（会话导出 markdown）、
  `/resume` 加 fork（复制旧会话消息开新 sessionId）。

## 4. 批次计划（按「向 Claude Code 体验对齐」的价值排序）

| 批次 | 内容 | 内核改动 | 交付判据 |
|---|---|---|---|
| **B1 交互手感闭环** | 06（视觉层）+ F-2（Esc/queued）+ F-3（ctrl+o/thinking） | 仅 K2 接线（钩子已有） | run 中输入可见排队、Esc 可中断、ctrl+o 可展开、thinking 可见；render.ts 一段代码一批改完，避免二次返工 |
| **B2 权限系统** | K1 → F-1 → Shift+Tab 模式切换（default/acceptEdits/plan 循环）→ `/permissions` | K1（effect 元数据 + permission 模块） | 同一 policy 双宿主一致；plan 模式零确认零变更；三选项可会话记住 |
| **B3 能力扩展** | K3 + F-4、F-5、F-6、F-7、F-8 余项、/resume fork | K3（装配 + 策略继承）、K5 可选 | Task 工具可用且子代理受审；补全/引用/直通可用 |
| 远期 | K4 rewind、hooks、自定义命令、statusline、vim、图片输入、headless JSON | K4 | 按需单独立项，不进本方案排期 |

## 5. 验收与文档同步

- 每批次沿用 **coder 实现 → reviewer 验证**；验证命令沿用 06 §6 的全量门禁
  （typecheck / architecture:check / build / test / lint + ohna-cli 专项测试 + verify 脚本）。
- B1 人工清单追加：排队回显、Esc 中断、ctrl+o 展开、thinking 流、`/cost` 推理 token。
- B2 双宿主一致性用例写入 `packages/agent` 测试（同一 policy 跑 CLI 适配器与 fake SSE 适配器）。
- 文档同步义务（每批）：`设计笔记` 对应主题笔记（B1：`coding-cli.md` 补交互协议；B2 新增
  `permission-policy.md`；B3 新增 `subagent-task.md`）；`docs/v1.3/README.md` 状态表；
  K1 / K3 触及公共 API 的，同步 AGENTS.md 的 Repository Structure 描述。

---

## 6. 落地结果（B1-B3，2025-10）

> 本节记录本轮实际交付、关键实现位置与**已知偏差**；后续维护以此为准，勿只看 §2-§4 的规划态描述。

### 6.1 批次状态

| 批次 | 状态 | 核心交付 | 主要文件 |
|---|---|---|---|
| **B1 交互手感** | **已实现** | K2 follow-up 排队注入当前 run（slash 命令不注入）；Esc 中断 / 双击 Esc 占位；`» 已排队（#N）`；ctrl+o verbose + 折叠块重打；thinking（TUI 占位行 / 非 TTY spinner）；`/cost` reasoning token | `follow-up.ts`、`esc-gesture.ts`、`render.ts`、`tui-app.ts`、`tui-editor.ts`、`turn.ts`、`usage.ts` |
| **B2 权限系统** | **已实现** | `AgentTool.effect` 单一事实源；`packages/agent/src/permission/`；三选项 + 会话记住；Shift+Tab default/acceptEdits/plan；plan 过滤 mutating 工具；`/permissions`；serve SSE AskAdapter 复用同一 policy | `packages/tools/src/{types,agent-tool}.ts`、`packages/agent/src/permission/*`、`confirm.ts`、`permission-session.ts`、`permission-mode.ts`、`packages/serve/src/confirm-gate.ts` |
| **B3 能力扩展** | **已实现** | K3 TeamCreate/SendMessage 接线；子代理策略继承（fail-closed）；`--no-team`；`/tools` Team 标注；`@` 文件引用（TUI 面板 + 提交展开）；`!` bash 直通（过闸门）/ `#` 记忆；`/status` `/mcp` `/export` `/resume fork` | `team-wiring.ts`、`packages/agent/src/team/{types,controller,tools}.ts`、`file-reference.ts`、`tui-file-palette.ts`、`direct-command.ts`、`memory-note.ts`、`session-export.ts`、`session-commands.ts` |
| 远期 | 未启动 | K4 rewind、hooks、自定义命令、statusline、vim、图片输入、headless JSON | — |

### 6.2 关键落地决策（与 §2 规划的差异）

1. **TUI 已是主路径**：§2 中「readline completer / raw-mode 地基」的描述已过时——CLI 在 v1.3 已迁移整屏 TUI，`/` 与 `@` 面板都落在 `TuiApp` / `LineEditor`；非 TTY 保留 readline 降级路径。
2. **ctrl+o 的 append-only 语义**：TUI 对话区是追加式内容模型，ctrl+o 只能「重打最近 N 个折叠块全文」，不能原地展开已打印行；这是刻意的 MVP 取舍，已在 `` 说明。
3. **effect 单一事实源**：`AgentTool.effect` 缺省 `mutate`（覆盖 MCP / 未标注工具）；`TeamCreate` / `SendMessage` 标 `read`（编排本身无直接文件副作用，真正写操作在子代理内受同一闸门裁决）。
4. **策略继承用可变 gateRef**：team controller 先于 REPL 创建（工具表要并入），闸门后建；转发器 `createTeamGateForwarder` 在闸门未就绪时 **fail-closed**（返回 block），避免未来新增入口漏回调导致静默放行。
5. **content 数组兼容**：`@` 展开后 `runTurn` 接受 `UserMessage["content"]`（字符串或块数组）；compaction 估算/摘要、session-store、`/export` 均已适配并补测试。
6. **状态行双锚点**：输入框下方左侧显示 `⏵⏵ <权限模式>`（default / acceptEdits / plan / bypass，带语义色），右侧保留 `模型 · 上下文占比`；模式由 `permissionSession.preset()` 每帧实时求值，Shift+Tab 切换即时可见。
7. **`/resume` 会话选择面板**：无参时在输入框下方展示最近 10 个会话（标题 / 短 id / 时间 / 条数），↑/↓ 选择、Enter 切换、Esc 取消；选中回调复用 `processLine('/resume <id>')` 的命令分发与串行保护。非 TTY 仍回退为文本列表 + `/resume <id>`。

### 6.3 已知偏差与后续项

- **web 模式 K2 语义**：`--web` 走 serve 的 `createRun`（每次一个完整 run），终端侧没有 agentLoop 级 follow-up 可注入；web 排队仍是「run 结束后串行新开 run」+ `» 已排队` 回显。已登记为 B1 已知偏差（``）。
- **serve 会话记住**：Web 确认卡片仍只有 allow/deny，没有「本会话一律允许」；B2 的会话记住仅 CLI 提供（`PolicyState` 在 serve 侧为空）。
- **plan 模式的子代理工具池**：plan 只过滤 supervisor 的 mutating 工具；子代理池仍完整，靠继承闸门 deny 兜底（无越权，但可能白耗 turn）。
- **`!` 直通不进 history**：结果只打印，不进入模型上下文；长命令可被 Esc/Ctrl-C 中断（B3b 已接线）。
- **`@` 扫描上限**：默认最多 2000 个文件、深度 12；超大仓库可能漏掉深层文件，可按前缀继续过滤。
- **`/export` 预算**：单文件 2MB 上限、写入 `0600`；`--web` 托管模式暂不支持导出。
- **`#` 记忆边界**：要求 `# `（井号+空白）才当记忆；`#include` 等按普通文本交给模型；plan 模式拒绝写入 AGENTS.md。

### 6.4 验证证据

本轮最终门禁全绿：

```bash
pnpm typecheck          # 全仓通过
pnpm build              # 全仓通过
pnpm test               # 全仓通过（ohna-cli 140 / agent 89 / coding 79 / serve 25；finance-api 42 pass + 3 skipped）
pnpm architecture:check # 590 modules / 1162 dependencies，无违规
```

`pnpm lint` 仍有 12 个存量 error（均在未改动的历史测试文件），本轮改动文件 0 error（仅存量 warning）。

### 6.5 相关笔记

- `` —— B1 交互协议（follow-up / steering、Esc、ctrl+o、thinking）。
- `` —— B2 权限策略内核（effect、preset、组合、双宿主、会话记忆）。
- `` —— B3 K3 团队接线与策略继承（gateRef 时序、fail-closed、已知限制）。
- `` —— B3 F-6/F-7/F-8（`@` / `!` / `#` / 命令补表）。
- `` —— 本轮 B1-B3 总览与学习检查点。
