# Finance Golden Studio 设计

## 意图

把目前分散在 `test/` 下的金融 golden 数据制作工具，迁移为 `apps/` 下的独立应用
`@aiagent/finance-golden-studio`，同时保留一等 CLI 入口，供人工标注和后续 Agent 自动化共用。

当前流程是 `mine → annotate → validate → promote → generate → eval`。问题不在脚本数量，
而在四个入口各自持有路径、校验和写入逻辑：标注器保存时不校验，生成器又自行推导
`expectedKeywords`，导致 golden 数据契约在生成阶段才暴露问题。

本应用采用 **共享核心 + 单入口 CLI + 本地 Web 工作台**：

- 人工通过 Web 完成候选查看、原文取证、标注、校验和发布。
- 后续 Agent 通过同一个 CLI 子命令完成批量抽取、校验、发布和生成。
- CLI 与 Web 只编排同一份 `core`，不形成两套业务逻辑。

## 目标

- 迁移现有 mine / validate / promote / generate / annotate 能力到 `apps/finance-golden-studio`。
- 保留单一 CLI 入口：`golden-studio <subcommand>`，支持结构化 JSON 输出供 Agent 消费。
- 提供单人本地 Web 工作台，完整覆盖草稿制作、原文取证、关键词标注、校验与发布。
- `golden.jsonl` 仍是作者集单一事实源；`rag-golden-v1.json` 仍是生成产物。
- 所有路径通过显式工作区配置解析，禁止写死开发者绝对路径。
- 草稿、作者集和生成物使用原子写入；发布前自动快照。

## 非目标

- 不做登录、权限、多用户协作、角色审批或 Postgres 持久化。
- 不把 golden 制作工具并入 `finance-api` 或 `finance-web`。
- 不改 `finance-api` 的评测指标语义或用放宽 SLO 的方式掩盖数据问题。
- 不在本阶段实现 OCR、VLM 读图或新的 RAG 算法。

## 约束

- 仓库为 TypeScript strict monorepo；应用目录放在 `apps/` 下，纳入 pnpm workspace。
- 现有 package boundary 不变：`@aiagent/parsing` 提供解析，`@aiagent/rag` 提供 RAG，
  `@aiagent/finance-api` 提供评测执行；新应用只做 golden 数据生产与编排。
- Web 遵循 `DESIGN.md` 的 Immersive Workbench token 与组件规则，不建立第二套视觉系统。
- 单人本地使用，但数据结构必须支持长期积累：草稿状态、审核状态和发布结果都需可追溯。
- `_drafts/` 仍是本地工作区，不作为作者集发布物；作者集与生成产物才进入版本控制。

## 方案

### 应用结构

```text
apps/finance-golden-studio/
  package.json
  tsconfig.json
  src/
    cli/
      main.ts
    core/
      workspace.ts
      drafts.ts
      mine.ts
      validate.ts
      promote.ts
      generate.ts
      evidence.ts
      keywords.ts
      backups.ts
    server/
      http.ts
      routes/
    web/
  test/
```

### CLI

唯一入口使用子命令：

```bash
golden-studio mine --candidates <file> [--batch <name>]
golden-studio validate [--batch <name>|--golden]
golden-studio promote --batch <name>
golden-studio generate
golden-studio serve
golden-studio doctor
```

公共能力：

- `--json`：输出结构化结果，供 Agent 解析。
- `--workspace <path>`：覆盖默认 golden 工作区。
- 环境变量：`FINANCE_CORPUS_ROOT` 与 `GOLDEN_WORKSPACE_ROOT`。
- 所有子命令在失败时返回非零退出码，并输出稳定错误码与详情。

现有根脚本保留名称，但改为调用新应用：

```text
eval:finance-golden:mine
eval:finance-golden:validate
eval:finance-golden:promote
eval:finance-golden:generate
eval:finance-golden:annotate
```

### Core

`core` 是 CLI 与 HTTP server 的唯一业务入口：

- `workspace.ts`：解析语料根、作者集、草稿目录和产物路径；所有路径先规范化再校验作用域。
- `drafts.ts`：批次枚举、草稿读取、原子保存、审核状态和导入旧 JSONL。
- `mine.ts`：候选解析、PDF 定位、抽取健康度、候选 block 和初始草稿生成。
- `evidence.ts`：解析 PDF、按页码/block/表格行投影证据；为 Web 和 CLI 共用。
- `keywords.ts`：`expected_keywords` 的归一化匹配与源文档可达性校验。
- `validate.ts`：统一的结构、manifest 引用、未完成 section、表格结构和关键词校验。
- `promote.ts`：只发布审核通过且完整校验通过的草稿；发布前备份作者集。
- `generate.ts`：作者集映射为评测集，输出产物路径、统计和校验结果。
- `backups.ts`：时间戳快照，避免覆盖事故。

### 数据契约

作者集新增人工审核字段：

```text
expected_keywords: string[]
```

规则：

- 非负例题至少包含一个源文档可达的关键词。
- 关键词必须由人工在标注阶段确认，不从生成器反推。
- `generate` 直接读取 `expected_keywords`，不再自行推导评测关键词。
- 旧作者集缺少该字段时，`validate` 报错并提示回到标注器补全。

草稿状态保留 `_draft` 元信息：

```text
_draft.batch
_draft.approved
_draft.savedAt
_draft.lastValidatedAt
_draft.validation
_draft.filePath
```

### Web 工作台

单人本地应用，使用 React + Vite，服务端为本地 Node API。

主导航只有两个工作区：

1. **草稿批次**：批次状态、进度、校验状态和发布入口。
2. **作者集**：当前 golden 条目、校验问题和生成评测集入口。

标注详情页：

- 左侧：来源 PDF 页面预览与页码切换。
- 中间：解析 block、表格行、页码和候选文本；可选择文本填入 `quote`。
- 右侧：query、gold answer、表格/表单、evidence、distractors、note 和
  `expected_keywords`。
- 底部：保存、保存并校验、标记审核；保存时即时显示校验错误。

页面状态明确区分：未填写、校验失败、可审核、已审核、已发布。

## 数据流

```text
candidates + corpus
        │ mine
        ▼
_drafts/<batch>/*.jsonl
        │ annotate + expected_keywords
        ▼
validated drafts
        │ promote
        ▼
golden.jsonl
        │ generate
        ▼
rag-golden-v1.json
        │ finance-api eval
        ▼
评测报告
```

Web 和 CLI 对每个阶段调用同一个 `core` 操作，产物路径和错误码完全一致。

## 验证

- `pnpm --filter @aiagent/finance-golden-studio typecheck`
- `pnpm --filter @aiagent/finance-golden-studio test`
- CLI smoke：`doctor`、`validate --golden`、`generate --json`。
- Web 单元测试覆盖草稿保存、关键词可达性、路径越界和发布前校验。
- 用现有 14 条 golden 数据完成导入、编辑、校验、生成和评测闭环。
- 在 `1440x900`、`1280x800`、`390x844` 检查布局、长表格、长文本和错误状态。

## 文档

落地时同步更新：

- `apps/finance-golden-studio/README.md`：启动、CLI、工作区配置和完整流程。
- `datasets/finance/rag-golden/SCHEMA.md`：`expected_keywords` 与标注规则。
- `datasets/finance/rag-golden/TAXONOMY.md`：新工具入口和校验流程。
- `docs/v2.0/02-eval-system-v2.md`、`docs/v2.1/02-finance-rag-table-recall.md`：
  旧 `test/` 脚本路径改为新应用入口。
- `AGENTS.md`：新增应用目录、职责和 CLI 入口。
