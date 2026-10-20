# 02 · ohna CLI 自动启动 Web 观测台 + LLM 请求/响应全程追踪

> **需求来源**（用户决策，2026-10-20）：`ohna-cli` 启动时同步启动 ohna-web；web 是完整 agent client，核心目标是**在 web 上观测完整 trace**，尤其每次 LLM 请求的**请求参数**与**返回的响应参数**。
> 与 `01-cli-optimization-plan.md` 的关系：01 是 CLI/TUI 表现层改造（C 系），本文是新的观测能力（W 系），两线独立，不共享交付物。
>
> 核心结论（本文要落地的三件事）：
> 1. **采集层**：包一层 `streamFn` wrapper，利用 `packages/ai` 现成的 `onPayload` / `onResponse` 钩子 + `done/error` 事件的最终 `AssistantMessage`，一次调用同时捕获统一请求参数与实际 provider 请求体，以及完整响应。**不改 `agent-loop.ts` 本体**。
> 2. **观测面**：`packages/serve` RunManager 扩展两种能力——自身 run 自动发 `llm_call` 事件（托管模式同享），以及 CLI 本地 run 的**镜像观测入口** `observeRun`（不改执行权归属）。
> 3. **CLI 接线**：默认 `ohna` 启动 = TUI repl 照常 + 进程内起 serve + 每次 run 把事件与 llm_call 镜像给 web；`--no-web` 降级为本地 JSONL 落盘。
>
> 执行纪律：沿用 v1.3/04 头部声明与 `设计演进记录` §3 七步法——每阶段「窄切片 + 可验收」、跑 §10 验收总闸相关子集、同步本文状态表 + ``（新建）。

---

## 0. 需求与范围

### 0.1 需求判定

| 编号 | 需求 | 判定 |
|---|---|---|
| R1 | `ohna-cli` 启动时同步启动 ohna-web（可关闭） | 默认进程内起 serve + 静态托管 `apps/ohna-web/dist`；`--no-web` 关闭；`--web` 托管模式保持现状 |
| R2 | web 观测完整 trace，重点是每次 LLM 请求的参数与响应 | 采集层产出 `LlmCallRecordDto`，经 run 事件面（SSE + JSONL 落盘）到 web 的 Trace 观测台（`/trace` 页） |
| R3 | 不破坏 CLI 现有交互 | 默认 repl 继续**本地 agentLoop 执行**（steering / follow-up / TUI 权限卡 / 预算钩子原样）；serve 只做镜像观测 |
| R4 | 遵守仓库既有边界与类型规则 | DTO 归 `@aiagent/types`；trace 包保持零运行时依赖；金融线零改动 |

### 0.2 现状锚点（本次探查结论，实施时按此验证）

1. **采集钩子已存在且零使用者**：`StreamOptions.onPayload`（`packages/ai/src/types.ts:64-66`；实现点 `api/openai-completions/index.ts:300-304`，在 `buildParams` 之后、POST 之前观察**最终 provider 请求体**，返回值可替换 payload）与 `onResponse`（`index.ts:267`，`{status, headers}`）。`AgentLoopConfig extends SimpleStreamOptions`（`packages/agent/src/types.ts:127-168`），`...config` 在 `agent-loop.ts:358` 原样进入流调用——**不改 loop 本体即可注入**。
2. **响应面无需触碰 SSE 帧级解析**：`done` / `error` 事件自带最终 `AssistantMessage`（content blocks、toolCalls、usage、stopReason、responseId、errorMessage；cost 由 `calculateUsageCost` 在收尾填充，`openai-completions/index.ts:316/327`）。事件契约 =「失败编码进事件流，不抛出」（`types.ts:79-84`）。
3. **serve 事件管线可复用**：`emitFrame`（`run-manager.ts:511-544`）统一分配 sequence + 落盘 + 双订阅（进程内回调 + SSE replay/live）；`message_update` 是唯一瞬态不落盘事件（`run-store.ts:49`），其余 kind 天然持久——新增 `llm_call` kind 无需存储器改造。
4. **CLI 本地 repl 与 serve 是两条独立执行线**：`turn.ts` + `repl.ts` 直驱 agentLoop（裸 `AgentEvent` → `renderEvent`），不经 serve（`turn.ts:180-247`）；`--web` 托管模式（`web-entry.ts`）才把执行权交给 RunManager。**把默认 repl 迁入 serve 会失去 steering/follow-up/本地权限卡/预算钩子——所以采用镜像观测而非执行迁移（D1）**。
5. **新事件 kind 的一致性检查点**：`@aiagent/trace` 的 `RunEventType`（`trace/src/index.ts:12-29`）、`@aiagent/types` 的 `RunEventTypeDto`（`types/src/run-v2.ts:20-39`）、run-store 持久化过滤（只 `message_update` 瞬态）、金融 Postgres CHECK 约束（`packages/database/src/schema.ts:340`）。前三个必须改/自动放行；第四个属金融线，本期不动（D8）。
6. **子路径 streamFn 注入面**：Team 子代理 `options.streamFn ?? streamSimple`（`team/controller.ts:125`，`team/types.ts:151-152`），组合根传入同一个被包装 streamFn 即可全覆盖；`goal-controller.ts:197` 与 `plan-reflexion/*` 有独立默认值，接线清单见 W3。

