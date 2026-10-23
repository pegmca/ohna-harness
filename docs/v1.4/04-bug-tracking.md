# v1.4 · Bug 跟踪记录

> 本文记录 v1.4 阶段发现的 bug，每条包含**编号 + 标题、现象描述、原因定位、修复建议**四部分。
> 定位到根因代码位置（文件 + 行号 + 逻辑说明），修复建议给出方向，不强制要求立即实施。

## 修复状态总览（2026-10-21）

| 编号 | 标题 | 状态 | 落地位置 |
|---|---|---|---|
| BUG-001 | composer 失败提示与消息内容不一致 | ✅ 已修复 | `apps/ohna-web/src/features/workbench/{format.ts,Workbench.tsx,chat.tsx,types.ts}` |
| BUG-002 | 跨工作区会话 web 侧无法续写 | ✅ 已修复（服务端 + web） | 服务端 `packages/serve/src/{index.ts,run-manager.ts,run/types.ts}`；web 侧移除只读守卫（见下方「修复记录」） |
| BUG-003 | JSON 展示缺少阅读器能力 | ✅ 已修复 | `apps/ohna-web/src/features/json-viewer/*` + `trace/{LlmCallBlock,TraceStream}.tsx` + `workbench/run-details.tsx` + `styles.css` |
| BUG-005 | 会话标题用「前 24 字符截断」未语义化 | ✅ 已修复 | 服务端 `packages/serve/src/{run/title.ts,run-manager.ts,routes/conversations.ts,index.ts}`；web `apps/ohna-web/src/{features/workbench/Workbench.tsx,shared/api/conversation-client.ts}` |

---

## BUG-001 · composer 失败提示「请求失败，已把结构化错误写入当前 assistant 消息」与实际消息内容不一致

### 现象描述

在 ohna-web 工作台提交一条 Agent 请求，当 run 失败（`result.ok === false` 且非用户主动取消）时，composer 下方固定弹出提示：

> 请求失败，已把结构化错误写入当前 assistant 消息。

但实际 assistant 消息气泡里显示的内容往往**不是**结构化错误，而是：

- 模型流式输出到一半才失败时，气泡正文显示的是**残留的半截文本**（`finalText`），结构化错误只在气泡底部一个小的 `error-block` 里（`code: message` 形式），与「已把结构化错误写入当前 assistant 消息」的说法不符；
- 错误信息在气泡正文（残留文本）、气泡 error-block、composer 提示三处同时出现，内容冗余且口径不统一。

### 原因定位

**核心文件：`apps/ohna-web/src/features/workbench/Workbench.tsx:663-677`**

```ts
if (!result.ok) {
  const cancelledRun = result.error.code === "request_cancelled";
  replaceMessage(submittedConversationId, pendingMessageId, {
    content: finalText || formatApiError(result.error),  // ← 实际写入气泡正文的内容
    blocks: finalBlocks,
    status: cancelledRun ? "cancelled" : "failed",
    ok: false,
    runStatus: cancelledRun ? "cancelled" : "failed",
    error: result.error,                                  // ← 结构化错误在独立 error 字段
    liveEvents: undefined
  });
  if (!cancelledRun) {
    setComposerError("请求失败，已把结构化错误写入当前 assistant 消息。");  // ← 固定文案
  }
  return;
}
```

问题出在三个层面的「口径不一致」：

1. **固定文案断言的误导性**（`Workbench.tsx:675`）：
   该提示是硬编码字符串，无条件断言「结构化错误已写入当前 assistant 消息」。但消息气泡正文写入的是 `finalText || formatApiError(result.error)`，其中：
   - `finalText = textOfBlocks(projection.blocks)`，来自 `projectLiveRun(liveEvents)`（`Workbench.tsx:659-661`）；
   - 当模型流式输出到一半才失败时，`liveEvents` 里已有 `message_update` 事件，`projection.blocks` 非空，`finalText` 是**残留的半截文本**，并非结构化错误。

2. **错误实际渲染在独立字段，与正文分离**：
   结构化错误真正存放在 `message.error`（`replaceMessage` 第 671 行传入），由 `chat.tsx:244-246` 渲染为独立的小 `error-block`（`<AlertTriangle/> code: message`）。而正文 `content` 只来自 `finalText`。因此「写入当前 assistant 消息」的说法在实现上既不精确（正文没写、只写了 error 字段），在视觉上也与用户感知冲突（正文是残留文本）。

