/**
 * preload 纯契约层（spec §5.1 / §9）：只收类型与常量，绝不 import Electron / Node / ipcRenderer。
 *
 * 本文件被 main / preload / 渲染进程共享，作为 `window.ohna` 暴露面的类型来源。它不得包含
 * 任何运行时符号，否则会被打包进渲染进程，破坏 sandbox 安全基线。渲染进程只消费这些类型，
 * 真正的能力由 `preload/index.ts` 经 contextBridge 暴露的语义化方法提供。
 */
import type {
  ConversationSummaryDto,
  CursorPageDto,
  LinearMessageDto,
  ModelCatalogDto,
  RuntimeEventEnvelope,
  RuntimeHealthDto,
  RuntimeRequestEnvelope,
  RuntimeResponseEnvelope,
  RunSnapshotDtoV2,
  RunStartResultDto,
  RunStreamEventDtoV2,
  RunMetaDtoV2,
  WorkspaceDescriptorDto,
} from "@aiagent/types";
import type { RuntimeErrorDto } from "@aiagent/types";

/** 跨进程协议版本（与 `@aiagent/types` 的 `PROTOCOL_VERSION` 同步）；preload 只在构造信封时使用。 */
export const SDK_PROTOCOL_VERSION = 1 as const;

/** 主进程请求分发通道（single dispatcher）。渲染端 SDK 只经此通道发送 `RuntimeRequestEnvelope`。 */
export const REQUEST_CHANNEL = "ohna:request";

/** 主进程向渲染端单向推送运行事件（run / 会话流式事件）的通道。 */
export const EVENT_CHANNEL = "ohna:event";

/** 原生目录选择通道：渲染端请求 main 弹出系统对话框并授权工作区。 */
export const PICK_WORKSPACE_CHANNEL = "ohna:pick-workspace";

/** 一次 run 启动入参（渲染端最小子集，与 runtime `StartRunInput` 对齐）。 */
export interface StartRunInputDto {
  requestId?: string;
  conversationId: string;
  message: string;
  mode?: "auto" | "report";
  source?: "composer" | "report_button" | "cli";
  maxTurns?: number;
  deadlineMs?: number;
  maxCost?: number;
  workspaceId?: string;
}

/** 取消订阅所需的上下文（由 subscribe 返回，主进程据此释放上游订阅）。 */
export interface UnsubscribeHandle {
  (): void;
}

/**
 * 渲染端最终消费的运行事件句柄：订阅时注入回调，主进程经 `EVENT_CHANNEL` 推送。
 * @property subscriptionId - 订阅幂等键，匹配 `RuntimeEventEnvelope.subscriptionId`。
 * @property event - 复用的 run 流事件，与 serve SSE 同源。
 */
export interface DeliveredEvent {
  subscriptionId: string;
  event: RunStreamEventDtoV2;
}

/**
 * 渲染进程可用的语义化 SDK 契约（spec §5.1）。
 * 只暴露语义方法，不暴露 ipcRenderer / invoke / Node / 绝对路径；fork/export/compact
 * 不在桌面契约范围内（CLI 专属、未进入 runtime/serve，详见 Task 12 scope ruling）。
 */
