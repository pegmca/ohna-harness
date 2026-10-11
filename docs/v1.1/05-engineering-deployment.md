# 05 · 工程化、部署、安全与多租户

> 维度：Engineering / Deployment / Security / Multi-tenant
> 现状：`apps/api` Fastify + `run_events` SSE 持久 replay；`packages/security` 注入评估 / SQL 只读 / PII 脱敏；PG + pgvector（23 表，migration 幂等）；Docker Compose 一键 demo（mock）。
> 缺口：执行与 HTTP 同进程（崩溃丢 run）、SSE 缺 token 流式/背压/跨实例 fan-out、无多租户/鉴权/审计、OWASP 仅覆盖部分、无容量/SLO/成本证据。

## 1. 行业现状速览（2025–2026）

- **Durable runs 成主流**：Agent 执行与 HTTP 解耦为 worker + queue + lease + outbox/inbox，保证 at-least-once、重启可恢复、副作用幂等。
- **SSE 仍主导推送**：但生产需 token 级流式 + 背压 + 多实例 fan-out（Redis pub/sub 或共享 replay 存储）。
- **多租户靠 tenant_id 行级隔离 + per-tenant 配额/成本归因 + AI gateway** 统一鉴权/限流/成本护栏。
- **OWASP LLM Top 10(2025)** 重点：间接注入（RAG 文档投毒）、数据外泄、SSRF、供应链；tool 调用与 RAG 是主战场。
- **新趋势**：agent sandboxing（最小权限容器执行工具）、运行时平台化、secret 治理（KMS/vault，不落代码与 DB）。

## 2. 本项目差距

- 执行与 HTTP 同进程：崩溃/重启丢 run，无 queue/lease/状态机。
- SSE 仅单实例持久 replay，无 token 流式、无背压、跨实例不 fan-out。
- 无用户/租户/鉴权/RBAC、无 per-tenant 密钥与配额、无审计闭环。
- OWASP 仅覆盖注入/SQL 只读/PII，缺 SSRF、供应链、数据外泄护栏。
- 无容量/SLO/成本证据；MCP 仅本地 mock、无远程鉴权。

## 3. 改造方向（按优先级）

### P0 真实化运行时（低成本高收益）
- **目标**：mock → 真实 LLM + token streaming + RAG 接真实 PG+pgvector。立刻让 demo 可信。
- **落地**：`.env` 切 `AIAGENT_PROVIDER_MODE=real` 接 DeepSeek/通义；run-service token 事件接入 SSE。

### P1 worker 解耦（难度：中）
- **目标**：`run-service` 改 PG 队列表 + lease(`lease_until`) + 状态机；HTTP 只入队/查状态/SSE。复用现有 `run_events` 与 `clientMessageId` 幂等。

### P2 SSE token 流式 + 背压 + fan-out（难度：中）
- **目标**：事件按 run 落 PG（已有），新增 token 事件；跨实例用 Redis pub/sub 或共享存储 replay；背压靠 SSE 写缓冲 + 已有 `Last-Event-ID`。

### P3 多租户 + 鉴权 + 审计（难度：高）
- **目标**：补 `tenant_id/owner_id` 列（23 表）+ RBAC；secret 进 vault/KMS 不落 DB；run/tool 动作写 `audit_log`。

### P4 OWASP 体系化 + MCP 远程化（难度：中高）
- **目标**：`packages/security` 加 SSRF 域名白名单、tool 输出出口过滤（防 exfiltration）、MCP 远程鉴权。

## 4. 学习路径（TS 强、Docker/PG 已有基础）

- **阶段1（1–2周）真实化**：读 OWASP LLM 2025 + 本项目 `run-service`/SSE 代码；改 provider 真实化 + token 流式。**产出**：可跑 demo。
- **阶段2（2–3周）worker 解耦**：读 outbox/lease 范式；改 `run-service` 为队列表 + 状态机 + 重启恢复。**产出**：可恢复 run。
- **阶段3（2周）多租户 + 安全**：读 multi-tenant AI 架构；加 `tenant_id`/RBAC/审计/SSRF 护栏。**产出**：OWASP 对照 checklist。
- **阶段4（持续）SLO/成本**：接 AI gateway 或自研 cost guardrail；**产出**：容量/成本证据。

