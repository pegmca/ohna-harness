/**
 * @aiagent/agent 公共出口：pi-agent 形态的多轮 ReAct loop（阶段 2）。
 * 旧的单轮意图路由三分支编排（runAgent/createAgent/intent-router/reliability/llm-client）
 * 已删除；security 已独立为 @aiagent/security（阶段 5）。
 */
export { agentLoop, agentLoopContinue, runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
export { executeToolCalls, failToolCallsFromTruncatedMessage } from "./agent-loop.js";
export { defaultConvertToLlm, toLlmTools } from "./convert.js";
export {
  compact,
  createCompactionTransform,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  prepareCompaction,
  shouldCompact,
  type CompactionMessage,
  type CompactionPreparation,
  type CompactionSettings,
  type CompactionTransformOptions,
} from "./compaction.js";
export type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentLoopTurnUpdate,
  AgentLoopError,
  AgentMessage,
  AgentToolCall,
  BeforeToolCallContext,
  BeforeToolCallResult,
  PrepareNextTurnContext,
  ShouldStopAfterTurnContext,
  StreamFn,
} from "./types.js";
// AgentTool 契约定义在 @aiagent/tools（工具契约属于工具包），此处原样 re-export，
// 对外仍从 @aiagent/agent 拿到 AgentTool，命名与 pi 对齐。
export type { AgentTool, AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode } from "./types.js";

// ---- v1.1 控制流增强（docs/v1.1/01-control-flow-multagent.md）----
// P1 系统化 Context Engineering：分层上下文装配器 + token 预算分级。
export {
  buildSystemPromptWithMemory,
  formatMemoryAsUserMessage,
  assembleMemoryBlocks,
  limitContextByBudget,
  computeMemoryBudgetTokens,
  defaultDeriveQuery,
  createContextAssemblyTransform,
  DEFAULT_CONTEXT_BUDGET,
  buildBudgetReport,
  summarizeBudgetReports,
} from "./context-assembly.js";
export type {
  AssembleMemoryInput,
  AssembledMemory,
  ContextAssemblerOptions,
  ContextBudgetSettings,
  ContextBudgetTier,
  MemoryBlock,
  MemoryInjectionMode,
  RetrievedMemoryProvider,
  WorkingMemoryProvider,
  ContextBudgetReport,
  BudgetSummary,
} from "./context-assembly.js";

// P4 Goal 模式：loop 外挂目标守卫（零改 agentLoop，依赖倒置判定器）。
export { createCommandJudger, createGoalController, createLlmJudger } from "./goal-controller.js";
export type {
  CommandJudgerOptions,
  GoalController,
  GoalControllerOptions,
  GoalJudgeContext,
  GoalJudgeResult,
  GoalJudger,
  GoalProgress,
  LlmJudgerOptions,
} from "./goal-controller.js";

// P5 Plan-and-Execute + Reflexion：规划 DAG + 自评估重试（复用既有钩子，组合于 Goal 之上）。
export {
  createPlanner,
  createReflexionHook,
  defaultPlanSystemPrompt,
  defaultReflectionPrompt,
  parsePlanFromModel,
} from "./plan-reflexion.js";
export type {
  Plan,
  Planner,
  PlannerError,
  PlannerOptions,
  ReflexionHookOptions,
  ReflexionHooks,
  ReflexionResult,
  Subtask,
  SubtaskStatus,
} from "./plan-reflexion.js";

// P3 多智能体 Supervisor 编排：复用 agentLoop 作 subagent 原语 + TeamCreate/SendMessage 消息总线。
export * from "./team-controller.js";

// P3 多代理成本 → RunEvent(cost_summary) 投影（可观测闭环）：把 TeamState / ContextBudgetReport[]
// 投影成完全对齐 trace 契约的 team / contextBudget 段，供 run-service 在 agent_end 直接并入 payload。
export { projectTeamCostSummary, projectContextBudgetSummary } from "./team/run-event.js";
export type { TeamCostMember, TeamCostSection } from "./team/run-event.js";

// SLO / 容量证据聚合（docs/v1.2 §3 差距#7 收口）：成本已由 cost_summary 覆盖，本层补
// 时延/成功率/并发三类可量化证据。纯函数聚合，run-service 在 agent_end 并入 cost_summary.payload。
export { summarizeSlo } from "./team/slo.js";
export type { RunSloSummary, SloAggregate } from "./team/slo.js";

export interface AgentStatus {
  name: string;
  description: string;
  ready: boolean;
}

/**
 * 返回 agent package 当前能力摘要，便于 smoke test 和前端调试台展示。
 *
 * @returns package 状态摘要。
 */
export function createAgentStatus(): AgentStatus {
  return {
    name: "@aiagent/agent",
    description: "Agent package provides a pi-shaped multi-turn ReAct loop (agentLoop/agentLoopContinue) with AgentTool contracts.",
    ready: true
  };
}
