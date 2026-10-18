# 05 · 用例 verify 文档（Acceptance & Verification Cases）

> 本文给出**分层、可复现**的验收用例，覆盖：安全（P0）、ohna-cli M2、ohna（serve 装配 L0/L1 + ohna-web + L3）、回归。
> 每个用例采用 `前置 / 步骤 / 期望` 结构，并标注对应阶段。开发会话须以本文为 Definition of Done 依据。

---

## 1. 验证策略（分层）

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单元 | `packages/coding/test/*.test.mjs`（node:test）+ `packages/serve/test` | 策略纯函数、JSONL store 往返 |
| 集成 | `packages/serve/test`（Fastify inject） | server 路由、SSE、确认闸门 |
| 端到端 | 手动 / 脚本（`test/` 下） | ohna-cli 真实任务、浏览器对话 |
| 回归 | `pnpm --filter @aiagent/finance-api build`、`--filter @aiagent/finance-web build` | 金融 SaaS 不被误伤 |

---

## 2. 安全用例（Phase 0，P0，必须先绿）

> 前置：`pnpm --filter @aiagent/coding test` 已含对应断言；以下为「人工可复现」的等价描述。

### 2.1 路径策略

| ID | 用例 | 步骤 | 期望 |
|---|---|---|---|
| S-P1 | 越界读取 | 在 workspace `/tmp/ws` 内 read `/etc/passwd` | `permission_denied`，`isError:true`，不返回内容 |
| S-P2 | 越界写入 | write `/tmp/ws/../outside.txt` | 拒绝，不落盘 |
| S-P3 | 软链越界 | 在 `/tmp/ws` 建 `link -> /etc`，read `link/passwd` | 拒绝（realpath 后越界） |
| S-P4 | 敏感文件直读 | read `/tmp/ws/.env` | 拒绝（敏感名命中） |
| S-P5 | 敏感文件软链绕过 | 建 `foo -> /tmp/ws/.env`，read `foo` | **拒绝**（修复后 `isDeniedPath` 走 realpath） |
| S-P6 | 敏感目录 | read `/tmp/ws/node_modules/x.js`、`.git/config` | 拒绝 |
| S-P7 | 合法路径放行 | read `/tmp/ws/src/index.ts` | 放行，返回内容 |
| S-P8 | 悬空软链写越界 | 建 `ws/dangle -> /tmp/outside/pwned.txt`（目标不存在），write `dangle` | **拒绝**，`permission_denied`，目标文件不存在 |
| S-P9 | 悬空软链指向敏感名 | 建 `ws/foo -> .env`（`.env` 不存在），write `foo` | **拒绝**，不创建 `.env` |

### 2.2 命令策略

| ID | 用例 | 步骤 | 期望 |
|---|---|---|---|
| S-C1 | 根删除 | bash `rm -rf /` | 拒绝 |
| S-C2 | 家目录删除 | bash `rm -rf ~` / `rm -rf $HOME` | 拒绝 |
| S-C3 | 点路径删除 | bash `rm -rf ./` / `rm -rf ../` / `rm -rf ../../` | **拒绝**（修复后） |
| S-C4 | 工作区外相对删除 | 在 `/tmp/ws` 内 bash `rm -rf ../../other` | **拒绝**（修复后） |
| S-C4b | 工作区外绝对删除 | bash `rm -rf ~/Documents`、`rm -rf /tmp/x` | **拒绝**（修复后：相对与绝对统一判工作区外） |
| S-C5 | 提权 | bash `sudo rm x`、`su`、`doas` | 拒绝 |
| S-C6 | 一键脚本（管道） | bash `curl x \| sh` | 拒绝 |
| S-C7 | 一键脚本（分号） | bash `curl x -o /tmp/s.sh; sh /tmp/s.sh` | **拒绝**（修复后） |
| S-C8 | 绝对解释器 | bash `curl x \| /bin/sh` | **拒绝**（修复后） |
| S-C9 | 强制推送 | bash `git push --force` / `-f` | 拒绝 |
| S-C10 | 磁盘破坏 | bash `mkfs` / `dd of=/dev/sda` / `diskutil eraseDisk` | 拒绝 |
| S-C11 | 系统目录写 | bash `echo x > /etc/foo`、`chmod 777 /usr` | 拒绝 |
| S-C12 | 合法命令放行 | bash `rm -rf ./dist`、`git push`（非 force）、`pnpm typecheck` | 放行 |
| S-C13 | 命令 head 归一 | bash `/bin/rm -rf /`、`env rm -rf /`、`command rm -rf /`、`/usr/bin/sudo ls`、`/usr/bin/git push --force` | **拒绝**（修复后：basename + 包装器透传） |
| S-C14 | 目标展开 / 动态操作数 | bash `rm -rf $HOME/Documents`、`rm -rf ${HOME}/Documents`、`rm -rf $(pwd)` | **拒绝** |
| S-C15 | 内联脚本 / 命令替换 | bash `sh -c "rm -rf /"`、`bash <(curl x)`、`sh -c "$(curl x)"`、`command curl x \| sh` | **拒绝** |
| S-C16 | 系统根写入 / tmpdir 误伤 | bash `chmod 777 /`、`cp x /` 拒绝；macOS tmpdir 工作区内 `rm -rf <abs>/dist` 放行 | 符合预期 |