---

## 1. 架构决策（本轮拍板，实现时不再逐项讨论）

- **D1 · 观测不接管执行**：默认 `ohna` = TUI repl 本地执行 + 进程内 serve 观测（镜像 run）；`--web` 托管模式语义不变（run 全部经 RunManager）。CLI 运行时行为（K2 排队、权限卡、`--max-*` 预算）零回归。
- **D2 · 采集在调用方 wrapper**：`createLlmTraceStreamFn(base, emit)` 放 `packages/agent/src/llm-trace.ts`（新领域模块，先例：`apps/finance-api/src/application/circuit-breaker.ts:88-115`、`verify-server.ts:71-137`、`test-double-model.ts:244-249`），`agent-loop.ts` 零 diff。
- **D3 · DTO 归属**：`LlmCallRecordDto` 收进 `@aiagent/types/src/llm-trace.ts`（跨边界：SSE / JSONL 落盘 / web 反序列化三方共用；`message`、`providerPayload` 用 `unknown` + JSDoc 标明结构来源，先例 `LinearMessageDto.usage?: unknown`）。`@aiagent/trace` 与 `@aiagent/agent` 以 `import type` 引用并显式声明依赖（类型级依赖，运行时零符号，符合「依赖声明与实际引用一致」规则）。
- **D4 · 记录粒度 = 一次 stream 调用**：一次 wrapper 消费 = 一条 `llm_call` 记录（一次 LLM 请求）。`attemptCount` 仅统计 adapter **显式构造/重放 payload** 的次数；当前 `openai-completions` 的 HTTP 重试发生在 `retryProviderRequest` 内、不重建 payload，故生产恒为 1（逐次 attempt 录制见 §8 开放项）。与用户「每次请求」的需求对齐；run → callIndex 对应关系清晰。
- **D5 · 采集白名单**：request = {provider, api, modelId, baseUrl, systemPrompt, convertToLlm 后的 messages, tools(name/description/inputSchema), temperature, maxTokens, reasoning, toolChoice, providerPayload(最终替换后), attemptCount}；response = {status, finishReason, usage(含 cost), 最终 AssistantMessage, responseId, responseModel}。**永不采集 apiKey / Authorization / 其余 headers**——排除在写入层，不依赖事后脱敏。
- **D6 · 全量记录、不截断**：本地信任模型下不设默认长度截断（截断会让「看请求参数」失效；messages/providerPayload 可能达数 MB，接受本地体积成本）。落盘层沿用 run-store 既有 `redactSensitiveText`（`run-store.ts:84-95`）模式级脱敏兜底。web 端按需流式（见 D9）。
- **D7 · 事件 kind 命名 `llm_call`，可持久化**：payload = `LlmCallRecordDto`。两端既有渲染对未知 kind 免疫（ohna-web `live-run-projection.ts:164-165` default break；`web-entry.ts:46-57` 白名单过滤）——由 W4 显式渲染，托管模式旧终端不受影响。
- **D8 · 金融线零打扰**：`llm_call` 仅由 ohna 两路径（serve 执行 / CLI 镜像）生产；金融 Postgres `run_events.event_type` CHECK（`packages/database/src/schema.ts:340`）本期不动，金融 run-service 对未知类型保持 no-op（其 switch/default 现状）。**开放项**：金融线未来若要消费 `llm_call`，再补 CHECK 迁移（届时按 Database Rules 附 `COMMENT ON COLUMN`）。
- **D9 · 传输复用 run-v2**：CLI 镜像 run 走 RunManager 的既有 SSE/存储/sequence 语义——web 端现有 `run-stream-client`（`createAndStreamRun` / `replayRunEvents` / 按 sequence 续传）直接可用，不新建传输协议。**不新建 trace 专用 SSE 通道**（避免平行实现 sequence/落盘/续传）。
- **D10 · 观测降级链**：host 启动失败/端口耗尽 → TUI 提示 + 继续纯本地（观测缺失不阻塞 CLI）；`--no-web` → wrapper 仍生效，记录落 `~/.ohna/traces/<sessionId>.jsonl`（每行一条 record，供 jq 事后排查）。两条降级链共用同一 wrapper，仅 sink 不同。
- **D11 · abort/异常语义**：区分两种 throw——(a) streamFn **同步抛错**（调用栈内）→ wrapper 先发 error 记录再**原样 rethrow 同一对象**；(b) 流已返回后的 pump **迭代 reject** → 因无法再投递给调用方，改写为 error 终态事件（同一文案），避免 unhandled rejection。事件流正常结束但无终态事件（Ctrl-C 场景）→ 发 `error: {message: "stream ended without terminal event"}`（signal 已 abort 时附 `stopReason:"aborted"`）。观测不能改变 run 的失败语义。

---

## Phase W1 · LLM 采集层（记录 DTO + streamFn wrapper）

**目标**：任何调用方（serve / CLI repl / 未来 host）用同一个包装函数，把每次 LLM 请求/响应变成一条结构化记录。验收后 CLI 与 serve 都能独立消费。

**交付清单（文件级）**：

