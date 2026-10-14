# 04 能力扩展机制：Extensions / Skills / Slash Commands

> 本文定义改造后的三种能力扩展机制。参照 badlogic/pi-mono（本地浅克隆 `https://github.com/badlogic/pi-mono`，下称 pi），引用符号均已对照真实代码核实：
> - pi-coding-agent extensions：`badlogic/packages/coding-agent/src/core/extensions/`
> - pi-agent-core skills：`badlogic/packages/agent/src/harness/skills.ts`
> - slash commands：`badlogic/packages/coding-agent/src/core/slash-commands.ts`
>
> 已确认决策（全套文档口径一致）：LLM 层完全按 pi-ai 改造且命名与 pi 一致；会话存储为「线性消息 + run」；彻底删除 approval/permission 体系；保留 RAG/report/workflow/MCP/eval；接受完全不兼容改造。本文与 01（架构）、03（agent loop）、05（会话存储）配套。

## 现状

本项目当前**没有任何面向外部的扩展机制**，能力扩展全靠改核心代码：

- **工具注册**：`packages/tools/src/registry.ts` 的 `ToolRegistry`（`register` / `get` / `list` / `execute`）是静态类注册表，`packages/tools/src/default-registry.ts` 在启动时硬编码注册 calculator、financial-metric、market-data、filing-search、sql-query 等 mock 工具。新增工具 = 改 `default-registry.ts` 重新部署。
- **工具执行横切逻辑**：`packages/tools/src/executor.ts` 的 `executeTool` 内含 zod 入参/出参校验、超时/重试、以及 approval 权限门（`packages/tools/src/approval-repository.ts`）——权限门按已确认决策整体删除，校验与超时/重试保留。
- **意图分支硬编码**：`packages/agent/src/agent-loop.ts` 的 `runAgent` 把 chat / explain / report_skill 三种意图的执行骨架写死在循环里，加一类能力（如"估值建模"）需要改 intent router + agent loop 两处。
- **Skills 未被产品使用**：仓库根的 `.agents/skills/`（当前仅 `worktree-pr-workflow/SKILL.md`）是给编码 agent（如本 CLI）读的工程约定，服务端代码（`packages/*`、`apps/*`）没有任何 SKILL.md 加载逻辑。
- **无 slash command**：`apps/web/src/features/workbench/` 的 composer（`chat.tsx`、`composer-controls.tsx`）是纯文本输入，无 `/` 命令解析；compact、切换模型等操作也没有命令化入口。
- **MCP 是唯一"外部能力"入口**：`packages/mcp/src/tool-adapter.ts` 把 MCP server 工具适配进 `ToolRegistry`，说明项目已有"外部来源工具并入注册表"的先例，但没有统一的生命周期/事件模型。

## pi 参照

pi 的能力扩展是**三种互补机制**：extension（代码级）、skill（提示词级）、slash command（用户入口级），三者在 `SlashCommandInfo` 处汇合。

### 机制一：Extensions（jiti 运行时加载 + ExtensionAPI）

**加载**（`badlogic/packages/coding-agent/src/core/extensions/loader.ts`）：

- extension 是一个 TypeScript 模块，默认导出一个工厂函数 `ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`（`types.ts:1495`）。
- 加载用 `createJiti`（`loader.ts:411`）在运行时直接 import TS 源码，不需要预编译。Bun 二进制模式下通过 `virtualModules`（`loader.ts:48`）注入打包好的 pi-ai / pi-agent-core / typebox 等依赖；Node 开发模式下用 `alias`（`getAliases()`，`loader.ts:82`）解析到 workspace。
- 发现规则（`discoverExtensionsInDir`，`loader.ts:636`）：`extensions/` 目录下的 `.ts/.js` 文件、含 `index.ts/index.js` 的子目录、或 `package.json` 里 `"pi": { "extensions": [...] }` manifest 声明的入口。加载位置有两级：项目本地 `<cwd>/.pi/extensions/`（`CONFIG_DIR_NAME` 默认为 `.pi`，`badlogic/packages/coding-agent/src/config.ts:491`）与全局 `<agentDir>/extensions/`（`discoverAndLoadExtensions`，`loader.ts:673`）。
- 加载结果是一个 `Extension` 对象（`types.ts:1670`）：`handlers` / `tools` / `commands` / `flags` / `shortcuts` / `messageRenderers` 等 Map 的集合，外加共享 `ExtensionRuntime`（`types.ts:1667`）——action 方法在 `runner.initialize()` 前是抛异常桩（`createExtensionRuntime`，`loader.ts:170`）。

