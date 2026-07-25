# PR-08：Citation 持久化

## 目标与启动条件

同时依赖 PR-03 和 PR-07 已合并。从最新 `origin/master` 创建
`feat/postgres-citations`，使用 `0080_citations.sql`。让回答和报告引用固定指向生成时的
document version/chunk。

## 数据模型

建立 `message_citations` 和 `artifact_citations`：

- UUID、user ID、message/artifact ID、chunk ID、document version ID
- citation ordinal、claim、quote snapshot、score、verifier status
- created_at

分别唯一 `(message_id,ordinal)`、`(artifact_id,ordinal)`，并对 chunk/version 建查询索引。
删除生成物时级联删除关系；文档版本默认保留，只有经过独立保留策略才能删除被引用版本。
所有字段逐列中文注释。

## 写入与读取

- 定义 Citation repository port，由 database package 实现。
- Agent final response 保存 assistant message 时，在同一事务写 message citations。
- Report artifact 保存时，在同一事务写 artifact citations。
- quote 是生成时快照，用于来源后续归档时仍可解释；它不能替代 chunk/version 外键。
- citation 查询先验证生成物 user，再按当前文档 scope 返回可访问来源。无权限时保留引用
  序号和“来源不可访问”状态，不返回正文或 source URI。
- verifier 更新使用明确状态迁移，不能覆盖人工/终态结果。

## 测试与验收

- 每条引用可追到固定 chunk 和 version。
- message/artifact 与 citation 写入原子成功或整体回滚。
- 两个用户不能通过 citation ID 读取对方文档。
- 文档归档/无权时不泄漏正文，但生成物引用顺序保持稳定。
- 重复保存相同生成物不产生重复 ordinal。
- 运行 agent/report/RAG/database tests、相关 typecheck、根级 test/typecheck/build。

## 提交与 PR

提交建议：`feat(rag): persist generated citations`。

同步 citation/RAG note。Review Agent 重点检查跨领域事务组织、文档版本保留、quote 脱敏和
无权来源的响应行为。

