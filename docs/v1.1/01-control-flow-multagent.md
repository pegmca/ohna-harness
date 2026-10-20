# 01 · Agent 控制流、多智能体与记忆

> 维度：Agent Control Flow / Multi-Agent / Memory / Context Engineering
> 现状：已实现 Pi 风格纯函数多轮 ReAct loop（双层循环 + 事件流 + 错误即数据 + Hook 挂载点），
> 单 Agent + 工具 + Report Workflow；**v1.1 已补齐** P1 系统化 Context Engineering、P2 长期记忆层
> （`packages/memory`）、P3 多智能体 Supervisor 编排、P4 Goal 模式、P5 Plan-and-Execute + Reflexion——
> 全部以「复用 `agentLoop` 内核 + 外挂 Hook 切片 / 独立 subagent 原语」方式落地，loop 内核零改动。
> 实现落地与公开 API 见文末「0. 实现落地」。

## 0. 实现落地（v1.1）

本仓库已按本文件 P1–P5 完成改造，核心纪律是「复用既有 `agentLoop` 内核，所有新能力以
`AgentLoopConfig` 钩子切片或独立 subagent 原语外挂，loop 内核一行不改」：

| 优先级 | 能力 | 落地位置 | 关键公开 API |
|---|---|---|---|
| P1 | 系统化 Context Engineering（分层装配 + token 预算分级） | `packages/agent/src/context-assembly.ts` | `createContextAssemblyTransform` / `buildSystemPromptWithMemory` / `limitContextByBudget` |
| P2 | 长期记忆层（短期/长期/语义三层，本地相似度替代向量库） | `packages/memory`（新包 `@aiagent/memory`） | `createMemoryStore` / `createMemoryRetrieveHook` / `createMemoryWriteHook` |
| P3 | 多智能体 Supervisor 编排（TeamCreate/SendMessage 消息总线） | `packages/agent/src/team-controller.ts` + `team/*` | `createTeamController` / `createBullBearRiskTeam` |
| P4 | Goal 模式（目标守卫，依赖倒置判定器） | `packages/agent/src/goal-controller.ts` | `createGoalController` / `createCommandJudger` / `createLlmJudger` |
| P5 | Plan-and-Execute + Reflexion（规划 DAG + 自评估重试） | `packages/agent/src/plan-reflexion.ts` | `createPlanner` / `createReflexionHook` |

- 包边界：P2 记忆层为独立 `@aiagent/memory` 包，不反向依赖 `@aiagent/agent`；P1 装配器只接受
  provider 回调，两者在「组装 `AgentLoopConfig`」时组合，互不耦合（见 `packages/agent/src/index.ts` 出口）。
- 所有新模块均已附带单元测试（`packages/agent/test/*`、`packages/memory/test/*`）与学习笔记
  （``、``、``、
  ``、``）。
- 约束：`agentLoop` / `agentLoopContinue` 未被修改；新增能力均为 config 层挂载或独立包，符合
  「控制逻辑外置、内核零改动」的工程纪律（见各 `设计笔记` 与 `agent-loop.ts`）。

## 1. 行业现状速览（2025–2026）

