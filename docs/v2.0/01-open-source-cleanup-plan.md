# v2.0 · 开源清洗与仓库迁移方案

> 目标：把 `pegmca/aiagent` 清洗为可开源的 `ohna-harness`，彻底移除「学习 / 技术表达 / 履历」痕迹（**含全部历史 commit 的 blob 与 message**），
> `notes/` 整体迁出至 `~/code/ohna-note/`，原仓库删除。
> 范围决策：**双产品线全保留**；**保留清洗后的技术演进历史**（182 → 约 178，prune 空 commit 后）；新仓库 `ohna-harness`。
> 状态：**方案设计稿，未改动任何代码与 git 历史。**
> 本方案的 14 项技术结论（工具安装、回调写法、正则边界、验收命令）**均已在临时仓库实跑验证**，见 §8。

---

## 0. 现状盘点（设计依据，全部经实测）

| 项 | 数值 / 结论 |
|---|---|
| 总 commit | 182（master）；含远端分支共 191 |
| tracked 文件 | 770（其中 `.ts/.tsx` 418，`.md` 104 / 18476 行） |
| 含「技术表达 / 履历」正文的文件 | 36 |
| 含「学习笔记 / 学习检查点」正文的文件 | 30 |
| `notes/` | 45 文件 / 5833 行，**tracked** |
| `docs/` | 53 文件（v1.1 13 / v1.2 8 / v1.3 8 / v1.4 2 / worktree 9） |
| 历史中出现过、HEAD 已删除的路径 | 255 个（含 `resume/*` 3、`docs/implementation/*` 29、`docs/weeks/*` 9、`docs/worktree/PR-*` 16） |
| commit 作者邮箱 | 3 个（`1070826775@qq.com` 100 / `pegmca@macos.local` 61 / noreply 21） |
| 敏感 commit message | 8 条（含 `docs(resume): 新增履历与技术表达答辩手册`） |
| tag | 无 |
| LICENSE | **缺失** |
| **历史密钥泄露** | **未发现**（`.env` 从未入库；无 `sk-` 明文；`.env.example` 全为占位符） |

### 0.1 关键发现（决定方案形状）

1. **`resume/` 目录只有 3 个文件、且 HEAD 已删除**——但 `c4e9338`（新增）与 `d36a9fc`（删除）两条 commit 的 blob 仍在历史里，
   且这两个文件现已存在于 `~/code/ohna-note/resume/`（说明当时是「移出仓库」而非「丢弃」）。
   → **必须按历史 blob 清洗，不能只删 HEAD 文件。**
2. **`notes/` 45 个文件被 86 个 commit 触碰过，但只有 4 个 commit 是「只改待移除路径」**（`e73ff92` / `96d7724` / `a3f69ad` / `049cfd2`）。
   → 单纯 `--path notes/ --invert-paths` 只会 prune 这 4 条，剩下 86 条 commit 的 **blob 仍带着 `notes/*` 的文件条目**，会被考古。
   → **必须「路径剔除」+「历史 blob 按内容清洗」双管齐下**。
3. **代码注释里有 3 处「技术表达叙事」字样**（`packages/agent/src/team/presets.ts:53`、`team/slo.ts:5`、`packages/trace/src/index.ts:285`），
   另有 **7 处源码注释引用 `notes/*.md`**（如 `packages/agent/src/permission/policy.ts:68`）。
   → 迁走 `notes/` 后这些注释会变成**死链接**，必须改写（详见 §3.3）。
4. **源码含第三方参考声明**：`apps/ohna-cli/src/ui/tui/*` 与 `packages/coding/src/**` 多处注释说明设计参考了 pi / opencode（MIT）；均为自主实现，仅依 MIT 许可证致谢，并非逐字移植。
   → 开源前**必须补 LICENSE**，否则法律上不可发布。
5. **个人绝对路径 `<HOME>/...`** 出现在 18 个文件（含 `.vscode/launch.json` 与 13 个文档）。
   → 非学习类，但属于隐私泄露面，应一并清洗为相对/示例路径。
6. **`.env.example:44` 暴露自托管 LLM 的真实公网 IP** `http://43.130.49.34:8787/v1`。
   → 应改为占位域名。
7. **4 个 `stage5/*` 远端分支均未合入 master**（`NOT-MERGED`），是 PR 遗留分支。
   → 开源仓库不需要，剔除即可（内容已含在 master 的 squash commit 中）。
8. `.agents/skills/` 与 `.claude/skills/` 为 **superpowers 第三方 skill（MIT）**，当前**未 tracked**，但含 `LICENSE-superpowers-MIT` 与 `SUPERPOWERS-SOURCE.txt`。
   → 决定是否入库；若入库需在 NOTICE 中声明。

