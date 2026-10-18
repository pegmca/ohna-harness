# 02 · 本地 Web 运行时（Local Web Runtime）设计方案

> 本文是 `docs/v1.3/README.md`（编码型 CLI 改造）的延伸：把「在终端里跑的编码 Agent CLI（M1）」升级为「跑在用户本机、接管本地目录、并启动一个本地 Web 服务，让人不在终端里对话也能干活」的本地 Agent 运行时——也就是 CodeBuddy CLI / Claude Code 那种**本地守护进程**模式。
> 状态：**设计稿（未实现）**。落地切片遵循 `LEARNING_AND_EVOLUTION_ROADMAP.md` §3 七步法与 Definition of Done。
> 工具能力底座（`packages/coding` 的 read/write/edit/bash/grep/find/ls + 沙箱策略）由 `01-coding-cli.md` 的 M1 负责，不在本文重复；本文只解决「本地 Web 运行时 / 守护进程」这一层。

## 0. 目标与定位（一句话）

> 让同一个 `agentLoop` 内核，除了在终端（`apps/cli`）和云端 SaaS（`apps/api`）跑之外，还能**在本机作为一个守护进程跑**：拥有（own）一个本地工作目录、绑定 `127.0.0.1` 启动 Web 服务、自动打开浏览器，用户在网页里对话，Agent 直接改本地文件、跑本地命令。

产品动机：当前 `apps/web` 更像一个 SaaS 金融助手；而「本地优先」的 Agent（CodeBuddy CLI / Claude Code / Codex）都是用户侧有一个常驻程序，既能在终端用，也能在它拉起的本地网页里用。我们要让项目具备后一种形态，**且不与现有 SaaS 路径冲突**。

## 1. 为什么现在就能做（复用基线，不重写内核）

| 已具备能力 | 位置 | 对本地运行时的意义 |
|---|---|---|
| 纯函数 `agentLoop` 三端共用、运输层可替换 | `packages/agent` | CLI / API 已证明「换组合根不动内核」 |
| `createApiServer(options)` 是**端口注入式** | `apps/api/src/index.ts:113` | `tools`/`runStore`/`conversationRepository`/`messageStore`/`eventBus`/`requireIdentity` 全是参数；可整份复用 transport 契约 |
| Web 客户端只依赖 `@aiagent/types` DTO | `apps/web/src/shared/api/*` | 后端换 JSONL 存储、换工具注册表，Web **零改动** |
| `packages/coding` 提供文件/命令工具 + 沙箱 | `01-coding-cli.md` M1（规划/进行中） | 「接管本地目录」的能力底座，本地运行时只负责把 `workspaceRoot` 注入它 |
| `JsonlMemoryStore` 先例 + `RunEvent` 天生 append-only | `packages/memory`、`packages/trace` | 本地存储选 JSONL 水到渠成（见 §5） |
| 无 `DATABASE_URL` 时 RAG 向量库自动退内存 | `createVectorStoreFromEnv` | 本地运行时无需 Postgres 也能跑 RAG 检索 |

**结论**：本地运行时 = `createApiServer` 复用 + JSONL 端口实现 + coding 工具注册表 + `127.0.0.1` 绑定 + 静态托管 Web。内核零改动。

## 2. 目标形态

```
┌─ 用户本机 ──────────────────────────────────────────┐
│  aiagent-local 守护进程 (Node, 仅 127.0.0.1:PORT)     │
│   ├─ 静态托管 apps/web/dist  ──► 浏览器自动打开        │
│   ├─ HTTP/SSE API (复用 createApiServer 契约, 无鉴权)  │
│   ├─ agentLoop 内核 (不变)                            │
│   ├─ 工具注册表 = packages/coding (fs/bash/grep...)   │
│   │     + WorkspaceRoot 沙箱 (path/command-policy)     │
│   ├─ 本地存储 = JSONL 端口实现 (无 PG / 无 Redis)      │
│   └─ eventBus = 进程内内存                            │
└───────────────────┬──────────────────────────────────┘
                    │ 拥有并读写
              ~/your-project  (工作目录 / workspaceRoot)
```

