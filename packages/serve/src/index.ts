/**
 * `@aiagent/serve` 公共入口：ohna 本地服务端装配。
 *
 * 装配只做三件事：
 * 1. 构造 JSONL stores（会话元数据 / 线性消息 / run 事件）；
 * 2. 构造 RunManager（消费 `agentLoop`，实现 run-v2 线协议）；
 * 3. 注册 HTTP/SSE 路由与静态 fallback。
 *
 * `apps/ohna-api` 只负责进程生命周期；未来 `ohna-cli --web` 复用同一装配，
 * 因此这里不读取 `process.argv`、不打开浏览器、不注册信号处理。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { StreamFn } from "@aiagent/agent";
import type { Model } from "@aiagent/ai";
import type { AgentTool } from "@aiagent/tools";
import { buildCodingSystemPrompt, createCodingToolRegistry } from "@aiagent/coding";
import type {
  WorkspaceConversationDto,
  ModelCatalogDto,
  RunMetaDtoV2,
  RunSnapshotDtoV2,
  RunStreamEventDtoV2
} from "@aiagent/types";
import type {
  CreateRunResult,
  ObserveRunInput,
  ObservedRun,
  ResolvedWorkspaceContext
} from "./run/types.js";
import Fastify, { type FastifyInstance } from "fastify";
import { createAsyncConfirmGate, type ConfirmationDecision, type ConfirmationRequestedPayload } from "./confirm-gate.js";
import { registerErrorHandler } from "./errors.js";
import { RunManager } from "./run-manager.js";
import { toConversationDto } from "./routes/conversations.js";
import { registerRoutes } from "./routes/index.js";
import { createSingleModelCatalog } from "./routes/models.js";
import { registerStaticFallback } from "./static.js";
import { LocalMessageStore, LocalRunStore, LocalSessionStore } from "./store/index.js";

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
   * 只读观测模式（S2）：true 时**不注册** run 创建/取消与确认写路由，并强制 autoApprove=false。
   * 默认模式的 CLI（本地执行 + 镜像观测）用 true；`--web` 托管模式用 false。
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
  ): ReturnType<RunManager["resolveConfirmation"]>;
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
   */
  createRun(input: {
    conversationId: string;
    message: string;
    mode?: "auto" | "report";
    source?: "composer" | "report_button";
    requestId?: string;
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
  /**
   * 启动观测型 run（docs/v1.4 的 D1）：CLI 本地执行、serve 只承接事件。
   * 与 createRun 并存——执行权归属不同，存储 / SSE / sequence 语义相同。
   */
  observeRun(input: ObserveRunInput): Promise<ObservedRun>;
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

  const sessionStore = new LocalSessionStore(path.join(dataDir, "sessions"));
  const messageStore = new LocalMessageStore(path.join(dataDir, "conversations"));
  const runStore = new LocalRunStore(path.join(dataDir, "runs"));

  const systemPrompt =
    options.systemPrompt ??
    (await buildCodingSystemPrompt(workspaceRoot, {
      // 上下文读取失败只影响提示词增强，不阻断本地服务启动。
      onContextError: () => undefined
    }));

  // 主工作区工具集：必须复用注入的 tools，否则会丢 MCP 工具并破坏测试注入（tools: []）。
  const tools = options.tools ?? createCodingToolRegistry(workspaceRoot);

  // BUG-002 方案 2：按会话持久化的 workspaceRoot 动态装配上下文，支持跨工作区会话续写。
  // 按绝对路径缓存 Promise：并发创建同一工作区的 run 共享同一次装配，避免重复读上下文。
  const workspaceContextCache = new Map<string, Promise<ResolvedWorkspaceContext>>();
  // 种子 = 主工作区：复用已注入的 systemPrompt / tools（单工作区语义与 MCP/测试注入零变化）。
  workspaceContextCache.set(workspaceRoot, Promise.resolve({ workspaceRoot, systemPrompt, tools }));

  /**
   * 按会话解析工作区上下文：命中缓存直接复用，未命中则按会话根装配编码上下文。
   *
   * 边界：跨工作区根只装配 `createCodingToolRegistry(root)` + 编码系统提示词，不携带
   * 主实例的 MCP 工具；写/执行仍由既有 confirm-gate 确认闸门把关，这是可接受的取舍。
   *
   * @param conversationId 会话 id。
   * @returns 该会话应使用的上下文（含绝对路径 workspaceRoot）。
   */
  const resolveWorkspace = async (conversationId: string): Promise<ResolvedWorkspaceContext> => {
    let root = workspaceRoot;
    const meta = await sessionStore.get(conversationId);
    if (meta?.workspaceRoot) root = path.resolve(meta.workspaceRoot);

    const cached = workspaceContextCache.get(root);
    if (cached) return cached;

    const context = buildCodingSystemPrompt(root, {
      onContextError: () => undefined
    }).then((prompt): ResolvedWorkspaceContext => ({
      workspaceRoot: root,
      systemPrompt: prompt,
      tools: createCodingToolRegistry(root)
    }));
    workspaceContextCache.set(root, context);
    return context;
  };

  // 闸门的 emit 需要 RunManager（分配 sequence 后落盘 + 广播），而 RunManager 又需要闸门。
  // 用运行期持有者打破构造期循环：emit 只在工具真正请求确认时才被调用。
  const emitHolder: {
    emit?: (runId: string, payload: ConfirmationRequestedPayload) => Promise<void>;
  } = {};

  const confirmGate = createAsyncConfirmGate({
    // 只读观测模式下强行关闭自动批准：该进程根本不该执行工具（S2）。
    autoApprove: options.observeOnly ? false : options.autoApprove ?? false,
    ...(options.confirmTimeoutMs !== undefined ? { timeoutMs: options.confirmTimeoutMs } : {}),
    emit: async (runId, payload) => {
      if (!emitHolder.emit) throw new Error("确认事件通道尚未就绪。");
      await emitHolder.emit(runId, payload);
    }
  });

  const runManager = new RunManager({
    workspaceRoot,
    model: options.model,
    apiKey: options.apiKey,
    systemPrompt,
    tools,
    messageStore,
    runStore,
    sessionStore,
    confirmGate,
    resolveWorkspace,
    ...(options.streamFn ? { streamFn: options.streamFn } : {})
  });
  emitHolder.emit = (runId, payload) =>
    runManager.emitConfirmationRequested(runId, payload);

  const modelCatalog = options.modelCatalog ?? createSingleModelCatalog(options.model);
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  let closing = false;

  registerErrorHandler(app);
  registerRoutes(app, {
    workspaceRoot,
    dataDir,
    model: options.model,
    modelCatalog,
    sessionStore,
    messageStore,
    runStore,
    runManager,
    pid: process.pid,
    isShuttingDown: () => closing,
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
      await runManager.shutdown();
    },

    async close() {
      await app.close();
    },

    resolveConfirmation(runId, toolCallId, decision) {
      return runManager.resolveConfirmation(runId, toolCallId, decision);
    },

    async createConversation(title?: string) {
      const meta = await sessionStore.create({
        title: title?.trim() ? title : "新会话",
        workspaceRoot
      });
      await messageStore.ensureConversation(meta.id, meta.title);
      return toConversationDto(meta);
    },

    async listConversations() {
      const metas = await sessionStore.list();
      return metas.map(toConversationDto);
    },

    async generateConversationTitle(conversationId, text) {
      const meta = await sessionStore.get(conversationId);
      if (!meta) return undefined;
      const title = await runManager.generateTitle(text);
      if (!title) return undefined;
      const updated = await sessionStore.update(meta.id, { title });
      return toConversationDto(updated ?? meta);
    },

    createRun(input) {
      return runManager.createRun({
        conversationId: input.conversationId,
        message: input.message,
        mode: input.mode ?? "auto",
        source: input.source ?? "composer",
        requestId: input.requestId ?? randomUUID()
      });
    },

    subscribeRun(runId, listener) {
      return runManager.subscribe(runId, listener);
    },

    subscribeConversation(conversationId, listener) {
      return runManager.subscribeConversation(conversationId, listener);
    },

    cancelRun(runId) {
      return runManager.cancel(runId);
    },

    isAutoApprove() {
      return runManager.isAutoApprove();
    },

    observeRun(input) {
      return runManager.observeRun(input);
    },

    listRunsByConversation(conversationId) {
      return runManager.listRunsByConversation(conversationId);
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
 * 确保数据目录存在（供 ohna-api 启动日志/诊断使用）。
 *
 * @param dataDir 数据目录。
 */
export async function ensureDataDir(dataDir: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
}

/**
 * 在 127.0.0.1 上监听端口；占用时自动 +1 重试（EADDRINUSE 除外直接抛出）。
 *
 * Phase 5 起为共享 helper：`ohna-api` 与 `ohna --web` 两个入口使用同一套
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
  ObserveRunInput,
  ObservedRun,
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
