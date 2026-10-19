/**
 * 权限领域模块公共入口。
 *
 * 与 `agent-loop.ts` 的关系：本模块是「组合根挂载的策略」，不是内核依赖；
 * 内核只负责在工具执行前调用 `beforeToolCall`，不感知 allow / deny / ask 语义。
 */
export {
  createPermissionGate,
  resolvePermissionTarget,
  resolveToolEffect,
} from "./gate.js";
export {
  composePolicy,
  createPresetPolicy,
  summarizePermissionRequest,
} from "./policy.js";
export { createPolicyState } from "./state.js";
export type {
  AskAdapter,
  PermissionAnswer,
  PermissionDecision,
  PermissionEffect,
  PermissionPolicy,
  PermissionPreset,
  PermissionRequest,
  PermissionRule,
  PolicyState,
} from "./types.js";