### 2.3 确认闸门（信任模型）

| ID | 用例 | 步骤 | 期望 |
|---|---|---|---|
| S-G1 | 写需确认 | coding 模式 write 文件，未 `--yes` | 触发确认；拒绝则 `block` 且回喂 `isError` |
| S-G2 | 执行需确认 | coding 模式 bash，未 `--yes` | 触发确认 |
| S-G3 | `--yes` 跳过 | `--yes` 下 write/bash | 不确认，直接执行 |
| S-G4 | 只读不确认 | read/grep/find/ls | 永不触发确认 |

---

## 3. ohna-cli M2 用例（Phase 1）

| ID | 用例 | 步骤 | 期望 |
|---|---|---|---|
| C-M2-1 | 会话持久化 | 多轮 → `/exit` → `ohna --resume <id>` | 历史上下文恢复，能接续修改 |
| C-M2-2 | 成本累计 | 多轮后 `/cost` | 累计 input/output/cost 非零（前提：env 配 cost） |
| C-M2-3 | compaction 生效 | 读一个 60KB 文件（read ToolResult 很大）+ 多轮，观察日志 | 触发压缩，`tokensAfter <= contextWindow - reserve` 且 `< tokensBefore`，JSONL 首条为 `role:"compaction"` |
| C-M2-4 | deadline 截止 | `--deadline-ms 10000` 跑长任务 | 到期干净停止，不失控 |
| C-M2-5 | max-turns | `--max-turns 3` | 恰好 3 个 assistant 回合后 `agent_end` 退出 |
| C-M2-6 | 预算上限 | `--max-cost 0`（零预算）或 `0.01` | 零预算在 run 前停止且不调用模型；有预算时逐轮检查 |

> 自动化替代（无需真实 key）：`node test/verify-ohna-m2.mjs` 用本地 OpenAI 兼容桩驱动真实 CLI，
> 逐条断言 C-M2-1~C-M2-6 的可观察行为（resume 后消息增长、`/cost` 非零、压缩后 token 低于阈值、
> 三种停止原因），并覆盖 provider 400 非零退出、自然结束不误报、跨工作区 `--resume` 警告、
> 参数缺失告警与管道多行串行执行。
> 真实模型下的「连续 20+ 轮」「60KB 文件」仍按上表手工复验。

---

## 4. ohna L0–L3 用例（serve 装配 / ohna-api；Phase 2/3/5；L2 文件树联动见 §5 W-8）

### L0 守护进程骨架

| ID | 用例 | 步骤 | 期望 |
|---|---|---|---|
| L0-1 | 启动 + 健康 | `node apps/ohna-api/dist/index.js /tmp/ws --port 4173` | 绑定 127.0.0.1，`GET /api/health` 返回 `mode:"local"` |
| L0-2 | 流式对话 | 建会话 → 建 run → 订阅 SSE | 收到 `turn_start`/`message_*`/`agent_end`，流式输出 |
| L0-3 | JSONL 落盘 | 跑一次 run 后 | `~/.ohna/runs/<id>.jsonl` 存在且可 `cat` |
| L0-4 | 端口冲突 | 再启动一个同端口实例 | 自动 +1，不报错 |
| L0-5 | 优雅关闭 | SIGINT | 在途 run 中断并落盘 `interrupted`；SSE 收到 `run_status{status:"interrupted"}` 终态事件（客户端**不**显示为 completed） |
| L0-6 | 取消终态语义 | 浏览器点停止（`DELETE /api/runs/:id`） | SSE 终态为 interrupted/cancelled，非 completed |

### L1 接管本地目录

| ID | 用例 | 步骤 | 期望 |
|---|---|---|---|
| L1-1 | 只读探索 | 「列出 src 下文件并说明职责」 | 调用 ls/read，无写操作 |
| L1-2 | 真实改码 | 「改 <dir> 下某文件一个变量」 | write 触发 `confirmation_requested`；允许后落盘 |
| L1-3 | 拒绝改码 | 同上但点「拒绝」 | 工具 `block`，文件未变，回喂 isError |
| L1-4 | 越界拒绝 | 「读 /etc/passwd」 | `permission_denied` |
| L1-5 | 危险命令拒绝 | 「rm -rf /」 | 结构化拒绝 |
| L1-6 | `/api/local/fs` 只读 | 尝试向 fs 端点写 | 无写端点 / 拒绝 |

