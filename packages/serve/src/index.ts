/**
 * `@aiagent/serve` 公共入口：ohna 本地服务端装配。
 *
 * Task 11 后，serve 退化为 `OhnaRuntime` 的纯 HTTP 适配器：不再持有任何 store / RunManager
 * 实例（单 dataDir 写者约束由 runtime 的 `acquireDataDirLock` 统一保证），所有业务经由
 * `createOhnaRuntime` 构造的 `runtime` 转发；serve 只负责 HTTP/SSE 路由、静态 fallback 与
 * 进程内句柄的形状适配。
 *
 * `ohna-cli` 单一形态下经本包驱动执行（TUI / 浏览器双端订阅同一执行线），
 * 仅负责进程内装配；不读取 `process.argv`、不打开浏览器、不注册信号处理。
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@aiagent/ai";
import type { AgentTool, StreamFn } from "@aiagent/agent";
import type { ConfirmationDecision, ResolveConfirmationResult } from "./confirm-gate.js";
import type {
  WorkspaceConversationDto,
  ModelCatalogDto,
  RunMetaDtoV2,
  RunSnapshotDtoV2,
  RunStreamEventDtoV2
} from "@aiagent/types";
import type { CreateRunResult } from "./run/types.js";
import type { OhnaRuntime, OhnaRuntimeOptions } from "@aiagent/ohna-runtime";
import Fastify, { type FastifyInstance } from "fastify";
import { registerErrorHandler } from "./errors.js";
import { toConversationDto } from "./routes/conversations.js";
import { registerRoutes } from "./routes/index.js";
import { createSingleModelCatalog } from "./routes/models.js";
import { registerStaticFallback } from "./static.js";
import { createOhnaRuntime } from "@aiagent/ohna-runtime";

/** 端口占用时最多尝试的递增次数（与 04 Phase 2 的 +1 重试一致）。 */
export const MAX_PORT_ATTEMPTS = 20;

/** createOhnaServer 的选项。 */
export interface OhnaServerOptions {
  /** 工作区根目录：编码工具的唯一作用域。 */
  workspaceRoot: string;
  /** 数据目录；缺省 `~/.ohna`。 */
  dataDir?: string;
  /** 当前模型（L0 单模型）。 */
  model: Model<"openai-completions">;
  apiKey: string;
  /** 系统提示词；缺省由 `buildCodingSystemPrompt(workspaceRoot)` 生成。 */
  systemPrompt?: string;
  /** 工具集；缺省 `createCodingToolRegistry(workspaceRoot)`（L1 全工具）。 */
  tools?: AgentTool[];
  /** 跳过写/执行确认（`--auto-approve`）；缺省 false。 */
  autoApprove?: boolean;
  /**
   * 只读观测模式（可选能力）：true 时**不注册** run 创建/取消与确认写路由，并强制 autoApprove=false。
   * 仅外部只读观测实例可能传 true；CLI 单一形态恒传 false，始终经同一 `server.createRun` 驱动执行。
   */
  observeOnly?: boolean;
  /** 确认等待上限（毫秒）；缺省 5 分钟，测试可注入短超时。 */
  confirmTimeoutMs?: number;
  /** 前端构建产物目录；缺省 `apps/ohna-web/dist`。 */
  staticDir?: string;
  /** 测试注入的 LLM 流函数。 */
  streamFn?: StreamFn;
  /** 模型目录；缺省根据 model 生成单模型目录。 */
  modelCatalog?: ModelCatalogDto;
  /**
   * Team 开关（docs/v2.0/04 §2.2）：缺省 false 保持既有单智能体行为。
   * true 时透传 runtime，由 runtime 自建 TeamController（单一 controller / 成本来源）。
   */
  team?: boolean;
}

