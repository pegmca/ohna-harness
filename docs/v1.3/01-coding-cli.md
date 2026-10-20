# 01 · CLI 编码 Agent 实施方案（M1 / M2 / M3）

> 本文是 `docs/v1.3/README.md` 的落地细节：把 `apps/ohna-cli` 从金融问答 REPL 改造成编码 Agent CLI。
> 移植来源：`https://github.com/badlogic/pi-mono` 的 `packages/coding-agent/src/core/tools/*`（pi，MIT）。
> 状态：M0（会话外壳）**已实现**；M1（编码工具闭环）**已实现**；M2（长任务治理）**已实现**；
> M3（体验对齐）**规划中，按序推进**。

## 1. 基线：已具备 vs 已缺

### 1.1 已具备（不需要重写，直接复用）

| 能力 | 位置 | CLI 现状 |
|---|---|---|
| 纯函数 ReAct 双循环 + 6 个挂载点 + AbortController | `packages/agent/src/agent-loop.ts` | 已用 |
| 工具契约（zod 校验、timeout/retry、parallel/sequential） | `packages/tools/src/types.ts`、`executor.ts` | 已用 |
| 上下文压缩（compaction） | `packages/agent/src/compaction.ts` | **未挂载** |
| MCP stdio client + `discoverMcpAgentTools` | `packages/mcp/src/tool-adapter.ts` | **未接入** |
| 子代理 team controller | `packages/agent/src/team/controller.ts` | 未用 |
| Prompt injection 评估 / `<untrusted_context>` 封装 | `packages/security/src/security.ts` | CLI 未用 |
| 会话开场 + 多轮 + `/help` `/clear` `/exit` | `apps/ohna-cli/src/ui/welcome.ts`、`harness.ts` | **M0 已实现** |

### 1.2 缺口清单（编号沿用会诊结论，M1–M3 逐项消化）

| # | 缺口 | 现状证据 | 归属 |
|---|---|---|---|
| 1 | 无文件/命令工具 | `packages/tools/src/default-registry.ts:16` 只有 4 个金融工具 | M1 |
| 2 | 无权限与沙箱 | `packages/agent/src/types.ts:161` 明确「不接任何审批逻辑（approval 体系已删除）」 | M1 |
| 3 | 系统提示词写死金融场景 | `apps/ohna-cli/src/cli/harness.ts:29` | M1 |
| 4 | 会话不落盘，退出即丢 | `harness.ts` 的 `runRepl` 仅内存 `history` | M2 |
| 5 | compaction 未挂、`MAX_TURNS=8` 太小 | `apps/ohna-cli/src/cli/harness.ts:26`；`createConfig` 未传 `transformContext` | M2 |
| 6 | 模型元数据写死 | `packages/ai/src/providers/env-runtime.ts:62-72`（`reasoning:false`、`contextWindow 128000`、`maxTokens 8192`） | M2 |
| 7 | anthropic provider 是 disabled 桩 | `packages/ai/src/providers/anthropic.ts:8` | M3 |
| 8 | REPL 无 slash 命令体系、无 diff 渲染、输出不折叠 | `apps/ohna-cli/src/ui/render.ts` | M3 |
| 9 | 无「改完自己跑验证」闭环 | 依赖 1 + 项目脚本知识 | M1/M3 |
| 10 | 无 MCP / 子代理分工 | `apps/ohna-cli/package.json` 未声明 `@aiagent/mcp`（与 `docs/v1.2/04-cli-harness.md` 描述不符，属文档漂移） | M3 |

## 2. 移植映射表（pi → aiagent）

pi 工具位于 `packages/coding-agent/src/core/tools/`，共约 4100 行。核心算法可直接搬，依赖需替换。

