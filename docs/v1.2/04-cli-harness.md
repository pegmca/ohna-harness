# 04 · 本地 Harness CLI + 全仓去 mock 化（共享 runloop 核心）

> 维度：本地 Harness / 组合根工程思想 + 真实化运行时（v1.2 `03` G0 拉满档）
> 配套：`01` 的 mock/real 边界、`03` 的 G0 真实化运行时。
> 状态：**已实现**（v1.2 去 mock 化 + CLI harness 落地完成）。本文件作为方案归档与回顾依据，落地细节见 §2 与 ``。
> 本轮相较初版方案的重大变更（用户决策）：**整个项目去除 mock 模式**——删除 `MockModel` 假 LLM、CLI 只走真实模型、4 个数据工具换成真实 adapter（本次"未配置即报异常"，数据源后续单独提供）。

## 0. 为什么去 mock + 做 CLI（工程思想）

v1.2 `01`/`03` 已论证：mock 全链路（假 LLM + 假数据）会掩盖内核与真实 provider 之间的契约问题，也无法验证工具在真实数据缺失时的结构化报错路径。用户具备充足真实模型额度，决定**彻底去 mock**，把 demo 从"确定性玩具"变为"真实 Agent"。CLI 则是这一转变的最小验证载体：同一套 `agentLoop`，去掉 HTTP/SSE/worker，直接在终端跑真实模型——证明内核可 headless 运行、前端只是运输层。

- **真实化运行时（G0 拉满）**：删 `MockModel`，`apps/api` 本地开发也必须配真实 key；不再有"mock 回退"。
- **工具真实化**：`market_data` / `filing_search` / `financial_metric` 三个数据工具从 `*-mock.ts` 确定性假数据换成真实 adapter，经 `FinancialDataSource` 端口接入；`sql_query` 按用户决策直接删除（SQL 执行不属于金融研究 Agent 的内核职责）；本次数据源未配置时**结构化报异常**（`ToolErrorCode.configuration_error`），不静默造假。
- **CLI 复用核心**：与 `apps/api` 同级组合根，只负责"选真实模型 + 装真实工具 + 调同一 `agentLoop` + 渲染"。

## 1. 已核对的现状（file:line）

| 项 | 位置 | 去 mock 后 |
|---|---|---|
| 假 LLM 运行时 | `apps/api/src/adapters/mock-model.ts:54` `createMockModelRuntime` | **删除整个文件** |
| API 默认 mock 分支 | `apps/api/src/server.ts:32` `providerMode`、`:99` mock 目录 | 仅保留 real；无真实 provider 则启动/ready 失败 |
| 真实 provider 构造 | `apps/api/src/server.ts:242` `createOpenAiCompatibleRuntime` | **抽进 `packages/ai` 复用** |
| 内置工具集 | `packages/tools/src/default-registry.ts:14` | 改为真实工具（带数据源端口） |
| 生产 mock 数据工具 | `packages/tools/src/tools/{market-data,filing-search,financial-metric}-mock.ts` | **删除，换成真实 adapter** |
| 生产 SQL 执行工具 | `packages/tools/src/tools/sql-query-mock.ts` | **删除（用户决策：不在内核职责内）** |
| eval 自包含 mock 替身 | `packages/eval/src/loop-runner.ts:405` `createEvalTools` | **不动**（独立 test double，不依赖生产 mock 工具，eval 确定性不受影响） |
| calculator（真实计算） | `packages/tools/src/tools/calculator.ts` | 保留 |

## 2. 改动清单

### 2.1 `packages/ai` — 仅提取真实 provider 构造器（共享核心，无 mock）
- 新增 `packages/ai/src/providers/env-runtime.ts`：`createOpenAiCompatibleRuntime(profile, defaultBaseUrl, overrides?)`，从环境变量构造 `Model<"openai-completions">` + `apiKey`（保留占位 key 过滤、缺配置返回 `{ error }`）。仅依赖 `@aiagent/ai` + `process.env`。
- `packages/ai/src/index.ts`：导出 `createOpenAiCompatibleRuntime`。
- **不抽 MockModel**（已删除，方向反转）。

### 2.2 `packages/tools` — 数据工具真实化 + 数据源端口
- 新增 `packages/tools/src/data-source.ts`：`FinancialDataSource` 端口（`isConfigured()` + `getMarketData` / `searchFilings` / `getFinancialMetrics` / `runQuery`），及 `createUnconfiguredDataSource()`（方法调用即抛结构化 `configuration_error`）。这是用户后续接 Tushare / AkShare 的接缝。
- 改 `packages/tools/src/tools/market-data.ts`、`filing-search.ts`、`financial-metric.ts`、`sql-query.ts`（原 `*-mock.ts` 重命名/重写）：`execute` 调 `dataSource` 对应方法；工具加 `source: "real"` 元数据；数据源未配置时抛结构化错误。
- 删除 `packages/tools/src/tools/*-mock.ts` 四个文件。
- 改 `packages/tools/src/default-registry.ts`：`createDefaultToolRegistry(dataSource?)`，缺省 `createUnconfiguredDataSource()`。
- `AgentTool` 契约（`packages/tools/src/types.ts` / `packages/agent/src/types.ts` re-export）加 `source?: "real" | "mock"` 字段（对齐 v1.2 `01` P0 边界；当前统一 `"real"`）。