**API 面**（`ExtensionAPI`，`types.ts:1185`）：

- `on(event, handler)`：33 个事件重载（`types.ts:1190-1231`），按类别整理如下：
  - 启动/资源：`project_trust`、`resources_discover`（让 extension 补充 skill/prompt/theme 搜索路径）
  - 会话生命周期：`session_start`、`session_info_changed`、`session_before_switch`、`session_before_fork`、`session_before_compact`、`session_compact`、`session_shutdown`、`session_before_tree`、`session_tree`
  - agent 循环：`before_agent_start`（可改 systemPrompt）、`agent_start`、`agent_end`、`agent_settled`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`（可替换消息）
  - 上下文/Provider：`context`（每次 LLM 调用前可改 messages）、`before_provider_request`（可替换 payload）、`before_provider_headers`（可注入 header）、`after_provider_response`
  - 工具执行：`tool_execution_start` / `tool_execution_update` / `tool_execution_end`（观测）；`tool_call`（执行前，可 `block` 或原地改 `event.input`，`types.ts:904`）、`tool_result`（执行后，可改 content/details，`types.ts:965`）
  - 模型/输入：`model_select`、`thinking_level_select`、`input`（用户输入可 transform/handle）、`user_bash`
- `registerTool(tool)`：`ToolDefinition`（`types.ts:449`）——`name` / `label` / `description` / `parameters`（TypeBox schema）/ `execute(toolCallId, params, signal, onUpdate, ctx)`，外加 TUI 渲染钩子 `renderCall/renderResult` 和 `promptSnippet` / `promptGuidelines`（注入 system prompt 的工具说明）。
- `registerCommand(name, { description, handler, getArgumentCompletions })`：注册斜杠命令，handler 拿到 `ExtensionCommandContext`（`types.ts:353`，含 `newSession` / `fork` / `switchSession` / `reload` 等会话控制能力）。
- 其他：`registerShortcut` / `registerFlag`（CLI 快捷键与 flag）、`registerMessageRenderer` / `registerEntryRenderer`（TUI 渲染）、`sendMessage` / `sendUserMessage` / `appendEntry`（写会话）、`registerProvider` / `unregisterProvider`（注册模型 provider）、`events`（extension 间通信的 `EventBus`）。
- 事件分发在 `runner.ts`：`emit()`（`runner.ts:796`）顺序调用所有 extension 的同名 handler 并聚合返回值；`emitToolCall`（`runner.ts:927`）、`emitToolResult`（`runner.ts:872`）、`emitMessageEnd`（`runner.ts:830`）等有专门方法做结果合并。单个 handler 抛错只记入 `ExtensionError`，不中断其他 extension。

### 机制二：Skills（SKILL.md + frontmatter，提示词级能力）

- 加载器在 pi-agent-core：`badlogic/packages/agent/src/harness/skills.ts` 的 `loadSkills(env, dirs)`（第 49 行）。递归扫描目录找 `SKILL.md`（目录本身即一个 skill 根，不再向下递归），目录根部的散置 `.md` 也作为 skill 加载；遵守 `.gitignore/.ignore/.fdignore`（`IGNORE_FILE_NAMES`，第 7 行）；解析失败、元数据不合法都降级为 `SkillDiagnostic` warning 而不是报错（`loadSkillsFromDirInternal`，第 103 行）。
- 文件格式：YAML frontmatter（`name`、`description`、`disable-model-invocation`，`SkillFrontmatter` 第 30 行）+ markdown 正文。name 必须与父目录同名、小写连字符、≤64 字符（`validateName`，第 281 行）；description 必填、≤1024 字符（`validateDescription`，第 293 行）。
- 两种生效方式：
  1. **模型自主调用**：pi-coding-agent 的 `formatSkillsForPrompt`（`badlogic/packages/coding-agent/src/core/skills.ts:335`）把可见 skill 以 `<available_skills><skill><name>…<description>…<location>…` 列表注入 system prompt，模型判断任务匹配时自己用 read 工具读取 SKILL.md 全文。
  2. **用户显式调用**：`/skill:<name>` 命令（见下），把 skill 正文包装成 `<skill name="…" location="…">…正文…</skill>` 块直接注入为一条用户消息（`badlogic/packages/coding-agent/src/core/agent-session.ts:1314`），可附加用户补充指令（pi-agent-core 的 `formatSkillInvocation`，`harness/skills.ts:38`）。

### 机制三：Slash Commands（三来源汇合的用户入口）

- 类型定义在 `badlogic/packages/coding-agent/src/core/slash-commands.ts`：`SlashCommandSource = "extension" | "prompt" | "skill"`（第 4 行），`SlashCommandInfo = { name, description?, source, sourceInfo }`（第 6 行）。
- 三来源的汇合点在 `agent-session.ts` 的 `getCommands`（`agent-session.ts:2332`）：extension 注册的命令（`source: "extension"`）+ prompt 模板（`source: "prompt"`，markdown 模板经 `expandPromptTemplate` 做 `$ARGUMENTS` 占位符展开，`badlogic/packages/coding-agent/src/core/prompt-templates.ts:269`）+ skill（`source: "skill"`，命令名固定为 `skill:<name>`）。
- 另有一组内置命令 `BUILTIN_SLASH_COMMANDS`（`slash-commands.ts:19`）：`/model` `/compact` `/new` `/resume` `/export` `/fork` 等，走会话控制而非 LLM。
- TUI 侧 autocomplete 把四者（内置 + extension + prompt + skill）合并成一个 `CombinedAutocompleteProvider`（`badlogic/packages/coding-agent/src/modes/interactive/interactive-mode.ts:623`）。

## 目标设计

核心判断：**pi 的 extension 加载机制是为单机 CLI 设计的，本项目是长驻多用户的 Web + Postgres 服务端，必须换掉加载层，保留 API 形状与事件命名**。三种机制全部保留，各自裁剪。

### 4.1 Extensions：进程内模块注册，不做运行时 TS 加载

extension 从「磁盘上的 TS 文件」变成「monorepo 内的 TS 模块，在服务端 bootstrap 时显式注册」。`ExtensionFactory` / `ExtensionAPI` / 事件命名全部对齐 pi，但：

- 删除 jiti / `virtualModules` / `alias` / 磁盘发现（`discoverAndLoadExtensions`），改为 `extensionRegistry.register(factory)`，在 `apps/api` 启动时装配。
- 删除 UI 相关 API：`registerShortcut`、`registerFlag`、`registerMessageRenderer`、`registerEntryRenderer`、`ExtensionUIContext` 全部不引入。Web 前端的工具/消息展示由 03 文档的 run 事件流驱动，extension 只产生事件，不拥有渲染。
- 删除 CLI/会话树相关能力：`newSession` / `fork` / `navigateTree` / `switchSession` / `reload`（本项目会话是线性消息，无树）；`project_trust`、`user_bash`、`input` 事件不引入（无终端场景）。
- 保留并裁剪的 hook 事件清单（命名与 pi 一致）：

```ts
// packages/agent/src/extensions/types.ts
// —— 服务端裁剪后的 ExtensionAPI 签名草案 ——

