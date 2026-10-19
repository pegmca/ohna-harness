# v1.3 编码型 Agent 改造方案（ohna：CLI + 本地 Web）

> **开发验证阶段 · 无向后兼容约束**：本阶段所有改动（目录/包名改名、bin 名、CLI 参数面、模式默认值等）**不需要考虑兼容原代码**，可直接打破重来；金融产品线仅需保证自身构建/测试通过，不受改名影响。

> 目标：把共享核心 `agentLoop`（`packages/agent`）从「金融 SaaS 专用」扩展为**能真实改代码、跑测试、自己修的编码 Agent**，
> 能力对齐 Claude Code / Codex CLI / CodeBuddy Code；产品命名 **ohna**，表面包括终端（`apps/ohna-cli`）+ 本地 Web（`apps/ohna-web`，依托 CLI 启动）+ 服务端装配（`packages/serve`，薄入口 `apps/ohna-api`）。
>
> **本文是索引与总览**。落地细节分三份文档：
> - `03-decomposition.md` —— 权威拆解 + 目标架构 + 设计决策（**取代 02 文档中「复用 apps/api createApiServer」的假设**）
> - `04-development-plan.md` —— 依赖有序、文件级交付清单的分阶段开发计划
> - `05-verify-cases.md` —— 分层验收用例（安全 P0 / ohna-cli M2 / serve L0-L1 / ohna-web / L3 / 回归）
> - `06-cli-theme.md` —— CLI 终端样式改造（复刻 Claude Code 风格，已落地：门控裁决 + spinner 单写者协议 + **整屏 TUI 输入区**（v3，取代原「打印式顶线」降级方案，根治 resize 重绘风暴））
> - `07-cli-feature-parity.md` —— CLI 功能对齐 Claude Code：差距清单 + 编码建议 + 内核改动设计（K1 权限策略内核 / K2 排队与 steering 接线 / K3 子 agent 接线，批次 B1-B3，**已落地**；落地结果与已知偏差见 07 §6）
>
> 历史背景文档：`01-coding-cli.md`（CLI M1 移植细节，仍有效）、`02-local-web-runtime.md`（本地 Web 早期设计，**其 §3.2「复用 createApiServer」已被用户决策取代**，其余 JSONL/目录沙箱/UI 思路沿用）。
> 落地切片遵循 `LEARNING_AND_EVOLUTION_ROADMAP.md` §3 七步法与 Definition of Done。

