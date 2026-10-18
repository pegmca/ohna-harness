# 04 · 开发计划（Development Plan）

> 本文给出**依赖有序、可独立验收**的分阶段开发计划，每个阶段都有文件级交付清单 + 验收命令 + 完成判据。
> 供另一个 codebuddy 会话**按序逐阶段实现**。拆解与目标架构见 `03-decomposition.md`，验收用例见 `05-verify-cases.md`。
>
> 执行纪律（沿用 `AGENTS.md` / `LEARNING_AND_EVOLUTION_ROADMAP.md` §3 七步法）：
> - 每阶段只做「窄切片 + 可验收」，禁止无验收的大爆炸重写。
> - 每个阶段跑完 §11 验证矩阵的**相关子集**再进入下一阶段。
> - 文档同步：每完成一阶段，同步 `docs/v1.3/README.md` 状态表 + `` / ``。

---

## 0. 阶段总览与依赖

```
Phase R  机械改名（finance-* / ohna-*，见 03 D7；纯 git mv + 引用替换，行为零变化）
   │
Phase 0  安全加固（P0，前置，阻塞一切「接管本地目录」承诺）
   │
   ├─► Phase 1  ohna-cli M2 长任务治理（持久化 / compaction / 预算 / 模型元数据）
   │
   ├─► Phase 2  packages/serve 装配 + ohna-api 薄入口（L0：JSONL + 流式对话）
   │        │
   │        ├─► Phase 3  ohna L1 接管本地目录（coding 全工具 + workspaceRoot + 异步确认）
   │        │
   │        └─► Phase 4  ohna-web 本地 Web UI（复制改造 + 文件树 + 本地模式）
   │
   └─► Phase 5  ohna-cli M3 + --web 进程内托管 + ohna L3（slash/diff/folding/MCP/子代理）
```

- Phase R 先做：改名先行，后续所有交付清单引用新路径，避免「改到一半再全局替换」。
- Phase 0 与 Phase 1 可**并行**（0 改 `packages/coding`，1 改 `packages/ai` + `apps/ohna-cli`，无文件交集）。
- Phase 2 依赖 Phase 0（沙箱可信）与 Phase 1（模型元数据可配 + `resolveActiveModelFromEnv` 下沉）。
- Phase 3 依赖 Phase 2（serve 装配骨架）。
- Phase 4 依赖 Phase 3（`/api/local/fs` + 确认闸门端点就绪）。
- Phase 5 依赖 Phase 1~4 全部（`--web` 复用 serve 装配，是 CodeBuddy 式主路径落地）。

---

## Phase R · 机械改名（前置，行为零变化）

**目标**：落实 03 D7 的产品命名，让后续交付清单直接引用新路径。**（D9：开发验证阶段，无需兼容原代码——bin 改名不留别名、`--mode` 面可随 Phase 1/5 重构。）**

**交付清单（文件级，全部机械替换）**：
1. `git mv apps/api apps/finance-api`、`git mv apps/web apps/finance-web`、`git mv apps/cli apps/ohna-cli`。
2. `package.json` 名称：`@aiagent/api`→`@aiagent/finance-api`、`@aiagent/web`→`@aiagent/finance-web`、`@aiagent/cli`→`@aiagent/ohna-cli`。
3. `apps/ohna-cli/package.json` 的 `bin`：`immersive` → `ohna`（及 `printProviderError` 等文案里的 `immersive`）。
4. 引用同步（`grep -rl` 全仓替换）：
   - 根 `package.json` scripts（`dev` / `test:e2e` 的 `@aiagent/api`/`@aiagent/web`）。
   - `Dockerfile`（`COPY apps/api/...`、`CMD node apps/api/dist/server.js`、`apps/web/dist`）。
   - `docker-compose.yml`、`deploy/nginx.conf`。
   - `.dependency-cruiser.cjs`（正则 `^apps/web/` → `^apps/finance-web/` 等）。
   - `test/*.mjs` 引用路径。
   - `AGENTS.md`、`ARCHITECTURE.md`、`README.md`、`docs/v1.3/*` 全部引用。
5. 新增 `apps/ohna-api/`、`apps/ohna-web/`、`packages/serve/` 目录占位（Phase 2/3/4 填内容）。