---

## 1. 目标仓库形态

### 1.1 新建 `ohna-harness`

- 推送清洗后的历史；`master` 为默认分支。
- 原 `pegmca/aiagent` **直接删除**（GitHub Settings → Danger Zone → Delete）。
  - ⚠️ 删除前确认：无未合入的 PR、无 issue 引用需要保留的内容、4 个 `stage5/*` 分支无需留存。
  - ⚠️ 建议删除前先在 GitHub 建一个 **私有 fork 或本地 bare 镜像**作为 7 天冷静期备份（见 §5 步骤 0）。

### 1.2 保留范围（双产品线全保留）

```
apps/       finance-api, finance-web, ohna-api, ohna-cli, ohna-web   ← 全保留
packages/   agent ai channels coding conversation database eval identity
            mcp memory parsing rag report security serve term tools trace
            types workflow                                            ← 全保留
docs/       仅保留「设计 / 方案 / 决策 / 验收」类（见 §2.2 保留清单）
test/ datasets/ deploy/ .github/ DESIGN.md system.css ARCHITECTURE.md ← 全保留
notes/      ❌ 整体移出
```

---

## 2. 内容处置清单

### 2.1 整体移出（→ `~/code/ohna-note/`）

| 源 | 规模 | 去向 |
|---|---|---|
| `notes/`（全部 45 文件） | 5833 行 | `ohna-note/notes/` |
| `docs/v1.2/interview/`（3 文件） | 115 行 | `ohna-note/interview/` |
| `docs/ROADMAP_1_MONTH.md` | 291 行 | `ohna-note/roadmap-1-month.md` |
| `docs/LEARNING_AND_EVOLUTION_ROADMAP.md` | 615 行 | `ohna-note/learning-roadmap.md` |
| `docs/v1.1/LEARNING_PATH.md` | 78 行 | `ohna-note/learning-path-v1.1.md` |
| `docs/v1.2/03-frontier-interview-sprint.md` | 214 行 | `ohna-note/interview/` |
| `docs/v1.2/01-agent-engineering-philosophy.md` | — | `ohna-note/interview/`（整篇以技术表达 ROI 为标尺） |
| `docs/v1.2/02-harness-engineering-philosophy.md` | — | `ohna-note/interview/`（同上） |
| `resume/*`（仅存于历史） | 848 行 | 已在 `ohna-note/resume/`，仓库侧纯删除 |
| `docs/implementation/*`、`docs/weeks/*`、`docs/WEEK_*.md`（仅存于历史） | — | 无需迁出（已被 v1.1 文档取代），仓库侧纯删除 |

> `ohna-note` 当前**非 git 仓库**。建议 `git init` 并做一次初始 commit，避免这批技术表达素材无版本管理。

### 2.2 保留但需改写（`docs/` 内的设计 / 方案类）

保留理由：这些是**真实的技术设计与决策记录**，对开源仓库有价值；只需剥离「技术表达表达」章节与学习口径。

| 文件 | 处置 |
|---|---|
| `docs/v1.1/01~06*.md`（含 `-reading.md` 5 篇） | 删除末尾「§N 技术表达表达要点」章节；删除内部「可技术表达 / 技术表达叙事」字样。`-reading` 系列保留（是代码带读，非学习流水账） |
| `docs/BUSINESS_DIRECTION_FINANCIAL_RESEARCH_AGENT.md` | 删除 `## 11. 技术表达表达`（290 行起至 EOF） |
| `docs/IMMERSIVE_PRODUCT_DESIGN.md` | 1 处命中，改写措辞 |
| `docs/v1.2/04-cli-harness.md` | ✅ **原样保留**（0 处技术表达命中，是方案归档） |
| `docs/v1.3/*`（01/02/03/04/05/06/07） | ✅ **原样保留**（0 处命中） |
| `docs/v1.4/*` | ✅ 原样保留 |
| `docs/worktree/*`（01~08） | ✅ 保留，仅替换 `<OLD_BADLOGIC_PATH>` → 公开仓库 URL |
| `docs/decisions/*`（ADR 3 篇） | ✅ 原样保留 |
| `docs/SECURITY_THREAT_MODEL.md` / `AI_CODING.md` / `CODEBUDDY_CLI_TOOLS.md` / `docs/eval/*` | ✅ 原样保留 |
| `README.md` | **重写**（见 §4.1） |
| `AGENTS.md` | **改写**：移除 `notes/` 交付物约束与学习路线引用（见 §4.2） |

