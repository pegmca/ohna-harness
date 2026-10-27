/**
 * IPC 路由层（spec §5.2 / §9）：登记单一请求分发通道，校验 sender 是否属于本应用已授权窗口，
 * 并按 `webContents.id` 跟踪订阅，窗口销毁时清理。
 *
 * 本层不实现业务逻辑：普通请求信封原样转发给 `RuntimeHost`（后者再转发给 worker 内的 runtime）。
 * 订阅类方法（`events.subscribeRun` / `events.subscribeConversation`）先让 host 向 worker 建立
 * runtime 订阅拿到 `subscriptionId`，再在 host 侧登记「事件 → 渲染端」转发器；退订类
 * （`events.unsubscribe`）反向释放。所有 fail-closed 校验集中在 `validateEnvelope`。
 */
import { ipcMain } from "electron";
import {
  PROTOCOL_VERSION,
  type RuntimeErrorDto,
  type RuntimeEventEnvelope,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
  type RunStreamEventDtoV2,
} from "@aiagent/types";
import { EVENT_CHANNEL, REQUEST_CHANNEL } from "../preload/contract.js";
import type { RuntimeHost } from "./runtime-host.js";
import type { WindowRegistry } from "./windows.js";
import { createOhnaRuntime, type OhnaRuntime } from "@aiagent/ohna-runtime";
import { validateEnvelope } from "./envelope.js";

/** 某 webContents 持有的订阅清理函数集合。 */
interface WebContentsSubscriptions {
  unsubscribers: Set<() => void>;
}

/** 注册 IPC 路由所需的依赖。 */
export interface IpcDeps {
  host: RuntimeHost;
  windows: WindowRegistry;
}

/**
 * 登记 IPC 路由：单一请求分发通道 `ohna:request`。
 *
 * 每个 handler 都先校验 sender 归属（未知 / 已销毁窗口一律拒绝），再处理信封；订阅按
 * `webContents.id` 归集，窗口销毁时统一退订上游。原生目录选择走 `ohna:pick-workspace`
 * （见 `main/index.ts`）。
 *
 * @param deps 宿主与窗口登记器。
 * @returns 清理函数（移除所有已登记 handler）。
 */