**验收**：
```bash
pnpm install && pnpm build && pnpm typecheck && pnpm architecture:check && pnpm test
pnpm dev   # finance-api + finance-web 照常启动，行为不变
```

**完成判据**：全仓 `grep -r "apps/api\|apps/web\|apps/cli\|@aiagent/api\|@aiagent/web\|@aiagent/cli"`（排除 .git/node_modules/dist/历史注释）无残留；金融路径行为零变化。

---

## Phase 0 · 安全加固（P0，最高优先）

**目标**：消除 `03-decomposition.md` §4.2 的 P0-1~P0-4，让「denylist + 确认闸门」信任模型成立。

**交付清单（文件级）**：
1. `packages/coding/src/policy/path-policy.ts`
   - `isDeniedPath` 改用 realpath（复用 `canonicalizePath`），与 `assertPathWithinRoot` 一致，封死软链绕过（P0-4）。
2. `packages/coding/src/policy/command-rules.ts`
   - `RM_DANGEROUS_TARGETS` 补 `"./"`、`"../"`、`"../../"`（及更深的 `..` 前缀变体）。
   - `checkDestructiveRm` 改为对**相对与绝对路径统一**判断「删除目标是否落在工作区外」（`~/Documents`、`/tmp/x`、`../../other` 一律拒绝）；工作区内合法操作（`rm -rf ./dist`）不误伤（P0-2）。
   - `SHELL_INTERPRETERS` 补绝对路径变体 `/bin/sh`、`/bin/bash`、`/usr/bin/python3` 等（P0-3）。
3. `packages/coding/src/policy/command-policy.ts`
   - `checkFetchPipedToShell` 覆盖 `;`/`&&`/`||` 切分后的「下载 → 解释器」组合（P0-3）。
4. `packages/coding/test/`：新增/扩展 `command-policy.test.mjs`、`path-policy.test.mjs`，逐条覆盖 §05 的安全负向用例（含 `rm -rf ~/Documents` 绝对路径用例）。
5. `packages/coding/src/tools/ls.ts`：消费 `signal`（取消可见）；`find.ts`：改为全量收集→排序→截断（字典序前 N）。

**验收**：
```bash
pnpm --filter @aiagent/coding test          # 覆盖所有绕过向量 + 正向放行
pnpm typecheck && pnpm architecture:check
```

**完成判据**：`05-verify-cases.md` §2 的安全负向用例全绿；正向用例（合法 `rm ./dist`、`git push` 普通推送）不误伤。

---

## Phase 1 · ohna-cli M2 长任务治理

**目标**：连续长任务不丢上下文、不超窗、成本可见、预算可控。

**交付清单（文件级）**：
1. `packages/ai/src/providers/env-runtime.ts`：模型元数据可配（D4）
   - 支持 `AIAGENT_LLM_CONTEXT_WINDOW_<P>`、`AIAGENT_LLM_MAX_TOKENS_<P>`、`AIAGENT_LLM_REASONING_<P>`、`AIAGENT_LLM_COST_IN_<P>` / `COST_OUT_<P>`（$/百万 token），缺省沿用现值（不破坏现有 profile）。
2. `packages/ai/src/model-selection.ts`（新）：`resolveActiveModelFromEnv` 从 `apps/ohna-cli/src/harness.ts` **下沉**（PROFILES 常量 + 遍历/选择逻辑原样迁移）；`apps/ohna-cli/src/harness.ts` 改为薄封装消费，公共行为不变。ohna-cli 与 serve 装配共用（核心包复用，见 03 §5 下沉说明）。
3. `packages/coding/src/prompt.ts`（新）：`buildCodingSystemPrompt(cwd)` 从 `apps/ohna-cli/src/mode.ts` coding 分支**下沉**（编码提示词模板 + `loadProjectContext` 组装）；`apps/ohna-cli/src/mode.ts` 改为消费。
4. `apps/ohna-cli/src/session-store.ts`（新）：JSONL 会话持久化
   - 落 `~/.ohna/sessions/<id>.jsonl`（复用 `@aiagent/ai` Message 形状）；`save/load/list`。
   - **会话级 compaction（跨 run 语义）**：`agentLoop` 复制上下文（`agent-loop.ts:126`），`transformContext` 产物只存在于 loop 内副本，`agent_end.messages` 只含增量——因此 run 结束/会话保存时由 harness 对全量 history 跑 `shouldCompact/compact`，把 `CompactionMessage` + 未压缩尾部写回 session JSONL（内核零改动），避免每 run 重复压缩与 JSONL 无界增长。