### 2.3 代码侧改写（7 + 3 处）

- **7 处 `notes/*.md` 注释引用** → 改为「设计决策内聚在代码注释 / `docs/`」或直接删除引用句：
  - `apps/ohna-cli/src/session/session-runtime.ts:9`
  - `apps/ohna-web/src/features/workbench/confirmations.ts:4`
  - `packages/agent/src/permission/policy.ts:68`
  - `packages/agent/src/team/controller.ts:300`
  - `packages/agent/src/team/tools.ts:11`、`:83`
  - `packages/report/src/report-tool.ts:379`
- **3 处「技术表达叙事」措辞** → 改为「可观测性证据 / 成本护栏收益」等工程口径：
  - `packages/agent/src/team/presets.ts:53`
  - `packages/agent/src/team/slo.ts:5`
  - `packages/trace/src/index.ts:285`

### 2.4 隐私 / 合规清洗

| 项 | 处置 |
|---|---|
| `.env.example:44` 真实 IP `43.130.49.34:8787` | → `https://your-llm-endpoint.example.com/v1` |
| 18 个文件的 `<HOME>/...` 绝对路径 | → 相对路径 / 公开仓库 URL / 通用示例路径 |
| `.vscode/launch.json` 的 `<HOME>/.nvm/...` | → `node` 交给 PATH，或改 `${workspaceFolder}` 相对写法 |
| commit 作者邮箱（3 个） | `--email-callback` 统一为单一 noreply 邮箱；`-qq.com` 尤其应替换（实名邮箱） |
| `.env`（本地真实密钥） | 已 gitignore，确认未入库 ✅ |
| `.ccmanager.json`（含 codex/kimi preset） | 建议删除或 gitignore（个人工具配置，对开源无意义） |
| `.agents/skills/` + `.claude/skills/` | 建议 **不入库**（加入 `.gitignore`），避免第三方 superpowers skill 混入；若保留需在 NOTICE 声明 MIT |
| llm-trace 未提交改动（6 文件） | ⚠️ filter-repo 前必须处理：建议单独 commit 为「feat(trace): llm_call 观测事件」或 stash |

### 2.5 新增文件（开源必备）

| 文件 | 内容 |
|---|---|
| `LICENSE` | 主许可证（建议 MIT；或 Apache-2.0 若顾虑专利） |
| ~~`THIRD-PARTY-NOTICES.md`~~ | 原方案计划新增的第三方致谢文件；最终未随仓发布 |
| `.github/ISSUE_TEMPLATE/`、`PULL_REQUEST_TEMPLATE.md` | 可选，但显著提升开源观感 |
| `CONTRIBUTING.md` | 可选 |

---

## 3. Git 历史重写方案（核心）

### 3.1 工具选型：`git-filter-repo`（**已实测验证**）

- `git filter-branch` 官方已废弃，慢且易出错（本仓 182 commit / 770 文件规模下风险高）。
- `git-filter-repo` 本机**未安装**。⚠️ **`pip3 install git-filter-repo` 会被 PEP 668 拦截**（`externally-managed-environment`），
  实测报错需 `--break-system-packages`。→ **必须走 venv**（见下方命令）。
- 以下结论均已**在临时仓库实测通过**（非读源码推断）：

| 能力 | 实测结论 |
|---|---|
| `--invert-paths --paths-from-file` | ✅ 按路径剔除生效 |
| `--prune-empty`（默认 auto） | ✅ 剔除后变空的 commit 自动 prune |
| `--replace-text` | ✅ 字面量 `literal:` + `==>` 替换生效；⚠️ **对所有 blob 生效，无法限定文件范围** |
| `--replace-message` | ✅ commit message 替换生效 |
| `--email-callback` / `--name-callback` | ✅ 必须写成 `return b"..."`（bytes）；生效 |
| **`--blob-callback` 写法** | ⚠️ **文件内容被当作函数体包进 `def callback(blob):`**，所以脚本里**不能写 `def run(blob, metadata):`**（那样只是定义嵌套函数、永不被调用）。<br>✅ 正确写法：脚本直接是**顶层语句**，用 `blob.data` 读写，**且不能带 `return`**（源码对 blob 豁免 return 检查）。<br>✅ 回调内**可直接用 `re`**（`public_globals` 已含），且**自带 `re.MULTILINE` 能力**（自己 `re.compile(..., re.MULTILINE)` 即可）。 |
| `--replace-text` 的 regex | ⚠️ 内部是 `re.compile(regex)` **无 flags**，不能跨行锚定 → 跨行删除**必须走 `--blob-callback`** 而非 `--replace-text` |