import type { AgentMessage } from "../types.js"; // pi 命名：UserMessage/AssistantMessage/ToolResultMessage 的联合
import type { AgentTool } from "../types.js";    // 03 文档定义的 AgentTool（zod schema 版）

/** 事件处理器：返回值可选，异步允许。与 pi ExtensionHandler 形状一致。 */
export type ExtensionHandler<E, R = undefined> = (
  event: E,
  ctx: ExtensionContext,
) => Promise<R | void> | R | void;

// —— 事件载荷（裁剪后子集，命名对齐 pi types.ts）——

/** agent 循环前：可追加消息或替换本轮 systemPrompt。对应 pi before_agent_start。 */
export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string;
}
export interface BeforeAgentStartEventResult {
  systemPrompt?: string; // 多个 extension 返回时按注册序链式替换
}

/** 每次 LLM 调用前：可改写 messages（对应 pi context 事件；与 03 的 transformContext 的关系见取舍论证）。 */
export interface ContextEvent {
  type: "context";
  messages: AgentMessage[];
}
export interface ContextEventResult {
  messages?: AgentMessage[];
}

/** provider 请求发出前：注入 header（trace 透传等）。对应 pi before_provider_headers。 */
export interface BeforeProviderHeadersEvent {
  type: "before_provider_headers";
  headers: Record<string, string | null>; // null 表示删除该 header，语义同 pi
}