1. `packages/types/src/llm-trace.ts`（新）+ `packages/types/src/index.ts` 导出：
   ```ts
   /** 一次 LLM 请求/响应的线格式记录（SSE 落盘/web 反序列化共用）。 */
   export interface LlmCallRecordDto {
     callId: string;              // randomUUID
     callIndex: number;           // run 内第几次 LLM 调用，从 1 起
     startedAt: number;           // epoch ms
     durationMs?: number;
     attemptCount: number;        // onPayload 被观察到几次（重试次数内化，默认 1）
     request: LlmCallRequestDto;
     response?: LlmCallResponseDto;   // done/error 到达且可汇聚时存在
     error?: { message: string; stopReason?: string }; // abort/无终态/throw 时存在
   }
   export interface LlmCallRequestDto {
     provider: string; api: string; modelId: string; baseUrl: string;
     systemPrompt?: string;
     /** 统一 Message[]（transformContext → convertToLlm 之后的最终序列），structuredClone 快照。 */
     messages: unknown;
     tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
     temperature?: number; maxTokens?: number; reasoning?: string; toolChoice?: unknown;
     retries?: number;            // 调用方配置的 maxRetries（语义同 StreamOptions）
     /** 实际发给 provider 的请求体（onPayload 观察的最终 payload，含 provider 专有字段）。 */
     providerPayload?: unknown;
   }
   export interface LlmCallResponseDto {
     status?: number;             // HTTP 状态（onResponse 观察；连接失败时不存在）
     finishReason?: string;       // = AssistantMessage.stopReason
     usage?: LlmCallUsageDto;     // tokens + cost（对齐 Usage，含 cost.total）
     responseId?: string; responseModel?: string;
     /** done/error 事件的最终 AssistantMessage（content blocks / toolCalls / errorMessage）。 */
     message?: unknown;
   }
   export interface LlmCallUsageDto { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; totalTokens: number; cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number; total: number } }
   ```
   全量中文 JSDoc；`message / providerPayload / messages` 类型用 `unknown` + JSDoc 注明结构来源（@aiagent/ai 的 `AssistantMessage` / `Message`），保持 types 叶子纯净（D3）。
2. `packages/agent/src/llm-trace.ts`（新）：
   ```ts
   export type LlmTraceSink = (record: LlmCallRecordDto) => void;
   export function createLlmTraceStreamFn(base: StreamFn, sink: LlmTraceSink): StreamFn
   ```
   语义（全部中文注释 + 学习点注释）：
   - 每次消费：`callId/startedAt` 分配；请求快照 structuredClone（messages/providerPayload 防流式期别名突变）；临时重入无状态（wrapper 纯函数于每次调用）。
   - 链式注入 `options.onPayload`：先执行调用方已有 onPayload（若替换 payload，观察到替换后最终值），后观察记录 + `attemptCount` 计数；`onResponse` 观察 `{status}`。
   - 透传全部事件（流式不打断、不改序）；`done` / `error` 事件到达时汇聚 response/message/error + `durationMs`，调 sink。
   - 上游 throw → 先发 error 记录再 rethrow（保原错误对象）；无终态事件即结束（abort）→ 发 `error {stopReason:"aborted"}` 或 "stream ended without terminal event"。
   - wrapper 不做脱敏（D5/D6）。
3. `packages/agent/package.json`：`dependencies` 增加 `"@aiagent/types": "workspace:*"`（import type 引用，规则一致性）。
4. `@aiagent/trace`：
   - `packages/trace/src/index.ts`：`RunEventType` 联合 += `"llm_call"`；新增 `LlmCallTraceEvent`（payload 类型 `import type { LlmCallRecordDto } from "@aiagent/types"`，`RunEvent` 联合增加该成员）；包头部注释更新（trace 引入**类型级** workspace 依赖，运行时仍零依赖 `@aiagent/*`，不破坏「不依赖 ai/agent」红线）。
   - `packages/trace/package.json`：声明 `@aiagent/types`。
5. 测试 `packages/agent/test/llm-trace.test.mjs`（按 `agent-loop.test` 的 FakeStreamFn 模式）：
   - 记录完整形状：request 快照（messages/tools/参数）、providerPayload 捕获、链式 onPayload 先用户后观测且感知替换；
   - done → response.usage/finishReason/message 聚合；error 事件 → error 聚合；
   - 上游 throw → error 记录 + rethrow 原错误；无终态事件 → error 记录；
   - `attemptCount` 按注入次数计数（3 次）。

**验收**：

```bash
pnpm --filter @aiagent/types typecheck && pnpm --filter @aiagent/trace test && pnpm --filter @aiagent/agent test
pnpm typecheck && pnpm architecture:check
```

**完成判据**：`git diff packages/agent/src/agent-loop.ts` 为空（D2）；CLI/serve 在未接线时行为零变化（wrapper 尚未被任何人消费）。

---

## Phase W2 · serve 观测面（RunManager 两条扩展）

**目标**：(a) serve 自托管路径（`--web` / `ohna-api`）的每次 run 自动产生 `llm_call` 事件；(b) 新增 CLI 镜像入口 `observeRun`，把外部执行的事件灌进同一存储/SSE/sequence 语义。