/** 装配后的服务句柄。 */
export interface OhnaServer {
  app: FastifyInstance;
  /** 监听 127.0.0.1；返回实际端口与 URL。 */
  listen(port: number): Promise<{ port: number; url: string }>;
  /** 中断在途 run、关闭 store 写入队列。 */
  shutdown(): Promise<void>;
  /** 关闭 Fastify / HTTP server。 */
  close(): Promise<void>;
  /** 提交待确认操作的决定（供进程内入口 / 测试复用，等价于确认路由）。 */
  resolveConfirmation(
    runId: string,
    toolCallId: string,
    decision: ConfirmationDecision
  ): Promise<ResolveConfirmationResult>;
  /** 创建会话（进程内入口复用，等价 POST /api/conversations）。 */
  createConversation(title?: string): Promise<WorkspaceConversationDto>;
  /** 列出 active 会话（进程内入口复用，等价 GET /api/conversations）。 */
  listConversations(): Promise<WorkspaceConversationDto[]>;
  /**
   * 语义化生成会话标题（进程内入口复用，等价 POST /api/conversations/:id/generate-title）。
   * 失败返回 undefined，由调用方降级为截断标题。
   */
  generateConversationTitle(
    conversationId: string,
    text: string
  ): Promise<WorkspaceConversationDto | undefined>;
  /**
   * 创建并启动一次 run（进程内入口复用，等价 POST /api/runs）。
   * requestId 缺省时自动生成；mode/source 缺省取 composer 语义（auto / composer）。
   * maxTurns/deadlineMs/maxCost 为 `--max-turns` / `--deadline-ms` / `--max-cost` 预算护栏的透传。
   */
  createRun(input: {
    conversationId: string;
    message: string;
    mode?: "auto" | "report";
    /** 触发入口：composer/report_button 来自浏览器，cli 来自终端。 */
    source?: "composer" | "report_button" | "cli";
    requestId?: string;
    maxTurns?: number;
    deadlineMs?: number;
    maxCost?: number;
  }): Promise<CreateRunResult>;
  /** 订阅单个 run 的实时事件（run 不在内存时为 noop）。 */
  subscribeRun(runId: string, listener: (event: RunStreamEventDtoV2) => void): () => void;
  /** 会话级订阅：当前与后续所有 run 的事件（--web 终端共享同一会话事件流）。 */
  subscribeConversation(
    conversationId: string,
    listener: (event: RunStreamEventDtoV2) => void
  ): () => void;
  /** 取消 run（等价 DELETE /api/runs/:id，供 Ctrl-C 中断在途 run）。 */
  cancelRun(runId: string): Promise<RunSnapshotDtoV2 | null>;
  /** 当前是否处于自动批准模式（只读观测模式下恒为 false）。 */
  isAutoApprove(): boolean;
  /** 是否只读观测实例（docs/v1.4/06 D-A7）：true 时 Web 应禁用 composer。 */
  readonly observeOnly: boolean;
  /** 按会话列 run 摘要（等价 GET /api/conversations/:id/runs）。 */
  listRunsByConversation(conversationId: string): Promise<RunMetaDtoV2[]>;
  readonly port: number | undefined;
  readonly url: string | undefined;
}

/**
 * 计算默认静态目录：`<repo>/apps/ohna-web/dist`。
 *
 * 同时兼容源码运行（packages/serve/src）与构建产物（packages/serve/dist）——
 * 两者到仓库根的层级相同。
 *
 * @returns 静态目录绝对路径。
 */
function defaultStaticDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/ohna-web/dist");
}

/**
 * 装配 ohna 本地服务。
 *
 * @param options 工作区、模型、store 与测试注入项。
 * @returns 可 listen / shutdown / close 的服务句柄。
 */