### 3.2 单命令重写（推荐 —— 实测可行，无需分阶段）

> 实测结论：路径剔除、空 commit prune、message 改写、邮箱统一、blob 内容清洗
> **可在一条 filter-repo 命令里同时完成**，初稿的「两阶段拆分」是多余的。

```bash
# 0) 备份（不可省）
git clone --mirror git@github.com:pegmca/aiagent.git /tmp/aiagent-mirror.git
cp -R ./aiagent /tmp/aiagent-worktree-backup

# 1) 安装工具（走 venv，绕过 PEP 668）
python3 -m venv /tmp/gfrvenv
/tmp/gfrvenv/bin/pip install -q git-filter-repo
export PATH=/tmp/gfrvenv/bin:$PATH

# 2) 路径剔除规则（--invert-paths → 这些路径整体消失）
cat > /tmp/paths.txt <<'EOF'
notes/
docs/v1.2/interview/
docs/ROADMAP_1_MONTH.md
docs/LEARNING_AND_EVOLUTION_ROADMAP.md
docs/v1.1/LEARNING_PATH.md
docs/v1.2/03-frontier-interview-sprint.md
docs/v1.2/01-agent-engineering-philosophy.md
docs/v1.2/02-harness-engineering-philosophy.md
resume/
docs/implementation/
docs/weeks/
docs/WEEK_1_AGENT_FOUNDATION.md
docs/WEEK_2_RAG_KNOWLEDGE_BASE.md
docs/WEEK_3_AGENTIC_RAG_WORKFLOW_MCP.md
docs/WEEK_4_PRODUCTION_AND_INTERVIEW.md
EOF

# 3) 全局字面量替换（--replace-text 与 --replace-message 共用）
#    只放"全局安全"的精确字面量；跨行删节交给 blob-callback
cat > /tmp/replace.txt <<'EOF'
literal:docs(resume): 新增履历与技术表达答辩手册==>chore: 移除私有档案
literal:chore: 删除个人履历文档==>chore: 移除私有档案
literal:43.130.49.34:8787==>your-llm-endpoint.example.com
literal:<OLD_BADLOGIC_PATH>==>https://github.com/badlogic/pi-mono
literal:<OLD_OPENCODE_PATH>==>https://github.com/sst/opencode
literal:<OLD_NODE_PATH>==>node
literal:./aiagent==>.
EOF

# 4) blob 内容清洗（顶层语句，直接操作 blob.data；勿写 def）
cat > /tmp/blob_cb.py <<'PYEOF'
# 删除「标题含 技术表达/履历/技术表达官」的整节（到下一个标题或文末）
INTERVIEW = re.compile(
    r'^#{1,4}[^\n]*?(?:技术表达|履历|技术表达官)[^\n]*\n[\s\S]*?(?=^#{1,4} |\Z)'.encode('utf-8'),
    re.MULTILINE)
# 删除「标题含 学习检查点/学习笔记/学习目标」的整节
LEARNING = re.compile(
    r'^#{1,4}[^\n]*?(?:学习检查点|学习笔记|学习目标)[^\n]*\n[\s\S]*?(?=^#{1,4} |\Z)'.encode('utf-8'),
    re.MULTILINE)
# 删除源码/文档里对 notes/*.md 的引用（保留句子本身）
NOTES_REF = re.compile(rb'notes/[a-z0-9\-]+\.md')

if b"\0" not in blob.data[:8192]:          # 跳过二进制
    data = INTERVIEW.sub(b'', blob.data)
    data = LEARNING.sub(b'', data)
    data = NOTES_REF.sub(b'', data)
    if data != blob.data:
        blob.data = data
PYEOF

# 5) 执行（在 mirror 副本上先试跑）
cd /tmp && rm -rf aiagent-rewrite && git clone /tmp/aiagent-mirror.git aiagent-rewrite && cd aiagent-rewrite
git filter-repo \
  --invert-paths --paths-from-file /tmp/paths.txt \
  --replace-text /tmp/replace.txt \
  --replace-message /tmp/replace.txt \
  --email-callback 'return b"pegmca@users.noreply.github.com"' \
  --name-callback  'return b"pegmca"' \
  --blob-callback /tmp/blob_cb.py \
  --force
```

### 3.3 正则边界实测结果（决定正则能否直接用）

在临时仓库对 4 种场景实测，**全部符合预期**：