**交付清单（文件级）**：

1. `packages/types/src/run-v2.ts`：`RunEventTypeDto` 联合 += `"llm_call"`（JSDoc：ohna 观测扩展，payload = `LlmCallRecordDto`，各 DTO 包已引用该 record 类型）。
2. `packages/serve/src/run-manager.ts`：
   - `execute` 内 per-run 包装 streamFn：`createLlmTraceStreamFn(options.streamFn ?? streamSimple, (record) => emitTypedFrame(run, "llm_call", record))`——把现有 `emitAgentEvent`（`run-manager.ts:500-502`）推广为 `emitTypedFrame(run, type, payload)`（复用 `emitFrame` 的 sequence/落盘/广播语义）。
   - 新增 `observeRun(input: { conversationId, requestId?, title? }) → ObservedRun`：
     ```ts
     interface ObservedRun {
       runId: string;
       push(event: AgentEvent | { type: "llm_call"; payload: LlmCallRecordDto }): void;
       end(result: { failed?: boolean }): void;   // 合成 run_status 终态 + forceTerminal
     }
     ```
     实现要点：run_meta 记 `{mode:"observe", source:"cli"}`；会话订阅者挂接（同 `createRun:216-220`）；AgentEvent 分支复用 `handleAgentEvent` 类型映射，但 `message_end` **跳过 `persistRunMessage`**（观测型不落会话消息，避免消息双份存储）；`llm_call` 直接 emit；`push` 不抛错（失败吞掉并记账，观测不能打断 CLI——与 subscriber 广播失败吞掉语义一致）。
3. `packages/serve/src/store/run-store.ts`：新增 `<dataDir>/runs/index.jsonl` 追加 `run_index` 索引行 + `listRunsByConversation(conversationId, statusResolver)`（磁盘行 + 内存态 status 合并；`runs/<id>.jsonl` 首行结构不变）。
4. `packages/serve/src/routes/runs.ts`：新增 `GET /api/conversations/:conversationId/runs`（返回 run meta 列表：runId/status/createdAt/mode/source/requestId）。静态只读，供 W4 runs 侧栏。
5. 测试 `packages/serve/test/observe-run.test.mjs`：
   - observeRun + push 合成事件序列 → `runs/<id>.jsonl` 落盘含 `llm_call`（非瞬态）与不含 `message_update`（瞬态）；`message_end` 未写 conversations 消息存储；
   - `subscribeRun` / SSE（复用 events 路由）按 sequence replay + live；
   - `listRunsByConversation` 索引正确；
   - 托管 run（createRun + stub streamFn，stub 在 `options.onPayload` 中回填模拟 payload——即 W1 装配的观察端到端验证）→ `llm_call` 自动出现在事件流，`payload.request.providerPayload` 为完整请求体，`response.message`/`usage`/`durationMs` 聚合到位。

**验收**：

```bash
pnpm --filter @aiagent/serve test && pnpm typecheck && pnpm architecture:check
```

**完成判据**：observe 型 run 与托管型 run 在存储/SSE 层不可区分（同 envelope、sequence、端点）；托管模式旧消费方（web-entry 终端白名单）不受 `llm_call` 影响（D7 免疫验证）。

---

## Phase W3 · CLI 自动同步启动 Web + run 镜像接线

**目标**：默认 `ohna` = TUI repl 照常 + 进程内 serve 观测台；`--no-web` 本地落盘降级。

**交付清单（文件级）**：

1. `apps/ohna-cli/src/cli/args.ts`：新增 `--no-web`（默认观测台开启）；`--web-port` 继续复用；help 文案区分「默认模式（本地执行 + 观测台）」与「`--web`（托管模式）」。
2. `apps/ohna-cli/src/cli/web-host.ts`（新，从 `web-entry.ts` 抽共享装配）：
   ```ts
   export async function hostOhnaWeb(options: HostOptions): Promise<HostResult | undefined>
   // HostResult { server, url, conversationId }；失败（端口耗尽/装配异常）resolve undefined
   ```
   内含 createOhnaServer 装配（工具/模型/prompt 同 web-entry 现状）+ `listenWithRetry` + `createConversation("CLI · <sessionId 前 8>")`；web-entry.ts 退化为「hostOhnaWeb + 原 readline 逻辑」薄壳。`apps/ohna-web/dist` 缺失时复用 serve `static.ts` 占位页并打印构建提示（`pnpm --filter @aiagent/ohna-web build`）。
3. `apps/ohna-cli/src/index.ts` → `cli/harness.ts`：非 `--web` 分支先 `hostOhnaWeb`（`--no-web` 跳过），把 `observation` 上下文注入 repl；失败打印警告（stderr/toast）继续。**进程内只允许一个 host**（防 `--web` 与默认模式同进程双起——单入口分发天然满足，加断言）。
4. `apps/ohna-cli/src/runtime/turn.ts`：runTurn 增加 `observer?: TurnObserver`：
   ```ts
   interface TurnObserver { start(userText: string, meta: { sessionId: string; runIndex: number }): ObservedRun; }
   ```
   事件转发在现有 `for await`（`turn.ts:219-247`）内 `push(event)`；结束 `end({failed})`；streamFn 改为 `createLlmTraceStreamFn(streamSimple, record => observedRun.push({type:"llm_call", payload: record}))`（无 observer 时维持默认）。
