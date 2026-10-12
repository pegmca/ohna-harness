# 带读路线：工具生态 / MCP / 多 Agent 互联（v1.1 · P0 落地）

> 配套文档：`docs/v1.1/03-tools-mcp.md`（差距与改造方向）
> 参考实现：`.`（本仓库 `@aiagent/mcp` + `@aiagent/agent`）
> 本路线只讲**本次 P0 改造落地的代码**（e2e 测试 + 外部 server 可插拔接入），帮你把"协议即集成"从概念落到可运行证据。
> 读法：先读一节理论，再打开对应 `file_path:line` 读源码，最后回看「学习检查点」。

---

## 0. 本次改造落地了什么（一句话）

把 docs/v1.1/03-tools-mcp.md 的 **P0（低成本高收益点）** 落地为可运行代码：

1. **一条走 `agentLoop → createCombinedAgentTools → discoverMcpAgentTools → execute` 的真实 e2e 集成测试**，证明"我们的 `AgentTool` 抽象 ≈ MCP 协议契约，边界正确"；
2. **`createCombinedAgentTools` 支持 `extraServers`**（接外部/社区 MCP server 的配置化入口），让"协议即集成"成为一行配置即可接入的能力；
3. 配套一个**确定性 in-repo 次级 MCP server fixture**，演示多 server 合并、且零网络依赖。

> 关于"真实公开 server"的取舍：文档 P0 原文建议"从官方/社区选一个 TS 只读 server（如 filesystem）接入"。本次用**项目自带的真实 stdio MCP server**（`packages/mcp/src/stdio.ts` 启动的 `dist/stdio.js`，注册了 `search_filings` 等三个真实工具，走真实 MCP 握手 + `tools/call`）作为 e2e 主对象，并用 in-repo 的 `echo-demo` fixture 演示"外部 server 经同一契约并入"。原因：避免把测试绑死在外部网络/版本上，保证 CI 确定性；接入真实社区 server 只需把 `extraServers` 换成 `npx @modelcontextprotocol/server-filesystem <dir>` 之类的配置，**契约与代码零改动**——这正是 P0 想证明的"协议即集成"。

---

## 1. e2e：agentLoop 真跑通 MCP 工具调用

**读什么**
- `packages/mcp/test/agentloop-mcp-e2e.test.mjs`
  - 测试一 `agentLoop executes MCP search_filings …`（`agentloop-mcp-e2e.test.mjs:108`）：
    - `createCombinedAgentTools()` 启动真实内置 server，返回 `combined.tools`（`agentloop-mcp-e2e.test.mjs:109`）；
    - 断言 `combined.mcpAvailable === true` 且 `mcpToolNames` 含 `search_filings`（`agentloop-mcp-e2e.test.mjs:112`）；
    - 构造确定性 mock `StreamFn`（`createMockStreamFn` `:77`）：第一轮返回 `search_filings` 的 `toolCall`（`stopReason:"toolUse"`），第二轮返回含"不良贷款率"的最终答案（`stop`）；**严格对标** `packages/eval/src/loop-runner.ts` 的 `createFixtureStreamFn` / `createMockAssistantMessage` / `EVAL_MODEL`；
    - 真正 `agentLoop([user], context, config, signal, streamFn)` 跑双循环（`agentloop-mcp-e2e.test.mjs:136`）；
    - 收集事件后断言：(b) 出现 `tool_execution_end(toolName==="search_filings", isError===false)`（`:148`）；(c) 工具结果 `details.data.source === "mock_rag_runtime"`（`:155`，**强断言**——只有真实 RAG runtime 才产出该源，证明工具真的经 MCP server 执行，而非 mock 短路）；
    - `finally` 中 `await combined.close()` 释放子进程（`:171`）。
  - 测试二 `createCombinedAgentTools merges an external echo MCP server …`（`agentloop-mcp-e2e.test.mjs:175`）：用 `extraServers:[echo-demo]` 证明多 server 合并（`extraServers` 含 `echo-demo` 且 `tools` 出现 `echo_demo`），同时断言内置 server 行为不变。

**为什么这条测试值钱**
它把"AgentTool 抽象 ≈ MCP 协议契约"从口头说法变成**端到端证据**：MCP 工具（外部进程、JSON-RPC、`tools/call`）被 `createMcpTool` 包装成与内置工具**同一套 `AgentTool` 契约**，直接并进 `agentLoop` 的 `config.tools`，模型无感知来源差异。这正是本项目相对多数框架最值得讲的点——**工具来源透明、靠统一契约解耦**。

**学习检查点**
- 为什么说"零回归、确定性"？mock `StreamFn` 不发起任何 HTTP；server 是本地 `dist/stdio.js`；echo fixture 用 `process.execPath` 跑 in-repo `.mjs`。三者都不依赖网络，可在任意 CI 复现。
- 强断言 vs 弱断言：`details.data.source === "mock_rag_runtime"` 为什么算强断言？如果 MCP 调用被短路或返回空，`toolEnd` 为 `undefined` 会让 `.find` 后的 `.result` 直接抛错，测试必然失败——它不是"永远为真"的断言。

---

## 2. extraServers：把"接社区 server"做成配置入口

