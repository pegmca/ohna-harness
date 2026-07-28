# PR-11：模型目录与服务端路由

## 目标与启动条件

依赖 PR-03、PR-10 已合并。从最新 `origin/master` 创建 `feat/chat-model-routing`，使用
`0090_run_model.sql`。本 PR 建立服务端模型目录，并让每个 Run 持久化用户选中的稳定路由 ID。

## 模型身份语义

必须区分三个概念：

- `modelId`：产品目录中的稳定路由 ID，例如 `deepseek-chat`；由用户选择，写入
  `agent_runs.model_id`，参与创建 Run 的幂等比较，Accepted、Snapshot、Result 均返回此值。
- provider model name：发送给 provider 的具体模型名，仅存在服务端配置，不作为产品稳定 ID。
- actual attempt：每次模型请求实际使用的 provider、provider model name、attempt、fallback
  原因和 usage；记录到既有 `model_call` Trace event，不覆盖 `agent_runs.model_id`。

当前跨目录 fallback 被禁止：选择 DeepSeek 的 Run 不得静默切换到 OpenRouter 目录项。目录项
内部针对同一 provider model 的超时重试可以保留，并逐 attempt 记录 Trace。将来若引入跨目录
fallback，必须新增独立的 resolved/fallback DTO 和 migration，不能改写 `modelId` 的语义。

## API、Schema 与模块边界

- 新增 `GET /api/models -> ApiResult<ModelCatalogDto>`；只返回 ID、label、provider、
  description、capabilities 和 `defaultModelId`，不得返回 endpoint、model name 或凭据。
- `AgentRunCreateRequestDto.modelId` 必须来自目录；服务端可为旧调用者补默认值。
- `AgentRunAcceptedDto`、`AgentRunSnapshotDto`、`AgentRunResponseDto` 返回选中路由 ID。
- migration 为 `agent_runs.model_id` 回填兼容值、设为非空、添加中文字段注释；不得修改旧
  migration。
- `apps/api` 的 model registry 同时承担公开目录与私有 client resolver；`packages/agent`
  只接收注入的 client，不读取环境变量或目录。
- Web 只新增无状态 `listModels` API client，供 PR-14 消费；本 PR 不维护 localStorage、不实现
  Composer 状态或模型选择控件。

结构化错误：未知/不可用模型返回 `validation_failed` 或专用稳定代码的 400；provider 执行
失败沿用模型边界错误，不泄漏 key、endpoint 或原始响应。配置缺失必须使 readiness 失败，
不能静默调用 Mock。

## 包含与排除

包含目录 API、DTO、migration、composition、幂等校验和最小 Web API client。不包含
Composer hook/模型选择器/样式/localStorage，也不包含动态后台配置、多模型并行、跨目录
fallback、成本路由和浏览器直连 provider。所有最终模型交互统一由 PR-14 实现。

## 目标模块

- `packages/types`：模型目录和 Run DTO。
- `packages/agent`：按注入 client 执行并记录 model attempt。
- `packages/database`：migration、schema、Run repository。
- `apps/api`：model registry、models/runs routes、composition/readiness。
- `apps/web/src/shared/api`：仅新增无状态 models client 及 client contract test。

## 测试与验收

- 未指定模型使用服务端默认值；未知 ID 返回结构化 400。
- 同一 clientMessageId 改换 `modelId` 返回 conflict，不产生第二个 Run。
- Snapshot/历史 Result 始终返回选中路由 ID；Trace 可证明实际 provider model/attempt。
- DeepSeek 配置失败不能落到 OpenRouter 或 Mock；OpenRouter 同理。
- 模型目录不含任何 secret/endpoint；最小 Web client 能解析成功和结构化失败响应。
- 运行 API/agent/Web 定向测试、migration comment 检查及根级 `pnpm typecheck`、
  `pnpm test`、`pnpm build`。

## 文档、提交与 PR

同步环境变量示例、Run/LLM 学习 note、路线图证据和本任务卡。提交建议：
`feat(agent): add server-side model routing`。

PR 描述必须列出 migration、目录 DTO、fallback 禁止规则、配置/凭据安全、测试结果和回滚
方式。Review Agent 重点检查三个模型身份是否混用、幂等字段、生产配置失败是否静默 Mock。
