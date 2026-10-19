/**
 * 多智能体 Supervisor 编排的类型契约（P3）。
 *
 * 设计对齐 Claude Code Subagent / pi subagent 思想：
 * - 每个 TeamMember 是一次独立 `agentLoop`（独立 context + EventStream）；
 * - 跨 agent 通信只走显式 TeamMessage（消息总线），不共享可变内存；
 * - 主上下文只回收「摘要」，子代理的探索/工具噪音不外泄（上下文隔离 + 摘要回收）。
 */
import type { Api, Message, Model } from "@aiagent/ai";
import type { AgentTool } from "@aiagent/tools";
import type { AgentLoopConfig, AgentMessage, StreamFn } from "../types.js";
import type { BudgetGuardConfig, TeamBudgetAccumulator } from "./budget.js";

export type { BudgetGuardConfig, TeamBudgetAccumulator } from "./budget.js";

/**
 * 团队成员（子代理）状态。
 *
 * 每个成员 = 一次独立 `agentLoop`，持有自己的 `model` 与 `allowedTools`（权限最小化）。
 * 主上下文只通过 `summary` / `artifacts` 回收其产出，不接触其原始消息流。
 */
export interface TeamMember {
  /** 子代理唯一名称（消息总线寻址键）。 */
  name: string;
  /** 角色描述（如「多头评审」「风控评审」）。 */
  role: string;
  /** 该子代理使用的模型；由 supervisor 在 TeamCreate 时决定（成本路由）。 */
  model: Model<Api>;
  /**
   * 被授权工具名子集（权限最小化）。缺省（undefined）时由 controller 从可用池全量授予；
   * 显式空数组 `[]` 表示授予零工具。生产实践应只给任务所需子集（如评审代理只给只读工具）。
   */
  allowedTools?: string[];
  /** 角色专属 system prompt，注入子代理上下文（覆盖默认角色提示）。 */
  systemPrompt?: string;
  /** 运行状态机：idle→running→done|failed。 */
  status: "idle" | "running" | "done" | "failed";
  /** 子代理回传的摘要（上下文隔离：主上下文只回收它）。 */
  summary?: string;
  /** 子代理产出的产物引用（如工具结果摘要），供 supervisor 汇总引用。 */
  artifacts?: string[];
  /** 本次运行累计用量（token 数 + 成本美元），由成本护栏在每轮 turn_end 累加。 */
  usage?: { tokens: number; cost: number };
  /** 是否被成本护栏停止（超 per-member 或团队总 ceiling / deadline）。 */
  budgetExceeded?: boolean;
  /** 该成员本次 subagent 运行墙钟时长（毫秒），仅当真实跑过才回填；多代理时延归因用。 */
  durationMs?: number;
}

/**
 * 消息总线信封：跨 agent 通信只走显式 SendMessage，不共享全局可变状态。
 * 可 replay / trace / 审计，且天然失败隔离（一条消息失败不污染其他成员）。
 */
export interface TeamMessage {
  /** 消息唯一 id（用于 replay / 去重）。 */
  id: string;
  /** 发送方名称；supervisor 派发时为 "supervisor"。 */
  from: string;
  /** 接收方成员名称。 */
  to: string;
  /** 消息正文（通常是委派给该成员的任务）。 */
  content: string;
  /** Unix 毫秒时间戳。 */
  timestamp: number;
}

/**
 * 投影的 run-event：team 状态机对底层 agentLoop 事件的轻量投影，
 * 供可观测看板 / Agent View 使用，不携带完整消息体（控制体积）。
 */
export interface TeamEvent {
  type: "member_created" | "message_sent" | "member_started" | "member_completed" | "member_failed";
  /** Unix 毫秒时间戳。 */
  timestamp: number;
  /** 关联成员名称。 */
  member?: string;
  /** 人类可读的补充信息。 */
  detail?: string;
}

/**
 * Team 状态快照：成员表（name/role/状态）、每成员 inbound 消息队列、run_events 投影。
 * `getTeamState()` 返回浅拷贝快照，调用方不应直接 mutate 其中的实时引用。
 */