| pi 文件（行数） | aiagent 落地 | 改造要点 |
|---|---|---|
| `truncate.ts`（276） | `packages/coding/src/tools/truncate.ts` | 零外部依赖，**原样搬**（`DEFAULT_MAX_BYTES/LINES`、`truncateHead/Tail/Line`、`formatSize`） |
| `output-accumulator.ts`（222） | 同名 | 只依赖 `truncate.ts`，原样搬 |
| `file-mutation-queue.ts`（61） | 同名 | 原样搬（写文件串行化，避免并发写坏） |
| `path-utils.ts`（118） | 同名 + 本地 `paths.ts` | 去掉 `../../utils/paths.ts` 依赖，自建 `resolvePath`（`~` 展开、相对 cwd 解析、去 `@` 前缀）；macOS NFD/截图变体可保留 |
| `render-utils.ts`（85） | 简化为 `text-utils.ts` | 只保留 `getTextOutput` / `str` / `shortenPath` / `replaceTabs`；**剥离 pi-tui 的 hyperlink、imageFallback、theme** |
| `read.ts`（351） | 同名 | typebox→zod；去掉图像读取、TUI 高亮、`keyHint`；保留 offset/limit、行号前缀、截断提示 |
| `write.ts`（267） | 同名 | 同上；`mkdir -p` + 原子写保留；接入 `file-mutation-queue` |
| `edit.ts`（437）+ `edit-diff.ts`（560） | 同名 | 去掉 TUI `renderDiff`（M3 在 CLI 侧自绘 unified diff）；`edit-diff.ts` 依赖 `diff` npm 包 → **决策：引入 `diff`（MIT）还是自实现最小 diff**，建议先引入 |
| `bash.ts`（505）+ `core/bash-executor.ts` | 同名 | 去掉 TUI/theme；保留 spawn + `OutputAccumulator` 头尾截断 + 超时 kill；**命令 denylist 抽出到 `policy/command-policy.ts`** |
| `grep.ts`（385）/ `find.ts`（374） | 同名 | pi 用 `ensureTool` 下载 `rg`/`fd` 二进制；**建议先用 Node 原生回退**（`readline` + `readdir` 递归），保留 spawn `rg`/`fd` 作为可选加速开关 |
| `ls.ts`（225） | 同名 | 去掉 TUI；保留 entries/长格式/截断 |

### 2.1 契约适配要点（必读）

| 维度 | pi | aiagent | 处理 |
|---|---|---|---|
| 参数 schema | typebox `Type.Object` | **zod v4**（`packages/tools` 同款） | 逐个改写为 `z.object`，description 保留英文原意 + 中文补充 |
| execute 签名 | `(toolCallId, params, signal, onUpdate, ctx)` | `(toolCallId, params, signal, onUpdate)` | 删掉第 5 个 `ExtensionContext` |
| 中间层 | `ToolDefinition` + `wrapToolDefinition` | 无 extension 体系 | **不引入**；工具直接是 `AgentTool` |
| 结果 | `{ content, details }` | `{ content, details, isError? }` | 失败走 `isError: true` + 文本 content，不向上抛裸异常 |
| 渲染 | 工具自带 TUI renderer | 由 `apps/ohna-cli/src/ui/render.ts` 统一渲染 | 工具只回文本与 details |

结论：**移植成本主要在「剥 TUI + 换 schema」，算法逻辑基本可原样保留**。

## 3. 包与目录设计

```
packages/coding/
  package.json            # @aiagent/coding，deps: zod；composite tsconfig
  src/index.ts            # 导出 createCodingToolRegistry / createReadOnlyToolRegistry 与类型
  src/tools/              # read/write/edit/edit-diff/bash/bash-executor/grep/find/ls
  src/support/            # truncate / output-accumulator / path-utils / text-utils / file-mutation-queue / paths
  src/policy/
    path-policy.ts        # workspace 根校验、敏感文件 denylist（.env、密钥、node_modules）
    command-policy.ts     # bash 危险命令 denylist 编排入口（assessCommand）
    command-rules.ts      # 命令词法切分与单条规则原语（command-policy 超过 500 行后拆出）
  src/context/
    project-context.ts    # 读 AGENTS.md / DESIGN.md / package.json scripts / git branch+dirty
```