3. **三种失败来源共用同一分支，文案无法区分**：
   `result.ok === false` 覆盖了多种失败来源，全部命中同一个固定提示：
   - **场景 A（误导性最强）**：run 已创建、SSE 正常，中途 `run_error` / `agent_end.error` 收尾。此时 `liveEvents` 非空、`finalText` 为残留文本。
   - **场景 B**：HTTP 创建请求本身失败（`POST /api/runs` 返回非 ok，如本地服务未启动 / 代理端口不一致）。此时 `createAndStreamRun` 在 `run-stream-client.ts:51` 直接 `return accepted`，`liveEvents` 为空、`finalText` 为空，气泡正文 = `formatApiError(result.error)`。此场景下提示文案勉强成立，但与 `catch` 分支（`Workbench.tsx:711`，专门处理「本地服务未启动 / 代理端口不一致」）职责重叠，用户无法从提示区分是「服务没起来」还是「run 运行失败」。

**关联代码链路：**

- `apps/ohna-web/src/shared/api/run-stream-client.ts:40-65`：`createAndStreamRun` —— 创建失败时 `return accepted`（第 51 行），不产生任何 SSE 事件。
- `apps/ohna-web/src/features/workbench/live-run-projection.ts:62-170`：`projectLiveRun` —— `run_error`（第 139-145 行）与 `agent_end.error`（第 146-158 行）只设置 `terminal` 与 `error`，不产出 text 块，因此失败时不追加结构化错误到 `blocks`。
- `apps/ohna-web/src/features/workbench/chat.tsx:242-246`：`MessageBlocks` 只渲染 `blocks`（残留文本），`message.error` 另渲染为 `error-block`。
- `apps/ohna-web/src/features/workbench/format.ts:51-60`：`formatApiError` 生成 `code: message (status=..., cause=...)` 文案。

### 修复建议

1. **让提示文案如实反映行为**：把固定文案改为区分场景的提示，例如：
   - 有残留文本时：`「请求失败，错误详情见下方消息。`（或直接不额外提示，因为气泡内已有 error-block）。
   - 无残留文本（创建/传输失败）时：复用 `catch` 分支的「本地服务未启动 / 代理端口不一致」口径，避免与 run 失败混淆。

2. **统一失败信息的落点**（推荐）：失败时把结构化错误**同时写入**消息正文（或在 `blocks` 里追加一个明确的 error 文本块），使「写入当前 assistant 消息」的说法成立，而不是依赖残留文本 + 独立 error-block 两个分裂位置。可复用 `projectLiveRun` 已有的 `error` 字段，在渲染层对 `terminal === "failed"` 且 `blocks` 为空时回退展示 `error`。

3. **消除三处冗余**：明确「正文残留文本」「气泡 error-block」「composer 提示」三者的职责边界，避免同一错误重复展示三遍。建议保留气泡 error-block 作为唯一错误展示点，composer 提示仅用于「提交失败且无消息气泡可承接」的场景。

### 修复记录（✅ 已修复，2026-10-21）

采用建议 1 + 建议 3，**未采纳**建议 2 的「正文与 error 字段同时写入」——那正是同一错误重复展示两遍的根因。

**不变量「错误落点唯一化」**：失败信息必须如实且只展示一次，按本次 run 是否已产生残留文本分两态，由纯函数 `format.ts` 的 `applyFailure(error, blocks, cancelled)` 单点构造（已单测于 `format.test.ts`）：

| run 是否已有残留文本 | `content`（气泡正文） | `error`（气泡 error-block） |
|---|---|---|
| 有（流式输出到一半失败） | 残留文本 | 原始 `ApiError`（error-block 是唯一错误展示点） |
| 无（创建 / 传输即失败） | `formatApiError(error)` | `undefined`（错误只在正文出现一次） |

- `Workbench.tsx` 的 `!result.ok` 分支直接 `replaceMessage(..., applyFailure(...))`，patch 只含需变更字段，因此 pendingMessage 上的 `retryContext` 保留，失败重试仍可用；
- composer 提示改为如实的「请求失败，错误详情见下方消息。」，不再断言错误写在哪个字段；
- 取消（`request_cancelled`）分支行为不变：`status` / `runStatus` 均为 `cancelled`，不弹 composer 提示；
- `chat.tsx` 的 error-block 文案由 `${code}: ${message}` 改为 `formatApiError(message.error)`，与 `run-details.tsx` 的 `ErrorBlock` 同口径（保留 `status` / `cause` 诊断字段）；
- `types.ts` 的 `UiMessage.content` / `UiMessage.error` JSDoc 同步写入上述两态约定。

回归测试：`apps/ohna-web/src/features/workbench/Workbench.failure.test.tsx`（3 例：有残留 / 无残留 / 取消）+ `format.test.ts`（5 例，覆盖空白残留、仅 toolCall 块、取消两态）。

---

## BUG-002 · 访问其他工作区会话时提示「该会话属于其他工作区，请在对应目录的 ohna 会话中继续」，web 侧无法跨目录继续对话

