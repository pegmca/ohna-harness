# PR-12：附件生命周期、消息绑定与私有 RAG

## 目标与启动条件

依赖 PR-06 至 PR-10 已合并，可与 PR-11 并行。从最新 `origin/master` 创建
`feat/chat-attachments`，使用 `0100_message_attachments.sql`。支持每条消息最多 5 个、
单文件不超过 10 MB 的 Markdown/TXT，并把检索范围绑定到持久化消息附件。

## 上传身份、幂等与生命周期

- `POST /api/attachments` 接收 `clientAttachmentId`、文件元数据和文本内容。幂等身份为
  `(userId, clientAttachmentId)`，相同 ID + 相同内容 checksum 返回同一 `documentId`；
  相同 ID + 不同内容返回 conflict，重试不得创建新文档/version。
- `uploading` 使用 15 分钟初始租约和不可猜测的 claim token，索引期间每分钟续租；进程在
  claim 后退出时，相同 checksum 可在租约到期后接管。`renew/complete/fail` 必须携带当前
  token，旧执行者不能续租或覆盖新租约。
  ingest 已成功但 complete 中断时，接管者通过相同 RAG lineage/checksum 取得既有 document。
- 上传创建 owner 为当前用户、scope 为 private 的 RAG 文档，等待最新 version 进入 indexed
  后才返回。正文只保存在 document version，不复制到消息表。
- 上传后未发送、从草稿移除或页面关闭的文档进入 orphan 候选；本 PR记录 `uploaded_at`/
  绑定关系并提供按保留期清理的 repository/service。默认保留 24 小时，清理仅软删除
  “从未绑定任何消息且超过保留期”的上传文档。已绑定文档不因 Composer 移除而删除。
- 同一 `documentId` 在同一消息内禁止重复；跨消息复用默认禁止，除非未来新增显式“从资料库
  引用”流程。服务端以 upload ownership/首次绑定约束执行，不能只依赖浏览器去重。

若现有 RAG schema 无法表达上传幂等和 orphan 时间，必须在 `0100_message_attachments.sql`
增加所需字段/约束并逐列中文注释，不能用进程内 Map 承担事实源。

## Orphan 清理触发机制

- `packages/database` 暴露 `cleanupOrphanAttachments({ before, limit })`；单批默认 100、最大
  500，查询再次确认没有 `message_attachments` 引用，并用事务内
  `FOR UPDATE SKIP LOCKED` 支持多实例并发。
- `apps/api` composition 在启动成功后立即异步触发一次 sweep，此后用受控 interval 每小时
  触发；不得阻塞 listen/readiness。shutdown 必须清除 timer 并等待当前批次有限完成。
- 每轮循环处理至不足一批或达到单轮 1000 条上限，避免清理占满连接池；剩余项留给下一轮。
- 单批失败记录脱敏结构化 warning/metric，不使 API 退出；不在同一 tick 紧密重试，下一个
  小时间隔自然重试。被其他实例锁定或上传/绑定竞争中的记录留给后续 sweep。
- `AIAGENT_ATTACHMENT_ORPHAN_TTL_HOURS` 可配置保留期，默认 24、最小 1；interval 和 batch
  暂不开放环境配置，避免无界运维参数。测试通过注入 clock/scheduler，不真实等待。

## 消息绑定事务与检索范围

- `message_attachments` 保存 user/message/document、ordinal、文件名、类型、大小和创建时间
  快照；唯一 `(message_id,document_id)` 与 `(message_id,ordinal)`。
- 创建 Run 的数据库事务依次验证 conversation owner、幂等用户消息、附件 owner/private/
  indexed/未被其他消息绑定，并以 document ID 升序 `FOR UPDATE` 锁定上传文档，然后插入
  message attachments、Run 和 assistant 占位消息。cleaner 使用相同文档行锁顺序；因此绑定
  与软删除竞争只能有一个提交。任一步失败整体回滚；上传文档仍作为 orphan 等待清理。
- Run request 中的 document IDs 只是绑定意图，不是执行期授权事实源。Agent 执行必须重新从
  已持久化的“本 Run user message -> message_attachments”查询 document IDs，再构造 RAG
  filter；禁止直接信任请求数组或检索用户资料库全量文档。
- 幂等重试比较持久化附件的有序 document ID 集合。相同 clientMessageId 改变集合返回
  conflict，不新增绑定。

## API、错误与安全

上传 DTO 返回 `ChatAttachmentDto`；历史 `ConversationMessageDto.attachments` 返回快照。
文件类型、字节数、数量、重复 ID、checksum conflict 使用结构化 400/409；不存在、跨用户、
已被其他消息绑定统一使用不泄漏资源存在性的 not found/conflict 策略。

附件 evidence 使用明确的不可信数据边界进入 Agent prompt；附件内容不得成为 system 指令，
不得写入日志、Trace 原文或错误 details。

## 包含与排除

包含文本上传、索引、生命周期事实与定时 sweep、事务绑定、消息历史、限定 RAG 及最小 Web
API client。不包含附件草稿 hook/chips/最终 Composer UI（统一由 PR-14 实现），也不包含
PDF/OCR、对象存储、多段上传、资料库附件复用 UI、手动删除已绑定文档。

## 目标模块

- `packages/types`：上传、消息附件和 Run 请求 DTO。
- `packages/rag`：多 document filter 与不可信 evidence 组装。
- `packages/database`：migration、上传幂等/orphan repository、消息绑定事务。
- `apps/api`：attachments route、Run service 的持久化绑定查询、composition timer。
- `apps/web/src/shared/api`：仅新增无状态 attachment client 及 client contract test。

## 测试与验收

- 相同上传幂等键与 checksum 返回同一文档；内容冲突返回 409。
- fake clock 推进启动 sweep/每小时 interval 后，到期 orphan 被分批清理；失败批次在下一周期
  重试，shutdown 不再触发；已绑定附件永不被 sweep 删除。
- 两个并发 cleaner 不重复处理同一记录，单轮不超过 1000 条且不会长时间占用事务。
- bind 与 cleanup 并发时结果只能是“绑定成功且未删除”或“先删除后绑定返回结构化失败”，
  不能出现已绑定文档被软删除。
- 同消息重复、跨消息复用、跨用户、未 indexed 文档均被拒绝。
- 故意篡改 Run request 后，执行期仍只能检索持久化消息附件集合。
- Run 创建失败不留下半条 message attachment；幂等重试不重复绑定。
- 历史消息恢复附件顺序和快照；prompt injection fixture 不能覆盖系统指令。
- 运行 RAG/database/API/Web 定向测试和根级 `pnpm typecheck`、`pnpm test`、`pnpm build`。

## 文档、提交与 PR

同步 RAG/附件学习 note、数据保留说明、路线图证据。提交建议：
`feat(chat): add private rag attachments`。

PR 描述必须说明 orphan 保留期、timer/sweep 生命周期、事务图、唯一约束、权限模型、
migration 和测试。Review Agent 重点检查执行期授权事实源、孤儿泄漏、重复绑定、清理并发
和正文泄漏。