**读什么**
- `packages/mcp/src/combined-tools.ts`
  - 选项新增 `extraServers?: CreateMcpStdioClientOptions[]`（`combined-tools.ts:13`），结果新增 `extraServers: ExtraServerDiscovery[]`（`combined-tools.ts:25`、`combined-tools.ts:46`）；
  - 核心循环（`combined-tools.ts:108`）：对每一项 `extraServers`，单独 `createMcpStdioClient` + `discoverMcpAgentTools({ includeUnknown: true })`，把工具并入 `tools`；
  - **失败隔离**（`combined-tools.ts:120`）：任一 extra server 启动/发现失败，只把结构化错误 `{ code:"mcp_extra_server_unavailable", … }` 推入 `extraServers` 列表，**绝不 rethrow、绝不拖垮内置 server**；
  - `close()` 同时关闭内置 client 与所有 extra client（`combined-tools.ts:141`）。

**设计要点**
- 默认路径（不传 `extraServers`）行为 100% 不变：`options.extraServers ?? []` 为空，新增分支不执行；`fallbackToRest ?? true` 保持原默认（`combined-tools.ts:67`、`combined-tools.ts:102`）。
- 外部 server 的工具本就未知，必须 `includeUnknown:true` 才能全量透传（见第 3 节）。

**学习检查点**
- 为什么"单个 server 失败不能拖垮整体"是生产级分水岭？真实环境里"接了 5 个社区 server、其中 1 个挂了"，Agent 不应整体崩，而是降级 + 观测。本项目用结构化 `extraServers` 列表把"接入状态"显式暴露给调用方，符合 docs/03 里"生产化治理优先"的方向。
- 接入一个真实社区 server（如 filesystem）要改几行代码？**零行**——只在调用方传 `extraServers:[{ command:"npx", args:["-y","@modelcontextprotocol/server-filesystem", dir] }]`。这就是"协议即集成"的落地形态。

---

## 3. 未知外部工具的宽松透传：保持模型选择不被破坏

**读什么**
- `packages/mcp/src/tool-adapter.ts`
  - `discoverMcpAgentTools` 新增可选 `includeUnknown`（`tool-adapter.ts:180`）；
  - `wrapDiscoveredMcpTool`（`tool-adapter.ts:235`）：已知工具（`search_filings`/`get_financial_metrics`/`get_market_data`）走精确 zod schema 包装；未知工具**仅当 `includeUnknown===true`** 才回退到 `createMcpGenericTool`（`tool-adapter.ts:244`），否则跳过；
  - `createMcpGenericTool`（`tool-adapter.ts:257`，已 re-export 到 `packages/mcp/src/index.ts:23`）：输入/输出用宽松 zod（`z.object({}).loose()`）透传，回喂封装与已知工具一致（走 `assembleUntrustedContext` 的 `<untrusted_context>`）。

**设计权衡**
内置 server 全为已知工具，所以默认 `includeUnknown=false` 完全保持原行为；只有外部/社区 server 路径才开宽松透传。理由见 docs/03 的"未知工具跳过"原则：**不能用宽松 schema 破坏模型选择，也无法保证 zod→JSON Schema 转换的表达能力**。

**学习检查点**
- 为什么"未知工具默认跳过"而不是"一律宽松包装"？如果对所有未知工具都宽松包装，模型会在几十个未知工具里被噪声干扰、选择质量下降；而本项目内置工具是精选的、有精确 schema 的——这是一个"协议抽象 vs 模型可用"的实弹权衡。

---

## 4. 包边界决策：测试为什么放在 `packages/mcp`

**读什么**
- `packages/mcp/package.json`：`@aiagent/agent` 与 `@aiagent/ai` 仅出现在 **devDependencies**（仅供 `.mjs` 测试 import），未进 `dependencies` 运行时依赖；`test` 脚本先 build agent 及其依赖、再 build mcp、最后 `node --test test/*.test.mjs`。

**为什么这样拆**
docs/03 原文写"在 packages/agent 加一条集成测试"，但架构硬规则是"包级依赖不能成环、运行时单向"。若让 `@aiagent/agent` 在运行时依赖 `@aiagent/mcp`，方向就反了（consumer→capability）。因此把 e2e 测试放在**能力方 `packages/mcp`**，以 devDependency 引入 agent 仅供测试，运行时方向不变。

**学习检查点**
- 依赖方向的"单向性"为何是硬规则？本仓库把"控制流内核"放在 agent，"工具/协议能力"放在 mcp/tools/security，agent 消费能力、能力不反向依赖 agent，才能避免循环依赖、保证每个包可独立测试与演进。

---

## 6. 最小可演示路径

1. `pnpm --filter @aiagent/mcp test` → 18/18 通过（含新增 e2e 两条）。
2. 想看 e2e 真跑：打开 `packages/mcp/test/agentloop-mcp-e2e.test.mjs:108`，断点跟 `agentLoop` 如何把 MCP 工具结果回喂模型。
3. 想看多 server 合并：把测试二的 `extraServers` 换成任意社区 server 配置（如 filesystem），观察 `result.extraServers` 与 `result.tools` 变化——**代码零改动**。