export interface TeamState {
  members: Map<string, TeamMember>;
  inboundQueues: Map<string, TeamMessage[]>;
  events: TeamEvent[];
  /**
   * 本次团队运行观测到的在飞成员峰值（多代理并发/容量证据）。由 controller 在 runMember
   * 入口 acquire 后维护 runningMembers 在飞计数峰值；缺省表示本次未实际并发（如 maxConcurrentMembers=1）。
   */
  peakConcurrency?: number;
}

/** TeamCreate 工具参数（由 supervisor 的 model 决定何时 spawn 与如何配置成员）。 */
export interface TeamCreateParams {
  /** 子代理唯一名称。 */
  name: string;
  /** 角色描述。 */
  role: string;
  /**
   * 模型 id（成本路由：轻任务小模型、重分析大模型）。省略时用 controller 的 defaultModel。
   * 由 `resolveModel(id)` 解析成具体 Model；不可解析时报结构化错误。
   */
  model?: string;
  /** 授权工具名子集；省略时从可用池全量授予，`[]` 表示零工具。 */
  tools?: string[];
  /** 角色 system prompt 覆盖。 */
  systemPrompt?: string;
}

/** SendMessage 工具参数：向某成员派发一条任务消息。 */
export interface SendMessageParams {
  /** 接收成员名称。 */
  recipient: string;
  /** 委派给该成员的任务 / 消息正文。 */
  content: string;
}

/**
 * 子代理一次运行的结构化结果。
 * 同时作为 SendMessage 工具结果的 `details`（供 trace/UI）与 team 状态的回写内容。
 */
export interface SubagentResult {
  /** 成员名称。 */
  member: string;
  status: "done" | "failed";
  /** 回收给主上下文的摘要文本。 */
  summary: string;
  /** 产物引用列表。 */
  artifacts: string[];
  /** 失败时的结构化错误（code + message），成功则为 undefined。 */
  error?: { code: string; message: string };
  /** 本次运行累计用量（token 数 + 成本美元），由成本护栏累加。 */
  usage?: { tokens: number; cost: number };
  /** 是否被成本护栏停止（超预算 / deadline）。 */
  budgetExceeded?: boolean;
  /** 成员使用的模型 id（成本路由依据）；供 run-service 投影 cost_summary.team 段对齐形状。 */
  model?: string;
}

/** createTeamController 的选项。 */
export interface TeamControllerOptions {
  /** 可用工具池：子代理工具只能是它的子集（权限最小化）。 */
  availableTools?: AgentTool[];
  /** 默认 model：TeamCreate 未指定 model 时使用。 */
  defaultModel: Model<Api>;
  /** 把 model 字符串 id 解析成 Model；不传则 TeamCreate 必须显式给出可解析的 model id。 */
  resolveModel?: (id: string) => Model<Api> | undefined;
  /** 注入的子代理流式函数，缺省用 @aiagent/ai 的 streamSimple（测试注入 mock）。 */
  streamFn?: StreamFn;
  /** 子代理使用的 convertToLlm，缺省用 defaultConvertToLlm。 */
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  /**
   * 最大并发成员数（在飞上限）。默认 1 = 现状顺序执行（学习版、易 trace）；
   * 演示并发可设 3。runMember 入口经信号量 acquire/release 限制并发，配合
   * `runMembers` 扇出 helper 实现 pi 风格 worker 池。
   */
  maxConcurrentMembers?: number;
  /**
   * 成本护栏配置（P0）：per-member 上限与团队总 ceiling + 墙钟 deadline。
   * 通过 `AgentLoopConfig.shouldStopAfterTurn` 钩子注入子代理，内核零改动。
   */
  budget?: BudgetGuardConfig;
  /**
   * 策略继承（K3）：把 supervisor 的权限闸门原样注入每个子代理的 `agentLoop`。
   *
   * 子代理与 supervisor 共用**同一权限闸门与会话 PolicyState**：write / edit / bash
   * 在子代理内部执行时同样受审（Shift+Tab 模式、会话 allowlist、plan 模式全部生效）。
   * 这里只声明 `AgentLoopConfig` 的钩子类型，不 import permission 模块——策略本体
   * 仍由组合根装配，team 包保持「只管编排、不感知审批实现」的边界。
   */
  beforeToolCall?: AgentLoopConfig["beforeToolCall"];
}