### 现象描述

在 ohna-web 中选中一个由**其他工作目录**的 CLI 启动时产生的会话，composer 被禁用并固定提示：

> 该会话属于其他工作区，请在对应目录的 ohna 会话中继续。

用户预期是：只要本地 CLI 服务正常启动，web 侧无论从哪个目录打开，都应该能访问并继续任意目录下的会话（因为会话是共享持久化的）。但当前实现把它变成「只读」，无法在该 web 里继续这条跨工作区会话。

### 原因定位

这条提示是 **03 L3 的 D2「跨工作区会话只读」设计行为**，不是随机报错；但它暴露了一个架构上的认知不一致：

**1. 会话存储是跨工作区共享的，但 agent 执行上下文是实例本地绑定的。**

- `packages/serve/src/index.ts:143-148`：`createOhnaServer` 里 `workspaceRoot = path.resolve(options.workspaceRoot)`（绑定 CLI 进程启动时的 cwd），而 `dataDir` 缺省 `~/.ohna`，`sessions` / `conversations` / `runs` 三个 JSONL store 都落在**同一个 dataDir** 下。
- 因此，在 `/a` 和 `/b` 两个目录分别起 CLI，它们**共享同一份会话存储**，web 里能看到 `/b` 的会话（侧栏按 `workspaceRoot` 分组展示全部会话），但当前实例的 agent 工具作用域（`createCodingToolRegistry(workspaceRoot)`、`buildCodingSystemPrompt(workspaceRoot)`）是 `/a`。

**2. 只读判断直接比较两个 workspaceRoot 字符串。**

- `apps/ohna-web/src/features/workbench/Workbench.tsx:95-101`：
  ```ts
  const crossWorkspaceReadOnly = Boolean(
    localMode?.workspaceRoot
    && activeConversation?.workspaceRoot
    && localMode.workspaceRoot !== activeConversation.workspaceRoot
  );
  ```
  `localMode.workspaceRoot` 来自 `GET /api/health`（`packages/serve/src/routes/health.ts:17-23`，即实例启动时的 cwd）；`activeConversation.workspaceRoot` 来自会话 meta（`packages/serve/src/routes/conversations.ts:36`，即创建该会话时的 cwd）。
- 二者不相等 → `crossWorkspaceReadOnly = true` → `composer-controls.tsx:76-78` 渲染该提示、textarea 与发送按钮被禁用（`composer-controls.tsx:83`）。

**3. 这是「消息存储共享 + agent 上下文实例本地」二者割裂造成的。**

- 消息 store 按 dataDir 共享，所以 web 能「看到」所有工作区的会话；
- 但 agent 的编码工具 / 系统提示词在服务端进程启动时就固定绑定了单一 `workspaceRoot`，serve 没有提供「按会话 workspaceRoot 动态切换 agent 上下文」的能力；
- 因此前端只能用「只读」这个最保守的手段，防止把 `/b` 的消息发进 `/a` 的 agent 上下文去读错/写错目录（`Workbench.tsx:95-96` 注释明确写了这一点）。

**关联代码链路：**

- `packages/serve/src/index.ts:143` —— workspaceRoot 绑定进程 cwd，dataDir 缺省 `~/.ohna` 跨工作区共享。
- `packages/serve/src/routes/conversations.ts:36,72` —— 会话 meta 记录创建时的 `workspaceRoot`。
- `packages/serve/src/routes/health.ts:17-23` —— 实例只上报一个 `workspaceRoot`。
- `apps/ohna-web/src/features/workbench/Workbench.tsx:95-101,527-542` —— 前端只读守卫（UI 层 + `submitAgentMessage` 兜底）。
- `apps/ohna-web/src/features/workbench/composer-controls.tsx:76-84` —— 提示文案 + 禁用。

### 你的疑问与判断

**你的疑问**：「web 侧应该只要 CLI 服务正常启动，不管是哪个目录都可以访问吧？」

**结论：你的判断方向是对的——「看到 / 浏览」任意目录的会话确实应该没问题（而且现状就已经能做到，因为 store 是共享的）；但「继续对话 / 让 agent 干活」目前做不到，卡点不在 web 展示层，而在服务端 agent 上下文是「单实例单工作区」绑定的。**

具体拆分：

- **只读浏览**：✅ 已支持。侧栏按 `workspaceRoot` 分组展示所有目录的会话（`03-web-layout-alignment.md` D1），消息历史也能读。
- **继续对话（写）**：❌ 目前不支持。因为 serve 在启动时就把编码工具作用域和系统提示词固定到一个 `workspaceRoot`（`createOhnaServer` 的 `options.workspaceRoot`），agent 无法感知「这条会话属于另一个目录」，除非重启一个指向那个目录的 ohna 实例。