5. `apps/ohna-cli/src/input/repl.ts` + `repl-context.ts`：`ReplContext` += `observation?: { start: TurnObserver }`；每次 `runTurn` 前 `observe(...)`（requestId = `<sessionId>:<turnIndex>`）。
6. `apps/ohna-cli/src/runtime/team-wiring.ts`：把**包装后**的 streamFn 传 `TeamControllerOptions.streamFn`（子代理 LLM 调用同享采集，`team/controller.ts:313` 消费同一函数）。
7. `apps/ohna-cli/src/runtime/llm-trace-file.ts`（新，`--no-web` 降级 sink）：append-only 写 `~/.ohna/traces/<sessionId>.jsonl`（每行一条 `LlmCallRecordDto`）；目录不存在则建；写失败静默降级（不阻塞）。
8. UI：welcome banner 追加一行 `Trace: http://127.0.0.1:<port>/trace`；TUI 状态行右段可选加 `web` 标识；host 失败走 toast（复用 C3 toast）。
9. 回看行为：`/resume` 切换 session 时保持同一 conversation（trace 页在 run 摘要中显示 requestId 内嵌的 `${sessionId}:${turnIndex}` 以区分会话），不新开会话（开放项：每 session 一个 conversation）。
10. 测试：`test/verify-ohna-web-trace.mjs`（根 test/ 目录，见 W5）；CLI 单测补：args `--no-web` 解析、turn observer 注入路径（mock observedRun 收到 message/tool/llm_call 帧）。

**验收**：

```bash
pnpm --filter @aiagent/ohna-cli test && pnpm typecheck && pnpm architecture:check
test/verify-ohna-m3.mjs      # 既有回归
```

手工：`pnpm --filter @aiagent/ohna-cli dev`（需先 `pnpm --filter @aiagent/ohna-web build`）跑一次含 read+bash 的编码任务 → 浏览器 `/trace` 出现该 run，`llm_call` 可展开看到请求/响应；`--no-web` 后 `~/.ohna/traces/` 出现记录行。

**完成判据**：默认启动对 TUI 交互零回归（K2/权限卡/预算照常）；`grep -c "import { agentLoop" apps/ohna-cli/src/input/repl*` 不变（repl 仍本地执行）；`apps/ohna-cli` 不新增对 `packages/serve` 以外的运行时依赖声明（serve 依赖已存在）。

---

## Phase W4 · ohna-web Trace 观测台（`/trace` 页）

**目标**：浏览器一侧完成 R2——列 runs、回放/实放事件流、`llm_call` 一等公民展示（请求参数 + 响应参数 + 复制）。

**交付清单（文件级）**：

1. `apps/ohna-web/src/features/trace/TracePage.tsx`（新）：左列 conversation 列表（复用 `conversation-client.ts`）→ run 列表（`GET /api/conversations/:id/runs`）→ 右侧 trace 流。顶部导航加 Trace tab（chat 主页不动；CLI 会话在 chat 页不承担输入，只提示"CLI 会话请用 Trace 观测台"——观测台页尾注明）。
2. `apps/ohna-web/src/features/trace/TraceStream.tsx`（新）：复用 `shared/api/run-stream-client.ts` 的 `replayRunEvents`（历史）+ `followRunEvents`（live，按 sequence 续传）；事件行渲染规则：
   - `llm_call` → `LlmCallBlock`（**一等公民**）：摘要行 `#<callIndex> · <modelId> · <durationMs>ms · in <tokens> · out <tokens> · $<cost>`（含 attemptCount>1 标记与 error 标记；attemptCount 当前生产恒为 1，标记仅在 adapter 多次重建 payload 时出现）；展开 → Tab：**请求参数**（Provider Payload / 统一 messages+tools 两个子 tab）、**响应**（message content blocks / usage / finishReason / responseId）、**原始 JSON**；每 tab 配「复制 JSON」。
   - `message_*` → 用户/助手文本行（流式期 live 增长，`message_update` 帧实时 patch）；
   - `tool_execution_*` → 工具行（参数 + 结果折叠；复用 `run-details.tsx` 的 JsonDetails 组织样式）；
   - `run_status` / `run_error` → 终态横条。
3. 类型来源：`LlmCallRecordDto` 直接 `import type` from `@aiagent/types`（apps/ohna-web 只依赖 `@aiagent/types` ✓，无需新增依赖）。
4. 样式：遵守 `DESIGN.md`（`system.css` tokens；折叠/details 复用现有组件样式，不发明新视觉体系——C 线已对齐）。
5. vitest（`apps/ohna-web/src/features/trace`）：fixture 事件序列 → LlmCallBlock 摘要与 JSON 面板渲染、复制内容正确、runs 列表 mock、replay/live 续传。

**验收**：

```bash
pnpm --filter @aiagent/ohna-web build && pnpm --filter @aiagent/ohna-web test
```