用户运行 `aiagent-local [dir]` → 进程启动、绑定 localhost、打印并打开 `http://127.0.0.1:PORT` → 在网页里像用 SaaS 一样对话，Agent 实际在 `dir` 里读写文件、跑命令。

## 3. 新增组合根 `apps/local`

### 3.1 为什么不是改 `apps/api`
`apps/api/src/server.ts` 是**生产**组合根：PostgreSQL + Redis + 多租户 + 鉴权 + QQ channel。`apps/local` 是**单机、单用户、零基础设施**的第三个组合根，与 SaaS 路径**并存**——共享内核与 `createApiServer` transport，仅装配不同。这是「运输层/组合根可替换」的硬证据，不破坏现有云端部署。

### 3.2 `apps/local/src/index.ts` 职责（只做进程生命周期 + 装配）
直接复用 `createApiServer`，注入本地端口：

```ts
const app = createApiServer({
  modelRegistry,                       // 复用本地配置的 LLM profile（同 apps/api 的读取逻辑）
  tools: createCodingToolRegistry({ workspaceRoot }),  // 来自 packages/coding，注入沙箱根
  identityService: createLocalIdentityService(),       // 固定本地主体 "local-user"，无登录
  requireIdentity: false,              // 单用户本机，跳过鉴权
  runStore: jsonlRunStore,            // §5 JSONL 实现
  conversationRepository: jsonlConversationRepository,
  messageStore: jsonlMessageStore,
  eventBus: undefined,                // 默认进程内内存总线
  executionRegistry: createInMemoryExecutionRegistry(),
  // 其余端口（RAG/附件/artifact）按本地可用度注入；
  // RAG 无 DATABASE_URL 时自动退内存向量，检索仍可用
});
```

- **绑定**：`host = 127.0.0.1`（仅本机），`port` 可配，启动探测占用端口自动 +1。
- **打开浏览器**：启动后 `open(http://127.0.0.1:PORT)`；macOS/Linux/Windows 各用对应命令。
- **工作目录**：`aiagent-local [dir]` 的 `dir`（缺省 `cwd`）即 `workspaceRoot`，传给 coding 注册表。
- **静态托管**：注册一个 Fastify 静态插件 serve `apps/web/dist` + SPA fallback（`*` → index.html）。dev 模式下可改为反向代理 Vite dev server，避免每次改 UI 重 build。

### 3.3 本地身份（最小）
`createLocalIdentityService()` 返回一个始终返回固定 `local-user` 的桩实现，满足 `createApiServer` 的 `identityService` 端口形态；不签发 cookie、不做指纹。未来若需多本地会话隔离，再扩展。

## 4. 目录沙箱（WorkspaceRoot）

复用 `packages/coding` 的两条策略（M1 已规划），本地运行时只负责把 `workspaceRoot` 传进去：

- **路径策略 `path-policy.ts`**：所有读写 `realpath` 后必须落在 `workspaceRoot` 内；拒绝 `.env`、`*.pem`、`.git/*`、`node_modules` 等敏感/噪声路径。越界返回结构化 `isError`，不抛裸异常。
- **命令策略 `command-policy.ts`**：`rm -rf /`、`sudo`、`curl|sh`、`git push --force`、`mkfs`、写 `/etc` 等进入 denylist，结构化拒绝。
- **写/执行确认**：默认写文件、执行命令需确认（`--yes` 跳过，对应 M1 的终端确认在 Web 下改为「待确认」卡片，用户在网页点允许/拒绝）。
- **RAG**：本地无 PG，向量库走内存回退（`createVectorStoreFromEnv` 已有此逻辑）；后续如需跨会话持久化向量，再在 JSONL 方案上加一个本地 sqlite 向量（属 §5 的「升级触发条件」）。