| 场景 | 输入 | 输出 |
|---|---|---|
| 技术表达节在**中间** | `## 5. 技术表达表达要点` + secret + `## 6. 附录` | ✅ 删掉技术表达节，**保留 §6 附录** |
| 技术表达节在**文末** | `## 10. 技术表达表达要点` + secret（无后续标题） | ✅ 删到 EOF（`\Z` 兜底） |
| 正文**提及**技术表达（非标题） | `这里提到技术表达技巧但不该删。` | ✅ **不误删**（只匹配标题行） |
| 「学习检查点」节在中间 | `## 学习检查点` + secret + `## 9. 总结` | ✅ 删掉该节，保留后续 |

> ⚠️ 组合命令实测：3 commit 的仓库经处理后 → 2 commit（notes-only 被 prune）、
> `resume/` 与 `notes/` 全部消失、message 与邮箱均已改写、**全历史 blob 中「技术表达/履历」命中数 = 0**。

### 3.4 保留文件的精确改写（工作区 commit）

filter-repo 处理完后，在工作区做仍需人工判断的改写，作为新 commit：

```bash
git add -A && git commit -m "chore: 剥离学习/技术表达内容，转为开源工程文档"
```

需人工处理的点见 §2.2 的表与下方 §3.5（这些是正则删不干净或删了会破坏结构的部分）。

### 3.5 人工改写点清单（可执行）

> 说明：§3.2 的正则已能自动删除「标题含技术表达/学习」的整节，因此下表大多**已被自动处理**。
> 保留此表是作为**人工复核清单**——跑完后逐项确认，尤其注意 §3.6 列出的正则管不到的点。

**删除整节**（从标题行到文件末尾或下一同级标题前）：

| 文件 | 起点 | 终点 |
|---|---|---|
| `docs/v1.1/01-control-flow-multagent.md` | L95 `## 5. 技术表达表达要点` | EOF（L102） |
| `docs/v1.1/02-rag-production.md` | L93 `## 5. 技术表达表达要点` | EOF（L97） |
| `docs/v1.1/03-tools-mcp.md` | L53 `## 5. 技术表达表达要点` | EOF（L58） |
| `docs/v1.1/04-eval-observability.md` | L69 `## 5. 技术表达表达要点` | EOF（L73） |
| `docs/v1.1/05-engineering-deployment.md` | L51 `## 5. 技术表达表达` | EOF（L54） |
| `docs/v1.1/06-chat-attachments.md` | L509 `## 10. 技术表达表达要点` | L515（`## 附：已确认决策` 之前） |
| `docs/BUSINESS_DIRECTION_FINANCIAL_RESEARCH_AGENT.md` | L290 `## 11. 技术表达表达` | EOF（L307） |

**`-reading.md` 5 篇中的技术表达节**：`01:159`、`02:185`、`03:92`、`04:153`、`05b:153` —— 同样删除到 EOF 或下一节前。
**`docs/v1.1/README.md`** L31 `## 跨维度总优先级（技术表达 ROI 排序）` → 改写为「跨维度总优先级」。
**`docs/IMMERSIVE_PRODUCT_DESIGN.md`** 1 处命中 → 改写措辞。

**源码 10 处**：见 §2.3 表（7 处 `notes/` 引用 + 3 处「技术表达叙事」）。

### 3.6 正则管不到、必须人工处理的点

以下 3 类内容**不在「标题行」里**，§3.2 的正则（只匹配 `#{1,4}` 标题）删除不到：

1. **正文句中的「可技术表达 / 技术表达叙事 / 技术表达 ROI」措辞**（非标题）—— 例如
   `docs/v1.1/01-control-flow-multagent.md:73`（`- **为什么值得学**：...技术表达叙事更贴合 2026 前沿。`）、
   `:93`（`- **可技术表达**：实现 P3...`）、`docs/v1.1/README.md:31` 标题里的「（技术表达 ROI 排序）」后缀。
2. **源码注释里的「技术表达叙事」3 处**（`packages/agent/src/team/presets.ts:53`、`team/slo.ts:5`、`packages/trace/src/index.ts:285`）。
3. **源码注释里 `notes/*.md` 引用 7 处**（见 §2.3）—— §3.2 的 `NOTES_REF` 会删掉 `notes/xxx.md` 串，
   但留下的句子可能残缺（如「见 的取舍记录」），需**人工润色**。

→ 因此 §3.4 的「工作区精确改写 commit」**不可省略**。建议做法：
跑完 filter-repo 后，用 §6 验收清单第 2、5 条 grep 出所有残留，再逐条人工改写。

### 3.7 为什么不用「按文件名过滤」

`--blob-callback` 的 `blob` 对象**不含 filename 字段**（源码 `class Blob.__init__(self, data, original_id)`），
`metadata` 也不提供路径 → **无法在 callback 里按文件名分支**。

