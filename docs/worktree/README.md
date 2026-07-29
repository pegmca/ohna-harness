# PostgreSQL 持久化与 Agent Chat 多 Worktree 实施总览

## 1. 目标

本目录把 PostgreSQL 持久化和后续 Agent Chat 体验工作拆成 16 个独立 PR。每份文档对应
一个 Implementation Agent、一个 worktree、一个分支和一个 PR；实现者不需要自行决定任务
边界、依赖、migration 编号或验收方式。

最终运行时不再把 Conversation、Run、Trace、Approval、Workflow、Artifact metadata、
RAG document/chunk/vector 的内存 `Map` 当作事实源。内存仅保留 live event fan-out、
`AbortController` 和单元测试 adapter 等瞬时状态。

PR-00～PR-10 是数据库阶段：不引入 Redis/队列，不承诺 API 重启后自动续跑，不实现长期
Memory，也不把 PDF bytes 写入 PostgreSQL。PR-11～PR-15 是 Agent Chat 阶段：不引入 token
streaming、PDF/OCR 上传、动态模型管理、多模型并行或永久右侧调试栏。

## 2. 任务与依赖

```text
PR-00 数据库工程基线
  ├── PR-01 Conversation / Message
  │     ├── PR-02 Conversation API / Web
  │     └── PR-03 Run / RunEvent / SSE
  │             ├── PR-04 Trace
  │             └── PR-05 Approval
  ├── PR-06 RAG Document / Version / Chunk
  │     └── PR-07 pgvector / Retrieval
  │             └── PR-08 Citation（同时依赖 PR-03）
  └── PR-09 Workflow / Artifact

PR-02 至 PR-09 全部合并
  └── PR-10 Runtime integration / recovery

PR-10 合并
  ├── PR-11 Model catalog / routing
  ├── PR-12 Attachment lifecycle / private RAG
  └── PR-13 Progressive Run projection

PR-11、PR-12 合并
  └── PR-14 Composer interactions

PR-11 至 PR-14 全部合并
  └── PR-15 Cancellation / UX integration closeout
```

| PR | 文档 | 分支 | Migration |
| --- | --- | --- | --- |
| 00 | [数据库工程基线](PR-00-database-foundation.md) | `chore/postgres-foundation` | 无业务 migration |
| 01 | [Conversation / Message](PR-01-conversation-message.md) | `feat/postgres-conversation` | `0010_conversation.sql` |
| 02 | [Conversation API / Web](PR-02-conversation-api-web.md) | `feat/conversation-history-ui` | 无 |
| 03 | [Run / Event / SSE](PR-03-run-events-sse.md) | `feat/postgres-run-events` | `0020_runs.sql` |
| 04 | [Trace](PR-04-trace-persistence.md) | `feat/postgres-trace` | `0030_trace.sql` |
| 05 | [Approval](PR-05-approval-persistence.md) | `feat/postgres-approval` | `0040_approval.sql` |
| 06 | [RAG Document / Chunk](PR-06-rag-document-chunk.md) | `feat/postgres-rag-documents` | `0050_rag_documents.sql` |
| 07 | [pgvector / Retrieval](PR-07-pgvector-retrieval.md) | `feat/postgres-pgvector` | `0060_rag_vectors.sql` |
| 08 | [Citation](PR-08-citation-persistence.md) | `feat/postgres-citations` | `0080_citations.sql` |
| 09 | [Workflow / Artifact](PR-09-workflow-artifact.md) | `feat/postgres-report-artifacts` | `0070_report.sql` |
| 10 | [Runtime integration](PR-10-runtime-integration.md) | `feat/postgres-runtime-integration` | 仅必要的兼容 migration |

数据库阶段之后，Agent Chat 体验优化继续沿用相同拆分方式：

| PR | 文档 | 分支 | Migration |
| --- | --- | --- | --- |
| 11 | [模型目录与服务端路由](PR-11-chat-model-routing.md) | `feat/chat-model-routing` | `0090_run_model.sql` |
| 12 | [附件生命周期、消息绑定与私有 RAG](PR-12-chat-attachments.md) | `feat/chat-attachments` | `0100_message_attachments.sql` |
| 13 | [渐进式运行过程](PR-13-progressive-run-events.md) | `feat/progressive-run-events` | 无 |
| 14 | [Composer 快捷交互](PR-14-composer-interactions.md) | `feat/composer-interactions` | 无 |
| 15 | [停止、动效与体验收口](PR-15-chat-experience-polish.md) | `feat/chat-experience-polish` | 无 |

PR-11、PR-12、PR-13 从 PR-10 合并后的同一基线分别开发。PR-11 与 PR-12 都会触及共享
types/schema 入口，后合并者必须从最新 `master` rebase 并解决显式导出冲突，不得通过复制
未合并分支建立隐式依赖。PR-14 只有在 PR-11、PR-12 合并后启动；PR-15 只有在 PR-11～PR-14
全部合并后启动。