export function registerIpc(deps: IpcDeps): () => void {
  const { host, windows } = deps;
  const perWeb = new Map<number, WebContentsSubscriptions>();
  /** subscriptionId → 上游退订函数（由 host.subscribe 返回）。 */
  const subscriptionUnsubMap = new Map<string, () => void>();

  /** 取或建某 webContents 的订阅集合。 */
  const ensure = (id: number): WebContentsSubscriptions => {
    let entry = perWeb.get(id);
    if (!entry) {
      entry = { unsubscribers: new Set() };
      perWeb.set(id, entry);
    }
    return entry;
  };

  /** 校验请求来源：senderFrame 必须存在且属于本应用已登记窗口。 */
  const senderKnown = (event: Electron.IpcMainInvokeEvent): boolean => {
    if (!event.senderFrame) return false;
    return windows.isKnown(event.sender);
  };

  /** 拒绝响应构造。 */
  const reject = (requestId: string, code: RuntimeErrorDto["code"], message: string): RuntimeResponseEnvelope => ({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message, requestId }
  });

  /** 退订某 subscriptionId（清理映射与归属集合）。 */
  const doUnsubscribe = (subscriptionId: string): void => {
    const unsub = subscriptionUnsubMap.get(subscriptionId);
    if (!unsub) return;
    unsub();
    subscriptionUnsubMap.delete(subscriptionId);
    for (const entry of perWeb.values()) entry.unsubscribers.delete(unsub);
  };

  /** 事件转发器：worker 推来的事件经此回送发起订阅的渲染端（窗口销毁则丢弃）。 */
  const makeForwarder = (sender: Electron.WebContents, subscriptionId: string) => {
    return (ev: RunStreamEventDtoV2): void => {
      if (sender.isDestroyed()) return;
      const envelope: RuntimeEventEnvelope = { protocolVersion: PROTOCOL_VERSION, subscriptionId, event: ev };
      sender.send(EVENT_CHANNEL, envelope);
    };
  };

  /**
   * 单一请求分发 handler（异步）：校验来源与信封，按方法分流到普通转发 / 订阅 /
   * 退订，未知窗口或畸形信封一律拒绝（fail-closed）。
   */
  const requestHandler = async (
    event: Electron.IpcMainInvokeEvent,
    envelope: unknown
  ): Promise<RuntimeResponseEnvelope> => {
    if (!senderKnown(event)) {
      return reject("", "forbidden", "未知窗口来源");
    }
    const error = validateEnvelope(envelope);
    if (error) {
      return { protocolVersion: PROTOCOL_VERSION, requestId: error.requestId, ok: false, error };
    }
    const typed = envelope as RuntimeRequestEnvelope;

    // 退订：通知 worker 释放上游订阅并清理本端登记。
    if (typed.method === "events.unsubscribe") {
      const payload = (typed.payload ?? {}) as { subscriptionId?: string };
      if (typeof payload.subscriptionId !== "string") {
        return reject(typed.requestId, "bad_request", "events.unsubscribe 需要 subscriptionId");
      }
      doUnsubscribe(payload.subscriptionId);
      return host
        .request({ requestId: typed.requestId, method: typed.method, payload: typed.payload })
        .catch((err) =>
          reject(typed.requestId, "internal_error", err instanceof Error ? err.message : "未知错误")
        );
    }

    // 订阅：先让 worker 建立 runtime 订阅（返回 subscriptionId），再在 host 侧登记转发器。
    const isSubscribe =
      typed.method === "events.subscribeRun" || typed.method === "events.subscribeConversation";
    if (isSubscribe) {
      const response = await host
        .request({ requestId: typed.requestId, method: typed.method, payload: typed.payload })
        .catch((err) =>
          reject(typed.requestId, "internal_error", err instanceof Error ? err.message : "未知错误")
        );
      if (!response.ok) return response;
      const subscriptionId = (response.data as { subscriptionId?: string } | undefined)?.subscriptionId;
      if (typeof subscriptionId !== "string") {
        return reject(typed.requestId, "internal_error", "订阅未返回 subscriptionId");
      }
      const unsub = host.subscribe(subscriptionId, makeForwarder(event.sender, subscriptionId));
      subscriptionUnsubMap.set(subscriptionId, unsub);
      ensure(event.sender.id).unsubscribers.add(unsub);
      return response;
    }

    // 普通请求：原样转发给 host（worker 内路由到 runtime）。
    return host
      .request({ requestId: typed.requestId, method: typed.method, payload: typed.payload })
      .catch((err) =>
        reject(typed.requestId, "internal_error", err instanceof Error ? err.message : "未知错误")
      );
  };

  /** 窗口销毁时清理其全部订阅与登记。 */
  const onDestroyed = (contents: Electron.WebContents): void => {
    const entry = perWeb.get(contents.id);
    if (entry) {
      for (const unsub of entry.unsubscribers) unsub();
      perWeb.delete(contents.id);
    }
    windows.unregister(contents.id);
  };

  ipcMain.handle(REQUEST_CHANNEL, requestHandler);
  ipcMain.on("web-contents-created", (_event, contents: Electron.WebContents) => {
    contents.on("destroyed", () => onDestroyed(contents));
  });

  return () => {
    ipcMain.removeHandler(REQUEST_CHANNEL);
    for (const entry of perWeb.values()) {
      for (const unsub of entry.unsubscribers) unsub();
    }
    perWeb.clear();
    subscriptionUnsubMap.clear();
  };
}

/** 重新导出 runtime 构造，免去 main/index.ts 单另 import 长路径。 */
export { createOhnaRuntime };
export type { OhnaRuntime };
/** 重新导出信封校验，供纯 Node 单测与 ipc 路由共用同一份 fail-closed 实现。 */
export { validateEnvelope };