替代方案（本方案未采用，因复杂度不划算）：`--file-info-callback(filename, mode, blob_id, value)`
能拿到路径但**与 `--blob-callback` 互斥**（源码第 2323 行明确报错），
需改用两趟 filter-repo（先 file-info 收集「路径→blob_id」映射，再 blob 回调按 id 判断）。
→ **本方案选择「靠内容特征判断」**，已实测够用。

---

## 4. 配套文档改写

### 4.1 `README.md` 重写

现状开头是 `# AI Agent Learning Workspace` + 「学习目标 / 面向国内 AI Agent 岗位 / 可技术表达展示」——**全部要换掉**。

新结构建议：

```markdown
# ohna-harness

TypeScript Agent 工程 monorepo：一套可复用的 Agent 内核（`packages/agent`）与两条产品线。

- 产品 A · 金融 SaaS：`apps/finance-api` + `apps/finance-web`（Fastify + PostgreSQL + pgvector + RAG/Report）
- 产品 B · ohna 编码 Agent：`apps/ohna-cli`（终端 TUI）+ `apps/ohna-api` + `apps/ohna-web`

## 架构
## 快速开始（pnpm install / build / test / dev）
## 包职责表
## 验证命令
## 许可证（MIT）
```

需同步移除：仓库结构树里 `notes/` 及 `interview-qa.md` 条目、「推荐仓库结构」中的学习目标段落。

### 4.2 `AGENTS.md` 改写

当前 **0 处**「学习 / 技术表达」命中（已确认），但有两处需改：
- 「Primary planning documents」列了 `docs/LEARNING_AND_EVOLUTION_ROADMAP.md` / `docs/ROADMAP_1_MONTH.md` → **删除这两行**（文件已移出）。
- 「Documentation Sync」段要求「更新 `docs/LEARNING_AND_EVOLUTION_ROADMAP.md`」→ **删除该要求**。
- 「notes/ 目录」相关的 note 交付物规则 → **整段删除**（`notes/` 已移出）。

### 4.3 `docs/` 交叉引用修复

`notes/README.md` 被以下文件引用，需清理：
`AGENTS.md`、`ARCHITECTURE.md`、`README.md`、`docs/LEARNING_AND_EVOLUTION_ROADMAP.md`（已移出）、
`docs/ROADMAP_1_MONTH.md`（已移出）、`docs/v1.1/*`、`docs/v1.2/*`、`docs/v1.3/*`。

`docs/v1.3/04-development-plan.md` 与 `05-verify-cases.md` 引用 `LEARNING_AND_EVOLUTION_ROADMAP.md §3 七步法` → 改为直接内联七步法描述或删引用。

---

## 5. 执行顺序（Step-by-Step）

| # | 步骤 | 关键命令 / 动作 | 风险 |
|---|---|---|---|
| 0 | **备份** | `git clone --mirror git@github.com:pegmca/aiagent.git /tmp/aiagent-mirror.git`；`cp -R` 工作区 | 无 |
| 1 | **迁出 `notes/`** | `mv notes/* ~/code/ohna-note/notes/`；`cd ~/code/ohna-note && git init && git add -A && git commit` | 低（先确认 ohna-note 无同名冲突） |
| 2 | **清理当前脏工作区** | 当前脏：`M docs/v1.4/README.md`、**llm-trace 功能改动 6 个文件**（`packages/types/src/index.ts`、`packages/agent/{package.json,src/index.ts}`、`packages/trace/{package.json,src/index.ts,tsconfig.json}`、`pnpm-lock.yaml`）+ 未跟踪 `.agents/` `.claude/` `docs/v1.4/02-web-llm-trace.md` | ⚠️ **filter-repo 要求干净工作区**，否则报错。<br>**决策点**：llm-trace 是未完成的增量功能 → 建议**先 `git commit` 为独立的 llm-trace 功能提交**（保留工作成果）或 `git stash -u`（推迟）；`.agents/` `.claude/` 建议直接加入 `.gitignore` |
| 3 | 安装 `git-filter-repo` | **venv 路线**：`python3 -m venv /tmp/gfrvenv && /tmp/gfrvenv/bin/pip install -q git-filter-repo`（⚠️ `pip3 install` 会被 PEP 668 拦） | 低 |
| 4 | **在 mirror 副本上试跑全量重写** | 克隆 `/tmp/aiagent-mirror.git` → 跑 §3.2 单命令 | ⚠️ 必须在副本上跑，方便推倒重来 |
| 5 | **试跑后校验** | §6 验收清单第 1~5 条 + 人工 grep 抽检保留文档 | 正则误伤风险 |
| 6 | 校验通过后，**对正式工作区执行同命令** | 同样 §3.2 命令 | 中（不可逆，先有步骤 0 备份） |
| 7 | **人工改写** | §3.6 的 3 类残留 + §2.3 源码 10 处 + §2.4 隐私路径 | 低（可 review） |
| 8 | 新增 `LICENSE`（未随仓发布 `THIRD-PARTY-NOTICES.md`） | MIT | 无 |
| 9 | 重写 `README.md` / `AGENTS.md` | §4.1 / §4.2 | 无 |
| 10 | 修复交叉引用 | §4.3 | 无 |
| 11 | **最终校验** | §6 全部条 | — |
| 12 | 本地验证 | `pnpm install && pnpm build && pnpm typecheck && pnpm test && pnpm architecture:check` | — |
| 13 | 建 `ohna-harness` 空仓库 | GitHub New repo（**不要勾选初始化 README/LICENSE**，否则首次 push 冲突） | 无 |
| 14 | 推送 | `git remote add harness git@github.com:pegmca/ohna-harness.git && git push -u harness master` | — |
| 15 | **删除 `pegmca/aiagent`** | Settings → Danger Zone | ⚠️ 不可逆；确认备份到位 + 4 个 `stage5/*` 分支无需留存 |