## 5. 本地存储（JSONL 为主 — 回应你的选择）

**结论：JSONL 是合理的首选，我建议采用。** 理由：

1. **与既有数据流同构**：你的 canonical `RunEvent` 流本身就是 append-only；Claude Code / Codex 也都用 JSONL 落盘， precedent 一致。
2. **零依赖、零基础设施**：不需要 Postgres/Redis，单文件即可，符合「本地优先、开机即跑」。
3. **人类可读、利于学习调试**：本项目定位是学习/演示，JSONL 能直接 `cat`/git 跟踪，比二进制库更友好。
4. **复用现有先例**：`@aiagent/memory` 已有 `JsonlMemoryStore`，落地心智一致。

### 5.1 目录布局（建议放在 workspace 内 `.aiagent/` 或 `~/.aiagent-local/`）
```
.aiagent/
  runs/<runId>.jsonl            # 追加写 canonical RunEvent（复用 trace 契约 + run-v2 信封）
  conversations/<convId>.jsonl  # 追加写 Message（复用 conversation DTO）
  sessions/index.jsonl          # 轻量元数据：id / 标题 / 创建时间 / 最后活跃（用于列表/恢复）
  tool_results/<id>.jsonl       # 可选，复用 toolResultStore 端口（写类工具结果持久化）
```
- 每个文件都是**纯追加**；事件顺序由 `run_events` 既有的连续序号保证（与 `apps/api` 的 `RunStore` 语义对齐，只是存储介质换成文件）。
- 启动时从 `sessions/index.jsonl` + 各 `*.jsonl` 重建内存读模型（列表、续跑、成本汇总）；单用户单机，重建成本可忽略。

### 5.2 何时才需要 SQLite（明确升级触发条件，避免提前过度设计）
JSONL 的弱点是「跨全部历史做即席查询 / 全文检索」是 O(n) 扫描。仅当出现以下**具体需求**之一时，再引入 `better-sqlite3` 作为读模型（写仍是 JSONL，或迁移到 sqlite）：
- 需要跨所有历史 run 做全文检索（搜「上周改过哪个文件」）；
- 本地 RAG 向量需要持久化而非每次内存重建；
- 会话量增长到数千级导致启动重建变慢。
在此之前，**JSONL + 内存索引**足够，且最简单。

## 6. Web UI 本地模式（最小改动）

- 现有 chat UI（左会话列表 / 中时间线 / 底 composer）已可直接连本地 API，**传输契约不变、无需重写**。
- 本地只需补两件事：
  1. **工作目录文件树面板**（只读浏览 `workspaceRoot`）：新增一个只读端点 `/api/local/fs`（list/tree/read），UI 用它展示目录结构；**只读展示，写仍只走 Agent 工具**（避免绕过沙箱策略）。
  2. **模式开关**：通过运行期 `/api/health` 或构建期 `VITE_LOCAL` 暴露 `mode: "local" | "saas"`，隐藏 SaaS 专属区块（登录、多租户、用量账单），并显示「本地运行 · 工作目录：<path>」标识。
- 不做大改版：本地形态首先是「能用的 SaaS 网页 + 文件树 + 本地标识」，而不是另起一套 UI。

## 7. 与 SaaS 路径共存

| 维度 | `apps/api`（云端 SaaS） | `apps/local`（本机） |
|---|---|---|
| 存储 | PostgreSQL + Redis | JSONL + 内存 |
| 鉴权 | 多租户、cookie、指纹 | 无（`local-user` 固定） |
| 工具注册表 | 金融 `createDefaultToolRegistry` | `packages/coding` fs/命令工具 |
| 绑定 | `0.0.0.0` | `127.0.0.1` |
| Web | 部署的 `apps/web` | 本地守护进程自带 serve `dist` |
| 内核 | 同一个 `agentLoop` | 同一个 `agentLoop` |

