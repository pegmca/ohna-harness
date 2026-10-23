/**
 * RunManager 的公共输入/依赖与内部活跃状态类型。
 */
import type { StreamFn } from "@aiagent/agent";
import type { AgentEvent } from "@aiagent/agent";
import type { Model } from "@aiagent/ai";
import type { AgentTool } from "@aiagent/tools";
import type {
  AgentRunAcceptedDto,
  LlmCallRecordDto,
  RunSnapshotDtoV2,
  RunStreamEventDtoV2
} from "@aiagent/types";
import type { AsyncConfirmGate } from "../confirm-gate.js";
import type { LocalMessageStore, LocalRunStore, LocalSessionStore } from "../store/index.js";

/** SSE / 快照错误的最小结构化形状。 */
export interface RunErrorPayload {
  code: string;
  message: string;
  requestId: string;
  details?: Record<string, unknown>;
}

/** 活跃 run 的进程内状态。 */
export interface ActiveRun {
  snapshot: RunSnapshotDtoV2;
  requestId: string;
  controller: AbortController;
  done: Promise<void>;
  sequence: number;
  lastPersistedSequence: number;
  subscribers: Set<(event: RunStreamEventDtoV2) => void>;
  terminal: boolean;
  /** 首次 user message_end 是创建 run 时已落库的 prompt，避免重复写入。 */
  skipFirstUserMessage: boolean;
  /** 终态收尾 Promise；并发 cancel / shutdown 时复用，避免重复 run_status。 */
  finishPromise?: Promise<void>;
  /** 终态后内存回收定时器（P3-5）；unref，避免阻止进程退出。 */
  reclaimTimer?: NodeJS.Timeout;
}

/** 创建 run 的输入。 */
export interface CreateRunInput {
  requestId: string;
  conversationId: string;
  message: string;
  mode: "auto" | "report";
  source: "composer" | "report_button";
}

/** createRun 的返回：accepted DTO + 初始快照。 */
export interface CreateRunResult {
  accepted: AgentRunAcceptedDto;
  snapshot: RunSnapshotDtoV2;
}

/**
 * 观测型 run 的补充事件：LLM 采集记录（`llm_call`）。
 * AgentEvent 联合里没有该 kind（它由采集层产出，不属于 loop 内核）。
 */
export interface LlmCallPushEvent {
  type: "llm_call";
  payload: LlmCallRecordDto;
}

/** observeRun 的输入：CLI 本地执行、serve 只承接事件。 */
export interface ObserveRunInput {
  /** 目标会话 id；不存在时按 title 自动创建。 */
  conversationId: string;
  /** 请求标识（CLI 侧通常是 `<sessionId>:<turnIndex>`），缺省自动生成。 */
  requestId?: string;
  /** 会话缺失时的标题。 */
  title?: string;
}

/**
 * 观测型 run 句柄：CLI 把本地 agentLoop 的事件灌进来，serve 负责存储 / SSE / sequence。
 *
 * 语义约定：`push` / `end` 不抛错（观测不能打断 CLI）；执行权始终在 CLI 本地，
 * serve 不持有 AbortController 的决策权（cancel 对观测型 run 无意义）。
 */
export interface ObservedRun {
  runId: string;
  /** 推送一条 loop 事件或 llm_call 记录；run 已终态时静默忽略。 */
  push(event: AgentEvent | LlmCallPushEvent): void;
  /**
   * 合成 run_status 终态并释放内存态（幂等）。
   *
   * @param result.failed 本轮是否失败（映射为 failed / completed）。
   * @param result.error 失败时的结构化错误（透传给 run_status.payload.error）。
   */
  end(result?: { failed?: boolean; error?: RunErrorPayload }): void;
}

/**
 * 一次 run 的会话级工作区上下文（BUG-002 方案 2）。
 *
 * systemPrompt 文案中已内嵌 cwd，AgentContext 本身不再需要单独 workspaceRoot；
 * tools 是本次 run 实际注入 agentLoop 的编码工具集。
 */
export interface ResolvedWorkspaceContext {
  workspaceRoot: string;
  systemPrompt: string;
  tools: AgentTool[];
}

/** RunManager 依赖。 */
export interface RunManagerOptions {
  workspaceRoot: string;
  model: Model<"openai-completions">;
  apiKey: string;
  systemPrompt: string;
  tools: AgentTool[];
  messageStore: LocalMessageStore;
  runStore: LocalRunStore;
  sessionStore: LocalSessionStore;
  streamFn?: StreamFn;
  /**
   * 按会话解析工作区上下文（BUG-002 方案 2）：返回该会话应使用的
   * workspaceRoot / systemPrompt / tools。缺省时回退到构造时的
   * workspaceRoot / systemPrompt / tools（单工作区语义，保持向后兼容）。
   */
  resolveWorkspace?: (conversationId: string) => Promise<ResolvedWorkspaceContext>;
  /** 异步确认闸门；缺省时所有工具直接执行（测试 / 只读装配）。 */
  confirmGate?: AsyncConfirmGate;
  /**
   * run 前会话级压缩的摘要器（L3-3）；缺省由 model + apiKey + streamFn 构造
   * （createServeSummarizer）。测试可注入桩以避免真实摘要调用。
   */
  summarizer?: (
    messagesToSummarize: import("@aiagent/agent").AgentMessage[],
    previousSummary?: string,
    signal?: AbortSignal
  ) => Promise<string>;
  /**
   * 语义会话标题生成器（BUG-002）；缺省由 model + apiKey + streamFn 构造
   * （createTitleGenerator）。失败应返回 undefined，调用方降级为截断标题。
   * 测试可注入桩以避免真实标题调用。
   */
  titleGenerator?: (text: string, signal?: AbortSignal) => Promise<string | undefined>;
}
