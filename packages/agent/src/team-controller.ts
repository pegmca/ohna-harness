/**
 * 多智能体 Supervisor 编排（P3）公共出口。
 *
 * 本文件是 barrel：把 team/ 下的类型与工厂原样 re-export，保持公共 API 稳定、
 * 导入方零修改。编排核心 `agentLoop` 不被修改——子代理直接复用它作为原语。
 */
export {
  createTeamController,
  getTeamView,
  type TeamController,
} from "./team/controller.js";
export {
  createTeamCreateTool,
  createSendMessageTool,
  type TeamToolDeps,
} from "./team/tools.js";
export { createBullBearRiskTeam, type BullBearRiskOptions } from "./team/presets.js";
export type {
  TeamMember,
  TeamMessage,
  TeamState,
  TeamEvent,
  TeamCreateParams,
  SendMessageParams,
  SubagentResult,
  TeamControllerOptions,
} from "./team/types.js";
// 成本护栏与最小并发原语（P0）：供 presets / 测试直接引用，导入方一处取用。
export {
  createBudgetGuard,
  createMemberStopHook,
  type BudgetGuardConfig,
  type TeamBudgetAccumulator,
  type MemberBudgetHook,
} from "./team/budget.js";
export { mapWithConcurrencyLimit, Semaphore, AsyncMutex } from "./team/concurrency.js";