所以这不算「web 侧的 bug」，而是**产品能力边界**：当前架构下「一个 web 实例 = 一个工作区的可写 agent」，跨工作区会话只能读、不能续写。是否要支持「单 web 多工作区续写」，取决于产品是否希望一个 serve 进程能按会话切换 agent 上下文。

### 修复建议

分三档，按产品取舍选：

1. **仅澄清提示（最小改动）**：把提示文案从「请在对应目录的 ohna 会话中继续」改得更准确，例如「该会话属于工作区 <root>，当前实例只能读取、无法在此继续；请到该目录重新启动 ohna 后继续」。让用户理解这是「实例工作区绑定」而非「权限被拒」。

2. **支持按会话切换工作区（目标态，改动较大）**：让 serve 的 agent 上下文不再在 `createOhnaServer` 时一次性固定，而是按「会话的 workspaceRoot」动态装配工具与系统提示词（run 创建时根据会话 meta 决定 `workspaceRoot`）。这需要改动 run 装配链路（`run-manager.ts:275` 的 `workspaceRoot: this.options.workspaceRoot` 需改为按会话取），并评估工具路径策略（`fs.ts` 的 `resolveSafePath` 也以单一 workspaceRoot 为基准）。达成后前端可去掉 `crossWorkspaceReadOnly` 只读限制，跨工作区会话也能正常续写。

3. **折中**：保留只读，但在跨工作区会话上提供「切换实例 / 打开对应目录」的引导入口（如按钮指向该 workspaceRoot 的启动命令），而不是硬性禁用。

### 修复记录（✅ 已修复，2026-10-21）

**采用建议 2（按会话切换工作区）**，分两阶段落地，服务端先合入、web 侧收尾：

**阶段一 · 服务端（已合并）**：`RunManagerOptions.resolveWorkspace(conversationId)` 在 `RunManager.createRun` 内按会话持久化的 `workspaceRoot` 动态装配编码工具与系统提示词（`run-manager.ts` 的 `resolveWorkspaceContext`）。解析失败（会话元数据读不到、提示词装配异常）**静默回退**实例工作区语义、不阻断 run——跨工作区续写是增强能力，不是 run 的前置条件。

**阶段二 · web 侧（本次）**：移除全部只读守卫，前提是「侧栏全量 `conversations` 即 composer 的目标会话源」：

| 移除项 | 原位置 |
|---|---|
| `crossWorkspaceReadOnly` 计算 + 3 个使用点（`handleSubmit` 早退、`submitAgentMessage` 守卫、传给 `ChatComposer` 的 `readOnly`） | `Workbench.tsx` |
| `workspaceConversations` state、`appendWorkspaceConversation`、按 `?workspaceRoot=` 拉本工作区会话的 effect，以及 `submitAgentMessage` 内的多段 fallback 与 `sidebarMatch.workspaceRoot === localMode.workspaceRoot` 等值判断 | `Workbench.tsx` |
| `ChatComposerProps.readOnly`（含「该会话属于其他工作区，请在对应目录的 ohna 会话中继续」提示条、textarea `disabled` 与 `canSend` 守卫） | `chat.tsx` / `composer-controls.tsx` |

`submitAgentMessage` 现直接 `conversations.find((item) => item.conversationId === currentId)` 定位目标会话（会话要么从侧栏选中，要么新建后 prepend，因此一定在列表中）。服务端 `/api/conversations?workspaceRoot=` 过滤端点保留供 CLI / 脚本使用，但 web 不再发出该查询。

回归测试：`apps/ohna-web/src/features/workbench/Workbench.cross-workspace.test.tsx`（原 `Workbench.readonly.test.tsx` 改名改写，3 例）：实例工作区 `/work/a` + 会话属于 `/work/b` 时 textarea 未禁用、无只读提示、可直接发送到该会话，且不发 `?workspaceRoot=` 列表请求。

---

## BUG-003 · JSON 展示缺少「阅读器」能力：无节点级折叠/展开、无语法高亮，大 JSON 直接放弃渲染

### 现象描述

查看 Trace 的「请求参数 / 响应 / 原始 JSON」三个 tab，以及工具参数/结果、确认卡片参数等处的 JSON 时，都是**整段扁平纯文本 `<pre>`**，无法按对象/数组节点逐级展开或收起，排查深层字段要上下翻找、手动肉眼定位；JSON 体量超过 1MB 时直接不渲染，只给一句「请用复制 JSON」。

用户诉求：引入 **JSON 阅读器**，能对代码块做**展开 / 收起**（至少是节点级折叠），方便查看大 JSON 的局部内容。

### 原因定位

