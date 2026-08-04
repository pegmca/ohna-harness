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