## 一、状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| R | 机械改名：finance-* / ohna-* + bin `immersive`→`ohna` | **已实现**（04 Phase R，行为零变化） |
| M0 | 会话外壳：欢迎头、多轮上下文、`/help` `/clear` `/exit`、EOF 关闭修复 | **已实现**（`apps/ohna-cli/src/ui/welcome.ts`、`src/harness.ts`，原 apps/cli） |
| M1 | 编码工具闭环：read / write / edit / bash / grep / find / ls + 权限策略 + 项目上下文注入 | **已实现（待人工端到端验收）** |
| P0 | 安全加固：命令 head 归一、工作区边界、命令替换 / 内联脚本、悬空软链、`/private` 误伤、包装器与 fetch 组合 | **已实现**（04 Phase 0 多轮修复；最终状态 = **denylist 加固 + 确认闸门，非强 jail**；覆盖 `env -S`、转义引号、`nice/timeout/setsid/stdbuf`、fetch 管道 / 同路径落盘 / `-o` 受保护根、无空格重定向、`--force*`、`-tDIR`、子 shell 带参解释器，S-P1~S-P9 / S-C1~S-C16 全绿） |
| M2 | 长任务治理：会话持久化与 `--resume`、compaction、预算与模型元数据 | **已实现**（04 Phase 1；`~/.ohna/sessions/*.jsonl` + 会话级 compaction 与硬收敛 + `--max-turns` / `--deadline-ms` / `--max-cost` / `/cost`；本地桩端到端见 `test/verify-ohna-m2.mjs`） |
| L0 | serve 装配 + ohna-api 薄入口：JSONL + SSE 流式 + 自动开浏览器 | **已实现**（04 Phase 2；`packages/serve` + `apps/ohna-api`，L0 只读工具；自动化见 `packages/serve/test`） |
| L1 | 接管本地目录：coding 全工具 + workspaceRoot 沙箱 + 异步确认 | **已实现**（04 Phase 3；`packages/serve` 默认 `createCodingToolRegistry`，`AsyncConfirmGate` + `POST /confirmations` + 只读 `/api/local/fs`；自动化见 `packages/serve/test/l1.test.mjs`） |
| L2 | ohna-web 本地 Web UI：复制改造 + 文件树 + 本地模式 | **已实现**（04 Phase 4；`apps/ohna-web` 复制改造：文件树 `/api/local/fs` + write/edit/bash 事件联动刷新、待确认卡片 allow/deny + 刷新后 SSE replay 恢复、本地模式标识；自动化见 `apps/ohna-web/src`（51 vitest 用例），W-1~W-9 见 `` §12） |
| M3 | 体验对齐：slash 命令、diff 渲染、输出折叠、MCP 接入、`--web` 进程内托管 | **已实现**（04 Phase 5；`src/slash.ts`（/model /cost /compact /tools /resume）+ `src/diff.ts` 零依赖 LCS unified diff（写前预览、400 行折叠）+ `tool_execution_end` 头尾折叠 + `--mcp` 外部 server（`<untrusted_context>` 已由 mcp adapter 封装）+ `--web` 托管 `src/web-entry.ts`；自动化见 `test/verify-ohna-m3.mjs`） |
| L3 | 长任务治理（ohna）：`/resume`、compaction、成本展示 | **已实现**（04 Phase 5；CLI `/resume` 切换 + `/cost` 累计 + serve **run 前会话级 compaction**：双基准估算 → 摘要持久化 `messageType:"compaction"` → 硬收敛（与 CLI 共用 `packages/agent` 的 `enforceContextWindow`）；自动化见 `packages/serve/test/compaction.test.mjs` 与 `test/verify-ohna-m3.mjs`） |
| CLI 样式 | 终端样式复刻 Claude Code：ANSI 主题层（Amberwood 暖栗×橙）、`⏺/⎿/✻` 符号、整屏 TUI 输入区 | **已实现**（06-cli-theme.md v3：符号无条件替换 + 颜色/spinner TTY 门控、spinner 单写者协议；输入区由 v2 的「打印式顶线 + 单行 prompt」改为 `packages/term` 整屏 TUI——resize 节流幂等重绘、彻底消除重绘风暴，`box` 显式宽度为硬约束保证边框对齐；非 TTY 保留原滚动输出） |
| CLI 功能对齐 | 权限三选项与会话记住（K1）、queued/Esc/ctrl+o/thinking 交互（K2 接线 + 渲染层）、Task 子 agent（K3）、命令与补全补表 | **已实现**（07 批次 B1-B3：B1 K2 follow-up 排队注入 + Esc/双击 Esc + ctrl+o verbose + thinking + reasoning token；B2 `AgentTool.effect` 单一事实源 + `packages/agent/src/permission/`（default/acceptEdits/plan/bypass）+ 三选项/会话记住/Shift+Tab/plan 工具过滤/`/permissions` + serve SSE AskAdapter；B3 TeamCreate/SendMessage 接线 + 策略继承（fail-closed）+ `--no-team` + `@` 文件引用 / `!` 直通（过闸门）/ `#` 记忆 / `/status` `/mcp` `/export` `/resume fork`；`/resume` 无参打开输入框下方可选择的会话面板；`pnpm typecheck/build/test/architecture:check` 全绿） |

## 一·一、架构决策（本轮已拍板，见 03 §7）

1. **不复用 `apps/api` 的 `createApiServer`**：`packages/serve` 自建装配，直接消费 `agentLoop`（同 CLI）；`apps/ohna-api` 为薄入口。
2. **产品分界**：`apps/finance-api`+`apps/finance-web`（原 apps/api+apps/web）= 产品 A·金融 SaaS（不动）；ohna 产品线（`apps/ohna-cli`+`apps/ohna-api`+`apps/ohna-web`）= 编码 Agent，两者只共享 `packages/` 核心包。
3. **bash 信任模型** = denylist 加固 + 确认闸门（对齐 Claude Code / CodeBuddy，不追求强 jail）。
4. **ohna-web 复制改造**：从 `apps/finance-web`（原 apps/web）复制后剥离身份门/金融块，本次不抽前端组件库。
5. **产品命名（D7）**：金融线 `finance-api`/`finance-web`；编码 Agent 命名 **ohna**：`ohna-cli`/`ohna-api`/`ohna-web`（未来 `ohna-tui`），bin `immersive`→`ohna`。
6. **Web 托管主路径（D8）**：ohna-web 依托 CLI 启动（`ohna --web`，终端与浏览器同一会话）；装配下沉 `packages/serve`，`ohna-api` 仅作独立/headless 薄入口。
7. **无向后兼容约束（D9）**：开发验证阶段，改名/参数面均可直接重构，无需兼容原 `immersive` 等旧行为。

## 二、问题陈述（当前状态）