**现状是「把 JSON 当纯文本渲染」，没有任何结构化的 JSON 阅读器组件。** 涉及的全部位置：

1. **Trace LLM 记录三 tab（核心）** —— `apps/ohna-web/src/features/trace/LlmCallBlock.tsx:250-256`：
   ```tsx
   {tooLarge ? (
     <p className="muted-row trace-json-hint">
       记录体量 {…} KB，已折叠渲染；完整内容请用「复制 JSON」。
     </p>
   ) : (
     <pre className="trace-json">{jsonText}</pre>
   )}
   ```
   - `jsonText = toJsonText(activeValue)` 是 `JSON.stringify(value, null, 2)`（`:37-43`）产出的整段字符串；
   - `tooLarge` 阈值 `LARGE_JSON_THRESHOLD = 1_000_000`（`:29`），超过即放弃 DOM 渲染，只剩复制按钮；
   - 三个 tab（`request`/`response`/`raw`）共用同一个 `<pre>`，切 tab 只换字符串内容，无任何「可折叠节点」概念。

2. **Trace 工具行** —— `apps/ohna-web/src/features/trace/TraceStream.tsx:58,63`：
   - `参数` 与 `结果` 都是 `<pre className="trace-json">{toJsonText(...)}</pre>`，同样纯文本。

3. **Workbench 工具参数/结果** —— `apps/ohna-web/src/features/workbench/run-details.tsx:137-147` 的 `JsonDetails`：
   ```tsx
   <details className="json-details">
     <summary><Braces />{props.title}</summary>
     <pre>{JSON.stringify(props.value, null, 2)}</pre>
   </details>
   ```
   - 只有「整块开/关」一层折叠（`<details>`），展开后仍是整段扁平 JSON，没有节点级折叠。
   - 被 `chat.tsx:342,346,374` 与 `run-details.tsx:40,55,123` 复用。

4. **确认卡片参数** —— `apps/ohna-web/src/features/workbench/confirmation-cards.tsx:70`：
   ```tsx
   {keyParam ? <pre className="confirmation-param"><code>{keyParam}</code></pre> : null}
   ```
   - 纯文本 `<pre>`，同样无结构化折叠。

**根因**：项目里**不存在一个统一的「JSON 阅读器」组件**，各处各自用 `<pre>` + `JSON.stringify` 平铺。`LlmCallBlock` 已有的折叠只是「摘要行 ↔ 展开体」这一层（`open` state），进入展开体后仍是平铺；`JsonDetails` 的 `<details>` 也只是最外层折叠。没有任何代码在做「按 JSON 结构逐级折叠」的解析/渲染。

### 修复建议

1. **抽一个统一的 `JsonViewer`（/ `JsonTree`）组件**：入参 `value: unknown`（或已序列化文本），内部做结构化渲染，支持：
   - 对象 / 数组节点级展开/收起（默认浅层展开、深层折叠，或「全部展开/全部折叠」一键）；
   - 语法高亮（键 / 字符串 / 数字 / 布尔 / null 分色）；
   - 长字符串截断 + 点击展开全文；
   - 可选：节点路径复制、按 key 搜索。

2. **替换四处调用点**：`LlmCallBlock` 三 tab、`TraceStream` 工具参数/结果、`JsonDetails`、`confirmation-cards` 参数，统一走 `JsonViewer`，消除各处的 `<pre>` + `JSON.stringify` 平铺。

3. **大 JSON 策略升级**：用「惰性渲染 + 节点折叠」替代「超阈值直接不渲染」。节点级折叠天然让大 JSON 只渲染可见部分，可保留一个更高的安全上限（如虚拟滚动 / 分页），但不应像现在这样 1MB 就整段消失。

4. **实现选型**：优先评估是否引入成熟的 JSON 树/阅读器库（需评估 bundle 体积与 `DESIGN.md` 一致性）；若倾向零依赖，则用 React 递归组件手写折叠树，复用现有 `details-chevron` / `trace-tabs` 视觉语言，避免引入第二套折叠样式。

---

### 修复记录（✅ 已修复，2026-10-21）

**采用建议 4 的「零依赖手写递归树」**，抽成独立目录 `apps/ohna-web/src/features/json-viewer/`（零新增生产依赖），替换四处 `JSON.stringify` 平铺。

**分层**：`json-tree.ts`（纯函数：构树、摘要、截断、转义、降级，可脱离 DOM 单测）/ `json-row.tsx`（无状态行渲染）/ `JsonViewer.tsx`（展开状态编排壳）/ `index.ts`（公共入口）。

**关键取舍**：