5. `apps/ohna-cli/src/harness.ts`：
   - `createConfig` 传 `deadlineMs` + `transformContext`（`createCompactionTransform`，注入 summarizer 复用 `streamSimple` 做摘要）；
   - `shouldStopAfterTurn` 内查 deadline（时钟）+ maxTurns + **`--max-cost` 预算**（会话累计 cost 超限即停，对齐 `team/budget.ts` 的 pre-commit 判定心智）；
   - `runRepl` 每次 run 结束落盘 history；启动 `--resume <id>` 恢复；`/clear` 另开新会话保留旧盘。
6. `apps/ohna-cli/src/render.ts`：usage tracker 升级为**会话级累计**（`/cost` 展示累计 input/output/cost）。
7. `apps/ohna-cli/src/index.ts`：新增 `--resume <id>`、`--max-turns <n>`、`--deadline-ms <n>`、`--max-cost <n>`。

**验收**：
```bash
pnpm --filter @aiagent/ohna-cli build && pnpm typecheck
# 人工：连续 20+ 轮改同一模块；/exit 后 --resume 能续；/cost 有累计值；长文件读取后 compaction 生效（不超窗）
```

**完成判据**：`05-verify-cases.md` §3 用例通过；`/cost` 不再恒 `$0.000000`（前提：env 配置了 cost）。

---

## Phase 2 · packages/serve 装配 + ohna-api 薄入口（L0）

**目标**：终端之外用浏览器对话——服务端装配包绑定 127.0.0.1、JSONL 落盘、SSE 流式回复、自动开浏览器。先用只读 coding 工具（`createReadOnlyToolRegistry`）验证闭环，风险最低。装配放包内（D8），`ohna-api` 只做进程生命周期，未来 `ohna-cli --web` / `ohna-tui` 复用同一装配。

**交付清单（文件级）**：
1. `packages/serve/package.json`（新）：`@aiagent/serve`，deps 声明 `@aiagent/agent`、`@aiagent/ai`、`@aiagent/coding`、`@aiagent/tools`、`@aiagent/trace`、**`@aiagent/types`（run-v2 线协议 DTO 必需）**、`@aiagent/security`、`fastify`、`@fastify/static`。
2. `packages/serve/src/store/session-store.ts`、`run-store.ts`、`message-store.ts`（新）：接口见 `03` §6.2，JSONL 纯追加（只落关键事件，`message_update` 不落盘）。
3. `packages/serve/src/routes/`（新，预拆避免单文件超 500 行）：`health.ts`、`identity.ts`（`GET /api/identity/me` 固定 local-user）、`conversations.ts`（含 `:id/messages` 游标页）、`runs.ts`（`POST /api/runs` → `AgentRunAcceptedDto`、`GET /:id` 快照、`DELETE /:id` 取消）、`events.ts`（SSE `event: run_event` + `afterSequence`/`Last-Event-ID` 续传）。
   **实现 run-v2 线协议（03 §6.1，评审 Gate 1）**——DTO 全部复用 `@aiagent/types`，不得自造 API 形状。
4. `packages/serve/src/index.ts`（新）：`createOhnaServer(options)` 薄壳，只做 routes 装配 + 进程内事件 fan-out；接受 `workspaceRoot` / `tools` / `dataDir` / `autoApprove` / `modelResolver` / `systemPrompt` 等选项。
5. `packages/serve/src/static.ts`（新）：serve `apps/ohna-web/dist` + SPA fallback（L0 可先返回占位页，Phase 4 接真实 UI）。
6. `apps/ohna-api/src/index.ts`（新，薄入口）：解析 `[dir]`、`--port`、`--data-dir`、`--auto-approve`；`createOhnaServer` + listen 127.0.0.1；端口探测占用自动 +1；`open(http://127.0.0.1:PORT)`；SIGINT/SIGTERM 优雅关闭（中断在途 run、**追发 `run_status{status:"interrupted"}` 终态事件**（评审 Gate 3，否则客户端显示为 completed）、落盘 interrupted）。
   模型解析与系统提示词：消费 Phase 1 下沉的 `resolveActiveModelFromEnv`（`packages/ai`）与 `buildCodingSystemPrompt`（`packages/coding`），不在 apps 重复实现。
