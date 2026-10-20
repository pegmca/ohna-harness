# v1.1 改造与学习路线图（基于 2025–2026 Agent 前沿）

> 本目录汇总 5 位资深 Agent 工程师，基于 2025–2026 最新 Agent 发展思想与架构，
> 针对本仓库（Pi 风格 TS ReAct Agent + RAG + MCP + 工具 + eval + trace）提出的
> **学习者改造方向**与**学习路径**。后续按本目录逐步完善项目，目标是对齐 Agent 工程师要求。

## 如何使用本目录

| 文件 | 内容 | 对应 Agent 维度 |
|---|---|---|
| `01-control-flow-multagent.md` | Agent 控制流、多智能体、记忆与上下文工程 | 控制流 / 多智能体 |
| `02-rag-production.md` | RAG 与知识层生产化（真实 embedding / rerank / pgvector） | 知识层 |
| `03-tools-mcp.md` | 工具生态、MCP 协议、A2A、sandboxing | 工具 / 协议 |
| `04-eval-observability.md` | 评测、可观测性、成本工程 | 质量工程 |
| `05-engineering-deployment.md` | 工程化、部署、安全、多租户 | 系统工程 |
| `设计演进记录` | 跨维度合并的**总学习路径与优先级** | 汇总 |

每个文档结构统一：行业现状速览 → 本项目差距 → 改造方向（按优先级 P0/P1…）→ 学习路径 → 表达要点。

## 项目现状基线（改造前）

- ✅ 已完成：pnpm monorepo + TS strict；`packages/ai` 统一 LLM 抽象；Pi 形态多轮 ReAct loop；
  内置 + MCP 工具；文档 ingestion → chunk → embedding → hybrid retrieval → rerank → citation answer；
  Report 工具化 + 有限 Workflow + PDF；线性消息 + Run/RunEvent；SSE 持久 replay；确定性 eval；
  Docker Compose；双主题 Web。
- ⚠️ 主要缺口（优化重点）：**数据全 mock**（行情/公告/财务/embedding 均确定性假数据，且本地现跑 mock 模式）；
  无真实 LLM 接入演示；RAG 无真实 embedding / 无 cross-encoder rerank / 默认内存向量库；
  无多智能体；SSE 缺 token 流式 / 背压 / 跨实例 fan-out；无多租户 / 鉴权 / 审计闭环；
  eval 仅确定性 fixture，无 LLM-as-judge；无容量 / SLO / 成本证据。

## 学习者画像（贯穿所有路径）

- 精通 TypeScript，正在学 Python for Agent，通过 Pi Agent 学 Agent 架构。
- 所有改造建议默认 **用 TS 实现**，避开 Python 短板（仅在必要时对比 Python 生态）。
- 每个改造都应带测试 / eval / trace 证据，并同步更新 `设计笔记` 与 `ARCHITECTURE.md`（遵循 AGENTS.md 文档同步规则）。