| 决策 | 理由 |
|---|---|
| 默认 `defaultDepth = 2`（可见层数），根与第一层容器展开、第二层起折叠成 `{n 项}` / `[n 项]` | 折叠节点不构建子树 → 初始 DOM 由可视深度决定、与记录总大小解耦，即「惰性渲染」 |
| 删除 `LARGE_JSON_THRESHOLD` / `tooLarge` 的「>1MB 整段不渲染」，改为节点数 > 50 000（`MAX_RENDER_NODES`）才退化为根摘要 + 复制提示 | 按真实节点数计费，口径远高于旧的字符串长度上限；且只有已展开节点进 DOM |
| 「全部展开」另设 `MAX_BULK_EXPAND_NODES = 2 000` 行预算 | 节点上限只管「可否渲染」，一次性铺开几万行仍会卡住主线程 |
| 折叠态零序列化（S1 保持） | 树直接由原值构建；`toJsonText` 仍只在展开时执行，只服务「复制 JSON」与体量展示 |
| 展开键用 NUL 分隔 + 键内转义（`childKey` / `decodeKeyPath`），不再用 `/` 拼接 | `{"a/b": 1}` 与 `{a: {"b": 1}}` 在 `/` 方案下会得到同一个键，父子展开状态互相覆盖；trace payload 里的 HTTP 路径 / URL 字段可触发 |
| 长字符串「展开全文」状态收敛到 `JsonViewer`（`expandedStrings`），行组件无状态 | 父节点折叠会卸载子树，行内 state 会丢，用户再展开又变回截断态 |
| WeakSet 防环（DAG 不算环）、BigInt / 函数 / Symbol / Date / Map → 带标识降级文本、深度 > 64 不递归 | 循环引用与不可序列化值真实出现在 trace payload 里，必须安全降级而非崩溃 |
| disclosure 模式（`button[aria-expanded]`）而非 `role=treeitem` | 扁平兄弟行不满足树语义的嵌套要求，读屏会串层级 |

**未改 `confirmation-cards.tsx`**：其 `keyParam` 是 `keyParamOfArgs` 返回的标量字符串（bash 命令 / 文件路径），没有可折叠节点，折叠树只增加噪声。

**样式清理**：`.json-viewer*` 是全应用唯一的 JSON 视觉层；旧的 `.json-details pre`、`.trace-json`、.trace-json-hint 已删除（避免两套 JSON 底色的误用），`.json-details .json-viewer` 的内嵌去边框规则保留。

**回归测试**：`JsonViewer.test.tsx`（20 例：纯逻辑 7 + 组件 13），含键名含 `/` 的状态隔离、长字符串展开状态跨折叠保持、批量展开预算、超上限降级；`LlmCallBlock.test.tsx` 改为结构化断言并新增节点级折叠用例；`Workbench.test.tsx` 的 `JsonDetails` 断言改为结构化。

### 评审修复（2026-10-21，第二轮）

| 问题 | 修复 |
|---|---|
| **[major] 「全部展开」反而折叠了树**：`setAll(true)` 先给所有可展开键写 `false`、再展开前 1 000 个，于是排在预算之后、本已被 `defaultDepth` 展开的节点被强制收起；深树上按钮看起来毫无反应 | 展开路径改为**只给预算内的键写 `true`**，其余键保持原状（函数式更新合并，保留既有 override）；折叠路径仍全量写 `false`（否则会被 `defaultDepth` 重新判定为展开）。预算截断不再静默：工具栏显示「已展开前 N 个节点，另有 M 个嵌套节点保持原状，可逐级展开」（`role="status"` + `.json-viewer-budget-note`） |
| **[minor] `role="tree"` 但全树无 `treeitem`** | 容器改为 `role="group"` + `aria-label="JSON 结构"`；折叠语义由 `button[aria-expanded]`（disclosure 模式）承载，与行组件注释中的 a11y 论证一致 |

新增 3 条回归测试：1001 个容器（可展开键 1 002 > 预算 1 000）上断言「全部展开」后**预算内外的容器都保持展开**并出现截断提示；未超预算时不出现提示；容器不声明未兑现的 ARIA 角色。三条测试均做过**变异验证**：还原旧的 `setAll` 与 `role="tree"` 后，前两条分别以 `aria-expanded` 为 `false` 与命中 `[role="tree"]` 失败，恢复实现后通过。

---

## BUG-004 · 未实际发送消息也会生成会话（web「New Chat」与 CLI 启动/`/clear`）

### 现象描述

- **web 侧**：点击侧栏「New Chat」按钮（尚未输入/发送任何消息），就会在会话存储里**立即创建并持久化一条空会话**；CLI 以 `--web` 托管模式启动时，`web-host` 也**启动即建一条会话**（即使用户从没发过消息）。
- 用户预期：只有**发送第一条真实 message** 后才应创建会话记录，空会话不应落盘、不应出现在侧栏列表里。

