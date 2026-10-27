/**
 * `@aiagent/ohna-runtime` 的组合根（composition root）。
 *
 * 这是桌面 runtime 的唯一对外入口：装配 JSONL store、异步确认闸门与 `RunManager`，
 * 把底层 `CreateRunResult`（`AgentRunAcceptedDto` 带 HTTP URL）适配成跨进程协议所需的
 * `RunStartResultDto`（`subscriptionId` + `initialEvents`，无 URL）。
 *
 * 设计要点：
 * - 不依赖 Fastify / Electron / React / CLI / TUI（架构边界见计划 Global Constraints）。
 * - 复杂运行逻辑都在 `RunManager` 内，本文件只做「注入依赖 + 协议适配 + 生命周期」。
 * - `workspaceRoot` 首版用 `dataDir` 占位，Task 6 引入工作区注册表后替换为真实根。
 */
import { randomUUID } from "node:crypto";
import type { Model } from "@aiagent/ai";
import type { AgentTool, StreamFn } from "@aiagent/agent";
import {
  PROTOCOL_VERSION,
  type ModelCatalogDto,
  type ModelOptionDto,
  type RunSnapshotDtoV2,
  type RunStartResultDto,
  type RuntimeHealthDto,
  type RunMetaDtoV2,
  type WorkspaceDescriptorDto,
} from "@aiagent/types";
import {
  createAsyncConfirmGate,
  type AsyncConfirmGate,
  type ResolveConfirmationResult,
  type ConfirmationDecision,
  type ConfirmationRequestedPayload,
} from "./confirm-gate.js";
import { WorkspaceRegistry, WorkspaceMcpRegistry, WorkspaceContextCache } from "./workspace/index.js";
import { LocalMessageStore, LocalRunStore, LocalSessionStore } from "./store/index.js";
import { RunManager } from "./run-manager.js";
import { createConversationScheduler } from "./scheduler/conversation.js";
import { createRunConfigResolver } from "./model/config.js";
import { createServeTeamSession } from "./run/team-session.js";
import { resolveCompactionSettings } from "@aiagent/agent";
import { streamSimple } from "@aiagent/ai";

/** 组合根注入参数。 */
export interface OhnaRuntimeOptions {
  /** 本地数据目录（JSONL 持久化根，首版同时作为 workspaceRoot 占位）。 */
  dataDir: string;
  /** 当前模型（窗口与费率的唯一来源）。 */
  model: Model<"openai-completions">;
  /** 模型 apiKey。 */
  apiKey: string;
  /** 系统提示词；缺省由 model / dataDir 推导（首版占位，Task 6 接入工作区上下文）。 */
  systemPrompt?: string;
  /** 注入 agentLoop 的工具集；缺省为空（测试 / 只读装配）。 */
  tools?: AgentTool[];
  /** 自动批准（bypass 权限闸门）。 */
  autoApprove?: boolean;
  /** Team 开关。 */
  team?: boolean;
  /** 确认超时毫秒。 */
  confirmTimeoutMs?: number;
  /** 自定义 streamFn（测试注入 / MCP 装配）。 */
  streamFn?: StreamFn;
  /** 模型目录覆盖；缺省由 model 推导单模型目录。 */
  modelCatalog?: ModelCatalogDto;
  /** 结构化日志出口（server 侧通常写 stderr）。 */
  onLog?: (entry: { level: "info" | "warn" | "error"; message: string }) => void;
}