- **Workflow vs Agent 边界**（Anthropic《Building Effective Agents》2024.12）：多数场景预定义 Workflow 比自决策 Agent 更稳；只在模型需动态决策时才上 Agent。
- **Context Engineering 取代 Prompt Engineering**（Anthropic 2025.6 / 2026.3）：把上下文当稀缺资源体系化——管理 context 才是核心工程学科（写 prompt 已过时）。
- **多智能体收敛为三范式 + 双协议**：LangGraph（状态机）、CrewAI（角色扮演）、AutoGen（消息总线）；协议层 MCP 连工具、A2A 连 Agent。共识是"简单编排 > 复杂协作"，SWE-bench 上 5 专家 Agent(78.4%) 远胜单体(41.2%)，前提是任务复杂到值得。
- **记忆分层**：短期（上下文窗口）/ 长期（向量库持久化）/ 语义记忆；跨会话记忆成为生产级分水岭。
- **范式组合**：2026 强 Agent 普遍 **Plan-and-Execute + ReAct + Reflexion** 组合，而非单模式。
- **Loop Engineering 取代 Prompt Engineering（2026 新主线）**：Claude Code 作者 Boris Cherny 公开说"不再 prompt，只写 loop"。代表形态三类——`/goal`（设完成条件、跨轮次持续工作直到满足）、`/loop`（定时/条件循环触发）、Dynamic Workflows（模型动态编排）。多代理系统 token 消耗约为单体 15×，单代理约为聊天 4×，所以"循环/多代理不是新魔法，但是最贵的部分"，必须用 cost guardrail 收口。
- **Claude Code 2026 多代理与生产化能力**：Subagents（独立上下文窗口 + 只回摘要保护主会话 token + 工具/权限/模型可配，Explorer=Haiku 只读、Reviewer 指定 model）；Agent View（`claude agents` + `--json` 聚合所有会话状态/耗时/token，可喂 CI/tmux 看板）；`/fork`（子代理继承完整对话历史 + 共享 prompt cache 更便宜）；Persistent Memory（`memory: project/user/local` 子代理跨会话积累知识）；Hooks/Skills/CLAUDE.md 生命周期与复用机制。核心共识：**子代理第一性价值是上下文隔离 + 摘要回收**。
- **Meta Muse 与"行动入口"范式（2026-09）**：Muse（Spark 1.3，免费档每周 1 亿 token）把 AI 从"回答问题的聊天框"推进到"替你干活的行动入口"——给**每个用户分配一台持续运行的云端专属虚拟机**，agent 后台自主拆任务、开网页、填表单、调外部 App（订机票、管邮件、把 Reels 菜谱变购物清单）。验证的路线是"个人长期常驻 Agent + 隔离运行时"，顺带引发对 CPU/底层硬件的重新估值（海量轻量持久 VM）。其"持久常驻 + 隔离执行"正好对应本仓库 `05-P1` durable runs（worker + lease + 状态机）与 `05-P2` 后台/SSE fan-out。

## 2. 本项目差距

- 无显式状态机（当前是隐式 turn/follow-up 双层循环，缺可观测、可分支的 AgentState）。
- Context Engineering 未系统化（compaction 仅注入确定性摘要，无分层上下文装配、无 context 预算分级）。
- 无长期记忆（PostgreSQL 线性消息是唯一真相源，跨会话无语义/情节记忆）。
- 无 Plan / Reflexion 阶段（纯 ReAct，缺规划分解与自我反思闭环）。
- 无多智能体通信（roadmap 阶段五 bull/bear/risk 未落地，缺 supervisor/router 与 handoff）。
- **注：Goal 模式的循环原语已就绪**——`agentLoop` 的 `shouldStopAfterTurn`（`agent-loop.ts:269`）、`getSteeringMessages`（`agent-loop.ts:198`/`:274`）、`getFollowUpMessages`（`agent-loop.ts:278`）、`prepareNextTurn`（`agent-loop.ts:254`）已是"完成判定 + 跨轮续跑 + 进度注入"的最小原语，只差一个上层 `GoalController` 即可实现 `/goal`，无需改 loop。

## 3. 改造方向（按优先级）

### P1 系统化 Context Engineering（难度：中）
- **目标架构**：在 `packages/agent` 新增 `context-assembly.ts`，把 `transformContext`/`convertToLlm` 升级为"分层上下文装配器"（系统提示 + 工作记忆 + 检索记忆 + compaction 摘要），并加 context token 预算分级。
- **落地**：复用现有 Hook 体系，落点在 `compaction.ts`、`convert.ts`、Hook `transformContext`。
- **为什么值得学**：把 compaction 升级为可观测、可调试的上下文工程，直接对标 Anthropic 思想。

### P2 长期记忆层（难度：中高）
- **目标架构**：新增 `packages/memory`（短期/长期/语义三层），PG 持久化 + 向量检索；用 Hook `prepareNextTurn` 每轮注入检索到的记忆，`afterToolCall` 写回情节。
- **落地**：新 `packages/memory` + `packages/agent/types.ts` Hook 扩展。
- **为什么值得学**：补齐跨会话能力，是生产级 Agent 分水岭。

### P3 多智能体 Supervisor 编排：TeamCreate + SendMessage 拓扑（难度：高）
- **目标架构**：落地 roadmap 阶段五的 bull/bear/risk 评审，但用**生产级多窗口拓扑**包装——Supervisor（一次 `agentLoop`）+ 一组**隔离子代理**（各一次独立 `agentLoop`）+ **消息总线**通信。对齐 Claude Code Subagent 思想（独立上下文窗口、只回摘要、工具/权限最小化、成本路由）：
  - **上下文隔离**：每个子代理持有独立 `context.messages`，主上下文只回收"摘要"，不被探索/日志/测试输出污染（subagent 第一性价值）。
  - **工具/权限最小化**：子代理只拿任务所需工具子集（如评审代理只给只读工具），用 `disallowedTools` 收口。
  - **成本路由**：轻任务小模型、重分析大模型，在 supervisor 派发时决定。
  - **消息总线而非共享内存**：跨 agent 通信只走显式 `SendMessage`，不共享全局可变状态——可 replay、可 trace、可审计，失败隔离。