### 原因定位

「创建会话」被绑定在「进入空编辑态 / 进程启动」这些**与消息发送无关**的时机上：

1. **web「New Chat」** —— `apps/ohna-web/src/features/workbench/Workbench.tsx:357-369` 的 `handleNewConversation`：
   ```ts
   async function handleNewConversation(): Promise<void> {
     const result = await createConversation({ title: "新会话" });   // ← 立即落盘
     ...
     setConversations((current) => [result.data, ...current]);
     selectConversation(result.data.conversationId, false, true);
     ...
   }
   ```
   点击「New Chat」即 `POST /api/conversations` 建一条 `title:"新会话"` 的空会话。真正的「懒创建」逻辑（`submitAgentMessage` 里 `if (!conversation) createConversation(...)`）只覆盖「发送消息时目标会话不存在」的情况，但 `handleNewConversation` 提前把会话建出来了。

2. **CLI `--web` 托管启动** —— `apps/ohna-cli/src/cli/web-host.ts:86`：
   ```ts
   const conversation = await server.createConversation(options.conversationTitle);  // ← 启动即建
   ```
   进程启动即创建一条会话，与「是否发送消息」完全无关。

3. **CLI `/clear`** —— `apps/ohna-cli/src/commands/session-commands.ts:288`（见 BUG-006，`/clear` 直接 `ctx.store.create` 建新会话）。

### 修复建议

- **web**：`handleNewConversation` 不再立即 `createConversation`，改为「本地占位空会话」进入编辑态；真正 `createConversation` 只在 `submitAgentMessage` 首次发送时执行（现有 `if (!conversation) createConversation` 分支已具备该能力，去掉提前建会话即可）。需要处理「占位会话未发送即离开」时不残留空记录。
- **CLI 托管**：`web-host.ts` 启动时不要 eager 建会话；改为首条消息到达时懒创建（或仅在前端确实发起 run 时创建）。
- 统一原则：**会话落盘的唯一触发点是「首条真实 message 发送」**。

---

## BUG-005 · 会话标题用「前 24 字符截断」，未做语义化（应过 LLM 生成标题）

### 现象描述

web 侧会话标题当前只是把首条用户消息**截断前 24 个字符**（超长加 `...`），例如输入「帮我重构 packages/agent 的 agentLoop 让它可以……」得到的标题是「帮我重构 packages/agent 的 agen...」。标题可读性差、不能反映任务语义。用户期望标题**经 LLM 整理成语义化短句**（如「重构 agentLoop 支持单步恢复」）。

### 原因定位

`apps/ohna-web/src/features/workbench/format.ts:110-112`：

```ts
export function createConversationTitle(message: string): string {
  return message.length > 24 ? `${message.slice(0, 24)}...` : message;
}
```

纯字符串截断，无任何 LLM 参与。调用点：

- `Workbench.tsx:493`（首条消息创建会话时）：`createConversation({ title: createConversationTitle(trimmed) })`。
- `Workbench.tsx:506,552`（占位「新会话」发送首条消息后改写标题）：同样用 `createConversationTitle(trimmed)`。

CLI 侧 `web-host.ts` 与 `session-commands.ts` 也有「新会话」默认标题，但语义化标题需求主要在 web 展示侧（侧栏列表）。

### 修复建议

1. **首条消息后异步生成语义标题**：会话创建时先用截断标题占位（保证落盘可回显），随后调用一次轻量 LLM（复用现有 provider / `streamSimple`）把首条用户消息概括为 ≤N 字标题，成功后 `updateConversation` 回写标题（失败静默保留截断标题，不阻塞 run）。
2. **避免额外成本/延迟影响主流程**：标题生成应是**尽力而为的后台任务**，失败降级、不纳入会话 token 成本统计（或单独记账）。
3. 统一 web 与 CLI 两侧的标题策略（若 CLI 也展示语义标题，则共用同一生成逻辑；否则至少 web 侧栏语义化）。

### 修复记录

采用「截断占位 → 异步语义化」两步策略，失败静默降级为截断标题：

- **服务端**新增 `packages/serve/src/run/title.ts` 的 `createTitleGenerator`（复用 model + apiKey + streamFn，中文提示词约束 ≤20 字，失败返回 `undefined`），`RunManager` 增加 `generateTitle(text)` 懒构造复用同一生成器；新增 `POST /api/conversations/:conversationId/generate-title` 端点与进程内句柄 `generateConversationTitle(conversationId, text)`。
- **web** 侧 `Workbench.tsx` 把「首条消息后改写标题」统一收口到 `ensureConversationTitle`：先立即用 `createConversationTitle` 落盘截断标题保证侧栏可用，再 fire-and-forget 调用语义标题端点并 PATCH 回写，失败保留截断标题，绝不阻塞消息发送。
- 降级兜底 `createConversationTitle` / `deriveTitle` 保留不动（截断仍是可靠兜底）。

