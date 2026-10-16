## 会诊阵容与分工

| 文档 | 视角 | 核心关切 |
|---|---|---|
| `01-agent-engineering-philosophy.md` | 资深 Agent 工程师 | Agent 控制流 / 契约 / 上下文 / 记忆 / 多智能体 的工程思想与讲法 |
| `02-harness-engineering-philosophy.md` | 资深 Harness / 系统工程工程师 | 运行 Agent 的 harness：状态机 / 幂等 / SSE / 恢复 / 多租户 / 成本 的工程思想与分布式讲法 |
| `03-frontier-interview-sprint.md` | 前沿工作者 | 2025–2026 心智模型（M1–M9）+ 把仓库打磨成作品的最短冲刺路径（G0–G4） |
| `04-cli-harness.md` | 本地 Harness / 组合根 | 本地 CLI 复用同一 `agentLoop` 核心（前端只是运输层）+ headless 可移植性的工程叙事（**已实现**） |

> 基线：v1.1 已由 5 名资深 Agent 产出控制流/多智能体、RAG、工具/MCP、eval/可观测、工程/部署五个维度与总学习路径。
> v1.2 不重复 v1.1 的技术细节，而是**提炼工程思想**并**按 ROI 重排优先级**。三名工程师引用的真实代码均已逐一核对（见各文件 `file:line`）。

## 三、工程思想改造建议（合并清单，按优先级）

> 跨三个文档去重合并。P0 是「低成本高 ROI、直接消除最大漏洞」；P1 是「生产级分水岭」；P2 是「按需深化」。

### P0（建议本轮优先认领）
- **真实化运行时**：~~把默认从 mock 切到 `AIAGENT_PROVIDER_MODE=real`（DeepSeek/通义）~~ **【已落地 v1.2】** `MockModel` 已彻底删除，默认仅真实 provider，`createOpenAiCompatibleRuntime` 抽到 `packages/ai` 被 API 与 CLI 共用，loop 控制流一行未改。→ `03` G0、`01` P0（见 `04-cli-harness.md`）
- **mock/real 显式边界**：~~在 `AgentTool` 契约层加 `source: "mock" | "real"` 元数据，registry 同时暴露 mock/real adapter 由配置切换~~ **【已落地】** 元数据已加并统一 `"real"`，边界收敛为全真实。→ `01` P0
- **SSE 跨实例 fan-out + 执行注册表外置**：`RunEventBus` 改 Redis pub/sub（或共享 replay），`AbortController` 外置为「cancel 标记 + 订阅」；`claimNext` 已 SKIP LOCKED，不动数据层即可水平扩。→ `02` P0

### P1（生产级分水岭）
- **真实 RAG 栈**：真实 `EmbeddingClient` + cross-encoder `Reranker` + 持久 pgvector 默认开；四个边界接口已就绪，只换实现。→ `03` G1、`01` P1
- **Eval with LLM-as-Judge**：在确定性评测上加真实 judge 维度 + 人工标注回流校准（`calibration.ts`）。→ `03` G2、`02` P3
- **多智能体 slice + 成本护栏**：supervisor + bull/bear/risk 隔离子 `agentLoop`，`Model.cost` 估算 + `shouldStopAfterTurn` 预算上限。→ `03` G3、`01` P0
- **Context 预算可观测**：统计预算命中率 / 记忆命中率 / 截断率，写入 RunEvent 或 eval 报告。→ `01` P1
- **写类工具幂等去重**：at-least-once 重排当前整 Run 重跑，需 `(run_id, tool_call_id)` 去重 + checkpoint 续跑，否则上写类工具会重复副作用。→ `02` P1

### P2（按需深化）
- **多租户 / RBAC / 审计 / 密钥治理闭环**（行级 `tenant_id` + vault + 不可抵赖 `audit_log`）。→ `02` P2、`01` P1
- **成本 guardrail + 运行时 SLO 熔断 + 容量/灾难演练量化证据**。→ `02` P3/P4
- **记忆/向量索引外置 + 入口瘦身对齐单文件 ≤500 行纪律**。→ `01` P2

