# 03 · 工具生态、MCP 协议与 Agent 互联

> 维度：Tool Use / Function Calling / MCP / A2A / Sandboxing
> 现状：`packages/tools` 5 个 deterministic mock 工具 + 统一 AgentTool 契约；`packages/mcp` 完整 stdio server + client adapter（MCP 工具包装为 AgentTool[] 并入 loop）。
> 数据全 mock，缺真实生态接入、tool sandboxing、computer/browser use、A2A、tool eval。

## 1. 行业现状速览（2025–2026）

1. **MCP 已成"AI 的 USB-C"**：2025 生态爆发。2026-07-28 规范核心变化是 **Stateless/Sessionless MCP**（SEP-2575/2567）——握手与 session 消失，server 可水平扩展不持状态；`server/discover` 先探能力、list 结果可缓存。
2. **工具发现从"全量塞给模型"转向"渐进式"**：百工具 server 让模型付费且选择变差，MCP 推 progressive discovery（小入口 + 随对话收敛展开）。
3. **Agent 通信分层清晰**：MCP=工具/上下文（Agent↔Tool），A2A（Google 2025-04）=Agent↔Agent（Agent Card 能力发现 + 任务管理），二者互补。
4. **生产化治理优先**：DPoP、Workload Identity Federation、Enterprise-Managed Authorization 解决"agent 身份"而非人审批；Tasks 已转官方 extension，MRTR 模式（SEP-2322）替代 server 主动请求。
5. **安全与评测成硬指标**：Tool sandboxing（容器隔离执行）、computer/browser use 的 prompt-injection 防护（VPI-Bench）、BFCL-V4 等可执行函数调用榜单成为能力标尺。

## 2. 本项目差距

- 真实生态接入：5 个 mock + MCP 全 mock，未接任何公开 server，缺"协议即集成"体感。
- Tool sandboxing：无隔离执行，SQL 仅靠启发式白名单，遇真实/不可信后端风险高。
- Computer/Browser use：完全没有 Agent-Computer Interface 维度。
- A2A / 多 agent 互联：仅单 agent 内 MCP，无 agent 间工具委派。
- Tool eval：无 BFCL 类可执评测，工具质量靠人工。
- MCP 生产化治理：无鉴权、多租户、远程部署、Server Card 发现。

## 3. 改造方向（按优先级）

### P0 补经 agentLoop 的 MCP e2e 测试 + 接一个真实公开 MCP server（难度：低）
- **目标**：在 `packages/agent` 加一条走 `agentLoop → createCombinedAgentTools → discoverMcpAgentTools → execute` 的集成测试；从官方/社区选一个 TS 写的只读 server（如 filesystem、或金融类公开 MCP）接入 `createMcpStdioClient`。
- **为什么学**：用最低成本验证"你的 AgentTool 抽象 ≈ MCP 协议契约"，证明边界正确。

### P1 把 mock 工具替换为真实 adapter（难度：中）
- **目标**：`AgentTool` 契约不变，仅把 `execute` 内部从 mock 改为真实 fetch/SDK；保留 `evaluatePermission` 与 zod 双校验。
- **为什么学**：区分"协议抽象"与"后端实现"，是工程化分水岭。

### P2 Tool sandboxing + 输出治理（难度：中高）
- **目标**：对 MCP 不可信结果强化 `<untrusted_context>` 封装（防 prompt injection），为高危工具（SQL/代码）加容器/Docker 隔离执行边界。

### P3 MCP 生产化：远程 Streamable HTTP + 鉴权 + Server Card（难度：中）
- **目标**：stdio server 加一层 HTTP transport，按 2026-07-28 规范做 stateless；补 client 鉴权与 capability 发现。

### P4 A2A 试点 + computer/browser use 旁支（难度：高）
- **目标**：把"子 agent"建模为 `discoverMcpAgentTools` 式远端能力，用 A2A Agent Card 暴露；另开 browser-use 探索分支。

> **低成本高收益点：P0（e2e 测试 + 接 1 个真实 server）与 P1（mock→真实 adapter）。**

## 4. 学习路径（TS 强、Python 弱）

- **阶段一（读协议）**：MCP 官方 spec（2026-07-28）+ 路线图；A2A 概述。**产出**：用 TS 写一个最小 stdio MCP server。
- **阶段二（接进你的抽象）**：把 server 经 `createMcpStdioClient` 接入 `createCombinedAgentTools`，加一条 agentLoop e2e 测试。**产出**：可运行真实工具调用 demo。
- **阶段三（治理）**：实现 sandboxing + 输出封装 + 简易鉴权。**产出**：带安全边界的工具执行。
- **阶段四（互联）**：试点 A2A 子 agent 委派，跑一次 BFCL 风格自测。**产出**：多 agent 工具互联原型。
- 全程用 TS，避开 Python 短板；MCP server 官方 TS SDK 成熟。