- **落地（两层）**：
  - **编排层 TeamController/Supervisor**：维护 team 状态（成员表 name/role/状态、每成员 inbound 消息队列、`run_events` 投影）；把两个原语实现为 `AgentTool` 注册进 supervisor 的 `context.tools`：`TeamCreate(name, role, tools, model)`（建子代理 = 独立 `agentLoop` + 独立 EventStream）、`SendMessage(recipient, content)`（向成员发消息）；supervisor 的 model 自行决定何时 spawn / 委派 / 汇总。
  - **执行层 Subagents**：每个 = 一次 `agentLoop(prompts, ctx, config)` 调用，天然产出独立 EventStream + 独立 token 预算，结果（摘要 + 产物引用）回写 team 状态；子代理失败以结构化 error 回传 supervisor，不拖垮主循环。
  - **与 durable runs 结合**：子代理后续可丢进 `05-P1` 的 worker 队列实现真正后台并发（当前同进程，先单进程跑通拓扑再解耦）。
- **为什么值得学**：你 `agentLoop` 就是现成 subagent 原语（每次调用天然独立 context + EventStream），TeamCreate/SendMessage 全走已有 `RunEvent` 边界，比 Claude Code 的 `agent-*.jsonl` 更规整；工程成本低、概念收益高、叙事更贴合 2026 前沿。

### P4 Goal 模式（复用现有钩子，难度：低）
- **目标架构**：实现 Claude Code `/goal` 思想——在 ReAct loop 外挂"目标守卫"：设一个**可判定的完成条件**，agent 持续跨轮次工作直到满足，期间实时展示进度/token/轮次。**不改 `agentLoop` 一行**，仅新增上层 `GoalController`：
  - 把自然语言 goal 编译成**完成判定器**：程序化断言（如"测试全过 + tsc 无错"→ 跑命令看退出码）或模型自检（调一次 `streamSimple` 让模型判达成并返 JSON）。
  - 判定器挂到 `shouldStopAfterTurn`（`agent-loop.ts:269`）：达成→正常 `agent_end`；未达成→返回 false。
  - `getFollowUpMessages`（`agent-loop.ts:278`）返回 meta 消息"目标未达成，请继续"，形成闭环。
  - `prepareNextTurn`（`agent-loop.ts:254`）注入当前进度（已完成子任务、剩余项），避免模型重复劳动。
- **落地**：`packages/agent` 新增 `goal-controller.ts`（依赖倒置：判定器接口 + 两种实现），挂到 `AgentLoopConfig` 钩子；`agentLoopContinue` 已支持续跑/继承上下文（类 `/fork`）。
- **为什么值得学**：证明"控制逻辑外置到 config 层、loop 内核零改动"的工程纪律，直接复用语义上已就绪的钩子；也是 LLM-as-Judge（见 `04`）的低门槛前哨。

### P5 Plan-and-Execute + Reflexion（难度：中）
- **目标架构**：`agentLoop` 前加规划阶段产出子任务图；`shouldStopAfterTurn` 旁加反思判定（自评估 → 重试）。
- **为什么值得学**：把纯 ReAct 升级为组合范式。

## 4. 学习路径（TS 强 / Python 弱）

- **入门**：读 Anthropic《Building Effective Agents》《Effective Context Engineering》。改 `compaction.ts` → 分层上下文装配器，加 token 预算可视化。**产出**：能解释"为什么 context 要分级"。
- **进阶**：读 Reflexion 论文 + LangGraph 状态机思想。实现 `packages/memory` 并用 Hook 注入。**产出**：跨会话记忆 Agent demo。
- **低成本亮点（先于多智能体）**：实现 P4 Goal 模式——读 Claude Code `/goal` 设计，用现有 `shouldStopAfterTurn`/`getFollowUpMessages` 钩子加 `goal-controller.ts`，零改 `agentLoop`。**产出**：可演示"设目标→跨轮持续干到达成"的 Agent，天然复用语义已就绪的钩子。
- **可**：实现 P3 多智能体 TeamCreate/SendMessage 拓扑（bull/bear/risk），写架构说明。**产出**：可演示多 Agent 评审系统（隔离上下文 + 消息总线）+ 技术博客。