### 最高 ROI 五切片（gaps → 可演示证据）
| 优先级 | Gap | 最低成本证据 | 命中题 |
|---|---|---|---|
| **G0** | 默认开真实 provider demo | 真模型流式对话 + SSE token 流（README 已写切换） | 「你的 Agent 可靠吗」 |
| **G1** | 真实 RAG 栈 | 真实 embedding/rerank vs heuristic 对比报告 | 「RAG 怎么做」必问 |
| **G2** | 一个 LLM-as-Judge 维度 | 含 judge 分的混合评分报告 | 「怎么评测」必问 |
| **G3** | 一个多智能体 slice | bull/bear/risk 评审 + 单 vs 多对比数据 | 「多智能体」高频 |
| **G4** | 一个可靠性/成本故事 | 单 Run token/成本 + 一条 cost guardrail + 容量自测 | 「成本/SLO」加分 |

### 时间盒升级路径
- **只有 1 周**：只做 **G0** + 打磨 3 分钟电梯演讲与话术库（见 `03` §2.5/§2.6）。已能过大部分初面。
- **2 周**：G0 + G1，主线叙事「数据从 mock 升级到生产栈」；可选 G2 起头。
- **4 周（推荐）**：G0→G1→G2→G3→G4，形成「真实运行时 / 真实 RAG / 生产 eval / 多 Agent / 成本基线」完整作品，对照 M1–M9 心智模型逐一展示已做/待补。

### 一页电梯演讲（项目级，见 `03` §2.5）
**问题** 金融研究信息散落、引用难追溯，市面 demo 多 mock 不可信。
**方案** Pi 风格 TS Agent：`agentLoop` 纯函数内核 + hook 外置控制流；`StreamFn` 抽象让 mock↔real 只换实现；hybrid RAG + MCP；`run_events` 事件溯源保证可恢复；`<untrusted_context>` + 字段脱敏防护。
**证据** 确定性 eval 31 条（成功率 0.903 / citation 0.935）+ 3 固定失败案例；`test/verify-runtime-integration.mjs` 证明重启/取消/越权；真实 provider + pgvector 对比报告。
**取舍** 默认 mock 优先可复现，真实一键切换；heuristic rerank 先低成本可用、模型 rerank 插拔；单 Agent baseline 始终保留。
**下一步** LLM-as-Judge + 人工校准；SSE 跨实例 fan-out；多租户/审计；成本 guardrail 与 OTel 对齐；A2A 协议。

### 话术库（高频追问，详见 `03` §2.6）
「为什么自研 loop 不用 LangGraph」「RAG 和别人不同」「怎么防 prompt injection」「多智能体怎么做」「你怎么知道它好」——统一句式：**已落地的硬证据 + 诚实列待补 + 下一步修复路径**，把「知道边界」本身讲成工程成熟度。

## 五、文档同步影响

- 本文与 `01`/`02`/`03` 三个分文档均为规划文档，不改动源码；`04-cli-harness.md` 的方案已落地，其源码改动（删 `MockModel`、抽 `createOpenAiCompatibleRuntime` 至 `packages/ai`、新增 `apps/cli`、数据工具真实化）已按 AGENTS.md 同步至 `ARCHITECTURE.md`、``，并按用户要求产出话术至 `docs/v1.2/interview/`（`de-mock.md`、`cli-shared-core.md`、索引 `README.md`）。
- 后续落地任何切片时，须按 AGENTS.md 同步：`notes/`（新增 `real-provider.md`、`mock-real-boundary.md`、`cost-guardrail.md`、`eval-judge.md` 等）、`ARCHITECTURE.md`（mock/real 边界、成本护栏、多实例前提与进程内状态清单）、`docs/decisions/`（fan-out 选型、恢复续跑语义 ADR）、以及各维度 v1.1 文档的 P 项勾选。
- 建议本轮在 `notes/` 新增 `` 承载跨维度工程思想学习笔记。