**立项时（M0 前）**：`apps/ohna-cli`（原 apps/cli）只能做金融问答——工具注册表只有 `calculator / market_data / filing_search / financial_metric`（`packages/tools/src/default-registry.ts:16`），无文件读写与命令执行能力。

**当前**：`ohna`（原 apps/cli）已具备编码闭环（`packages/coding` 7 工具 + Claude Code 风格的中文系统提示词与项目上下文注入）、M2 长任务治理（会话持久化、`--resume`、compaction 与窗口硬收敛、预算/时限、模型元数据与成本）、本地 Web 形态（`packages/serve` 装配 + `apps/ohna-api` + `apps/ohna-web`，L0/L1/L2 已实现）与 M3 体验（slash 命令、diff 渲染、输出折叠、`--mcp` 接入、`--web` 进程内托管）。剩余缺口按优先级：

1. **能力边界**：compaction 仍是 chars/4 启发式估算；摘要调用会计入会话成本；deadline 只在 turn 边界检查。

内核（ReAct 双循环、6 挂载点、abort、工具超时重试、compaction 原语）已就绪，上述缺口全部落在装配层与运输层——这正是「组合根可替换、内核零改动」架构命题的验证场。

## 三、落地顺序（以 `04-development-plan.md` 为准）

| 阶段 | 目标 | 归属文档 |
|---|---|---|
| **R** | 机械改名（finance-* / ohna-* + bin 改名，行为零变化） | `04` Phase R（前置） |
| **P0** | 安全加固（bash 沙箱 / command-policy 绕过 / 软链绕过） | `04` Phase 0（最高优先） |
| **M2** | ohna-cli 长任务治理（持久化/compaction/预算/模型元数据） | `04` Phase 1 |
| **L0** | serve 装配 + ohna-api 薄入口（JSONL + SSE + 开浏览器） | `04` Phase 2 |
| **L1** | 接管本地目录（coding 全工具 + workspaceRoot + 异步确认） | `04` Phase 3 |
| **L2** | ohna-web 本地 Web UI（复制改造 + 文件树） | `04` Phase 4 |
| **M3+L3** | 体验对齐 + `--web` 托管 + ohna 长任务治理 | `04` Phase 5 |

> 每个阶段的可复现验收见 `05-verify-cases.md`。

## 四、移植来源与许可

- 来源：`https://github.com/badlogic/pi-mono`（pi monorepo，`packages/coding-agent`），**MIT License**（`LICENSE`，Copyright (c) 2025 Mario Zechner）。
- 可移植：工具核心算法与结果截断策略；需改造：typebox → zod、剥离 pi-tui 渲染与 extension context、去掉 `ToolDefinition` 中间层。
- 归因要求：移植文件保留来源标注（文件头注明 ported from pi），并在 `` 记录移植取舍。

## 五、执行原则

1. **内核零改动（限定 `agent-loop.ts` 本体）**：`packages/agent/src/agent-loop.ts` 的 loop 契约与挂载点语义不变；改动落在 `packages/coding`（安全加固）、`packages/serve`（装配）、`apps/ohna-cli`、`apps/ohna-api`、`apps/ohna-web`。**07 方案的 K 项例外**：允许在 `packages` 内**新增领域模块**（`agent/src/permission/`）与**工具契约元数据**（`packages/tools` 的 `effect` 字段）——均为组合根装配范式（先例 `agent/src/team/`），loop 内核代码路径不引用它们。
2. **产品分界清晰**：产品 A（金融 SaaS）与 ohna（编码 Agent）互不依赖，只共享 `packages/` 核心包；编码工具不进 `packages/tools`（那是金融工具域）。
3. **窄切片 + 可验收**：每个 Phase 自带 `05-verify-cases.md` 的验收用例与结构化解错，禁止无验收的大爆炸重写。
4. **诚实失败**：未授权路径、危险命令、超时一律结构化报错（`isError` 回喂模型），不静默放行、不伪造结果。
5. **无向后兼容约束**：开发验证阶段，改名/参数面/默认值可直接重构，不为旧行为保留别名。
6. **文档同步**：每完成一个 Phase，同步 `` / ``、本文状态表与 `LEARNING_AND_EVOLUTION_ROADMAP.md` 阶段产出。

## 六、验收总闸（每个 Phase 都要跑相关子集）

```bash
pnpm --filter @aiagent/coding test
pnpm --filter @aiagent/serve test
pnpm --filter @aiagent/ohna-cli build
pnpm --filter @aiagent/ohna-api build
pnpm --filter @aiagent/ohna-web build
pnpm typecheck
pnpm architecture:check
pnpm lint
```

再加端到端（见 `05-verify-cases.md` §8）：CLI 真实编码任务自愈闭环 + `ohna --web` 浏览器对话 + 安全护栏全绿。