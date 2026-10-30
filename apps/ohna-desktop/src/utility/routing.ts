/**
 * utilityProcess 内请求路由（spec §4.2 / §5）：把 `RuntimeRequestEnvelope.method` 映射到
 * `OhnaRuntime` 方法。该模块不依赖 Electron，可用假 runtime 在 node 下直接单测。
 *
 * 设计要点：
 * - 纯函数 `routeRuntimeRequest(runtime, envelope)`：入参是 runtime 子集与已校验信封，返回
 *   `RuntimeResponseEnvelope`；任何业务异常都归一成结构化错误，不泄漏原始堆栈。
 * - 订阅类方法（`events.subscribeRun` / `events.subscribeConversation`）不在此处直接返回，由
 *   worker 持有 subscription 句柄后回填 `subscriptionId`；这里只负责识别「这是订阅请求」，
 *   实际订阅注册见 `utility/worker.ts`。
 */
import {
  PROTOCOL_VERSION,
  type RuntimeErrorDto,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
  type RunStreamEventDtoV2,
} from "@aiagent/types";
import { toRuntimeError } from "@aiagent/ohna-runtime";

/** IPC 边界校验失败：携带结构化错误码，由 `toRuntimeError` 归一。 */
class RoutingError extends Error {
  constructor(
    readonly code: "bad_request",
    message: string
  ) {
    super(message);
    this.name = "RoutingError";
  }
}

/** worker 内持有的 runtime 能力子集（订阅由 worker 单独管理）。 */
export interface RuntimeRouter {
  getHealth(): Promise<unknown>;
  getModelCatalog(): Promise<unknown>;
  shutdown(): Promise<void>;
  registerWorkspace(workspaceId: string, workspaceRoot: string): Promise<unknown>;
  listWorkspaces(): Promise<unknown>;
  releaseWorkspace(workspaceId: string): Promise<void>;
  startRun(input: unknown): Promise<unknown>;
  getRunSnapshot(runId: string): Promise<unknown>;
  listRunsByConversation(conversationId: string): Promise<unknown>;
  cancelRun(runId: string): Promise<unknown>;
  resolveConfirmation(runId: string, toolCallId: string, decision: unknown, options?: unknown): Promise<unknown>;
  createConversation(input: unknown): Promise<unknown>;
  listConversations(query?: unknown): Promise<unknown>;
  updateConversation(id: string, input: unknown): Promise<unknown>;
  generateConversationTitle(id: string, text: string): Promise<unknown>;
  listMessages(id: string, query?: unknown): Promise<unknown>;
}

/** 识别为「订阅请求」的方法名。 */
export const SUBSCRIBE_METHODS = [
  "events.subscribeRun",
  "events.subscribeConversation"
] as const;

/** 识别为「退订请求」的方法名。 */
export const UNSUBSCRIBE_METHOD = "events.unsubscribe" as const;

/** 退订请求的负载形状。 */
export interface UnsubscribePayload {
  subscriptionId: string;
}

/**
 * 判断一个方法是否为订阅/退订类请求（worker 需要单独处理 subscription 句柄）。
 *
 * @param method 方法名。
 * @returns 订阅或退订类请求返回 true。
 */
export function isSubscribeMethod(method: string): boolean {
  return (SUBSCRIBE_METHODS as readonly string[]).includes(method);
}

/**
 * 把任意错误归一成 `RuntimeResponseEnvelope` 的 error 分支。
 *
 * @param requestId 关联请求幂等键。
 * @param error 原始错误（已归一 / 未知形态均可）。
 * @returns 失败响应信封。
 */
function failure(requestId: string, error: unknown): RuntimeResponseEnvelope {
  const errorDto: RuntimeErrorDto = toRuntimeError(error, requestId, "internal_error");
  return { protocolVersion: PROTOCOL_VERSION, requestId, ok: false, error: errorDto };
}

/** 方法名 → runtime 调用器；payload 在调用器内做最小字段提取。 */
type Handler = (runtime: RuntimeRouter, payload: unknown) => Promise<unknown>;

/**
 * 从对象 payload 中读取必填字符串字段。
 *
 * preload 发送的是 `{ conversationId }` / `{ runId }` 包装对象；若直接把 payload 当 ID，
 * runtime 会收到 `[object Object]` 并把它当作会话名，导致授权反查永远失败。
 *
 * @param payload IPC payload。
 * @param field 字段名。
 * @param method 方法名（用于错误文案）。
 * @returns 非空字符串字段值。
 * @throws `bad_request`：字段缺失或非字符串。
 */
function requireString(payload: unknown, field: string, method: string): string {
  const value = (payload as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RoutingError("bad_request", `${method} 需要非空字符串 ${field}`);
  }
  return value;
}

/**
 * 读取可选的查询对象，缺省返回 undefined。
 *
 * @param payload IPC payload。
 * @returns 查询对象或 undefined。
 */
