/**
 * RunManager 的公共输入/依赖与内部活跃状态类型。
 */
import type { StreamFn } from "@aiagent/agent";
import type { Model } from "@aiagent/ai";
import type { AgentTool } from "@aiagent/tools";
import type {
  AgentRunAcceptedDto,
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
}