手工：CLI 跑任务 → 打开 `http://127.0.0.1:<port>/trace` → 选中当前 run → 任一 `llm_call` ≤2 次点击内展开看到完整 providerPayload 与响应 message/usage；刷新后（终态 run）通过 replay 恢复完整 trace。

**完成判据**：`llm_call` 在时间线是一等可见块；无 console 报错；chat 主页对 CLI 会话不出现空时间线误导（提示文案到位）。

---

## Phase W5 · 验证脚本与文档同步（W1-W4 交付时同步推进）

1. `test/verify-ohna-web-trace.mjs`（根 test/，人工调试入口合规）：
   - 起 serve（stub streamFn：push done 事件 + 注入假 providerPayload 观察路径）→ `createRun` → 断言事件流含 `llm_call`（payload.request.providerPayload 与 response.message/usage 完整、durationMs>0）；
   - `observeRun` 合成序列 → 同样断言（CLI 镜像路径）；
   - web dist 存在时 `GET /trace` 200。
2. ``（新建）：学习注记——采集 wrapper 机制（onPayload/onResponse/do-event plugin 组合）、DTO 归属推演（types 收线格式 + trace 类型级依赖）、observeRun 与托管 run 的统一性论证、降级链（host 失败 / --no-web）、abort 语义取舍。
3. 文档同步：本文 §6 状态表 + `设计演进记录` 阶段产出 + `AGENTS.md` 以下段落（落地后同步，不在启动前改）：
   - `apps/ohna-cli`：`cli/` 增加 `web-host.ts` 一句；`runtime/` 提 observation/llm-trace wrapper；默认启动语义（观测台 + `--no-web`）。
   - `packages/serve`：进程内句柄列表补 `observeRun / listRunsByConversation`；事件 kind 补 `llm_call`。
   - `packages/types` / `packages/trace` / `packages/agent`：导出面变化一句（LlmCallRecordDto / LlmCallTraceEvent / createLlmTraceStreamFn）。

---

## 5. 测试用例清单（W1–W5 统一补充）

> 每阶段的「交付清单」已内嵌测试文件名，本节把散落的用例收敛为**可逐条验收**的编号清单（TC-ID + 前置 + 关键断言）。命名规则：`TC-<阶段>-<序号>`；除 W4 用 vitest、W5 用根 `test/` 脚本外，其余用 `node --test`。所有断言写进对应阶段列出的测试文件，不新增第 7 个文件。

### W1 · LLM 采集层（`packages/agent/test/llm-trace.test.mjs`）

| ID | 用例 | 前置（FakeStreamFn 注入） | 关键断言 |
|---|---|---|---|
| TC-W1-01 | 记录完整形状（done 收尾） | 一次调用，`onPayload` 回填 `providerPayload`，最终 `done` | `request.provider/api/modelId/baseUrl/systemPrompt/messages/tools/temperature/maxTokens` 与回填的 `providerPayload` 齐全；`response.status/finishReason/usage(含 cost.total)/responseId/responseModel/message` 聚合到位；`durationMs` 为有限数（≥ 0）；`callId` 唯一、`callIndex === 1` |
| TC-W1-02 | 链式 onPayload 先用户后观测 | 调用方已传 `onPayload`（返回替换 payload） | 调用方 hook 先执行；wrapper 观察到的 `providerPayload` 是**替换后**最终值；`attemptCount` 按注入次数计数（注入 3 次 = 3） |
| TC-W1-03 | error 事件聚合 | 流以 `error`（reason=error）收尾 | `error.message` 存在；`response.message.errorMessage` 透传；`durationMs > 0` |
| TC-W1-04 | 上游 throw 重抛原错误 | streamFn 直接 throw 一个具名 Error | 先发出 `error` 记录，再 `rethrow` **同一错误对象**（`assert.equal` 引用相等） |
| TC-W1-05 | 无终态事件（abort） | 流正常结束但无 `done/error` | 发出 `error{ message: "stream ended without terminal event" }`（或 `stopReason:"aborted"`），不悬挂 |
| TC-W1-06 | 快照不可变 | `onPayload` 内先拿到 `request.messages` 引用，流式期再 mutate 原对象 | 已记录 `request.messages`/`providerPayload` 为深拷贝，不被后续突变污染（structuredClone 生效） |

### W2 · serve 观测面（`packages/serve/test/observe-run.test.mjs`）

| ID | 用例 | 前置 | 关键断言 |
|---|---|---|---|
| TC-W2-01 | observeRun 合成序列落盘 | `observeRun` + `push` 合成 `llm_call` 与 `message_update` | `runs/<id>.jsonl` 含 `llm_call`（非瞬态落盘）；**不含** `message_update`（瞬态） |
| TC-W2-02 | 观测型 message_end 不双份存储 | push `message_end` | `conversations/<id>.jsonl` 消息存储**无**该 run 的 assistant 消息（跳过 `persistRunMessage`） |
| TC-W2-03 | sequence replay + live | `subscribeRun` / events 路由 | 按 `sequence` 升序 replay；live 帧从 `lastEventSequence` 之后续传 |
| TC-W2-04 | runs 索引 | `listRunsByConversation` | `runs/index.jsonl` 索引行追加 `run_index`；磁盘行 + 内存态 status 合并正确（终态覆盖 running） |
| TC-W2-05 | 托管 run 端到端自动发射 | `createRun` + stub streamFn（`onPayload` 回填 providerPayload） | 事件流自动出现 `llm_call`：`payload.request.providerPayload` 为完整请求体，`response.message/usage/durationMs` 聚合 |
| TC-W2-06 | 旧消费方免疫（D7） | 用 `--web` 托管模式的事件白名单过滤 `llm_call` | 白名单过滤后旧终端不渲染 `llm_call`，无报错 |