---

## 6. 验收清单（每条都要实跑）

> 以下命令均**在临时仓库实测有效**（能正确揪出历史残留）。

```bash
# 1) 全历史：无任何 notes/ resume/ interview 等路径
git log --all --pretty=format: --name-only --no-renames | sort -u \
  | grep -Ei '^(notes/|resume/|docs/(v1\.2/)?interview|docs/implementation/|docs/weeks/)' \
  && echo FAIL || echo OK

# 2) 全历史 blob：无「技术表达/履历」（★最关键的考古校验★）
git rev-list --all | wc -l                                    # commit 数（预期 ≈178）
git grep -IinE '技术表达|履历|技术表达官|基础题' $(git rev-list --all) --    # 期望：无任何输出
#  ↑ 实测有效：会逐条输出 "<sha>:<path>:<line>:<match>"，能揪出历史版本里的残留

# 3) 全历史：commit message 无敏感词
git log --all --pretty=%s | grep -Ei '技术表达|履历|学习|笔记'          # 期望空

# 4) 全历史：无个人绝对路径 / 实名邮箱
git grep -Iln '<HOME>' $(git rev-list --all)               # 期望空
git log --all --pretty='%ae' | sort -u                            # 期望仅 1 个 noreply 邮箱

# 5) 工作区：交叉引用无死链
grep -rn 'notes/' --include='*.md' --include='*.ts' . | grep -v node_modules          # 期望空
grep -rn 'LEARNING_AND_EVOLUTION_ROADMAP\|ROADMAP_1_MONTH\|LEARNING_PATH' \
  --include='*.md' . | grep -v node_modules                                            # 期望空

# 6) 保留文档完整性与新增文件
git ls-files docs | wc -l                    # 预期 53 → 约 45
ls LICENSE                                     # 必须存在

# 7) 工程校验
pnpm install && pnpm build && pnpm typecheck && pnpm test && pnpm architecture:check
```

> ⚠️ **不要用 `git log -p --all -S '技术表达' --oneline` 做验收**（初稿曾建议，实测**不可靠**）：
> `-S` 只显示「该字符串数量发生变化」的 commit，若某个历史版本**整节被加入又整节被删除**，
> 或数量恰好抵消，就会漏报。→ **必须用第 2 条的 `git grep <rev>...` 全量扫描**。
>
> ⚠️ 第 2、4 条会展开全部 commit（178 × 数百文件），较慢。若 shell 报参数过长，
> 改用循环：`for c in $(git rev-list --all); do git grep -IinE '技术表达' $c --; done`（实测同样有效）。

---

