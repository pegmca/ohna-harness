/**
 * 语义化 SDK 的纯构造器（不依赖 Electron / contextBridge / ipcRenderer）。
 *
 * 把「调用方 → 传输层」的桥接抽象成 `invoke` 函数注入，使得同一份 SDK 实现既能在 preload
 * 内用 `ipcRenderer.invoke` 组装（见 `preload/index.ts`），也能在 node 测试里用假 `invoke`
 * 校验暴露面与请求形状（spec §5.1 / §9 安全基线：渲染端只看到语义方法）。
 *
 * 事件订阅走独立推送通道（`type`），与请求/响应信封解耦：订阅拿到 subscriptionId 后，由调用方
 * 在渲染端的 `onEvent` 中自行过滤 `DeliveredEvent`。这里只负责触发订阅、返回退订函数，不碰
 * ipcRenderer 的 `on`/`removeListener`（那部分留在 preload 薄壳里，保持本模块可单测）。
 */
import {
  EVENT_CHANNEL,
  PICK_WORKSPACE_CHANNEL,
  REQUEST_CHANNEL,
  SDK_PROTOCOL_VERSION,
  validateRequest,
  type OhnaSdk,
  type StartRunInputDto,
  type UnsubscribeHandle,
  type RunStreamEventDtoV2,
  type DeliveredEvent,
} from "./contract.js";

/** 传输层抽象：请求通道调用，返回结构化响应信封。 */
export type InvokeFn = (channel: string, envelope: unknown) => Promise<unknown>;

/** 事件订阅通道注册器：返回退订该监听器的函数。 */
export type SubscribeFn = (
  channel: string,
  listener: (event: unknown, payload: DeliveredEvent) => void
) => () => void;

/**
 * 构造渲染端语义化 SDK。
 *
 * @param invoke 请求/响应通道调用器（preload 中绑定 `ipcRenderer.invoke`）。
 * @param subscribe 事件推送通道订阅器（preload 中绑定 `ipcRenderer` 的 on/removeListener）。
 * @returns 仅含语义方法的 SDK。
 */
export function createOhnaSdk(invoke: InvokeFn, subscribe?: SubscribeFn): OhnaSdk {
  /** 发送一个协议请求并取回响应信封；协议层错误在此抛出归一错误。 */
  const request = async (method: string, payload: unknown): Promise<unknown> => {
    // 发送前先校验 SDK 语义入参（spec §4.2 / §9）：畸形 payload 直接拒绝，不触 IPC。
    const validationError = validateRequest(method, payload);
    if (validationError) {
      throw new Error(validationError.message);
    }
    const response = (await invoke(REQUEST_CHANNEL, {
      protocolVersion: SDK_PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      method,
      payload
    })) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
    if (!response.ok) {
      throw new Error(response.error?.message ?? "请求失败");
    }
    return response.data;
  };

  /** 订阅一个运行事件源（run 或会话级），返回退订函数。 */
  const subscribeEvent = (
    method: "events.subscribeRun" | "events.subscribeConversation",
    id: string,
    onEvent: (event: RunStreamEventDtoV2) => void
  ): Promise<UnsubscribeHandle> => {
    const useSubscribe = subscribe ?? defaultSubscribe;
    return request(method, { id }).then((data) => {
      const subscriptionId = (data as { subscriptionId: string }).subscriptionId;
      const listener = (_event: unknown, payload: unknown) => {
        const delivered = payload as { subscriptionId: string; event: unknown };
        if (delivered.subscriptionId === subscriptionId) {
          onEvent(delivered.event as RunStreamEventDtoV2);
        }
      };
      const off = useSubscribe(EVENT_CHANNEL, listener);
      return () => {
        off();
        void request("events.unsubscribe", { subscriptionId });
      };
    });
  };

  return {
    workspaces: {
      async pick() {
        return (await invoke(PICK_WORKSPACE_CHANNEL, undefined)) as never;
      },
      async list() {
        return (await request("workspaces.list", {})) as never;
      }
    },
    conversations: {
      async list(query) {
        return (await request("conversations.list", { query })) as never;
      },
      async create(input) {
        return (await request("conversations.create", { input })) as never;
      },
      async update(id, input) {
        return (await request("conversations.update", { id, input })) as never;
      },
      async listMessages(id, query) {
        return (await request("conversations.listMessages", { id, query })) as never;
      },
      async generateTitle(id, text) {
        return (await request("conversations.generateTitle", { id, text })) as never;
      }
    },
    runs: {
      async start(input: StartRunInputDto) {
        return (await request("runs.start", { input })) as never;
      },
      async snapshot(runId) {
        return (await request("runs.snapshot", { runId })) as never;
      },
      async list(conversationId) {
        return (await request("runs.list", { conversationId })) as never;
      },
      async cancel(runId) {
        return (await request("runs.cancel", { runId })) as never;
      },
      async resolveConfirmation(runId, toolCallId, decision) {
        return (await request("runs.resolveConfirmation", {
          runId,
          toolCallId,
          decision
        })) as never;
      }
    },
    events: {
      subscribeRun(runId, onEvent) {
        return subscribeEvent("events.subscribeRun", runId, onEvent);
      },
      subscribeConversation(conversationId, onEvent) {
        return subscribeEvent("events.subscribeConversation", conversationId, onEvent);
      }
    },
    models: {
      async list() {
        return (await request("models.list", {})) as never;
      }
    },
    app: {
      async getHealth() {
        return (await request("app.getHealth", {})) as never;
      }
    }
  };
}

/**
 * 渲染端未注入订阅器时的兜底：不订阅事件，退订函数为空操作。
 * 正常 preload 路径一定注入 `ipcRenderer` 订阅逻辑，此处仅保证 SDK 在非 Electron 环境可构造。
 *
 * @returns 空操作退订函数。
 */
function defaultSubscribe(): () => void {
  return () => undefined;
}