Agent Chat 阶段的 Web 所有权固定为：PR-11、PR-12 只交付无状态 API client，不创建 Composer
hook、控件或样式；PR-14 独占模型偏好、附件草稿、模型选择器、附件 chips 和 Composer 布局。
PR-14 发现前置契约缺口时退回对应 PR 修复，不能在集成 PR 内重新定义 API/DTO。

PR-00 合并后可并行启动 PR-01、PR-06、PR-09。后续任务只有在表中列出的依赖已经合并到
`master` 后才能从最新 `origin/master` 创建 worktree，不使用未合并分支作为隐式基线。

## 3. Agent 协作方式

### Implementation Agent

每个 Implementation Agent：

1. 从最新 `origin/master` 创建独立 worktree。
2. 只实现对应任务文档，不顺手实现相邻 PR。
3. 在自己的 worktree 完成测试、typecheck 和必要 build。
4. 自查 diff、migration、中文字段注释和敏感信息。
5. commit、push 并使用 `gh pr create` 创建 PR。
6. Review Agent 提出问题后，在原 worktree 修复、复测并 push 新 commit。

### Review Agent

Review Agent 由用户在 `master` 主工作区启动：

- 通过 `gh pr view`、`gh pr diff` 和 GitHub Checks 审查。
- 不切换主工作区分支，不在主工作区修改 PR 代码，不代替 Implementation Agent 跑测试。
- 按严重度输出带文件位置的 findings；没有问题时明确说明剩余风险。
- 所有修复退回原 Implementation Agent。

### 收口 Agent

PR-10 Agent 在全部依赖合并后执行根级 typecheck、test、build、Compose smoke、API 重启、
SSE replay、越权、备份恢复等数据库全链路验证。

PR-15 Agent 是 Agent Chat 阶段收口 Agent：不得重新设计 PR-11～PR-14 的契约；负责取消
竞争、真实模型选择、附件上传/绑定/检索、SSE replay 投影、响应式和无障碍的组合验证。
PR-15 未通过前，不得把单个前置 PR 的定向测试当作完整 Composer 流程验收。

## 4. 数据库与代码规则

- 领域 package 声明 repository port；`packages/database` 实现 PostgreSQL adapter。
- `apps/api` 只做鉴权、校验、用例调用和 DTO 映射；`apps/web` 不访问数据库。
- 核心归属、状态、时间、排序、模型、维度使用独立列；只有扩展 payload/metadata 使用 JSONB。
- 所有用户资源查询从 repository 方法签名上要求 `userId` 或显式 scope。
- 所有状态同时使用 TypeScript union 和数据库 `CHECK`。
- 每个写链路明确事务、幂等键、唯一约束和并发策略。
- 不泄漏 `pg` 原始异常；adapter 映射为结构化领域错误。
- 新建或修改字段必须在同一个 migration 中逐列执行中文 `COMMENT ON COLUMN`。
- 不修改已合并或已执行的历史 migration。

高冲突入口包括 `packages/database/src/index.ts`、`packages/database/src/schema.ts`、
`packages/types/src/index.ts`、`apps/api/src/index.ts`、`apps/api/src/server.ts`。
实现时优先按领域拆分 adapter、DTO 和 route 文件，公共入口只保留导出或组装。

## 5. Worktree 与 PR 统一流程

```bash
git fetch origin
git worktree add ../aiagent-prXX -b <task-branch> origin/master
cd ../aiagent-prXX
```

完成后：

```bash
git status --short
git diff --check
git add -A
git commit -m "<conventional commit>"
git push -u origin <task-branch>
gh pr create --base master --head <task-branch> --title "<title>" --body-file <pr-body-file>
```

PR 描述必须包含：目标、包含/排除范围、依赖、migration、schema/API 变化、测试结果、权限
与安全、兼容/回滚、剩余风险。若 `gh` 或网络不可用，只能报告阻塞，不得声称已创建 PR。

## 6. Review 统一清单

- repository 是否强制用户/scope 归属，是否存在先查 ID 后补授权。
- migration 是否独立、可从空库执行，每个字段是否有中文注释。
- 唯一约束和事务是否真正覆盖并发幂等。
- 状态是否可能从终态回退，CAS/行锁是否正确。
- JSONB 是否吞掉应查询和索引的核心字段。
- 分页是否使用稳定 cursor 和 ID tie-break。
- 删除、软删除、级联和审计保留是否一致。
- 模型目录路由 ID、provider model 和实际 attempt 是否保持不同语义。
- 上传附件是否有持久化幂等身份、orphan 清理和消息绑定事务；执行期检索是否只信任持久化绑定。
- UI 事件投影是否有确定映射，完整流与 replay 是否产生相同状态。
- 取消是否复用 `run_error/request_cancelled`，并由数据库 CAS 决定唯一终态。
- 错误和日志是否泄漏连接串、token、secret、PII、完整 prompt 或文档正文。
- adapter 是否通过 composition root 注入。
- 测试证据和文档同步是否与改动相符。