两路共享 `createApiServer` 契约与 `@aiagent/types` DTO，差异**只在组合根装配**。这是正确的演进，不是分叉。

## 8. 分阶段落地（建议顺序，每阶段可独立验收）

| 阶段 | 目标 | 主要交付 | 完成判据（可人工复现） |
|---|---|---|---|
| **L0** | 本地守护进程骨架跑通浏览器对话 | `apps/local` 组合根 + JSONL 端口 + `createApiServer` 复用 + 静态托管 + 自动开浏览器（先用 default/financial 工具） | 终端运行 `aiagent-local`，浏览器自动打开，能发消息收到流式回复 |
| **L1** | 接管本地目录 | 注入 `packages/coding` 注册表 + `workspaceRoot` 沙箱（path/command-policy） | 让本地 Agent「读取 <dir> 下某文件并改一个变量」，路径越界/危险命令被拒 |
| **L2** | 本地 Web 工作区 | 文件树面板 + 本地模式开关（`/api/local/fs`、`VITE_LOCAL`） | 网页能看到工作目录结构，对话中 Agent 的写操作在文件树可见 |
| **L3** | 长任务治理 | JSONL `/resume` 恢复、compaction 挂载、预算/成本展示 | 退出后重启能续跑；连续 20+ 轮不丢上下文、成本可见 |

L0 甚至不依赖 `packages/coding`——先验证「终端之外用浏览器对话」的闭环，再接文件工具，风险最低。

## 9. 风险与对策

- **误写 / 误执行**：coding 的 path/command policy 已覆盖；Web 下写/执行改为「待确认卡片」，用户在网页点允许/拒绝；`--yes` 才跳过（与 M1 终端确认语义一致）。
- **端口冲突 / 多实例**：启动时探测端口占用自动 +1；可写 pid 锁文件避免同目录双开。
- **浏览器安全面**：仅绑定 `127.0.0.1`；若用户显式 `--host 0.0.0.0` 想从同网其他设备访问，需在启动日志明确提示「已暴露到局域网」风险。
- **数据诚实**：本地用 coding 工具替换金融工具，不存在「伪造行情数据」问题（原 `DATA HONESTY` 约束针对 SaaS 金融路径，本地路径天然不涉及）。
- **依赖方向**：`apps/local` 不得反向依赖 `apps/api` 的领域逻辑；只依赖 `createApiServer`（运输层）、各包端口与 `packages/coding`。需通过 `pnpm architecture:check`。

## 10. 文档同步清单（实现时一并处理）

- 本文：`docs/v1.3/02-local-web-runtime.md`（新建）。
- `ARCHITECTURE.md`：`apps` 列表补 `apps/local` 与依赖方向；说明第三个组合根与 SaaS 并存。
- `docs/v1.3/README.md`：状态表补 L0–L3 阶段。
- `LEARNING_AND_EVOLUTION_ROADMAP.md`：新增阶段产出与验收证据。
- ``（新建）：技术重点、实现流、取舍、验证、学习检查点。
- `BUSINESS_DIRECTION_FINANCIAL_RESEARCH_AGENT.md`：若产品方向正式加入「本地优先」形态，补一段说明（视你的方向决策而定，本文不擅自改业务定位）。

## 11. 与 `01-coding-cli.md` 的分工（避免重复造轮子）

- `01-coding-cli.md` M1：负责**能力**（fs/命令工具 + 沙箱 + 项目上下文），归属 `packages/coding` 与 `apps/cli`。
- 本文：负责**形态**（本地守护进程 + Web 服务 + JSONL 存储 + 目录沙箱装配 + Web 本地模式），归属 `apps/local` 与 `apps/web` 的小幅扩展。
- 二者通过 `createCodingToolRegistry({ workspaceRoot })` 这一端口衔接：CLI 把 `cwd` 当根，本地运行时把 `--dir` 当根，工具与策略完全复用。