/** 一次 run 的启动入参（跨进程协议面向渲染端的最小子集）。 */
export interface StartRunInput {
  /** 客户端幂等键；缺省由 runtime 生成。 */
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

/** 组合根：健康检查 / 模型目录 / 生命周期 / run 与确认入口。 */
export interface OhnaRuntime {
  getHealth(): Promise<RuntimeHealthDto>;
  getModelCatalog(): Promise<ModelCatalogDto>;
  shutdown(): Promise<void>;
  /** 注册一个已授权工作区（绝对根目录由 main 经原生对话框选中后传入）。 */
  registerWorkspace(workspaceId: string, workspaceRoot: string): Promise<WorkspaceDescriptorDto>;
  /** 列出所有已授权工作区。 */
  listWorkspaces(): Promise<WorkspaceDescriptorDto[]>;
  /** 撤销工作区授权（只撤销后续执行授权，不删除历史会话）。 */
  releaseWorkspace(workspaceId: string): Promise<void>;
  startRun(input: StartRunInput): Promise<RunStartResultDto>;
  getRunSnapshot(runId: string): Promise<RunSnapshotDtoV2 | null>;
  listRunsByConversation(conversationId: string): Promise<RunMetaDtoV2[]>;
  cancelRun(runId: string): Promise<RunSnapshotDtoV2 | null>;
  resolveConfirmation(
    runId: string,
    toolCallId: string,
    decision: ConfirmationDecision,
    options?: { assertAuthorized?: (id: string) => Promise<void> }
  ): Promise<ResolveConfirmationResult>;
}

/**
 * 由单个模型推导单模型目录（L0 不做多模型切换）。
 *
 * 复用 serve 的投影口径（缺失费率按 0，UI 自行展示「—」），但放在 runtime 内以避免
 * 依赖 `apps/serve`（违反 `packages/*` 不依赖 `apps/*`）。
 *
 * @param model 当前模型。
 * @returns 单模型目录。
 */
function buildSingleModelCatalog(model: Model<"openai-completions">): ModelCatalogDto {
  const toProvider = (p: string): ModelOptionDto["provider"] =>
    p === "deepseek" || p === "openrouter" || p === "bridge_ai" || p === "mock" ? (p as ModelOptionDto["provider"]) : "mock";
  const pick = (v: number | undefined): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const option: ModelOptionDto = {
    id: model.id,
    label: model.name || model.id,
    provider: toProvider(model.provider),
    description: `本地模型 · ${model.provider}/${model.id}`,
    isDefault: true,
    capabilities: { structuredOutput: true, toolCalling: true },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: {
      input: pick(model.cost?.input),
      output: pick(model.cost?.output),
      cacheRead: pick(model.cost?.cacheRead),
      cacheWrite: pick(model.cost?.cacheWrite)
    }
  };
  return { defaultModelId: model.id, models: [option] };
}

/**
 * 创建运行时核心：装配 store / 确认闸门 / RunManager。
 *
 * @param options 数据目录、模型与可选能力注入。
 * @returns 组合根实例。
 */
export async function createOhnaRuntime(options: OhnaRuntimeOptions): Promise<OhnaRuntime> {
  const { dataDir, model, apiKey, systemPrompt, tools = [], autoApprove, team, confirmTimeoutMs, streamFn, modelCatalog, onLog } = options;

  // 首版单工作区：workspaceRoot 以 dataDir 占位，Task 6 接入工作区注册表后替换。
  const workspaceRoot = dataDir;
  const effectiveSystemPrompt = systemPrompt ?? `你是一个在 ${workspaceRoot} 工作的编码助手。`;

  const messageStore = new LocalMessageStore(dataDir);
  const runStore = new LocalRunStore(dataDir);
  const sessionStore = new LocalSessionStore(dataDir);

  // 工作区授权三件套：注册表（授权表 + 归属反查）、上下文缓存（按 canonical 根缓存
  // 系统提示词与工具集）、MCP 容器（按 workspace 隔离的会话生命周期）。三者都只在
  // runtime 边界内持有，渲染端仅凭 workspaceId 操作资源。
  const workspaceRegistry = new WorkspaceRegistry({ sessionStore });
  const workspaceContextCache = new WorkspaceContextCache();
  const workspaceMcpRegistry = new WorkspaceMcpRegistry();

  // 闸门 emit 需要 RunManager（分配 sequence 后落盘 + 广播），而 RunManager 又需要闸门；
  // 用运行期持有者打破构造期循环：emit 只在工具真正请求确认时才被调用。
  const emitHolder: {
    emit?: (runId: string, payload: ConfirmationRequestedPayload) => Promise<void>;
  } = {};

  const confirmGate = createAsyncConfirmGate({
    autoApprove: autoApprove ?? false,
    ...(confirmTimeoutMs !== undefined ? { timeoutMs: confirmTimeoutMs } : {}),
    emit: async (runId: string, payload: ConfirmationRequestedPayload) => {
      if (!emitHolder.emit) throw new Error("确认事件通道尚未就绪。");
      await emitHolder.emit(runId, payload);
    }
  });

  const runManager = new RunManager({
    workspaceRoot,
    model,
    apiKey,
    systemPrompt: effectiveSystemPrompt,
    tools,
    messageStore,
    runStore,
    sessionStore,
    confirmGate,
    ...(streamFn ? { streamFn } : {}),
    ...(team ? { team: true } : {}),
    workspaceRegistry,
    workspaceContextCache,
    workspaceMcpRegistry,
    // Team 开关打开时构造会话级 Team 注册表（按 conversationId 持有 controller，成员跨轮保留）；
    // 同一工具表只有一份 controller、一份 team 成本来源（docs/v2.0/04 §2.2 + spec §7.4）。
    // window 与 run 前压缩同源（reserveTokens 唯一算法），随每次 llm_call 落盘。
    ...(team
      ? {
          teamSession: createServeTeamSession({
            model,
            streamFn: streamFn ?? streamSimple,
            window: {
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              reserveTokens: resolveCompactionSettings(model.contextWindow).reserveTokens
            }
          })
        }
      : {}),
  });
  const resolveRunConfig = createRunConfigResolver({
    model,
    apiKey,
    autoApprove: autoApprove ?? false,
    team: team ?? false,
    workspaceRegistry,
    workspaceContextCache,
    fallback: {
      workspaceId: "default",
      workspaceRoot,
      systemPrompt: effectiveSystemPrompt,
      tools
    }
  });
  const scheduler = createConversationScheduler({
    cancelRun: (runId) => runManager.cancel(runId, { assertAuthorized }).then(() => undefined),
    waitTerminal: (runId) => runManager.waitTerminal(runId)
  });
  emitHolder.emit = (runId, payload) =>
    runManager.emitConfirmationRequested(runId, payload);

  // 资源操作反查工作区授权（fail-closed）：未授权 / 已撤销的工作区一律拒绝；
  // 作为统一入口传给 RunManager 与 runtime 各资源方法复用同一份实现。RunManager 构造前
  // 必须先声明（其构造入参依赖此闭包）。
  const assertAuthorized = async (id: string): Promise<void> => {
    // runId 优先（run 创建时已绑定 workspace），否则按 conversation 反查。
    try {
      await workspaceRegistry.resolveRunWorkspace(id);
      return;
    } catch {
      // 非 runId（或 run 尚未绑定）回退到 conversation 维度反查。
    }
    await workspaceRegistry.resolveConversationWorkspace(id);
  };

  const catalog = modelCatalog ?? buildSingleModelCatalog(model);
  let closed = false;

  /**
   * 把 `CreateRunResult`（`AgentRunAcceptedDto` 带 HTTP URL）适配成跨进程协议的
   * `RunStartResultDto`（`subscriptionId` + `initialEvents`，无 URL）。
   *
   * @param result RunManager 的创建结果。
   * @returns 协议层 run 启动结果（首版订阅与初始事件在 Task 9 接通）。
   */
  const toRunStartResult = (result: { accepted: { runId: string; requestId: string; conversationId: string; modelId: string; status: RunSnapshotDtoV2["status"] }; snapshot: RunSnapshotDtoV2 }): RunStartResultDto => ({
    accepted: {
      runId: result.accepted.runId,
      requestId: result.accepted.requestId,
      conversationId: result.accepted.conversationId,
      modelId: result.accepted.modelId,
      status: result.accepted.status
    },
    snapshot: result.snapshot,
    // 首版无实时订阅通道：留空字符串，订阅幂等键在 Task 9 由 runtime 分配。
    subscriptionId: "",
    // 首版不回放早期事件：订阅后由 Task 9 的 live 通道补齐。
    initialEvents: []
  });

  return {
    async getHealth(): Promise<RuntimeHealthDto> {
      return {
        status: "ok",
        protocolVersion: PROTOCOL_VERSION,
        modelCount: catalog.models.length,
        workspaceCount: (await workspaceRegistry.list()).length
      };
    },
    async registerWorkspace(workspaceId, workspaceRoot) {
      const descriptor = await workspaceRegistry.register(workspaceId, workspaceRoot);
      await workspaceContextCache.get(descriptor.displayPath);
      await workspaceMcpRegistry.get(workspaceId);
      return descriptor;
    },
    async listWorkspaces() {
      return workspaceRegistry.list();
    },
    async releaseWorkspace(workspaceId) {
      await workspaceMcpRegistry.release(workspaceId);
      await workspaceRegistry.release(workspaceId);
    },
    async getModelCatalog(): Promise<ModelCatalogDto> {
      return catalog;
    },
    async shutdown(): Promise<void> {
      if (closed) return;
      closed = true;
      await workspaceMcpRegistry.closeAll();
      await runManager.shutdown();
    },
    async startRun(input: StartRunInput): Promise<RunStartResultDto> {
      if (input.workspaceId) {
        await workspaceRegistry.register(input.workspaceId, workspaceRoot);
      }
      return scheduler.submit(input, async () => {
        const config = await resolveRunConfig(input.conversationId, input);
        const result = await runManager.createRun({
          requestId: input.requestId ?? randomUUID(),
          conversationId: input.conversationId,
          message: input.message,
          mode: input.mode ?? "auto",
          source: input.source ?? "composer",
          ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
          ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
          ...(input.maxCost !== undefined ? { maxCost: input.maxCost } : {}),
          ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
          config
        });
        onLog?.({ level: "info", message: `startRun ${result.accepted.runId} @ ${input.conversationId}` });
        return toRunStartResult(result);
      });
    },
    getRunSnapshot(runId: string) {
      return runManager.getSnapshot(runId, { assertAuthorized });
    },
    listRunsByConversation(conversationId: string) {
      // RunManager.listRunsByConversation 已在内部调用 this.assertAuthorized，无需重复传参。
      return runManager.listRunsByConversation(conversationId);
    },
    cancelRun(runId: string) {
      return scheduler.cancel(runId).then(() => runManager.getSnapshot(runId, { assertAuthorized }));
    },
    async resolveConfirmation(runId, toolCallId, decision, options) {
      return runManager.resolveConfirmation(runId, toolCallId, decision, options ?? { assertAuthorized });
    }
  };
}