- **为什么不进 `packages/tools`**：那是金融工具域（AGENTS.md 要求包边界清晰），编码工具独立成包，`apps/ohna-cli` 组合根固定装配它。
- 单文件 >500 行时按内聚拆分（项目纪律），例如 `edit.ts` 若超限可拆出匹配/替换策略。
- 每个移植文件头部注明「ported from pi (MIT)」，归因与改动点写进 ``。

## 4. M1：编码工具闭环（能真实改代码、跑测试、自己修）

> 状态：**已实现**（`packages/coding`；编码工具集是 ohna 唯一的工具注册表）。

### 4.1 交付清单

1. 新建 `packages/coding`，按第 2/3 节移植 7 个工具 + 支撑模块。
2. `packages/coding/src/policy/`：`path-policy.ts`、`command-policy.ts`。
   - 路径：所有读写必须落在 `cwd` 内（realpath 对比），拒绝 `.env`、`*.pem`、`.git/*`、`node_modules`。
   - 命令：`rm -rf /`、`sudo`、`curl|sh`、`git push --force`、`mkfs`、写 `/etc` 等 → 结构化拒绝。
   - 输出上限：单一来源为 `packages/coding/src/support/truncate.ts` 的 `DEFAULT_MAX_BYTES`（50KB）/ `DEFAULT_MAX_LINES`（2000 行），工具层不写字面量；bash 超时默认 60s 可配。
3. `packages/coding/src/context/project-context.ts`：组装项目上下文（AGENTS.md、DESIGN.md、package.json scripts、`git status --short`）。
4. `apps/ohna-cli`：
   - `package.json` 加 `@aiagent/coding` 依赖；`src/index.ts` 提供 `--yes`（跳过写/执行确认）。
   - `src/harness.ts`：固定装配编码工具注册表与 ohna 系统提示词；注入项目上下文；挂 `beforeToolCall` 做权限拦截 + 交互确认。
   - `MAX_TURNS`：固定为 24（`src/mode.ts` 的 `MAX_TURNS`），并加 `deadlineMs`。
   - `src/render.ts`：工具调用一行展示 `命令` / `路径`，结果与错误保持现有 `✓/✖` 风格。

### 4.2 验收（人工可复现）

```bash
# 1) 只读探索
pnpm --filter @aiagent/ohna-cli dev -- "列出 apps/ohna-cli/src 下的文件并说明各自职责"
# 期望：调用 ls/grep/read，不产生任何写操作

# 2) 真实改码 + 自跑验证（核心验收）
pnpm --filter @aiagent/ohna-cli dev -- "在 test/ 下新增一个 ts 文件，导出 add(a,b)，然后跑 pnpm --filter @aiagent/ohna-cli typecheck 直到通过"
# 期望：write → bash(pnpm typecheck) → 必要时 edit 自愈 → 结束

# 3) 权限护栏
pnpm --filter @aiagent/ohna-cli dev -- "读取 /etc/passwd"        # 期望：路径越界被拒
pnpm --filter @aiagent/ohna-cli dev -- "执行 rm -rf /"            # 期望：命令 denylist 拒绝
```

### 4.3 风险与对策

- **误写风险**：默认写/执行需终端确认（y/n），`--yes` 才跳过；确认交互复用 readline，abort 语义与现有 Ctrl-C 一致。
- **长输出刷屏**：沿用 pi 的 `OutputAccumulator` 头尾截断，只把截断后的文本回喂模型。
- **`diff` 依赖**：如不愿新增依赖，M1 可先只做整文件 `write` + 精确串替换 `edit`（不走 diff），M3 再引入。

## 5. M2：长任务治理（连续干长活不丢上下文）

> 状态：**已实现**（`apps/ohna-cli`；内核 `agent-loop.ts` 零改动）。

1. **会话持久化**：CLI 不依赖 Postgres，落 JSONL 到 `~/.ohna/sessions/<session-id>.jsonl`
   （首行 session 元数据，之后每行一条 `AgentMessage`，含 `CompactionMessage`）；
   启动时 `--resume <id>` 恢复（单次模式与 REPL 均支持）；`/clear` 保留旧文件另开新会话。