7. `packages/serve/test/`：store 单测（append/list 往返）、server 集成测（health + 流式 run + 取消终态 `run_status{interrupted}`）。

**验收**：
```bash
pnpm --filter @aiagent/serve build && pnpm typecheck && pnpm architecture:check
node apps/ohna-api/dist/index.js /tmp/demo --port 4173   # 浏览器自动打开，能发消息收流式回复
```

**完成判据**：`05-verify-cases.md` §4 的 L0 用例通过；`GET /api/health` 返回 `mode:"local"`；JSONL 落盘可 `cat`。

---

## Phase 3 · ohna L1 接管本地目录

**目标**：本地 Agent 真实读写 `workspaceRoot`，越界/危险命令被拒，写/执行经异步确认卡片。

**交付清单（文件级）**：
1. `packages/types/src/run-v2.ts`：`RunEventTypeDto` 增加 `"confirmation_requested"`（评审 Gate 2；金融线不消费，枚举扩展无害），payload `{ toolCallId, toolName, args, summary }`；该事件照常追加 runs JSONL（刷新页面后 SSE 重放恢复待确认卡片）。
2. `packages/serve/src/confirm-gate.ts`（新）：`AsyncConfirmGate`（见 `03` §6.3）；SSE 广播 `confirmation_requested`；新增 `POST /api/runs/:runId/confirmations/:toolCallId`（`src/routes/confirmations.ts`）。
3. `packages/serve/src/routes/runs.ts`：run 装配改为 `createCodingToolRegistry(workspaceRoot)`（全工具）。
4. `packages/serve/src/routes/fs.ts`（新）：`GET /api/local/fs`（只读 list/tree/read，复用 `packages/coding` 的只读语义，或独立实现只读遍历）。
5. `apps/ohna-api/src/index.ts`：`--auto-approve` 透传确认闸门。

**验收**：
```bash
# 让 Agent 读取 <dir> 下某文件并改一个变量 → 触发待确认卡片 → 允许后落盘
# 越界读取 /etc/passwd 被拒；rm -rf / 被拒（结构化 isError 回喂模型）
```

**完成判据**：`05-verify-cases.md` §4 L1 用例通过；`/api/local/fs` 只读、无法写。

---

## Phase 4 · ohna-web 本地 Web UI

**目标**：把 `apps/finance-web`（原 apps/web）复制改造为编码 Agent 的 Web 界面（文件树 + 本地模式 + 展开式工具详情）。

**交付清单（文件级）**：
1. `apps/ohna-web/`（新）：从 `apps/finance-web` 复制。
2. `src/app/identity.tsx`：删除 FingerprintJS / 渲染 gate，替换为 `local-user` 固定身份。
3. `src/shared/api/`：保留 run-stream/http client；base URL 指向本地（`vite.config.ts` 代理 → serve 装配端口）。
4. `src/features/files/`（新）：文件树面板（读 `/api/local/fs`）；**L2 联动刷新**：订阅 run 事件，write/edit/bash 类 `tool_execution_end` 后自动刷新文件树。
5. `src/shared/mode.ts`（新）：`/api/health` → `mode:"local"` → 显示本地标识 + 隐藏 SaaS 块（登录/账单/QQ/data-sources/workflow）。
6. 待确认卡片：把 run 流中的 `confirmation_requested` 事件渲染为 allow/deny 卡片，回 `POST /confirmations`；页面刷新后经 SSE 重放恢复未决卡片（落盘语义见 03 §6.3）。

**验收**：
```bash
pnpm --filter @aiagent/ohna-web build
# 本地：浏览器打开，看到文件树 + 对话；写操作弹待确认卡片；点击允许后文件树可见变更
```

**完成判据**：`05-verify-cases.md` §5 用例通过；无金融/登录残留。