export interface OhnaSdk {
  workspaces: {
    /** 弹出原生目录对话框并完成授权，返回已注册工作区描述符。 */
    pick(): Promise<WorkspaceDescriptorDto>;
    /** 列出所有已授权工作区。 */
    list(): Promise<WorkspaceDescriptorDto[]>;
  };
  conversations: {
    /** 列出会话（可选按 workspaceId 过滤）。 */
    list(query?: { workspaceId?: string }): Promise<ConversationSummaryDto[]>;
    /** 新建会话（必填已授权 workspaceId）。 */
    create(input: { title?: string; workspaceId: string }): Promise<ConversationSummaryDto>;
    /** 修改标题或归档；不存在返回 null。 */
    update(id: string, input: { title?: string; archive?: boolean }): Promise<ConversationSummaryDto | null>;
    /** 线性消息游标分页。 */
    listMessages(id: string, query?: { afterSequence?: number; limit?: number }): Promise<CursorPageDto<LinearMessageDto> | null>;
    /** 语义化生成会话标题；失败静默返回 undefined。 */
    generateTitle(id: string, text: string): Promise<ConversationSummaryDto | undefined>;
  };
  runs: {
    /** 启动一次 run，返回受理回执 + 快照 + 订阅键 + 初始事件。 */
    start(input: StartRunInputDto): Promise<RunStartResultDto>;
    /** 获取 run 快照。 */
    snapshot(runId: string): Promise<RunSnapshotDtoV2 | null>;
    /** 列出某会话下的所有 run。 */
    list(conversationId: string): Promise<RunMetaDtoV2[]>;
    /** 取消 run（不隐式取消其他 run）。 */
    cancel(runId: string): Promise<RunSnapshotDtoV2 | null>;
    /** 解析工具调用确认（放行 / 拒绝）。 */
    resolveConfirmation(runId: string, toolCallId: string, decision: "allow" | "deny"): Promise<unknown>;
  };
  events: {
    /** 订阅 run 流式事件，返回退订函数。 */
    subscribeRun(runId: string, onEvent: (event: RunStreamEventDtoV2) => void): Promise<UnsubscribeHandle>;
    /** 订阅会话级（新 run）事件，返回退订函数。 */
    subscribeConversation(conversationId: string, onEvent: (event: RunStreamEventDtoV2) => void): Promise<UnsubscribeHandle>;
  };
  models: {
    /** 获取模型目录。 */
    list(): Promise<ModelCatalogDto>;
  };
  app: {
    /** 获取 runtime 健康状态。 */
    getHealth(): Promise<RuntimeHealthDto>;
  };
}

/** 重新导出协议信封类型，供 main / preload 两侧共享同一线格式。 */
export type {
  RuntimeRequestEnvelope,
  RuntimeResponseEnvelope,
  RuntimeEventEnvelope,
  WorkspaceDescriptorDto,
  ConversationSummaryDto,
  RunStartResultDto,
  RunStreamEventDtoV2,
};

/**
 * 渲染端 SDK 入参预校验（spec §4.2 / §9 安全基线）：在 preload 把请求送上 IPC 之前，
 * 先校验语义字段形状，畸形输入直接归一成 `RuntimeErrorDto`，绝不把任意对象透传给主进程。
 *
 * 这是纯函数，不依赖 Electron / Node / ipcRenderer，可在 node 测试里直接驱动；
 * 与 ipc 层 `validateEnvelope` 形成两道防线（preload 防畸形 payload，main 防越权来源）。
 *
 * @param method SDK 语义方法名（与协议 method 对齐）。
 * @param payload 待校验的 SDK 入参。
 * @returns 校验错误 DTO（`bad_request` / `protocol_mismatch`）；合法时返回 null。
 */
export function validateRequest(method: string, payload: unknown): RuntimeErrorDto | null {
  const bad = (message: string): RuntimeErrorDto => ({
    code: "bad_request",
    message,
    requestId: ""
  });

  const asObj = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : null;

  switch (method) {
    case "runs.start": {
      const input = (payload as { input?: unknown })?.input;
      const obj = asObj(input);
      if (!obj) return bad("runs.start 需要 input 对象");
      if (typeof obj.conversationId !== "string" || obj.conversationId.trim() === "") {
        return bad("runs.start.input.conversationId 必须是非空字符串");
      }
      if (typeof obj.message !== "string" || obj.message.trim() === "") {
        return bad("runs.start.input.message 必须是非空字符串");
      }
      if (obj.workspaceId !== undefined && typeof obj.workspaceId !== "string") {
        return bad("runs.start.input.workspaceId 必须是字符串");
      }
      return null;
    }
    case "events.subscribeRun":
    case "events.subscribeConversation": {
      const obj = asObj(payload);
      const id = obj?.id ?? obj?.runId;
      if (typeof id !== "string" || id.trim() === "") {
        return bad(`${method} 需要非空 id`);
      }
      return null;
    }
    case "events.unsubscribe": {
      const obj = asObj(payload);
      if (typeof obj?.subscriptionId !== "string" || obj.subscriptionId.trim() === "") {
        return bad("events.unsubscribe 需要非空 subscriptionId");
      }
      return null;
    }
    case "conversations.create": {
      const input = (payload as { input?: unknown })?.input;
      const obj = asObj(input);
      if (!obj) return bad("conversations.create 需要 input 对象");
      if (typeof obj.workspaceId !== "string" || obj.workspaceId.trim() === "") {
        return bad("conversations.create.input.workspaceId 必须是非空字符串");
      }
      return null;
    }
    default:
      // 其余方法为对象/字符串入参，协议层已保证 envelope 合法；此处放行。
      return null;
  }
}