## 7. 风险与取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| 正则误删技术内容 | 保留的设计文档被吃掉正常章节 | 正则只匹配**标题行**含指定词的章节（实测正文提及不误删）；跑完仍须人工 grep 抽检保留文档 |
| 历史 blob 残留 | 考古者仍能翻出技术表达内容 | 单命令已含 blob-callback；验收清单第 2 条强制校验 |
| 删除原仓库不可逆 | 丢失 4 个 `stage5/*` 分支与历史 PR 引用 | 步骤 0 的 mirror 备份；删除前导出 PR 列表存档 |
| `notes/` 迁出后源码注释死链 | 文档指向不存在的路径 | §2.3 的 7 处改写必须做完 |
| 无 LICENSE 即公开 | 法律上默认「保留所有权利」 | 步骤 7 为**强制项**，不可跳过 |
| 第三方代码声明缺失 | pi / opencode MIT 代码未署名 | 源码注释已含参考致谢，无需独立声明文件 |
| 强制 push / 重写历史 | 若有人已 fork 会冲突 | 新建仓库而非原地重写，天然规避 |
| `filter-repo` 要求干净工作区 | 步骤 2 未清理会报错 | 步骤 2 显式处理脏工作区 |
| `pip3 install` 被 PEP 668 拦截 | 装不上工具，卡住整个流程 | 改用 `python3 -m venv`（已实测可行） |
| blob-callback 写成 `def run(blob, metadata)` | **静默失效**，什么都没删却不报错 | 脚本必须是顶层语句、直接操作 `blob.data`（已实测） |
| 正则用 `rb'...技术表达...'` | `SyntaxError: bytes can only contain ASCII` | 用 `r'...'.encode('utf-8')`（已实测） |
| 新建仓库时勾选了初始化 README | 首次 push 冲突 | 步骤 13 明确不勾选 |

---

## 8. 已实测验证记录（本方案的技术基础）

为避免「方案看着对、执行时踩坑」，以下结论**全部在临时 git 仓库中实跑验证过**，
而非仅凭文档推断。凡是与直觉/常规写法冲突的地方，均已标注。

| # | 验证项 | 结果 |
|---|---|---|
| 1 | `pip3 install git-filter-repo` | ❌ **被 PEP 668 拦截**（`externally-managed-environment`）→ 改用 `python3 -m venv /tmp/gfrvenv` ✅ |
| 2 | venv 内 `git-filter-repo --version` | ✅ 可用（2.47.0） |
| 3 | blob-callback 写成 `def run(blob, metadata):` | ❌ **静默失效**（脚本被包进 `def callback(blob):`，`run` 从不调用，无报错但内容未改） |
| 4 | blob-callback 写成顶层语句直接操作 `blob.data` | ✅ **生效**（`FIRED len=65 → AFTER len=22`） |
| 5 | 正则 `rb'^#...技术表达...'` | ❌ `SyntaxError: bytes can only contain ASCII literal characters` |
| 6 | 正则 `r'...'.encode('utf-8')` | ✅ 生效 |
| 7 | 回调内能否用 `re` / `re.MULTILINE` | ✅ 可直接用（`public_globals` 已含 `re`），自带 flags 不受 `--replace-text` 无 flags 限制 |
| 8 | 技术表达节在**中间**（后有其他标题） | ✅ 删除该节，保留后续章节 |
| 9 | 技术表达节在**文末**（无后续标题） | ✅ 删到 EOF |
| 10 | 正文**提及**技术表达（非标题行） | ✅ **不误删** |
| 11 | 「学习检查点」节 | ✅ 同样删除 |
| 12 | 组合命令：路径剔除 + prune + message + 邮箱 + blob | ✅ 3 commit → 2 commit（notes-only 被 prune）；`notes/`、`resume/` 全消失；message/邮箱改写；**全历史 blob「技术表达/履历」命中 = 0** |
| 13 | 验收 `git grep -IinE '技术表达' $(git rev-list --all) --` | ✅ 有效，能揪出历史版本残留 |
| 14 | 验收 `git log -p --all -S '技术表达' --oneline` | ⚠️ **不可靠**（`-S` 只看数量变化，会漏报）→ 已改用 #13 |

---

## 9. 后续迭代方向（本次不做，供你确认优先级）

清洗完成后仓库定位为「TypeScript Agent 工程 monorepo」，可继续优化的方向：

1. **Agent 内核**：`packages/agent` 的 ReAct loop 钩子切片、上下文装配、压缩收敛、子代理原语。
2. **ohna 编码 Agent**：`apps/ohna-cli` TUI 体验、权限体系、长任务治理、MCP 扩展。
3. **金融 SaaS**：`apps/finance-api` 的多租户 / RBAC / 审计（当前明确未实现）、RAG 与 Report 质量。
4. **工程门禁**：CI 已含 typecheck/build/test/architecture:check，可补覆盖率与 eval 回归门禁。

> 建议下一步先确认 §2.1 的移出清单与 §2.2 的保留清单是否符合你的预期，
> 特别是 **`docs/v1.1/*-reading.md` 5 篇带读文档**——它们是代码带读（有价值）但含「学习检查点」章节（需清洗），
> 我默认**保留并清洗**，如你想整体移出请说明。