function optionalQuery(payload: unknown): unknown {
  const query = (payload as { query?: unknown } | null | undefined)?.query;
  return query === null ? undefined : query;
}

const HANDLERS: Record<string, Handler> = {
  "runtime.getHealth": (r) => r.getHealth(),
  "runtime.getModelCatalog": (r) => r.getModelCatalog(),
  "runtime.shutdown": async (r) => {
    await r.shutdown();
    return undefined;
  },
  "workspaces.list": (r) => r.listWorkspaces(),
  "workspaces.register": (r, p) => {
    const { workspaceId, workspaceRoot } = (p ?? {}) as { workspaceId?: unknown; workspaceRoot?: unknown };
    if (typeof workspaceId !== "string" || typeof workspaceRoot !== "string") {
      throw new Error("workspaces.register 需要字符串 workspaceId 与 workspaceRoot");
    }
    return r.registerWorkspace(workspaceId, workspaceRoot);
  },
  "workspaces.release": (r, p) => {
    const { workspaceId } = (p ?? {}) as { workspaceId?: unknown };
    if (typeof workspaceId !== "string") throw new Error("workspaces.release 需要字符串 workspaceId");
    return r.releaseWorkspace(workspaceId);
  },
  "conversations.list": (r, p) => r.listConversations(optionalQuery(p)),
  "conversations.create": (r, p) => r.createConversation((p as { input?: unknown })?.input),
  "conversations.update": (r, p) => {
    const { id, input } = (p ?? {}) as { id?: unknown; input?: unknown };
    if (typeof id !== "string") throw new Error("conversations.update 需要字符串 id");
    return r.updateConversation(id, input);
  },
  "conversations.listMessages": (r, p) => {
    const { id, query } = (p ?? {}) as { id?: unknown; query?: unknown };
    if (typeof id !== "string") throw new Error("conversations.listMessages 需要字符串 id");
    return r.listMessages(id, query);
  },
  "conversations.generateTitle": (r, p) => {
    const { id, text } = (p ?? {}) as { id?: unknown; text?: unknown };
    if (typeof id !== "string" || typeof text !== "string") {
      throw new Error("conversations.generateTitle 需要字符串 id 与 text");
    }
    return r.generateConversationTitle(id, text);
  },
  "runs.start": (r, p) => r.startRun((p as { input?: unknown })?.input),
  "runs.snapshot": (r, p) => r.getRunSnapshot(requireString(p, "runId", "runs.snapshot")),
  "runs.list": (r, p) =>
    r.listRunsByConversation(requireString(p, "conversationId", "runs.list")),
  "runs.cancel": (r, p) => r.cancelRun(requireString(p, "runId", "runs.cancel")),
  "runs.resolveConfirmation": (r, p) => {
    const { runId, toolCallId, decision } = (p ?? {}) as {
      runId?: unknown;
      toolCallId?: unknown;
      decision?: unknown;
    };
    if (typeof runId !== "string" || typeof toolCallId !== "string") {
      throw new Error("runs.resolveConfirmation 需要字符串 runId 与 toolCallId");
    }
    return r.resolveConfirmation(runId, toolCallId, decision);
  },
  "models.list": (r) => r.getModelCatalog(),
  "app.getHealth": (r) => r.getHealth()
};

/**
 * 把信封路由到对应 runtime 方法并包裹成响应信封。
 *
 * 仅处理「请求/响应」类方法；订阅与退订由 worker 单独处理（返回 undefined 表示交给上层）。
 * 信封的协议版本与 requestId 在调用前已由 `assertProtocolVersion` 校验（见 worker）。
 *
 * @param runtime 已装配的 runtime（Router 子集）。
 * @param envelope 已解析的请求信封（method / payload 已可用）。
 * @returns 结构化响应信封（成功含 data，失败含 error）。
 */
export async function routeRuntimeRequest(
  runtime: RuntimeRouter,
  envelope: RuntimeRequestEnvelope
): Promise<RuntimeResponseEnvelope> {
  const { requestId, method } = envelope;
  const handler = HANDLERS[method];
  if (!handler) {
    return failure(requestId, { code: "bad_request", message: `未知方法：${method}` });
  }
  try {
    const data = await handler(runtime, envelope.payload);
    return { protocolVersion: PROTOCOL_VERSION, requestId, ok: true, data };
  } catch (error) {
    return failure(requestId, error);
  }
}

/** 事件信封的构造辅助（worker 内 onEvent 复用）。 */
export interface SubscribeResult {
  subscriptionId: string;
}

/**
 * 构造 run / 会话事件的传输层信封。
 *
 * @param subscriptionId 订阅幂等键。
 * @param event run 流事件（与 serve SSE 同源）。
 * @returns 事件信封。
 */
export function toEventEnvelope(
  subscriptionId: string,
  event: RunStreamEventDtoV2
): { protocolVersion: number; subscriptionId: string; event: RunStreamEventDtoV2 } {
  return { protocolVersion: PROTOCOL_VERSION, subscriptionId, event };
}