export interface AgentStartEvent { type: "agent_start" }
export interface AgentEndEvent { type: "agent_end"; messages: AgentMessage[] }
export interface TurnStartEvent { type: "turn_start"; turnIndex: number }
export interface TurnEndEvent { type: "turn_end"; turnIndex: number; message: AgentMessage }

/** 工具执行前：仅观测/block（approval 已删，block 只用于安全类硬阻断，如注入防护）。对应 pi tool_call。 */
export interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>; // 可原地改写参数，语义同 pi
}
export interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
}

/** 工具执行后：可改写结果内容。对应 pi tool_result。 */
export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: unknown; // AgentToolResult<TDetails>，细节随 03 文档定稿
  isError: boolean;
}
export interface ToolResultEventResult {
  content?: unknown;
  isError?: boolean;
}

/** 会话级（线性消息模型下仅剩两个）。 */
export interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  reason: "manual" | "threshold" | "overflow"; // 同 pi
}
export interface SessionBeforeCompactResult {
  cancel?: boolean;
}
export interface SessionCompactEvent { type: "session_compact"; reason: "manual" | "threshold" | "overflow" }

/** handler 的只读上下文：pi ExtensionContext 的服务端裁剪版。 */
export interface ExtensionContext {
  /** 当前会话/运行标识（线性消息模型）。 */
  readonly conversationId: string;
  readonly runId: string | undefined;
  /** 中断当前 run。 */
  abort(): void;
  /** 当前 abort signal。 */
  readonly signal: AbortSignal | undefined;
  /** 触发 compaction。 */
  compact(options?: { customInstructions?: string }): void;
  /** 当前生效 system prompt。 */
  getSystemPrompt(): string;
}

/** 服务端 ExtensionAPI：只留注册 + 少量 action。 */
export interface ExtensionAPI {
  on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
  on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
  on(event: "before_provider_headers", handler: ExtensionHandler<BeforeProviderHeadersEvent>): void;
  on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
  on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
  on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
  on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
  on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
  on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
  on(event: "session_before_compact", handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>): void;
  on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;

  /** 注册 LLM 可调用工具（并入 03 的 AgentTool 注册表，zod schema）。 */
  registerTool(tool: AgentTool): void;

