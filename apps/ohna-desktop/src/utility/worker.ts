import { homedir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  type RuntimeEventEnvelope,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
  type RunStreamEventDtoV2,
} from "@aiagent/types";
import {
  createOhnaRuntime,
  buildModelCatalogFromSettings,
  readSettings,
  resolveModelFromSettings,
  toRuntimeError,
  type OhnaRuntime
} from "@aiagent/ohna-runtime";
import { createCodingToolRegistry } from "@aiagent/coding";
import {
  isSubscribeMethod,
  routeRuntimeRequest,
  toEventEnvelope,
  UNSUBSCRIBE_METHOD,
  type RuntimeRouter,
  type UnsubscribePayload,
} from "./routing.js";

/** 控制消息（parentPort 握手用，不进业务信封）。 */
interface ReadyMessage {
  type: "ready";
}
interface RequestMessage {
  type: "request";
  envelope: RuntimeRequestEnvelope;
}

/** 业务消息（MessagePort 回送用）。 */
type OutgoingMessage =
  | { type: "response"; envelope: RuntimeResponseEnvelope }
  | { type: "event"; envelope: RuntimeEventEnvelope };

/**
 * 返回工具链探活值（spike 测试保留）。
 *
 * @returns 固定的 `"pong"`。
 */
/**
 * 在移交的 MessagePort 上处理 runtime 请求：路由到 `OhnaRuntime`，回送响应信封；
 * 订阅类方法登记 runtime `Subscription.onEvent` 回送 `RuntimeEventEnvelope`；退订释放上游。
 *
 * @param port 主进程移交的业务端口。
 * @param runtime 已装配的 runtime 实例。
 * @returns 无返回值。
 */
function servePort(port: Electron.MessagePortMain, runtime: OhnaRuntime): void {
  const router: RuntimeRouter = {
    getHealth: () => runtime.getHealth(),
    getModelCatalog: () => runtime.getModelCatalog(),
    shutdown: () => runtime.shutdown(),
    registerWorkspace: (id, root) => runtime.registerWorkspace(id, root),
    listWorkspaces: () => runtime.listWorkspaces(),
    releaseWorkspace: (id) => runtime.releaseWorkspace(id),
    startRun: (input) => runtime.startRun(input as never),
    getRunSnapshot: (runId) => runtime.getRunSnapshot(runId),
    listRunsByConversation: (conversationId) => runtime.listRunsByConversation(conversationId),
    cancelRun: (runId) => runtime.cancelRun(runId),
    resolveConfirmation: (runId, toolCallId, decision) =>
      runtime.resolveConfirmation(runId, toolCallId, decision as never),
    createConversation: (input) => runtime.createConversation(input as never),
    listConversations: (query) => runtime.listConversations(query as never),
    updateConversation: (id, input) => runtime.updateConversation(id, input as never),
    generateConversationTitle: (id, text) => runtime.generateConversationTitle(id, text),
    listMessages: (id, query) => runtime.listMessages(id, query as never)
  };

  /** subscriptionId → 上游退订函数。 */
  const upstream = new Map<string, () => void>();

  port.on("message", async (event) => {
    const message = event.data as RequestMessage | undefined;
    if (message?.type !== "request") return;
    const envelope = message.envelope;

    // 退订：释放上游订阅并回应。
    if (envelope.method === UNSUBSCRIBE_METHOD) {
      const payload = envelope.payload as UnsubscribePayload;
      const unsub = upstream.get(payload.subscriptionId);
      if (unsub) {
        unsub();
        upstream.delete(payload.subscriptionId);
      }
      const response: RuntimeResponseEnvelope = {
        protocolVersion: PROTOCOL_VERSION,
        requestId: envelope.requestId,
        ok: true,
        data: undefined
      };
      port.postMessage({ type: "response", envelope: response } satisfies OutgoingMessage);
      return;
    }

    // 订阅类：建立 runtime 订阅，onEvent 回送事件信封；subscriptionId 由 runtime 生成。
    if (isSubscribeMethod(envelope.method)) {
      try {
        const subscribeOptions = (envelope.payload as { options?: unknown })?.options ?? {};
        const requestedSubscriptionId =
          (envelope.payload as { subscriptionId?: unknown })?.subscriptionId;
        const targetId = (envelope.payload as { id?: string; runId?: string }).id ??
          (envelope.payload as { runId?: string }).runId ??
          "";
        // onEvent 在 runtime.subscribe* 返回前即可能触发 replay；此时还没有 subscriptionId。
        // 先用可变数组缓冲，拿到 runtime 分配的 id 后再统一以正确信封回送，避免用 targetId
        // 冒充 subscriptionId 导致 IPC 层按真实 id 过滤时丢弃全部事件（UI 永远 running）。
        // 主进程会预先登记 subscriptionId，确保 replay 第一批事件也有路由；缺失时回退 runtime id。
        const assignedSubscriptionId =
          typeof requestedSubscriptionId === "string" && requestedSubscriptionId
            ? requestedSubscriptionId
            : undefined;
        const pendingEvents: RunStreamEventDtoV2[] = [];
        const emitEvent = (ev: RunStreamEventDtoV2): void => {
          if (assignedSubscriptionId) emit(assignedSubscriptionId, ev);
          else pendingEvents.push(ev);
        };
        const subscription =
          envelope.method === "events.subscribeRun"
            ? await runtime.subscribeRun(targetId, {
                ...(subscribeOptions as object),
                onEvent: emitEvent
              })
            : await runtime.subscribeConversation(targetId, {
                ...(subscribeOptions as object),
                onEvent: emitEvent
              });
        upstream.set(subscription.subscriptionId, subscription.unsubscribe);
        // 订阅建立后切换为直发；先用真实 subscriptionId 回放缓冲，保证顺序不丢。
        for (const buffered of pendingEvents.splice(0)) {
          emit(assignedSubscriptionId ?? subscription.subscriptionId, buffered);
        }
        const response: RuntimeResponseEnvelope = {
          protocolVersion: PROTOCOL_VERSION,
          requestId: envelope.requestId,
          ok: true,
          data: { subscriptionId: assignedSubscriptionId ?? subscription.subscriptionId }
        };
        port.postMessage({ type: "response", envelope: response } satisfies OutgoingMessage);
      } catch (error) {
        const response: RuntimeResponseEnvelope = {
          protocolVersion: PROTOCOL_VERSION,
          requestId: envelope.requestId,
          ok: false,
          error: toRuntimeError(error, envelope.requestId, "internal_error")
        };
        port.postMessage({ type: "response", envelope: response } satisfies OutgoingMessage);
      }
      return;
    }

    // 普通请求：路由到 runtime 并回送响应。
    const response = await routeRuntimeRequest(router, envelope);
    port.postMessage({ type: "response", envelope: response } satisfies OutgoingMessage);
  });
  port.start();

  /** 经业务端口回送一条运行事件。 */
  function emit(subscriptionId: string, event: RunStreamEventDtoV2): void {
    const envelope = toEventEnvelope(subscriptionId, event);
    port.postMessage({ type: "event", envelope } satisfies OutgoingMessage);
  }
}

