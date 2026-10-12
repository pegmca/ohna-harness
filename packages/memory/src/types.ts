/**
 * @aiagent/memory 核心类型定义（三层记忆：短期/长期/语义）。
 *
 * 设计原则：本包不反向依赖 @aiagent/agent，避免形成包级依赖环。
 * 因此与 AgentLoopConfig 钩子（prepareNextTurn / afterToolCall）对接的上下文类型
 * 一律用「结构最小形状」（duck typing），只要运行时字段齐全即可被直接当作
 * 对应钩子使用；orchestrator 在集成层把本包 hook 挂载进 agent loop。
 */
import type { Message } from "@aiagent/ai";
import type { RequestId } from "@aiagent/types";

/** 复用 @aiagent/types 的请求标识作为 episode 主键类型（线格式一致、去重稳定）。 */
export type EpisodeId = RequestId;

/**
 * 与 AgentLoopConfig 对话消息兼容的最小结构类型（不反向依赖 @aiagent/agent）。
 * 结构上等价于 agent 包的 `AgentMessage`（Message | CompactionMessage），用于让本包的记忆
 * 注入钩子可作为 `transformContext` 直接挂载——结构性一致即可赋值，无需引用 agent 包。
 * 选择 `transformContext` 而非 `prepareNextTurn` 的原因：transformContext 的返回值只用于
 * 当次 LLM 调用、不会被写回持久对话历史，注入天然"瞬时"，避免记忆块逐轮累积污染上下文。
 */
export type MemoryMessage =
  | Message
  | { role: "compaction"; summary: string; tokensBefore: number; summarizedMessageCount: number; timestamp: number };

/** 情节记忆类型标签：观察 / 决策 / 结果。 */
export type EpisodeType = "observation" | "decision" | "result";

/**
 * 情节记忆记录（episodic memory）：跨会话长期记忆的最小单元。
 * 一条 episode 代表一次值得记住的「观察 / 决策 / 结果」，可来自工具回写或显式记录。
 */
export interface EpisodeMemory {
  /** 稳定主键（见 EpisodeId）。 */
  id: EpisodeId;
  /** Unix 毫秒时间戳。 */
  timestamp: number;
  /** 记忆文本（检索与注入的最小内容单元）。 */
  content: string;
  /** 记忆类型标签。 */
  type: EpisodeType;
  /** 来源轮次（可选，用于回溯）。 */
  sourceTurn?: number;
  /**
   * 可选：真实向量嵌入。学习版用本地相似度替代向量库，故默认不填充；
   * 未来接 PG + pgvector 时由 embedding 模型填充本字段并改用向量检索。
   */
  embedding?: number[];
  /** 任意业务元数据（如工具参数、isError 标记）。 */
  metadata?: Record<string, unknown>;
}

/** 带相似度评分的检索结果（score 范围 0~1，越大越相关）。 */
export interface RetrievedMemory {
  /** 命中的情节记忆记录。 */
  record: EpisodeMemory;
  /** 相似度评分。 */
  score: number;
}

/** 工作记忆中的一条键值事实（短期、在上下文窗口内）。 */
export interface WorkingMemoryFact {
  /** 事实键（同名覆盖）。 */
  key: string;
  /** 事实值。 */
  value: string;
}

/**
 * 工作记忆（WorkingMemory）：短期、在上下文窗口内的轻量状态，
 * 由一条滚动 summary + 一组键值事实组成；每轮可被读取并注入或覆盖。
 */
export interface WorkingMemory {
  /** 滚动摘要文本。 */
  summary: string;
  /** 键值事实列表（按 key 合并）。 */
  facts: WorkingMemoryFact[];
  /** 最近更新时间戳。 */
  updatedAt: number;
}

/**
 * 记忆存储契约：长期记忆的读写边界。
 * 实现可以是纯内存（InMemoryMemoryStore）或文件持久化（JsonlMemoryStore）。
 */