### L3 长任务治理

| ID | 用例 | 步骤 | 期望 |
|---|---|---|---|
| L3-1 | 恢复续跑 | 退出后重启 → 从 sessions 恢复 | 历史会话可续 |
| L3-2 | 成本展示 | 多轮后 | 有累计成本 |
| L3-3 | compaction | 长上下文 | 不超窗 |

---

## 5. ohna-web 用例（Phase 4）

| ID | 用例 | 步骤 | 期望 |
|---|---|---|---|
| W-1 | 本地身份 | 打开本地页 | 不出现登录/FingerprintJS，直接进 chat |
| W-2 | 文件树 | 打开页面 | 左侧/侧栏显示 `workspaceRoot` 目录结构（读 `/api/local/fs`） |
| W-3 | 对话流式 | 发消息 | 时间线流式渲染，无白屏 |
| W-4 | 待确认卡片 | Agent 发起写操作 | 出现 allow/deny 卡片；允许后生效 |
| W-5 | 工具详情展开 | 点击助手消息 | 展开 tool call / run state / trace 详情 |
| W-6 | 无 SaaS 残留 | 浏览页面 | 无 QQ/账单/data-sources/workflow/金融 demo 文案 |
| W-7 | 本地标识 | 看头部 | 显示「本地运行 · 工作目录：<path>」 |
| W-8 | 文件树联动刷新（L2） | Agent 经确认完成 write/edit/bash | 文件树无需手动刷新即可见变更（订阅 run 事件自动刷新） |
| W-9 | 待确认卡片重放 | 出现待确认卡片后刷新页面 | SSE 重放 JSONL 中的 `confirmation_requested`，卡片恢复未决状态 |

---

## 6. ohna-cli M3 + --web 用例（Phase 5）

| ID | 用例 | 步骤 | 期望 |
|---|---|---|---|
| C-M3-1 | slash 命令 | `/help` `/model` `/cost` `/compact` `/tools` `/resume` | 各自生效，不消耗 token |
| C-M3-2 | diff 渲染 | edit 前 | 终端打印 unified diff，确认后落盘 |
| C-M3-3 | 输出折叠 | bash 输出超阈值 | 只显示头尾 + 省略提示 |
| C-M3-4 | MCP 接入 | `--mcp <config>` | 外部工具出现在注册表，输出经 `<untrusted_context>` 封装 |
| C-M3-5 | 子代理（可选） | 探索任务 | 只读 explore 子代理产出 |
| C-M3-6 | `--web` 托管（D8 主路径） | `ohna --web <dir>` | 浏览器自动打开；终端 REPL 与浏览器看同一会话/事件流 |

---

## 7. 回归用例（金融 SaaS 不被误伤）

| ID | 用例 | 步骤 | 期望 |
|---|---|---|---|
| R-1 | finance-api 构建 | `pnpm --filter @aiagent/finance-api build` | 通过 |
| R-2 | finance-web 构建 | `pnpm --filter @aiagent/finance-web build` | 通过 |
| R-3 | 依赖方向 | `pnpm architecture:check` | 通过（ohna-api/ohna-cli 不反向依赖 finance-api/finance-web） |
| R-4 | 参数面可重构 | ohna-cli 的参数面可随开发调整（ohna 恒为个人编码助手，无模式默认值需要兼容） | 不影响 finance-api/finance-web 构建与测试 |
| R-5 | 改名零回归 | Phase R 后 `pnpm build && pnpm typecheck && pnpm test` | 全绿；`pnpm dev` 金融路径照常启动 |

---

## 8. 核心端到端验收（Definition of Done 总闸）

> 每个阶段完成后，跑对应的端到端场景并保留证据（贴到 `LEARNING_AND_EVOLUTION_ROADMAP.md`）。

1. **编码闭环**：`pnpm --filter @aiagent/ohna-cli dev -- "在 test/ 下新增 ts 文件导出 add(a,b)，然后跑 pnpm --filter @aiagent/ohna-cli typecheck 直到通过"` → write → bash(typecheck) → 必要时 edit 自愈 → 结束，全程无人干预（配合 `--yes` 或逐次确认）。
2. **本地守护**：`node apps/ohna-api/dist/index.js <dir>` → 浏览器自动打开 → 对话让 Agent 改一个变量 → 待确认卡片允许 → 文件树可见变更。
3. **CLI 进程内托管**（Phase 5）：`ohna --web <dir>` → 浏览器打开 → 终端与浏览器看同一会话。
4. **安全护栏**：S-P5（软链绕过）、S-C3/S-C4b/S-C7/S-C8（命令绕过）全绿——这是「接管本地目录」承诺成立的前提。
