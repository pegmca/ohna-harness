/**
 * Electron main / preload / utilityProcess / runtime 之间的版本化跨进程协议 DTO。
 *
 * 这是 desktop 形态下 4 个进程角色共享的长期线格式契约（spec §4.1/§4.2）：
 *   - main（主进程编排）
 *   - preload（渲染进程沙箱桥）
 *   - utilityProcess（runtime worker，承载 ohna-runtime）
 *   - runtime（worker 内的会话/run 执行核）
 *
 * 设计要点：
 * 1. **版本化信封**：每个请求 / 响应 / 事件都带 `protocolVersion`，让 preload 与 worker
 *    在协议不一致时 fail-closed（`protocol_mismatch`），而不是默默错配字段。
 * 2. **错误码归一**：`RuntimeErrorCode` 是跨边界的统一错误命名空间，覆盖鉴权 / 路由 /
 *    协议 / 运行时不可用 / 工作区不可用 / Agent / 工具 / 中断 / 内部错误，避免每个进程
 *    各自发明错误字符串。
 * 3. **复用既有 run-v2 线格式**：`RunAcceptedDtoV2` / `RunStartResultDto` 直接引用
 *    `run-v2.ts` 的 `RunStatusDtoV2` / `RunSnapshotDtoV2` / `RunStreamEventDtoV2`，
 *    不重复定义 run 协议；`ConversationSummaryDto` 复用 `conversation.ts` 的
 *    `ConversationStatusDto`，保证桌面端列表与 serve 列表状态语义同源。
 *
 * 本文件只收跨边界 DTO / 线格式（与 `@aiagent/types` 整体定位一致），不引入运行时依赖。
 */

import type {
  RunStatusDtoV2,
  RunSnapshotDtoV2,
  RunStreamEventDtoV2,
} from "./run-v2.js";
import type { ConversationStatusDto } from "./conversation.js";

/**
 * 跨进程协议版本。preload / worker / runtime 任意一端在收发信封时必须校验该字段，
 * 不匹配即返回 `protocol_mismatch`（fail-closed），禁止隐式降级字段语义。
 *
 * 当前为第一版。
 */
export const PROTOCOL_VERSION = 1 as const;

/**
 * 请求信封：main → worker / runtime 的方法调用统一外壳。
 * @property protocolVersion - 协议版本，必须等于 `PROTOCOL_VERSION`。
 * @property requestId - 调用方生成的请求幂等键，响应信封原样回填。
 * @property method - 方法名（如 `run.create` / `conversation.list`），由 worker 路由。
 * @property payload - 方法特定参数；类型由 method 隐含，协议层保持 `unknown`。
 */
export interface RuntimeRequestEnvelope {
  protocolVersion: number;
  requestId: string;
  method: string;
  payload: unknown;
}

/**
 * 响应信封：worker / runtime → main 的方法返回统一外壳。
 * @property ok - true 时 `data` 携带结果，false 时 `error` 携带错误。
 * @property data - 成功结果；类型由 method 隐含，协议层保持 `unknown`。
 * @property error - 失败时的归一错误（见 `RuntimeErrorDto`）。
 */
export interface RuntimeResponseEnvelope {
  protocolVersion: number;
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: RuntimeErrorDto;
}

/**
 * 事件信封：worker / runtime → main 的单向事件流（run 流式事件、生命周期通知等）。
 * @property subscriptionId - 订阅幂等键，main 据此分发到对应的渲染订阅者。
 * @property event - 复用 `RunStreamEventDtoV2`，与 serve SSE 同源。
 */
export interface RuntimeEventEnvelope {
  protocolVersion: number;
  subscriptionId: string;
  event: RunStreamEventDtoV2;
}

/**
 * 跨边界统一错误码命名空间。覆盖鉴权 / 路由 / 协议 / 运行时 / 工作区 / Agent / 工具 / 中断 / 内部。
 *
 * 关键错误码语义：
 *   - `runtime_unavailable`：runtime worker 未就绪或已退出（不可重试，需用户重启 worker）。
 *   - `protocol_mismatch`：信封 `protocolVersion` 与本端 `PROTOCOL_VERSION` 不一致（fail-closed）。
 *   - `workspace_unavailable`：工作区未授权 / 路径不可访问 / 已被移除。
 *   - `run_interrupted`：run 在终态前被外部取消或 worker 崩溃后恢复中断。
 */