---

## Phase 5 · ohna-cli M3 + --web 进程内托管 + ohna L3 体验对齐

**目标**：对齐 Claude Code / CodeBuddy 的体验与长任务治理，落地 D8 主路径（`ohna --web`）。

**ohna-cli M3（`apps/ohna-cli`）**：
1. `src/slash.ts`（新）：slash 命令 `/model`、`/cost`、`/compact`（手动压缩）、`/tools`、`/resume`（复用 Phase 1 的 session-store）。
2. `src/render.ts`：写前 unified diff 渲染（复用 `packages/coding` 的 edit diff 计算，或引入 `diff` npm 包）；工具输出折叠（头尾 + 省略提示）。
3. `src/index.ts`：`--mcp <config>` → `discoverMcpAgentTools` 并入注册表，外部工具输出经 `<untrusted_context>` 封装（`packages/security`）。
4. 子代理（可选）：`TeamController` 做只读 explore 子代理。
5. anthropic provider（可选）：`packages/ai/src/providers/anthropic.ts` 直连或走 OpenRouter 兼容层。

**`--web` 进程内托管（D8 主路径）**：
`apps/ohna-cli/src/web-entry.ts`（新）：`ohna --web [dir]` 复用 `createOhnaServer`（`packages/serve`）在同一进程内起 HTTP/SSE，自动开浏览器；REPL 与浏览器共享同一会话/事件流（终端与浏览器双表面看同一个 agent）。实现要点：serve 装配暴露可注入的 `sessionStore` 与事件源，CLI 复用其会话管理；此步仅作「入口 + 复用」，不改 serve 内核。

**ohna L3（长任务治理）**：
`/resume` 恢复（session store）、compaction 挂载（复用 Phase 1 的会话级 compaction 语义，落在 serve 装配的会话持久化）、`/cost` 预算展示（复用 Phase 1 的会话级 tracker 思路）。

**验收**：
```bash
pnpm build && pnpm typecheck && pnpm architecture:check && pnpm lint
# 主观对比 Claude Code：看得见 diff、能中断能续跑、能挂外部 MCP
# ohna --web：启动后浏览器打开，与终端看同一会话
```

**完成判据**：`05-verify-cases.md` §6 用例通过。

---

## 11. 全局验证矩阵（每个阶段至少跑相关子集）

```bash
pnpm --filter @aiagent/coding test          # Phase 0 起必跑
pnpm --filter @aiagent/serve test           # Phase 2 起必跑（装配包单测/集成测）
pnpm --filter @aiagent/ohna-cli build       # 改 ohna-cli 必跑
pnpm --filter @aiagent/ohna-api build       # 改 ohna-api 必跑
pnpm --filter @aiagent/ohna-web build       # 改 ohna-web 必跑
pnpm typecheck                              # 每阶段必跑
pnpm architecture:check                     # 新增包/改依赖方向必跑
pnpm lint                                   # 每阶段末必跑
```

回归红线：`apps/finance-api` / `apps/finance-web` 的既有测试与构建**不得被误伤**（`pnpm --filter @aiagent/finance-api build`、`pnpm --filter @aiagent/finance-web build`）。
**特别注意**：Phase 1 改 `packages/ai`、Phase 3 改 `packages/types` 时，这两个包与金融线共享——除 build 外必跑 `pnpm --filter @aiagent/finance-api test`（原 apps/api 已有测试目录），确认金融路径无回归后才算完成。

---

## 12. 文档同步清单（每阶段完成时）

- `docs/v1.3/README.md`：状态表勾选。
- ``（Phase R/0/1/5）：改名、安全加固取舍、长任务治理、体验对齐。
- ``（Phase 2/3/4/5）：serve 装配、JSONL 取舍、异步确认、文件树、`--web` 托管、SSE 简化。
- `ARCHITECTURE.md`：补 `apps/finance-api`/`apps/finance-web`/`apps/ohna-cli`/`apps/ohna-api`/`apps/ohna-web` 与 `packages/serve` 依赖方向。
- `AGENTS.md`：仓库结构一节同步新目录名。
- `LEARNING_AND_EVOLUTION_ROADMAP.md`：新增阶段产出与验收证据。