/**
 * 在 utilityProcess 中接收主进程移交的 MessagePort 并启动 runtime。
 *
 * utilityProcess 以独立 ESM 入口运行；parentPort 只负责握手，后续 runtime 请求走独立
 * MessagePort，避免控制通道与业务流量耦合。数据目录写入 `~/.ohna`（spec §8.1），
 * 不在代码里清空既有目录，数据重置由独立控制步骤处理。
 *
 * @returns 无返回值。
 */
async function listenForConnection(): Promise<void> {
  const parentPort = process.parentPort;
  if (!parentPort) return;
  parentPort.once("message", async (event) => {
    const port = event.ports?.[0] as Electron.MessagePortMain | undefined;
    if (!port) return;
    parentPort.postMessage({ type: "ready" } satisfies ReadyMessage);

    const dataDir = process.env.OHNA_DATA_DIR || join(homedir(), ".ohna");
    // 用户级配置唯一来源：`<dataDir>/settings.json`（测试可经 OHNA_SETTINGS_PATH 指向临时文件）。
    const { settings } = await readSettings(dataDir);
    const active = resolveModelFromSettings(settings);
    const model = active?.model;
    const apiKey = active?.apiKey ?? "";
    if (settings.httpProxy) {
      // provider 的代理感知 fetch 读取该变量；settings.json 显式配置优先于 shell。
      process.env.AIAGENT_HTTP_PROXY = settings.httpProxy;
    }
    if (!active) {
      console.warn("[ohna-worker] 未检测到模型 API key，runtime 以 degraded 状态启动。");
    }
    // 多模型目录：形状来自 settings 分组；详细元数据在 runtime 内补齐。
    const settingsCatalog = buildModelCatalogFromSettings(settings);
    // 工具集绑定到当前主工作区根（首版用 dataDir 占位；per-workspace 工具上下文见 Task 6/13）。
    const tools = createCodingToolRegistry(dataDir);
    try {
      const runtime = await createOhnaRuntime({
        dataDir,
        model: model as never,
        apiKey,
        tools,
        ...(settingsCatalog
          ? {
              modelCatalog: {
                defaultModelId: settingsCatalog.defaultModelId,
                models: settingsCatalog.models.map((model) => ({
                  id: model.id,
                  label: model.id,
                  provider: (active?.profile === "deepseek" || active?.profile === "openrouter"
                    ? active.profile
                    : "bridge_ai") as "deepseek" | "openrouter" | "bridge_ai",
                  description: model.group ? `${model.group} · ${model.id}` : model.id,
                  isDefault: model.isDefault,
                  capabilities: { structuredOutput: true, toolCalling: true },
                  contextWindow: 128_000,
                  maxTokens: 8_192,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  ...(model.group ? { group: model.group } : {})
                }))
              }
            }
          : {}),
        team: process.env.OHNA_TEAM === "true",
        autoApprove: process.env.OHNA_AUTO_APPROVE === "true",
        onLog: (entry) => console.log(`[ohna-runtime:${entry.level}] ${entry.message}`)
      });
      servePort(port, runtime);
    } catch (error) {
      console.error("[ohna-worker] runtime 启动失败", error);
    }
  });
}

void listenForConnection();