export interface MemoryStore {
  /** 保存一条情节记忆（长期层）。 */
  saveEpisode(episode: EpisodeMemory): Promise<void>;
  /** 语义检索：对 query 返回 top-k 按相似度降序排列的记录。 */
  retrieve(query: string, k?: number): Promise<RetrievedMemory[]>;
  /** 读取当前工作记忆（短期层）。 */
  getWorkingMemory(): WorkingMemory;
  /** 局部更新工作记忆（summary 覆盖、facts 按 key 合并）。 */
  updateWorkingMemory(patch: Partial<Omit<WorkingMemory, "updatedAt">>): void;
  /** 列出全部情节记忆。 */
  listEpisodes(): Promise<EpisodeMemory[]>;
}

/**
 * 与 AgentContext 结构兼容的最小形状（只用到 messages / systemPrompt / tools）。
 * 用 `unknown[]` 收口 messages，使 AgentContext（messages: AgentMessage[]）可被
 * 结构性地赋给本类型，从而让本包 hook 可直接挂在 AgentLoopConfig 上而不反向依赖 agent 包。
 */
export interface AgentContextLike {
  /** 系统提示词（可选）。 */
  systemPrompt?: string;
  /** 对模型可见的消息序列（钩子可就地注入/读取）。 */
  messages: unknown[];
  /** 工具定义（可选）。 */
  tools?: unknown[];
}

/**
 * 与 AgentLoopConfig.prepareNextTurn 钩子上下文结构兼容的最小形状。
 * 只依赖 `.context`（AgentContext）；其余字段对齐完整上下文以便被直接复用。
 */
export interface MemoryPrepareNextTurnContext {
  /** 当前 agent 上下文（钩子就地注入检索记忆）。 */
  context: AgentContextLike;
  /** 本轮完成的 assistant 消息（完整上下文中存在，本包不强制使用）。 */
  message?: unknown;
  /** 本轮工具结果消息。 */
  toolResults?: unknown[];
  /** 若此刻退出将返回的消息集。 */
  newMessages?: unknown[];
}

/** 工具结果结构兼容形状（只用到 content / details / isError）。 */
export interface AgentToolResultLike {
  /** 回喂模型的内容块数组（text / image）。 */
  content: Array<{ type: string; text?: string }>;
  /** 结构化结果（不进 LLM 上下文）。 */
  details?: unknown;
  /** 是否错误结果。 */
  isError?: boolean;
}

/**
 * 与 AgentLoopConfig.afterToolCall 钩子上下文结构兼容的最小形状。
 * 只用到了 result / isError / args / context；其余字段对齐完整上下文。
 */
export interface MemoryAfterToolCallContext {
  /** 发起调用的 assistant 消息。 */
  assistantMessage?: unknown;
  /** 原始 toolCall 块。 */
  toolCall?: unknown;
  /** 通过校验的工具参数。 */
  args?: unknown;
  /** 执行结果（未应用覆盖前）。 */
  result: AgentToolResultLike;
  /** 是否错误结果。 */
  isError: boolean;
  /** 当前 agent 上下文。 */
  context: AgentContextLike;
}

/** 记忆预算与注入配置（token 预算、检索条数、评分阈值、围栏标签）。 */
export interface MemoryBudgetSettings {
  /** 注入检索记忆后允许的最大上下文 token 数；超过则不注入，避免撑爆窗口。 */
  maxTokens: number;
  /** 单次检索返回的最大条数。 */
  maxResults: number;
  /** 检索相似度阈值：score 低于该值的结果不注入（本地余弦相似度 0~1）。 */
  minScore: number;
  /** 检索记忆注入的前导围栏标签，如「检索记忆」。 */
  fenceLabel: string;
}

/** 默认记忆预算：约 12k token 上限、最多 5 条、阈值 0.05、围栏「检索记忆」。 */
export const DEFAULT_MEMORY_BUDGET: MemoryBudgetSettings = {
  maxTokens: 12000,
  maxResults: 5,
  minScore: 0.05,
  fenceLabel: "检索记忆",
};