  /** 注册 slash 命令（服务端执行，结果走 run 事件流回前端）。 */
  registerCommand(name: string, options: {
    description?: string;
    handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  }): void;
}

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;
```

事件分发实现照搬 pi `runner.ts` 的语义：按注册顺序串行调用、聚合返回值、单个 handler 抛错降级为结构化错误事件（进 trace）而不中断其他 extension。

### 4.2 Skills：直接复用 pi 的加载器语义，目录兼容 `.agents/skills/`

- 加载逻辑按 `badlogic/packages/agent/src/harness/skills.ts` 移植到 `packages/agent/src/skills.ts`：`SKILL.md` + YAML frontmatter（`name` / `description` / `disable-model-invocation`）、name/description 校验规则、ignore 文件、diagnostic 降级，全部一致。
- 加载位置：默认扫描仓库根 `.agents/skills/`（与现有工程约定目录兼容，无需迁移）+ 服务端配置指定的额外目录。产物缓存进内存，支持管理接口热刷新（不做 pi 的 `resources_discover` 事件）。
- 两种生效方式都保留：
  1. `formatSkillsForPrompt` 等价物把可见 skill 注入 system prompt（对齐 `coding-agent/src/core/skills.ts:335` 的 `<available_skills>` 格式）；
  2. `/skill:<name>` 命令把正文包成 `<skill name location>` 块注入为一条用户消息（对齐 `agent-session.ts:1314`）。

### 4.3 Slash Commands：Web composer 的斜杠命令

- 类型与 pi 完全对齐：

```ts
// packages/agent/src/slash-commands.ts
export type SlashCommandSource = "extension" | "prompt" | "skill"; // 同 pi slash-commands.ts:4

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: SlashCommandSource;
}
```

- 形态差异：pi 在 TUI 里用 autocomplete provider，本项目在 Web composer 里实现 `/` 触发下拉——前端输入 `/` 时调用 `GET /api/conversations/:id/commands` 拿到 `SlashCommandInfo[]`（builtin + extension + prompt + skill 四来源），选中后整行文本提交给服务端解析执行。
- 服务端命令解析三态：
  1. **会话控制类**（`/compact`、`/new`）：直接调会话服务，不进 agent loop；
  2. **prompt/skill 展开类**：展开成用户消息文本，落线性消息表，再触发正常 run——命令本身不成为特殊消息类型；
  3. **extension 命令类**：调用注册的 handler，产出通过 run 事件流回前端。
- 内置命令裁剪到 Web 产品适用子集：`/compact`、`/new`、`/model`、`/name`、`/export`；`/fork` `/tree` `/resume`（线性模型无树）、`/login` `/logout`（provider 凭据是服务端配置）、`/reload` 不引入。

### 4.4 金融场景扩展点实例

- **研报写作 skill**：新增 `.agents/skills/research-report/SKILL.md`，frontmatter 声明 `name: research-report`、`description: 按模板撰写个股/行业深度研报`，正文规定章节结构、引用规范（必须挂 RAG citation）、数据时效要求。模型在报告意图下自主加载，用户也可 `/skill:research-report 贵州茅台` 显式触发。不动任何代码。
- **filings 工具包作为 extension**：`packages/parsing`（当前仅 `src/index.ts`）改造成一个 `ExtensionFactory`，`registerTool` 注册 `filing_search` / `filing_section_read` 等工具；通过 `on("tool_result")` 给结果附加 SEC/巨潮来源元数据（供 citation 落库）；通过 `on("before_agent_start")` 在金融语境追加 filings 使用规范到 systemPrompt。工具包的启停只改 bootstrap 装配一行。
- **eval 钩子**：`packages/eval` 的 runner 注册一个评测 extension，`on("agent_end")` 收集完整消息序列与工具轨迹写入评测数据集，`on("tool_call")` 记录每个工具调用的输入快照用于回归比对。评测能力由此与产品内核解耦，不再需要从 eval 包反向 import agent 内部结构。

## 取舍论证

1. **为什么不做 jiti 运行时 TS 加载**。pi 的运行时加载服务于单机 CLI 的"用户丢一个 .ts 文件就能扩展"场景；本项目是长驻多用户服务端：(a) 安全——服务端进程加载用户上传代码是不可接受的攻击面，金融场景尤其；(b) 可重现——进程内注册走 pnpm workspace 依赖与 CI typecheck，部署产物确定；(c) 热加载在多实例部署下无意义（水平扩缩后每个实例都要一致的能力集，靠发版而非热加载保证）。代价是"加能力必须发版"，对当前阶段的产品是可接受的。
2. **为什么 hook 命名对齐 pi 而不是自由设计**。全套文档已确定 LLM 层命名与 pi 一致，事件命名保持一致能让 03（agent loop）的 `transformContext` / `beforeToolCall` 等内部钩子与 extension 事件形成清晰的两层关系：**loop 配置钩子是编排者（应用代码）的挂载点，extension 事件是能力包的挂载点**，同名同语义降低上下文切换成本。例如 `context` 事件与 `transformContext` 做的是同一件事，前者面向 extension 后者面向应用编排，二者按固定顺序（先 transformContext 后 context 事件）串联执行。
3. **为什么保留 `tool_call` 的 block 但不复活 approval**。block 是无交互的硬阻断（安全策略、注入防护、禁用名单），handler 同步决策、立即生效；approval 是异步人机交互门，需要持久化决策状态与 UI——已确认整体删除。`block` 字段的存在不引入任何审批流程，只是给安全类 extension 一个否决点。
4. **为什么 slash command 仍保留三来源**。三来源汇合为一个 `SlashCommandInfo[]` 是 pi 里最干净的设计之一：用户不需要区分"这个命令是代码实现的还是一个 markdown"。Web 场景下这个性质更有价值——prompt 模板类命令（如 `/compare 茅台 五粮液` 的对比模板）允许产品/运营不改代码上线新命令。
5. **为什么 skill 目录兼容 `.agents/skills/`**。该目录已是本仓库给编码 agent 的工程约定入口，复用同一目录意味着"工程 skill"与"产品 skill"共用一套格式与审查流程；产品上不希望暴露的 skill 用 `disable-model-invocation: true` 或单独的加载目录白名单隔离。

## 删除清单

相对 pi 机制不引入的部分：

- jiti 运行时 TS 加载、`virtualModules` / `alias` 注入、磁盘 extension 发现（`loader.ts` 整体不引入，仅保留其 `Extension`/`ExtensionFactory` 类型形状与 runner 分发语义）。
- `ExtensionUIContext` 全部（select/confirm/input/notify/widget/footer/header/editor 等 TUI UI 原语）。
- `registerShortcut` / `registerFlag` / `getFlag` / `registerMessageRenderer` / `registerEntryRenderer`。
- 事件：`project_trust`、`resources_discover`、`session_info_changed`、`session_before_switch`、`session_before_fork`、`session_shutdown`、`session_before_tree`、`session_tree`、`agent_settled`、`message_start`、`message_update`、`message_end`、`tool_execution_start/update/end`（这些观测点位已由 03 的 run 事件流 + trace 覆盖，不重复开两道）、`before_provider_request`、`after_provider_response`（首期无需求，事件面保持最小，后续可按同一模式增补）、`model_select`、`thinking_level_select`、`user_bash`、`input`。
- `ExtensionCommandContext` 的会话树操作（`fork` / `navigateTree` / `switchSession` / `reload` / `newSession` 的 pi 形态）；`sendMessage` / `sendUserMessage` / `appendEntry`（pi 的 entry 树产物，线性模型下由 run 事件流替代）；`setLabel` / `setSessionName`（首期由会话服务 API 承担）。
- `registerProvider` / `unregisterProvider`：provider 注册是服务端部署配置（02 文档的模型目录/providers），不开放给 extension。
- 内置命令：`/fork` `/tree` `/clone` `/resume` `/import` `/share` `/login` `/logout` `/reload` `/trust` `/settings` `/hotkeys` `/changelog` `/copy` `/scoped-models` 不引入（TUI/会话树/CLI 场景产物）。

相对本项目现状删除的部分：

- `packages/tools/src/default-registry.ts` 的硬编码注册收敛为 bootstrap 装配处的显式 `registerTool` 列表（工具实现本身保留，迁为 03 的 AgentTool 形状）。
- approval 权限门（`executor.ts` 内审批检查、`approval-repository.ts`）——已在全套文档决策中删除，此处仅确认 extension 层不留等价入口（`tool_call.block` 不是审批，见取舍论证 3）。
