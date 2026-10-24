/**
 * @aiagent/eval-core 公共入口（v2.0 薄内核方案 §2）。
 *
 * 纯机制薄内核：只放纯函数 + 纯机制，不参与执行、不认识任何 app。
 * 跨边界 DTO（`EvalReportDto` / `BaselineDiff` / `GateResult`）定义在 `@aiagent/types`，
 * 这里用 `import type` 引用并 re-export，方便调用方从单一入口取齐类型与函数。
 *
 * 硬边界：除 `import type` 引用 `@aiagent/types` 外，无任何 `@aiagent/agent|ai|rag|trace`
 * 运行时依赖——grep 验证 import 语句仅出现 `@aiagent/types` 且均为类型引用。
 */

// 跨边界线格式类型：re-export 便于调用方一站式引用（仅类型，运行时零符号）。
export type {
  EvalMetricValue,
  EvalCaseOutcome,
  EvalReportDto,
  BaselineDiff,
  GateResult,
} from "@aiagent/types";

export { diffBaseline, evaluateGate, gateReport } from "./gate.js";
export type { SloSpec } from "./gate.js";

export { renderMarkdown, writeReports } from "./report.js";

export {
  parseJudgeJson,
  roundScore,
  majorityVote,
  sampleAndAverage,
  NEUTRAL_SCORE,
} from "./judge.js";

export {
  calibrateJudgeScores,
  createInMemoryCalibrationStore,
} from "./calibration.js";
export type {
  HumanCalibrationStore,
  CalibrationInput,
  CalibrationOutput,
} from "./calibration.js";

export { matchTrajectory } from "./trajectory.js";
export type {
  ToolCallStep,
  TrajectoryMatch,
  TrajectoryMatchMode,
} from "./trajectory.js";
