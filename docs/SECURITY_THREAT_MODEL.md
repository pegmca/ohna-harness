# 基础安全威胁模型

## 资产与信任边界

受保护资产包括 system/developer policy、工具与数据库权限、审批决定、模型/工具输入输出、trace、日志、研报 artifact 以及其中的个人信息。用户输入、外部文档、RAG 检索片段、模型生成的 tool call 和 tool output 均不可信；Agent policy、工具注册表和 schema、API/UI 人工操作边界、服务端 trace/redactor 以及数据库凭据属于受信控制面。

外部内容只通过 `assembleUntrustedContext()` 进入 data-only `user` message，并带 `untrusted_context` 来源标签。它不能创建 system/developer/tool role，也不能授予工具权限。检测器组合“策略覆盖、伪造权威、工具升级、秘密外传”等信号，输出 `allow`、`downrank`、`require_confirmation` 或 `block`，并记录稳定 reason code。

## 攻击面与控制

- Prompt injection：恶意文档可能要求忽略策略或调用敏感工具。结构化隔离是主边界，启发式检测用于降权、确认和阻止，不作为唯一防线。
- 工具越权：工具默认只能从注册表执行，zod 在执行前后校验；调用可传请求级 allowlist。敏感动作需要审批，审批同时绑定 `approvalId`、`requestId` 和完整规范化输入摘要，模型输出本身不被当作审批。
- SQL 绕过：只接受单条 `SELECT/WITH`，拒绝注释、未闭合语法、写/DDL/权限关键词及文件读取、存储过程等危险 primitive。代码检查只是第一层；部署必须使用只能连接允许 schema/view 且无写、DDL、文件、扩展和跨库权限的数据库账号，并在数据库侧设置 statement timeout 与审计。
- 数据泄漏：email、国内手机号、居民证件号、常见账户/银行卡数字和 secret 在 trace、API error、Agent API DTO、workflow/report artifact 输出前递归脱敏；普通日志不得显式记录 request body、prompt 或 artifact 正文。
- MCP 暴露面：只包装客户端已知的三个 schema 化金融工具，未知 discovery 结果不注册；MCP 工具仍经过同一个 registry/schema/permission 执行边界。

安全事件通过 `requestId` 回放，`security` trace 保存 category、decision、reasonCode、sourceType/redactionCount 等摘要，不保存检测规则命中正文。

## PII 分类与保留

当前直接标识符包括 email、手机号、身份证件号和账户/银行卡号；凭据包括 authorization、password、secret、API key 和 token。普通日志不保留这些值；内存 trace 只保留脱敏、最长 500 字符的排错摘要，随进程重启清除。报告和 API 展示层使用同一 redactor。生产环境还应定义按业务字段的数据分级、访问审计、加密、删除请求和明确 TTL。

## 残余风险

启发式 detector 会有误报和漏报，混合语言、编码、图片/OCR、跨 chunk 指令与间接 injection 仍可能绕过。轻量 SQL grammar 不是完整 dialect parser；输入摘要是绑定校验而非密码学签名。当前无 RBAC/SSO、远程 MCP 鉴权、持久审批库、完整 DLP 或不可篡改审计。生产化应增加服务端 HMAC/一次性审批 nonce、身份与租户绑定、成熟 SQL AST parser、数据库代理/只读副本、内容 provenance、输出 DLP 和持续红队 eval。