2. **compaction 挂载**：`createCompactionTransform` 挂到 `AgentLoopConfig.transformContext`，超水位自动压缩并保留摘要消息。
3. **预算可配**：`--max-turns`、`--deadline-ms`、`--max-cost`；`shouldStopAfterTurn` 内检查到期；`createUsageTracker` 从单轮升级为会话级累计并在 `/cost` 展示。
4. **模型元数据可配**：`env-runtime.ts:62-72` 支持 `AIAGENT_LLM_CONTEXT_WINDOW_<P>`、`AIAGENT_LLM_MAX_TOKENS_<P>`、`AIAGENT_LLM_REASONING_<P>`，缺省沿用现值（不破坏现有 profile）。

验收：连续 20+ 轮改同一模块，`/cost` 有累计值；中途 `/exit` 后 `--resume` 能接着改；长文件读取后不超窗（compaction 生效）。

## 6. M3：体验对齐成熟 CLI

> 状态：**规划中**。

1. **slash 命令体系**：`/help` `/clear` `/cost` `/exit` 已有（M0/M2），补 `/model`（切换 profile）、`/compact`（手动压缩）、`/tools`（列出当前注册表）。
2. **写前 diff 渲染**：写/编辑先在终端打印 unified diff，确认后再落盘（复用 `edit-diff` 的 diff 计算）。
3. **输出折叠**：bash / 工具输出超阈值只显示头尾 + 省略提示，details 供展开。
4. **`@文件` 引用与路径补全**：readline Tab 补全 + `@path` 注入文件内容，减少模型往返。
5. **MCP 接入**：`apps/ohna-cli` 补 `@aiagent/mcp` 依赖（顺带修正 `docs/v1.2/04-cli-harness.md` 的 deps 描述漂移），`--mcp <config>` 用 `discoverMcpAgentTools` 并入注册表，外部工具输出经 `<untrusted_context>` 封装。
6. **子代理（可选）**：用 `team-controller.ts` 做 explore / implement / review 分工，先只做只读 explore 子代理。
7. **anthropic provider（可选）**：`packages/ai/src/providers/anthropic.ts:8` 目前是 disabled 桩；需要直连 Claude 时再实现，短期可走 OpenRouter 兼容层。

验收：与 Claude Code 主观对比——看得见改了什么（diff）、能中断能续跑、能挂外部 MCP 工具。

## 7. 验证矩阵（每个 M 都要跑）

```bash
pnpm --filter @aiagent/ohna-cli build   # 或 pnpm build
pnpm typecheck
pnpm architecture:check            # 新增 packages/coding 必须通过依赖方向检查
pnpm lint
```

补充：
- `packages/coding` 需有单测（truncate / path-policy / command-policy 是纯函数，优先覆盖；工具用 tmpdir 做端到端）。
- 权限拒绝路径必须返回结构化 `isError` 结果，不把原始异常泄漏到终端（Definition of Done 要求）。

## 8. 取舍记录（写进 ``）

- **为什么新建 `packages/coding` 而不是塞进 `packages/tools`**：金融工具域与编码工具域的生命周期、权限模型完全不同，混编会让 `createDefaultToolRegistry` 语义膨胀。
- **为什么不改 `agentLoop`**：内核是三端共用的稳定契约，编码能力与金融能力只是注册表与提示词差异——这是「运输层/组合根可替换」的硬证据。
- **为什么 grep/find 先走 Node 原生**：避免 `ensureTool` 下载二进制的网络与环境依赖，先保证零安装可跑。
- **为什么权限放在 `beforeToolCall` 而不是工具内部**：权限是组合根策略，工具只负责能力；换 CLI/换 API 时策略可整体替换。

## 9. 落地后需同步的文档

- `docs/v1.3/README.md`：状态表勾选已完成阶段。
- ``（新建）：技术重点、实现流、取舍、验证、学习检查点。
- `设计演进记录`：新增阶段产出与验收证据。
- `ARCHITECTURE.md`：packages/apps 列表补 `packages/coding` 与依赖方向。
- `apps/ohna-cli/src/cli/args.ts` 的 `--help` 文案与 README（CLI 参数面变动时同步）。