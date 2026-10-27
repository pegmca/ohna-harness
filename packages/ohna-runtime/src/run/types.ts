/**
 * RunManager 的公共输入/依赖与内部活跃状态类型。
 */
import type { StreamFn, TeamState } from "@aiagent/agent";
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
import type { WorkspaceRegistry, WorkspaceContextCache, WorkspaceMcpRegistry } from "../workspace/index.js";
import type { ServeTeamSession } from "./team-session.js";
import type { RunConfigSnapshot } from "../model/config.js";

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
  /** 执行链完成（含 loop 收尾与清理）；用于 cancel / shutdown 等待。 */
  done: Promise<void>;
  /** 终态达成（completed / failed / interrupted）；用于同会话 FIFO 放行，避免等待后置清理。 */
  terminalDone: Promise<void>;
  /** 将 terminalDone 标记为完成；单 run 内只调用一次。 */
  resolveTerminalDone: () => void;
  sequence: number;
  lastPersistedSequence: number;
  subscribers: Set<(event: RunStreamEventDtoV2) => void>;
  terminal: boolean;
  /** 首次 user message_end 是创建 run 时已落库的 prompt，避免重复写入。 */
  skipFirstUserMessage: boolean;
  /** 单次 run 的最大回合数（--max-turns 透传；undefined 取内核默认）。 */
  maxTurns?: number;
  /** 单次 run 的墙钟上限毫秒（--deadline-ms 透传；undefined 表示不限）。 */
  deadlineMs?: number;
  /** 会话累计成本上限美元（--max-cost；undefined 表示不限）。 */
  maxCost?: number;
  /** 终态收尾 Promise；并发 cancel / shutdown 时复用，避免重复 run_status。 */
  finishPromise?: Promise<void>;
  /** 终态后内存回收定时器（P3-5）；unref，避免阻止进程退出。 */
  reclaimTimer?: NodeJS.Timeout;
  /** run 创建时解析的配置快照；缺省时回退 RunManager 构造配置。 */
  config?: RunConfigSnapshot;
}

/** 创建 run 的输入。 */
export interface CreateRunInput {
  requestId: string;
  conversationId: string;
  message: string;
  mode: "auto" | "report";
  /** 触发入口：composer/report_button 来自浏览器，cli 来自终端（单一形态下终端也经 serve 执行）。 */
  source: "composer" | "report_button" | "cli";
  /** --max-turns：单次 run 最大回合数（缺省取内核默认）。 */
  maxTurns?: number;
  /** --deadline-ms：单次 run 墙钟上限。 */
  deadlineMs?: number;
  /** --max-cost：会话累计成本上限（美元）。 */
  maxCost?: number;
  /** 工作区归属：跨工作区会话续写时携带，供 Task 6 的工作区授权与上下文解析使用（当前透传、暂不消费）。 */
  workspaceId?: string;
  /** run 创建时解析的配置快照；runtime 组合根注入后作为本 run 的执行事实源。 */
  config?: RunConfigSnapshot;
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
   * 工作区授权注册表（spec §6）：负责授权表维护与 conversation/run → workspace 归属反查。
   * 资源操作经 `assertAuthorized` 反查授权，未授权 / 已撤销的工作区一律拒绝（fail-closed）。
   */
  workspaceRegistry?: WorkspaceRegistry;
  /**
   * 按 canonical 根缓存的系统提示词与工具集；run 创建时按会话 workspace 解析上下文，
   * 避免每次 run 都重新读项目上下文（AGENTS.md / git 状态）。
   */
  workspaceContextCache?: WorkspaceContextCache;
  /**
   * 按 workspace 隔离的 MCP 会话生命周期容器；撤销工作区时统一 close。
   */
  workspaceMcpRegistry?: WorkspaceMcpRegistry;
  /**
   * 资源操作前的归属授权校验（fail-closed）：反查 id 对应的 conversation/run 所属工作区
   * 是否已授权。未绑定 / 未授权时抛 `forbidden` 或 `workspace_unavailable`。
   * 缺省（测试 / 无工作区模式）为空操作。
   */
  assertAuthorized?: (id: string) => Promise<void>;
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
  /**
   * 团队状态读取器（G-T1 单一路径，docs/v2.0/03-team-eval.md §9.1）：由组合根把
   * `TeamController.getTeamState` 绑定后透传，run 收尾时用于投影 `cost_summary.payload.team`。
   * 未注入（如 --no-team / 非 team 宿主）时不产生 team 段，事件形状与接入前一致。
   *
   * v2.0（docs/v2.0/04 §2.2）：`team: true` 时 serve 侧 TeamController 的 `getTeamState`
   * 优先；本字段退为 fallback，仍保留 03 已接通的组合根参数链（不得删除）。
   */
  getTeamState?: () => TeamState;
  /**
   * Team 开关（docs/v2.0/04 §2.2）：缺省 false 保持既有单智能体行为——不注册 Team 工具、
   * 不注入 observer、不转发子代理事件、不产生 run 级 Team 状态。
   */
  team?: boolean;
  /**
   * serve 侧 Team 会话（`createServeTeamSession` 的产物）。`team: true` 时必须提供；
   * 拆成注入项而非在 RunManager 内构造，是为了让 Team 装配（controller / 工具池 / 窗口）
   * 集中在组合根一处，RunManager 只做接线。
   */
  teamSession?: ServeTeamSession;
}
