# v1.3 编码型 CLI 改造方案

> 目标：把 `apps/cli`（bin `immersive`）从「金融问答 REPL」升级为**能真实改代码、跑测试、自己修的编码 Agent CLI**，能力对齐 Claude Code / Codex CLI / CodeBuddy Code。
> 本文是索引与总览，**落地细节见 `01-coding-cli.md`**；移植来源为本地 `../badlogic`（pi，MIT 许可）。
> 落地切片遵循 `LEARNING_AND_EVOLUTION_ROADMAP.md` §3 七步法与 Definition of Done。

## 一、状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 会话外壳：欢迎头、多轮上下文、`/help` `/clear` `/exit`、EOF 关闭修复 | **已实现**（`apps/cli/src/welcome.ts`、`apps/cli/src/harness.ts`） |
| M1 | 编码工具闭环：read / write / edit / bash / grep / find / ls + 权限策略 + 项目上下文注入 | **已实现（待人工端到端验收）** |
| M2 | 长任务治理：会话持久化 `/resume`、compaction 挂载、预算与模型元数据 | 规划中 |
| M3 | 体验对齐：slash 命令、diff 渲染、输出折叠、MCP 接入、子代理分工 | 规划中 |

## 二、问题陈述

`apps/cli` 已是可运行的第二个组合根（与 `apps/api` 共用纯函数 `agentLoop`），但它今天**只能做金融问答**：工具注册表只有 `calculator / market_data / filing_search / financial_metric`
（`packages/tools/src/default-registry.ts:16`），没有任何文件读写与命令执行能力；系统提示词写死为金融助手（`apps/cli/src/harness.ts:29`）。
要做编码工作，缺的不是内核（内核已具备 ReAct 双循环、6 个挂载点、abort、工具超时重试、compaction），而是**工具集、权限沙箱、上下文治理与编码向交互**。

## 三、MVP 顺序（建议按此推进）

| 阶段 | 目标 | 主要交付 | 完成判据（可人工复现） |
|---|---|---|---|
| **M1** | 能真实改代码、跑测试、自己修 | `packages/coding`（7 个工具 + 路径/截断/输出工具模块）+ 权限策略 + 项目上下文注入 + CLI `--mode coding` | 让 CLI「在测试目录加一个函数并让 `pnpm typecheck` 通过」，全程无人干预 |
| **M2** | 能连续干长任务不丢上下文 | 会话持久化 `/resume`、compaction 挂载、maxTurns/deadline 可配、模型元数据（contextWindow/maxTokens/reasoning）可配 | 连续 20+ 轮改动同一模块，不丢上下文、不超窗、成本可控 |
| **M3** | 体验对齐成熟 CLI | slash 命令、写前 diff 渲染、工具输出折叠、`@文件` 引用、MCP 接入、子代理 | 与 Claude Code 主观体验对比：看得见改了什么、能中断能续跑 |

## 四、移植来源与许可

- 来源：`https://github.com/badlogic/pi-mono`（pi monorepo，`packages/coding-agent`），**MIT License**（`LICENSE`，Copyright (c) 2025 Mario Zechner）。
- 可移植：工具核心算法与结果截断策略；需改造：typebox → zod、剥离 pi-tui 渲染与 extension context、去掉 `ToolDefinition` 中间层。
- 归因要求：移植文件保留来源标注（文件头注明 ported from pi），并在 `` 记录移植取舍。

## 五、执行原则

1. **内核零改动**：M1–M3 全部改动落在 `apps/cli` 与新包 `packages/coding`，`packages/agent/src/agent-loop.ts` 一行不改。
2. **包边界清晰**：编码工具不进 `packages/tools`（那是金融工具域），新建 `packages/coding`；`apps/cli` 只做组合根。
3. **窄切片 + 可验收**：每个 M 都自带人工复现步骤与结构化解错，禁止无验收的大爆炸重写。
4. **诚实失败**：未授权路径、危险命令、超时一律结构化报错（`isError` 回喂模型），不静默放行、不伪造结果。
5. **文档同步**：每完成一个 M，同步 ``、本文状态表与 `LEARNING_AND_EVOLUTION_ROADMAP.md` 阶段产出。

## 六、验收总闸（每个 M 都要跑）

```bash
pnpm --filter @aiagent/cli build # 或 pnpm build
pnpm typecheck
pnpm architecture:check
pnpm lint
```

再加一条人工端到端：启动 CLI → 提一个真实编码任务 → 观察工具调用 → 跑 `pnpm typecheck` → 自愈 → 结束。