### W3 · CLI 接线（`apps/ohna-cli/test/` 单测 + 手工）

| ID | 用例 | 前置 | 关键断言 |
|---|---|---|---|
| TC-W3-01 | `--no-web` 参数解析 | 解析 args | `--no-web` 为布尔、默认 false（观测台默认开）；help 文案区分默认模式与 `--web` 托管模式 |
| TC-W3-02 | turn observer 注入路径 | mock `ObservedRun` 传入 `runTurn` | observedRun 按序收到 `message_*` / `tool_execution_*` / `llm_call` 帧；`end({failed})` 被调 |
| TC-W3-03 | `--no-web` 降级 sink | `llm-trace-file.ts` 直写 | `~/.ohna/traces/<sessionId>.jsonl` 每行一条 `LlmCallRecordDto`；目录不存在自动建；写失败静默降级不抛 |
| TC-W3-04 | host 失败不阻塞 | `hostOhnaWeb` 端口耗尽/装配异常 | resolve `undefined` → TUI 打印警告（stderr/toast）→ 继续纯本地 repl |

### W4 · ohna-web Trace 观测台（`apps/ohna-web/src/features/trace/*.test` vitest）

| ID | 用例 | 前置（fixture 事件序列） | 关键断言 |
|---|---|---|---|
| TC-W4-01 | LlmCallBlock 摘要行 | 一条 `llm_call` 事件 | 摘要 = `#<callIndex> · <modelId> · <durationMs>ms · in <tokens> · out <tokens> · $<cost>`；`attemptCount>1` 与 `error` 有标记 |
| TC-W4-02 | LlmCallBlock 展开 Tab | 展开一条 `llm_call` | 请求参数（Provider Payload / 统一 messages+tools 两个子 tab）、响应（content blocks / usage / finishReason / responseId）、原始 JSON 均可切换查看 |
| TC-W4-03 | 复制 JSON | 点击复制 | 剪贴板内容与对应 tab 的 JSON 序列化一致 |
| TC-W4-04 | runs 列表 | mock `GET /api/conversations/:id/runs` | 侧栏按 runId/status/createdAt/mode/source/requestId 渲染 |
| TC-W4-05 | replay/live 续传 | 终态 run 刷新 + 活跃 run | 刷新走 `replayRunEvents` 恢复完整 trace；活跃 run 走 `followRunEvents` 按 sequence 续传 |

### W5 · 端到端验证脚本（根 `test/verify-ohna-web-trace.mjs`）

| ID | 用例 | 前置 | 关键断言 |
|---|---|---|---|
| TC-W5-01 | 托管 run 路径 | 起 serve + stub streamFn | 事件流含 `llm_call`：`request.providerPayload` 与 `response.message/usage` 完整、`durationMs>0` |
| TC-W5-02 | observe run 路径 | `observeRun` 合成序列 | 同上断言（CLI 镜像路径） |
| TC-W5-03 | web 静态托管 | `apps/ohna-web/dist` 存在 | `GET /trace` 返回 200 |
| TC-W5-04 | CLI 回归 | 跑 `test/verify-ohna-m3.mjs` | 既有 M3 回归全绿 |

> 实施期新增回归用例（保持可逐条验收）：TC-W2-07..12（cancel 守卫 / end 幂等 / error 透传 / 排序去重 / legacy 回填）、TC-W3-05（warm-up 缓冲）、TC-W4-05b 与 S4-①③、N6/N7，见对应测试文件。

---

## 6. 参考与先例对照（无外部参考）

本计划不引用外部代码；机制对应关系留档：

| 机制 | 仓库内先例 | 本文阶段 |
|---|---|---|
| streamFn 调用方包装 | `circuit-breaker.ts:88-115` / `verify-server.ts:71-137` / `test-double-model.ts:244-249` | W1 |
| 统一钩子注入（onPayload/onResponse） | `packages/ai` 预留（types.ts:64-67） | W1 |
| run 事件 kind 扩展管线 | `confirmation_requested`（serve 独有 kind 先例） | W2 |
| replay/live SSE 复用 | run-v2 events 路由（`routes/events.ts:45-146`） | W2/W4 |
| 折叠详情/JSON 面板 | `run-details.tsx` / `run-process.tsx` | W4 |

---

## 7. 不做清单（明确排除，防止范围膨胀）

