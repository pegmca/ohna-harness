# 01 · Agent 控制流、多智能体与记忆

> 维度：Agent Control Flow / Multi-Agent / Memory / Context Engineering
> 现状：已实现 Pi 风格纯函数多轮 ReAct loop（双层循环 + 事件流 + 错误即数据 + Hook 挂载点），
> 单 Agent + 工具 + Report Workflow，**无多智能体、无显式状态机、无长期记忆**。

## 1. 行业现状速览（2025–2026）

- **Workflow vs Agent 边界**（Anthropic《Building Effective Agents》2024.12）：多数场景预定义 Workflow 比自决策 Agent 更稳；只在模型需动态决策时才上 Agent。
- **Context Engineering 取代 Prompt Engineering**（Anthropic 2025.6 / 2026.3）：把上下文当稀缺资源体系化——管理 context 才是核心工程学科（写 prompt 已过时）。
- **多智能体收敛为三范式 + 双协议**：LangGraph（状态机）、CrewAI（角色扮演）、AutoGen（消息总线）；协议层 MCP 连工具、A2A 连 Agent。共识是"简单编排 > 复杂协作"，SWE-bench 上 5 专家 Agent(78.4%) 远胜单体(41.2%)，前提是任务复杂到值得。
- **记忆分层**：短期（上下文窗口）/ 长期（向量库持久化）/ 语义记忆；跨会话记忆成为生产级分水岭。
- **范式组合**：2026 强 Agent 普遍 **Plan-and-Execute + ReAct + Reflexion** 组合，而非单模式。

## 2. 本项目差距

- 无显式状态机（当前是隐式 turn/follow-up 双层循环，缺可观测、可分支的 AgentState）。
- Context Engineering 未系统化（compaction 仅注入确定性摘要，无分层上下文装配、无 context 预算分级）。
- 无长期记忆（PostgreSQL 线性消息是唯一真相源，跨会话无语义/情节记忆）。
- 无 Plan / Reflexion 阶段（纯 ReAct，缺规划分解与自我反思闭环）。
- 无多智能体通信（roadmap 阶段五 bull/bear/risk 未落地，缺 supervisor/router 与 handoff）。

## 3. 改造方向（按优先级）

### P1 系统化 Context Engineering（难度：中）
- **目标架构**：在 `packages/agent` 新增 `context-assembly.ts`，把 `transformContext`/`convertToLlm` 升级为"分层上下文装配器"（系统提示 + 工作记忆 + 检索记忆 + compaction 摘要），并加 context token 预算分级。
- **落地**：复用现有 Hook 体系，落点在 `compaction.ts`、`convert.ts`、Hook `transformContext`。
- **为什么值得学**：把 compaction 升级为可观测、可调试的上下文工程，直接对标 Anthropic 思想。

### P2 长期记忆层（难度：中高）
- **目标架构**：新增 `packages/memory`（短期/长期/语义三层），PG 持久化 + 向量检索；用 Hook `prepareNextTurn` 每轮注入检索到的记忆，`afterToolCall` 写回情节。
- **落地**：新 `packages/memory` + `packages/agent/types.ts` Hook 扩展。
- **为什么值得学**：补齐跨会话能力，是生产级 Agent 分水岭。

### P3 多智能体 Supervisor 编排（难度：高）
- **目标架构**：复用 `agentLoop` 作子 Agent 原语，新增 `supervisor.ts`（router/handoff），用 EventStream + `beforeToolCall`/`afterToolCall` 实现 bull/bear/risk 评审交接；显式 AgentState 状态机。
- **落地**：`packages/agent` 新增 `supervisor.ts`、扩展 `types.ts`。
- **为什么值得学**：落地 roadmap 阶段五，因复用同一 loop，工程成本低、概念收益高。

### P4 Plan-and-Execute + Reflexion（难度：中）
- **目标架构**：`agentLoop` 前加规划阶段产出子任务图；`shouldStopAfterTurn` 旁加反思判定（自评估 → 重试）。
- **为什么值得学**：把纯 ReAct 升级为组合范式。

## 4. 学习路径（TS 强 / Python 弱）

- **入门**：读 Anthropic《Building Effective Agents》《Effective Context Engineering》。改 `compaction.ts` → 分层上下文装配器，加 token 预算可视化。**产出**：能解释"为什么 context 要分级"。
- **进阶**：读 Reflexion 论文 + LangGraph 状态机思想。实现 `packages/memory` 并用 Hook 注入。**产出**：跨会话记忆 Agent demo。
- **可**：实现 P3 多智能体 supervisor（bull/bear/risk），写架构说明。**产出**：可演示多 Agent 评审系统 + 技术博客。