export type RuntimeErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation_failed"
  | "runtime_unavailable"
  | "protocol_mismatch"
  | "workspace_unavailable"
  | "agent_failed"
  | "tool_failed"
  | "run_interrupted"
  | "internal_error";

/**
 * 归一错误 DTO：所有跨进程失败统一走该结构，避免裸 Error 字符串泄漏到渲染层。
 * @property code - 归一错误码（见 `RuntimeErrorCode`）。
 * @property message - 面向用户的可读消息（不包含内部堆栈）。
 * @property requestId - 关联请求幂等键，便于日志追踪。
 * @property details - 可选的结构化补充（如字段级校验错误、tool 名等）。
 */
export interface RuntimeErrorDto {
  code: RuntimeErrorCode;
  message: string;
  requestId: string;
  details?: Record<string, unknown>;
}

/**
 * 运行时健康状态：worker 启动后定期上报，main 据此决定是否接受新 run。
 * @property status - `ok` 全部就绪；`degraded` 部分依赖不可用（如某工作区失联）但可服务；
 *   `unavailable` worker 不可服务（模型未加载 / 致命初始化失败）。
 * @property modelCount - 已加载模型数；0 表示 `unavailable`。
 * @property workspaceCount - 已授权工作区数。
 */
export interface RuntimeHealthDto {
  status: "ok" | "degraded" | "unavailable";
  protocolVersion: number;
  modelCount: number;
  workspaceCount: number;
}

/**
 * 工作区描述符：runtime 维护的已授权工作区列表项。
 * @property workspaceId - 稳定 ID（同一 dataDir 下唯一）。
 * @property displayPath - 用户可读的绝对路径（用于 UI 展示与工作区切换）。
 * @property status - `authorized` 表示可执行编码工具；`unavailable` 表示路径失联或权限丢失。
 */
export interface WorkspaceDescriptorDto {
  workspaceId: string;
  displayPath: string;
  status: "authorized" | "unavailable";
}

/**
 * 会话摘要 DTO：桌面端侧栏列表项。
 *
 * 与 `conversation.ts` 的 `ConversationDto` 区别：本类型带 `workspaceId`，因为桌面端
 * 一个 runtime 可承载多个工作区，会话按工作区分组；serve 的 `ConversationDto` 不带该字段
 * （serve 单实例单工作区）。状态字段复用 `ConversationStatusDto` 保证语义同源。
 */
export interface ConversationSummaryDto {
  conversationId: string;
  title: string;
  status: ConversationStatusDto;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  archivedAt?: string;
  workspaceId: string;
}

/**
 * Run 受理回执：`run.create` 成功后立即返回的定位信息。
 *
 * 与 `run-v2.ts` 的 `AgentRunAcceptedDto` 区别：后者带 `eventsUrl` / `snapshotUrl`
 * （HTTP 路由信息，serve 专用）；本类型面向跨进程协议，定位通过 `subscriptionId`
 * 订阅事件流完成，不需要 URL。`status` 复用 `RunStatusDtoV2`（受理时通常为 `queued`）。
 */
export interface RunAcceptedDtoV2 {
  runId: string;
  requestId: string;
  conversationId: string;
  modelId: string;
  status: RunStatusDtoV2;
}

/**
 * Run 启动结果：`run.create` / `run.start` 的完整响应。
 *
 * 一次性返回受理回执 + 当前快照 + 订阅幂等键 + 已有的初始事件流，让调用方在单次
 * 跨进程往返内拿到渲染首屏所需的全部数据（避免「先受理再订阅」的两段式握手带来的
 * 渲染空白窗口）。后续事件经 `RuntimeEventEnvelope` 持续推送。
 * @property accepted - 受理回执（含 runId / status 等）。
 * @property snapshot - 当前 run 快照（已落盘的最新状态）。
 * @property subscriptionId - 事件流订阅幂等键，对应 `RuntimeEventEnvelope.subscriptionId`。
 * @property initialEvents - 订阅时点之前已持久化的事件（按 sequence 升序），订阅后只推送增量。
 */
export interface RunStartResultDto {
  accepted: RunAcceptedDtoV2;
  snapshot: RunSnapshotDtoV2;
  subscriptionId: string;
  initialEvents: RunStreamEventDtoV2[];
}