### 2.3 `apps/api` — 去 mock 分支
- `apps/api/src/server.ts`：删除本地 `createOpenAiCompatibleRuntime`（改从 `@aiagent/ai` 引入）；删除 mock 目录分支与 `providerMode === "mock"` 路径；`providerMode` 仅接受 `real`（非 real 或 `realEntries.length === 0` 时 readiness 明确失败，不再回退 mock）；`createDefaultToolRegistry` 注入已配置的 `FinancialDataSource`（env 就绪时构造真实 client，否则 unconfigured 让工具按需报错）。
- 删除 `apps/api/src/adapters/mock-model.ts`。

### 2.4 `apps/cli`（新增）— 真实模型 CLI harness
- `package.json`：`@aiagent/cli`、`bin: immersive`、`type: module`；deps `@aiagent/agent` `@aiagent/ai` `@aiagent/tools` `@aiagent/types` `@aiagent/mcp`；scripts `dev` / `start` 均带 `--env-file-if-exists=../../.env`（`.env` 是 CLI 真实 provider 凭据的唯一来源，绕过脚本直跑 node 会因无 key 而结构化报错退出） / `build`(`tsc -b`) / `typecheck`。
- `tsconfig.json`：`composite`，`references` 指向 `packages/agent` `packages/ai` `packages/tools` `packages/types` `packages/mcp`，`include: ["src"]`，`outDir: dist`。
- `src/index.ts`：shebang；参数解析（`--model` 选 profile、`--prompt`/位置参数单次提问、`--help`）；readline REPL（多轮 history）；`SIGINT` 中断（运行中 abort，空闲退出）。**无 `--mode`，因为只有真实模型**；无真实 provider 配置则清晰报错退出。
- `src/harness.ts`：从 env 构造真实模型运行时（`createOpenAiCompatibleRuntime` + `createModelRuntimeRegistry` 或简化选择）；装配 `createDefaultToolRegistry(realClient)`；构建 `AgentLoopConfig`（`model`/`apiKey`/`convertToLlm: defaultConvertToLlm`/`shouldStopAfterTurn` 本地 `MAX_TURNS=8`）；**调用同一 `agentLoop`**；用 `agent_end.messages` 维护多轮 history。
- `src/render.ts`：`AgentEvent` → 终端（流式文本、`🔧 tool（real）` 调用/结果、错误、`message_end` 累计 token 小结）。

### 2.5 文档同步
- `ARCHITECTURE.md`：apps 列表/依赖方向补 `apps/cli`；运行模式去除 mock 描述。
- `docs/v1.2/README.md`：索引已加本文件；"最大短板"标注 mock 正在被去除。
- ``：组合根职责、EventStream 消费、history 维护、abort 传播、去 mock 取舍。

## 3. 不在范围内
- 不接 PostgreSQL / RAG / attachment / `generate_report`（CLI 只跑本地 core）。
- 不做 SSE / 多实例 / worker（属 `apps/api`）。
- 真实数据源的具体 provider 实现（Tushare/AkShare）由用户后续提供；本次只留端口与"未配置即报错"行为。

## 4. 设计取舍与价值
- 内核是一个纯函数 ReAct loop（`agentLoop`），`apps/cli` 与 `apps/api` 作为两个并列组合根共用同一内核，仅运输层不同（终端流式 vs HTTP/SSE）。去 mock 后默认走真实模型 + 真实数据源端口，未配置时结构化报错而非造假，契约正确性在真实 provider 上得到验证。

## 5. 验证（落地时执行）
- `pnpm --filter @aiagent/ai build && pnpm --filter @aiagent/tools build && pnpm --filter @aiagent/cli typecheck`
- `pnpm --filter @aiagent/cli build`、`pnpm --filter @aiagent/api typecheck`（确认去 mock 未破坏 API）
- `pnpm --filter @aiagent/eval eval`（确认 eval 确定性不受影响）
- 手动：`pnpm --filter @aiagent/cli dev "净利润最高的银行"` —— 未配真实 key 时清晰报错；配 key 后真实模型 + 工具（未配数据源则工具结构化报错）跑通
- `pnpm architecture:check`、`pnpm lint`

## 6. 关键文件
- 新增：`packages/ai/src/providers/env-runtime.ts`、`apps/cli/{package.json,tsconfig.json,src/index.ts,src/harness.ts,src/render.ts}`、`packages/tools/src/data-source.ts`
- 修改：`packages/ai/src/index.ts`、`packages/tools/src/default-registry.ts`、`packages/tools/src/types.ts`、`packages/tools/src/tools/*.ts`（4 个重写成真实 adapter）、`apps/api/src/server.ts`、`ARCHITECTURE.md`、`docs/v1.2/README.md`
- 删除：`packages/tools/src/tools/*-mock.ts`（4 个）、`apps/api/src/adapters/mock-model.ts`
- 文档：``