export async function createOhnaServer(options: OhnaServerOptions): Promise<OhnaServer> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const dataDir = path.resolve(options.dataDir ?? path.join(os.homedir(), ".ohna"));

  // Task 11：serve 退化为 runtime 的纯适配器，不再持有 store/RunManager（单 dataDir 写者约束）。
  // 所有业务经 runtime 转发；autoApprove 在只读观测模式下强制关闭（S2）。
  const isAutoApprove = options.observeOnly ? false : options.autoApprove ?? false;
  const runtime = await createOhnaRuntime({
    dataDir,
    model: options.model,
    apiKey: options.apiKey,
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
    autoApprove: isAutoApprove,
    ...(options.team ? { team: true } : {}),
    ...(options.confirmTimeoutMs !== undefined ? { confirmTimeoutMs: options.confirmTimeoutMs } : {}),
    ...(options.streamFn !== undefined ? { streamFn: options.streamFn } : {}),
    ...(options.modelCatalog !== undefined ? { modelCatalog: options.modelCatalog } : {})
  });
  // 迁移期单工作区：以绝对根作为 workspaceId 注册主工作区，使 createConversation
  // 传 workspaceId=workspaceRoot 通过 fail-closed 授权（与旧 serve 的 workspaceId 一致）。
  await runtime.registerWorkspace(workspaceRoot, workspaceRoot);

  const modelCatalog = options.modelCatalog ?? createSingleModelCatalog(options.model);

  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  let closing = false;

  registerErrorHandler(app);
  registerRoutes(app, {
    workspaceRoot,
    dataDir,
    model: options.model,
    modelCatalog,
    runtime,
    pid: process.pid,
    isShuttingDown: () => closing,
    isAutoApprove,
    observeOnly: options.observeOnly === true
  });
  registerStaticFallback(app, {
    staticDir: options.staticDir ?? defaultStaticDir(),
    workspaceRoot
  });

  const state: { port?: number; url?: string } = {};

  const server: OhnaServer = {
    app,

    async listen(port: number) {
      await app.listen({ port, host: "127.0.0.1" });
      const address = app.server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : port;
      state.port = actualPort;
      state.url = `http://127.0.0.1:${actualPort}`;
      return { port: actualPort, url: state.url };
    },

    async shutdown() {
      closing = true;
      await runtime.shutdown();
    },

    async close() {
      await app.close();
    },

    resolveConfirmation(runId, toolCallId, decision) {
      return runtime.resolveConfirmation(runId, toolCallId, decision);
    },

    async createConversation(title?: string) {
      const summary = await runtime.createConversation({
        title,
        workspaceId: workspaceRoot
      });
      return toConversationDto(summary, workspaceRoot);
    },

    async listConversations() {
      const summaries = await runtime.listConversations();
      return summaries.map((summary) => toConversationDto(summary, workspaceRoot));
    },

    async generateConversationTitle(conversationId, text) {
      const summary = await runtime.generateConversationTitle(conversationId, text);
      return summary ? toConversationDto(summary, workspaceRoot) : undefined;
    },

    async createRun(input) {
      // conversationId 缺省时 runtime 内部自动建会话；组装 HTTP 专用受理回执（含 URL）。
      const result = await runtime.startRun({
        conversationId: input.conversationId,
        message: input.message,
        mode: input.mode ?? "auto",
        source: input.source ?? "composer",
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
        ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
        ...(input.maxCost !== undefined ? { maxCost: input.maxCost } : {}),
        workspaceId: workspaceRoot
      });
      const accepted: CreateRunResult["accepted"] = {
        runId: result.accepted.runId,
        requestId: result.accepted.requestId,
        conversationId: result.accepted.conversationId,
        modelId: result.accepted.modelId,
        status: result.accepted.status,
        eventsUrl: `/api/runs/${result.accepted.runId}/events`,
        snapshotUrl: `/api/runs/${result.accepted.runId}`
      };
      return { accepted, snapshot: result.snapshot };
    },

    subscribeRun(runId, listener) {
      // runtime 订阅为 async 返回 Subscription；serve 句柄保持同步返回退订闭包。
      let unsubscribe = (): void => undefined;
      // 句柄镜像在途 run 只需实时通道（liveOnly），与旧 live-only 订阅行为一致。
      void runtime.subscribeRun(runId, { onEvent: listener, liveOnly: true }).then((subscription) => {
        unsubscribe = () => subscription.unsubscribe();
      });
      return () => unsubscribe();
    },

    subscribeConversation(conversationId, listener) {
      let unsubscribe = (): void => undefined;
      void runtime.subscribeConversation(conversationId, { onEvent: listener, liveOnly: true }).then((subscription) => {
        unsubscribe = () => subscription.unsubscribe();
      });
      return () => unsubscribe();
    },

    cancelRun(runId) {
      return runtime.cancelRun(runId);
    },

    isAutoApprove() {
      return isAutoApprove;
    },

    get observeOnly() {
      return options.observeOnly === true;
    },

    listRunsByConversation(conversationId) {
      return runtime.listRunsByConversation(conversationId);
    },

    get port() {
      return state.port;
    },

    get url() {
      return state.url;
    }
  };

  return server;
}

/**
 * 确保数据目录存在（供 `ohna --web` 启动日志/诊断使用）。
 *
 * @param dataDir 数据目录。
 */
export async function ensureDataDir(dataDir: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
}

/**
 * 在 127.0.0.1 上监听端口；占用时自动 +1 重试（EADDRINUSE 除外直接抛出）。
 *
 * Phase 5 起为共享 helper：`ohna --web` 入口使用同一套
 * 端口探测逻辑，避免「一个入口会 +1、另一个直接失败」的漂移。
 *
 * @param server 已装配的服务。
 * @param initialPort 起始端口。
 * @returns 实际端口与 URL。
 */
export async function listenWithRetry(
  server: OhnaServer,
  initialPort: number
): Promise<{ port: number; url: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_PORT_ATTEMPTS; attempt += 1) {
    const port = initialPort + attempt;
    if (port > 65_535) break;
    try {
      return await server.listen(port);
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`端口 ${initialPort} 起连续 ${MAX_PORT_ATTEMPTS + 1} 次均被占用。`);
}

export type { RunManager } from "./run-manager.js";
export type {
  CreateRunResult,
  LlmCallPushEvent,
  ResolvedWorkspaceContext,
} from "./run/types.js";
export {
  createAsyncConfirmGate,
  summarizeToolCall,
  DEFAULT_CONFIRM_TIMEOUT_MS,
  type AsyncConfirmGate,
  type AsyncConfirmGateOptions,
  type ConfirmationDecision,
  type ConfirmationRequestedPayload,
  type ResolveConfirmationResult
} from "./confirm-gate.js";
export { createSingleModelCatalog } from "./routes/models.js";
export { createTitleGenerator, type TitleGeneratorOptions } from "./run/title.js";
export {
  LocalMessageStore,
  LocalRunStore,
  LocalSessionStore,
  isValidStoreId
} from "./store/index.js";
export type {
  AppendMessageInput,
  ConversationMeta,
  RunMeta,
  SessionMeta
} from "./store/index.js";
