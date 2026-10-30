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
import * as path from "node:path";
import type { Model } from "@aiagent/ai";
import type { AgentTool, StreamFn, TeamState } from "@aiagent/agent";
import {
  PROTOCOL_VERSION,
  type ModelCatalogDto,
  type ModelOptionDto,
  type RunSnapshotDtoV2,
  type RunStartResultDto,
  type RuntimeHealthDto,
  type RunMetaDtoV2,
  type WorkspaceDescriptorDto,
  type ConversationSummaryDto,
  type CursorPageDto,
  type LinearMessageDto,
} from "@aiagent/types";
import {
  createAsyncConfirmGate,
  type AsyncConfirmGate,
  type ResolveConfirmationResult,
  type ConfirmationDecision,
  type ConfirmationRequestedPayload,
} from "./confirm-gate.js";
import { WorkspaceRegistry, WorkspaceMcpRegistry, WorkspaceContextCache } from "./workspace/index.js";
import { LocalMessageStore, LocalRunStore, LocalSessionStore, acquireDataDirLock, reconcileOnStart } from "./store/index.js";
import { RunManager } from "./run-manager.js";
import { RuntimeError } from "./errors.js";
import { createConversationScheduler } from "./scheduler/conversation.js";
import { createRunConfigResolver } from "./model/config.js";
import { createServeTeamSession } from "./run/team-session.js";
import { resolveCompactionSettings } from "@aiagent/agent";
import { streamSimple } from "@aiagent/ai";
import type { RunStreamEventDtoV2 } from "@aiagent/types";
import type { Subscription, SubscribeOptions } from "./events/subscription.js";
import type { SessionMeta } from "./store/session-store.js";

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
  /**
   * 外部 team 状态读取器（兜底 / 测试注入）。主路径由 `team:true` 经 runtime 自建
   * `TeamController` 产出；此字段仅作 fallback，不影响主路径。
   */
  getTeamState?: () => TeamState;
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
  /** 用户本次选择的模型 id；缺省使用 settings 默认模型。 */
  modelId?: string;
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
  subscribeRun(runId: string, options: SubscribeOptions): Promise<Subscription>;
  subscribeConversation(conversationId: string, options: SubscribeOptions): Promise<Subscription>;
  getRunSnapshot(runId: string): Promise<RunSnapshotDtoV2 | null>;
  listRunsByConversation(conversationId: string): Promise<RunMetaDtoV2[]>;
  cancelRun(runId: string): Promise<RunSnapshotDtoV2 | null>;
  resolveConfirmation(
    runId: string,
    toolCallId: string,
    decision: ConfirmationDecision,
    options?: { assertAuthorized?: (id: string) => Promise<void> }
  ): Promise<ResolveConfirmationResult>;
  /** 新建会话（必填 workspaceId，经 fail-closed 授权校验）。 */
  createConversation(input: { title?: string; workspaceId: string }): Promise<ConversationSummaryDto>;
  /** 列出会话（active 优先，可选按 workspaceId 过滤）。 */
  listConversations(query?: { workspaceId?: string }): Promise<ConversationSummaryDto[]>;
  /** 修改会话标题或归档；不存在返回 null。 */
  updateConversation(id: string, input: { title?: string; archive?: boolean }): Promise<ConversationSummaryDto | null>;
  /** 语义化生成会话标题；失败静默返回 undefined（不抛错）。 */
  generateConversationTitle(id: string, text: string): Promise<ConversationSummaryDto | undefined>;
  /** 线性消息游标分页（afterSequence 为已见最大 sequence）；会话不存在返回 null。 */
  listMessages(id: string, query?: { afterSequence?: number; limit?: number }): Promise<CursorPageDto<LinearMessageDto> | null>;
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
  const { getTeamState } = options;

  // 单写者锁：必须在构造 store 之前获取（spec §8.1）。残留锁会抛结构化错误阻断启动，
  // 绝不绕过——两个 writer 同时写 JSONL 会造成数据损坏。shutdown 时释放。
  const dataDirLock = await acquireDataDirLock(dataDir);

  // 首版单工作区：workspaceRoot 以 dataDir 占位，Task 6 接入工作区注册表后替换。
  const workspaceRoot = dataDir;
  const effectiveSystemPrompt = systemPrompt ?? `你是一个在 ${workspaceRoot} 工作的编码助手。`;

  // 各 store 使用独立子目录（spec §8.3 / serve 布局对齐）；单一目录是历史 outlier。
  const messageStore = new LocalMessageStore(path.join(dataDir, "conversations"));
  const runStore = new LocalRunStore(path.join(dataDir, "runs"));
  const sessionStore = new LocalSessionStore(path.join(dataDir, "sessions"));

  // 启动期对账：回填索引、把非终态 run 收敛为 interrupted（依赖 getRun 既有回退）。
  // 在 store 构造之后、执行之前运行，保证首次 list 即一致，且不重放/删除数据。
  await reconcileOnStart(dataDir, { runStore, messageStore, sessionStore });

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
    ...(getTeamState ? { getTeamState } : {}),
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
  const toRunStartResult = (result: {
    accepted: { runId: string; requestId: string; conversationId: string; modelId: string; status: RunSnapshotDtoV2["status"] };
    snapshot: RunSnapshotDtoV2;
    subscriptionId?: string;
    initialEvents?: RunStreamEventDtoV2[];
  }): RunStartResultDto => ({
    accepted: {
      runId: result.accepted.runId,
      requestId: result.accepted.requestId,
      conversationId: result.accepted.conversationId,
      modelId: result.accepted.modelId,
      status: result.accepted.status
    },
    snapshot: result.snapshot,
    subscriptionId: result.subscriptionId ?? "",
    initialEvents: result.initialEvents ?? []
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
      // 历史数据修复：旧桌面端曾把未授权目录写成 "default"，导致会话/replay 全部 forbidden。
      // 只在新工作区首次授权时重绑这些坏会话；其它 workspaceId 保持原归属。
      const sessions = await sessionStore.list({ includeArchived: true });
      for (const session of sessions) {
        if (session.workspaceId !== "default") continue;
        await sessionStore.rebindWorkspace(session.id, {
          workspaceId: descriptor.workspaceId,
          workspaceRoot: descriptor.displayPath
        });
        workspaceRegistry.bindConversation(session.id, descriptor.workspaceId);
      }
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
      await dataDirLock.release().catch(() => undefined);
      await workspaceMcpRegistry.closeAll();
      await runManager.shutdown();
    },
    async startRun(input: StartRunInput): Promise<RunStartResultDto> {
      return scheduler.submit(input, async () => {
        // 会话不存在时按消息自动建会话（fail-closed 授权 workspaceId）。旧 serve 在
        // 路由层自建会话，迁移后统一收口到 runtime：conversationId 缺省由 run 携带、
        // workspaceId 显式传入（serve 传 workspaceRoot）保证授权一致。create 幂等，
        // 已存在则直接复用，不覆盖原标题。
        const existing = await sessionStore.get(input.conversationId);
        if (!existing) {
          await sessionStore.create({
            id: input.conversationId,
            title: input.message.slice(0, 40),
            workspaceRoot: input.workspaceId ?? workspaceRoot,
            workspaceId: input.workspaceId ?? workspaceRoot
          });
          await messageStore.ensureConversation(input.conversationId, input.message.slice(0, 40));
        }
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
    subscribeRun(runId: string, options: SubscribeOptions) {
      return runManager.subscribeWithReplay(runId, options);
    },
    subscribeConversation(conversationId: string, options: SubscribeOptions) {
      return runManager.subscribeConversationWithReplay(conversationId, options);
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
    },

    async createConversation(input) {
      // 必须显式携带已授权 workspaceId：fail-closed，未注册的工作区一律拒绝。
      // 授权校验放在写会话之前，避免把非法 workspaceId 落进 sessions/index.jsonl。
      const workspace = await workspaceRegistry.resolveAuthorizedWorkspace(input.workspaceId);
      if (!workspace) {
        throw new RuntimeError(
          "workspace_unavailable",
          `工作区 ${input.workspaceId} 未授权，无法创建会话。`
        );
      }
      const meta = await sessionStore.create({
        title: input.title?.trim() ? input.title : "新会话",
        workspaceRoot: workspace.workspaceRoot,
        workspaceId: workspace.workspaceId
      });
      // 创建即绑定：后续 update / listMessages / run 无需等到首个 run 才能反查工作区。
      workspaceRegistry.bindConversation(meta.id, workspace.workspaceId);
      await messageStore.ensureConversation(meta.id, meta.title);
      return toConversationSummary(meta);
    },

    async listConversations(query) {
      const metas = await sessionStore.list();
      const filtered = query?.workspaceId
        ? metas.filter((meta) => meta.workspaceId === query.workspaceId)
        : metas;
      return filtered.map(toConversationSummary);
    },

    async updateConversation(id, input) {
      const updated = await sessionStore.update(id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.archive ? { status: "archived" } : {})
      });
      return updated ? toConversationSummary(updated) : null;
    },

    async generateConversationTitle(id, text) {
      const meta = await sessionStore.get(id);
      if (!meta) return undefined;
      const title = await runManager.generateTitle(text);
      if (!title) return undefined;
      const updated = await sessionStore.update(meta.id, { title });
      return toConversationSummary(updated ?? meta);
    },

    async listMessages(id, query) {
      const conversation = await sessionStore.get(id);
      if (!conversation) {
        return null;
      }
      return messageStore.listPage(conversation.id, {
        afterSequence: query?.afterSequence,
        limit: query?.limit
      });
    }
  };
}

/**
 * 把内部会话元数据映射为跨进程会话摘要 DTO。
 *
 * 字段全量对齐 `ConversationSummaryDto`；`lastMessageAt` 复用 `updatedAt`（本地会话
 * 列表即为「最后活跃」语义），归档态补 `archivedAt`。
 *
 * @param meta 会话元数据。
 * @returns 会话摘要 DTO。
 */
function toConversationSummary(meta: SessionMeta): ConversationSummaryDto {
  return {
    conversationId: meta.id,
    title: meta.title,
    status: meta.status,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    lastMessageAt: meta.updatedAt,
    ...(meta.status === "archived" ? { archivedAt: meta.archivedAt ?? meta.updatedAt } : {}),
    workspaceId: meta.workspaceId
  };
}
