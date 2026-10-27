/**
 * 单条 case 执行结果的类型归属模块（低层，供 run.ts / run-provider.ts / run-l1.ts / trend.ts 共用）。
 *
 * 单独成文件的原因：`TeamCaseRun` 同时被三个执行器与趋势聚合消费，若留在 run.ts 里，
 * run-provider.ts 就只能反向 import run.ts —— 这正是 W3 拆文件时引入的循环依赖来源。
 * 类型下沉后所有消费方单向依赖本文件。
 */

import type { scoreTeamCase } from "./metrics.js";
import type { TeamCaseEvidence, TeamEvalCase } from "./types.js";

/** 单条 case 的执行结果（逐 case 证据 + 指标得分）。 */
export interface TeamCaseRun {
  /** case id。 */
  id: string;
  /** 评测模式。 */
  mode: TeamEvalCase["mode"];
  /** 是否真正执行（false = 档位跳过）。 */
  executed: boolean;
  /** 证据（指标得分的事实来源）。 */
  evidence: TeamCaseEvidence;
  /** 逐指标得分（含 applicable 语义）。 */
  metrics: ReturnType<typeof scoreTeamCase>;
  /** 跳过原因（executed=false 时必有）。 */
  skipReason?: string;
}

