/**
 * @aiagent/workflow 公共入口（barrel）。
 *
 * 单文件原本 772 行，超出 AGENTS.md「单文件 ≤500 行」纪律；本文件退化为 barrel 再导出，
 * 实现按内聚域拆到 types / node-state / events / runtime-helpers / run-engine，
 * 公共 API（10 个类型 + `createWorkflowPackageSummary` / `runSequentialWorkflow`）零改动。
 */
export * from "./types.js";
export { createWorkflowPackageSummary, runSequentialWorkflow } from "./run-engine.js";