---

## BUG-006 · `/clear` 不应直接创建新会话

### 现象描述

CLI 执行 `/clear` 时，直接调 `ctx.store.create(...)` **立即新建并落盘一条新会话**（旧会话保留）。用户预期 `/clear` 只是「清空当前上下文」，不应立刻产生一条新会话记录——与 BUG-004 同一类问题：会话应在「发送第一条消息」时才真正创建。

### 原因定位

`apps/ohna-cli/src/commands/session-commands.ts:282-293`：

```ts
export async function clearSession(ctx: SessionCommandContext): Promise<void> {
  const previousId = ctx.getSessionId();
  ctx.history.length = 0;
  ctx.tracker.restore({ input: 0, output: 0, total: 0, cost: 0 });
  resetPresentation();
  const meta = await ctx.store.create({ workspaceRoot: ctx.setup.cwd });  // ← 立即建新会话落盘
  ctx.setSessionId(meta.id);
  ctx.setTitle(undefined);
  ctx.onSessionSwitched?.();
  write(`已清空上下文并开启新会话：${meta.id}（旧会话 ${previousId} 保留在磁盘）\n`);
}
```

`/clear` 的语义被实现成「立刻新建会话」，而不是「清空上下文、等首条消息再建」。

同理，web 托管模式的 `/clear`（`apps/ohna-cli/src/cli/web-entry.ts:308-315`）也直接 `server.createConversation()`：

```ts
clear: async () => {
  const previousId = conversationId;
  const fresh = await server.createConversation();   // ← 立即建
  await switchConversation(fresh.conversationId, fresh.title);
  ...
}
```

### 修复建议

- `/clear` 改为「清空内存历史 + 标记『待创建』状态」，**不落盘新会话**；`ctx.sessionId` 可置为一个未持久化的临时占位，直到下一条真实消息发送时再 `store.create`（复用首条消息落盘路径）。
- 需要处理「`/clear` 后直接 `/exit`（未再发消息）」不产生空会话，以及「`/clear` 后连续 `/clear`」不产生多条空会话。
- web 托管 `/clear` 同理：不 `createConversation`，退订旧会话、进入无会话的待创建态。

---

## BUG-007 · `/clear` 后 CLI 顶部 logo 不显示

### 现象描述

CLI 启动时顶部会显示块状 OHNA logo + 信息行（工作目录/工具/会话/快捷键等），但执行 `/clear`（或 `/resume`/fork 切换会话）后，顶部 logo 与信息行消失，只剩对话流，用户看不到「新会话」的开场头。

### 原因定位

欢迎头只在**进程启动时渲染一次**，会话切换路径没有重新渲染。

1. `apps/ohna-cli/src/input/repl.ts:166-175`：`renderWelcome(...)` 在 `runRepl` 启动流程里**只调用一次**（进程进入输入循环之前）。
2. `/clear` 的实现（`session-commands.ts:282-293`）做了 `resetPresentation()` + `setSessionId()` + `onSessionSwitched()`，但**没有重新调用 `renderWelcome`**。`resetPresentation()` 只清空「对话流条目与打印布局状态」（`ui/render.ts:119`），不负责重新打印欢迎头/logo。
3. 同理 `/resume`（`session-commands.ts:225-227`）与 `fork`（`:265-266`）切换会话后也不重打欢迎头。

因此 `/clear` 后（TUI 整屏模式尤其明显）顶部既无 logo 也无会话信息行，只有一条 `已清空上下文并开启新会话：<id>` 的普通输出。

### 修复建议

1. **会话切换后重新渲染欢迎头**：在 `/clear`、`/resume`、`fork` 的 `onSessionSwitched` 或对应命令里，用新会话 id 重新调用 `renderWelcome`（传入 `sessionId`、`cwd` 等），让 logo + 信息行随新会话一起显示。
2. **注意与 TUI 整屏模式协同**：`renderWelcome` 经 `write()` 出口，TTY 整屏模式下由 sink 注入为 `tui.append` 进入对话模型顶部（`welcome.ts:73` 注释），因此重打欢迎头应能正确追加到新会话顶部，但需确认 `resetPresentation()` 清空的是旧会话条目、与欢迎头追加顺序不冲突。
3. **确认非 TTY / 管道模式**：非 TTY 欢迎头含模型行与多轮提示，`/clear` 后是否重打需保持一致（避免管道下重复输出大量欢迎文案）；可仅在 TTY 模式重打 logo+信息行，非 TTY 维持轻量提示。

---