- **不冒险**：不把默认 repl 迁入 serve RunManager（D1）；不改 `agent-loop.ts` 本体（D2）。
- **不采集** apiKey / Authorization / 其余 headers（D5）；不初始化任何远端/上传机制（本地可信）。
- **不做** 默认截断（D6）；不做原始 SSE 帧级录制（AssistantMessage 聚合已覆盖"响应内容"需求，开放项再议）。
- **不动金融**：不改 `packages/database/src/schema.ts:340` 的 CHECK、不改 finance-api（D8）。
- **不新建** trace 专用传输协议/专用 SSE 通道（D9）；不做 trace 全局搜索/过滤/导出（开放项）。
- **不做** CLI → web 的对话输入互通（web 端对 CLI 镜像会话只读；`--web` 托管模式才有双向输入——这是两条模式的本质差异）。

---

## 8. 开放项（本期不实施，留档案）

1. 金融线消费 `llm_call` 时补 Postgres CHECK 迁移（含 `COMMENT ON COLUMN`）。
2. `plan-reflexion/*` 与 `goal-controller` 的 streamFn 接线（各自默认 streamSimple，ohna 当前未用；若后续启用需注入同一 wrapper）。
3. 每个 CLI session 独立 conversation / conversation 标题按 session 切换更新。
4. provider 多 attempt 的逐次请求体录制：需在 `packages/ai` 的 `retryProviderRequest` 暴露 attempt 钩子（当前 `onPayload` 在其外层只调用一次，`attemptCount` 生产恒为 1）。
5. trace 记录的 web 端搜索（按模型/tokens/时间过滤）与导出（JSONL 下载）。
6. 常量 kill-switch `OHNA_TRACE=off`（当前由 `--no-web` 覆盖；env 开关可在 serve 装配层加）。
7. **run 前会话级压缩的摘要 LLM 调用不计入 trace**：压缩发生在 runId 分配之前，无法挂 `llm_call` 帧；W4 文案需说明「摘要请求不在 trace 中」。
8. **SSE live 帧与落盘 replay 的脱敏不一致**：live 广播原始 payload，JSONL replay 经 `sanitizeRunPayload` 模式级脱敏（邮箱/手机号等会变 `[redacted:*]`）。W4/W5 需说明「刷新后的正文经过模式级脱敏」，避免误以为记录被篡改。

---

## 9. 风险与缓解

| 风险 | 说明 | 缓解 |
|---|---|---|
| wrapper 改变错误语义 | 上游 throw 被 wrapper 掩盖/重抛变形 | D11：先发记录、rethrow 原对象；W1 测试覆盖 throw/abort/无终态三类 |
| 记录体积 | messages + providerPayload 可达数 MB | 本地 JSONL 按需读取；web 采用「点开 run 才拉 replay」+ afterSequence 续传，不全量常驻 |
| 观测型与存储双份消息 | observe 的 message_end 若落会话存储会双份 | W2 跳过 persistRunMessage；测试断言 conversations 存储无该 run 消息 |
| Team / 子代理遗漏 | 子代理绕过 wrapper → 记录不完整 或 团队链未消费 | W3-6 team-wiring 显式传 wrapped streamFn；验收含子代理调用截图/记录计数 |
| 事件 kind 不一致 | trace/types unify 不同 / run-service 未知类型异常 | 一致性检查点三处同步（锚点 5）；D8 说金融 no-op 现状 |
| 端口抢占 | 默认 4173 与既有 `--web` / ohna-api 冲突 | 复用 `listenWithRetry`（+1×20）；host 失败降级不阻塞（D10） |
| 性能 | structuredClone + JSON 序列化 per call | 每 run 每 call 一次，量级可接受；wrapper 不拦截流式增量（只在调用边界快照、终态聚合），整体延迟影响可忽略 |

---

## 10. 验收总闸（每个 Phase 跑相关子集）

```bash
pnpm --filter @aiagent/types typecheck
pnpm --filter @aiagent/trace test
pnpm --filter @aiagent/agent test
pnpm --filter @aiagent/serve test
pnpm --filter @aiagent/ohna-cli test
pnpm --filter @aiagent/ohna-web test
pnpm typecheck
pnpm architecture:check
pnpm build
```

端到端（W3/W4 完成时）：

```bash
test/verify-ohna-web-trace.mjs        # W5 落地后：两次路径（托管 run + observe run）断言 llm_call 完整
test/verify-ohna-m3.mjs               # CLI 回归
pnpm --filter @aiagent/ohna-cli dev   # 手工：TUI + 浏览器 /trace 双端验收
```

---

## 11. 状态表（随阶段完成更新）

| 阶段 | 内容 | 状态 |
|---|---|---|
| W1 | LLM 采集层：`LlmCallRecordDto` + `createLlmTraceStreamFn` | 已完成（agent 101/101；reviewer 两轮通过） |
| W2 | serve 观测面：RunManager `llm_call` 自动发射 + `observeRun` + runs 索引 | 已完成（serve 38/38；S1/S2 与 B2 差集回填已修） |
| W3 | CLI 自动启动 Web + run 镜像 + `--no-web` 降级 | 已完成（ohna-cli 294/294；共享 counter + observeOnly 只读） |
| W4 | ohna-web Trace 观测台（`/trace`） | 已完成（ohna-web 65/65 + build；S1-S4/N1-N7 已修） |
| W5 | 验证脚本 `test/verify-ohna-web-trace.mjs` + 设计笔记 + AGENTS.md 同步 | 已完成（脚本 4 断言通过；设计笔记 已同步） |
