/**
 * ohna-eval 评测 CLI 入口（独立包 apps/ohna-eval，从 ohna-cli 迁出）（v2.0 评测体系 Step 4 / §5 强制接口；v2.0 team-eval §8 增 team 域）。
 *
 * 本文件是 `pnpm eval:ohna` 的入口：解析 process.argv → 识别**评测域**（coding / team）→
 * 加载对应数据集 → 跑对应执行器 → 落盘报告 → 判门禁。
 *
 * ## 两个评测域的分层（team-eval §8）
 *
 * - `--dataset <path>`（缺省 coding-v1.json）→ **coding 域**：行为与 v2.0 Step 4 完全一致，
 *   报告落 `apps/ohna-eval/eval/`（report.json / baseline.json）；
 * - `--dataset team` → **team 域**：报告落 `apps/ohna-eval/eval/team/`（独立目录，**互不覆盖 baseline**）。
 *
 * team 域内部再分两层门禁：
 * - **硬门禁**（T-L1/T-L2a/T-L2b 的确定性指标）→ eval-core `gateReport` → exitCode；
 * - **趋势门禁**（T-L4 的决策正确率 vs 基线）→ 只写 `trend.md` / `trend.json`，**永不参与 exitCode**。
 *
 * ## 档位
 *
 * coding 域沿用 `integration | live`；team 域使用 `T-L1 | T-L2a | T-L2b | T-L4`。
 * 无 provider 凭据时 T-L2b / T-L4 显式 skip（报告写明原因），绝不静默通过。
 *
 * 守卫：用 import.meta.url 仅在「作为入口被直接执行」时才启主流程；被 test import 时不自启。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gateReport, writeReports } from "@aiagent/eval-core";
import type { SloSpec } from "@aiagent/eval-core";
import type { EvalReportDto } from "@aiagent/types";
import { loadOhnaDataset } from "./dataset.js";
import { runOhnaEval } from "./run.js";
import { createOhnaCodingJudge } from "./judge-rubrics.js";
import { appendTrendSection, buildTeamTrend, loadTeamDataset, runTeamEvaluation } from "./team/index.js";
import type { TeamTier } from "./team/index.js";

/** 当前脚本所在目录（兼容 tsx/编译后两种形态）。 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认数据集路径：<repo>/datasets/ohna/coding-v1.json。 */
const DEFAULT_DATASET = resolve(HERE, "../../../../datasets/ohna/coding-v1.json");

/** team 数据集路径：`--dataset team` 的别名解析目标。 */
export const TEAM_DATASET_PATH = resolve(HERE, "../../../../datasets/ohna/team-v1.json");

/** coding 报告与 baseline 输出目录：<app>/eval/（独立包 apps/ohna-eval/eval/）。 */
const OUT_DIR = resolve(HERE, "../eval");

/** team 报告与 baseline 输出目录：<app>/eval/team/（与 coding 互不覆盖）。 */
const TEAM_OUT_DIR = resolve(OUT_DIR, "team");

/** 评测域标识。 */
export type EvalDomain = "coding" | "team";

/** coding 域档位。 */
type CodingTier = "integration" | "live";

/** 解析后的 CLI 选项（coding 与 team 共用一份结构，未使用的字段保留缺省）。 */
export interface ParsedEvalArgs {
  /** 评测域（由 `--dataset team` 或档位前缀决定）。 */
  domain: EvalDomain;
  /** 数据集路径（team 域恒为 team-v1.json）。 */
  dataset: string;
  /** coding 域档位。 */
  tier: CodingTier;
  /** team 域档位。 */
  teamTier: TeamTier;
  /** 是否启用 judge（coding 域为校准信号；team 域为趋势段裁判）。 */
  judge: boolean;
  /** 是否把本次报告写为 baseline。 */
  updateBaseline: boolean;
}

/** team 合法档位（运行时枚举）。 */
const TEAM_TIERS: readonly TeamTier[] = ["T-L1", "T-L2a", "T-L2b", "T-L4"];

/**
 * 解析 CLI 参数。
 *
 * 域判定规则：`--dataset team` 或 `--tier T-L*` 任一出现即是 team 域；两者同时给出时必须自洽。
 *
 * @param argv process.argv（含 node + 脚本两项前缀）。
 * @returns 解析后的选项。
 * @throws 当档位 / 数据集参数非法时抛出（由 `main` 统一收敛为 exit 1）。
 */
export function parseEvalArgs(argv: string[]): ParsedEvalArgs {
  const args = argv.slice(2);
  let domain: EvalDomain | undefined;
  let codingTier: CodingTier = "integration";
  let teamTier: TeamTier = "T-L1";
  let judge = false;
  let updateBaseline = false;
  let dataset = DEFAULT_DATASET;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--tier") {
      const value = args[index + 1];
      if (value === "integration" || value === "live") {
        codingTier = value;
        domain = domain ?? "coding";
        index += 1;
      } else if (TEAM_TIERS.includes(value as TeamTier)) {
        teamTier = value as TeamTier;
        domain = "team";
        index += 1;
      } else {
        throw new Error(`--tier 取值非法：${String(value)}（coding 应为 integration|live，team 应为 ${TEAM_TIERS.join("|")}）`);
      }
    } else if (arg === "--judge") {
      judge = true;
    } else if (arg === "--update-baseline") {
      updateBaseline = true;
    } else if (arg === "--dataset") {
      const value = args[index + 1];
      if (!value) throw new Error("--dataset 缺少路径参数");
      if (value === "team") {
        domain = "team";
        dataset = TEAM_DATASET_PATH;
      } else if (value === "coding") {
        domain = "coding";
        dataset = DEFAULT_DATASET;
      } else {
        dataset = resolve(value);
      }
      index += 1;
    }
  }

  // 域判定：显式 `--dataset team` 或 team 档位 → team；其余默认 coding（保持既有行为）。
  const resolvedDomain: EvalDomain = domain ?? "coding";
  // team 域的数据集恒为 team-v1.json（`--dataset team` 只是它的别名，自定义路径仅 coding 域支持）。
  if (resolvedDomain === "team") dataset = TEAM_DATASET_PATH;

  return { domain: resolvedDomain, dataset, tier: codingTier, teamTier, judge, updateBaseline };
}

/**
 * 读取 baseline 报告（不存在返回 null）。
 *
 * @param path baseline.json 路径。
 * @returns 解析后的报告或 null。
 */
function readBaseline(path: string): EvalReportDto | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as EvalReportDto;
}

/**
 * coding 域主流程：加载 → 运行 → 写报告 → 判门禁（与 v2.0 Step 4 行为一致）。
 *
 * @param parsed 解析后的选项。
 * @returns 进程退出码。
 */
async function runCodingDomain(parsed: ParsedEvalArgs): Promise<number> {
  const loaded = loadOhnaDataset(parsed.dataset);
  const judgeAdapter = parsed.judge ? (createOhnaCodingJudge() ?? undefined) : undefined;
  const report: EvalReportDto = await runOhnaEval(loaded, {
    tier: parsed.tier,
    judge: judgeAdapter,
    baseline: null,
  });

  await writeReports(report, OUT_DIR);

  const baselinePath = resolve(OUT_DIR, "baseline.json");
  if (parsed.updateBaseline) {
    writeFileSync(baselinePath, JSON.stringify(report, null, 2), "utf8");
    return 0;
  }

  const gate = gateReport(report, readBaseline(baselinePath), CODING_SLOS);
  for (const reason of gate.reasons) process.stderr.write(`[gate] ${reason}\n`);
  return gate.exitCode;
}

/**
 * team 域主流程：加载 → 按档位执行 → 硬门禁 → 趋势段（不参与 exitCode）。
 *
 * 报告文件（`apps/ohna-eval/eval/team/`）：
 * - `report.json` / `report.md`：完整报告（含全部指标）；
 * - `baseline.json`：`--update-baseline` 写入的硬门禁基线；
 * - `trend.md` / `trend.json`：趋势段（T-L4 决策正确率 vs 基线，**永不阻断**）。
 *
 * @param parsed 解析后的选项。
 * @returns 进程退出码（仅由硬门禁决定）。
 */
async function runTeamDomain(parsed: ParsedEvalArgs): Promise<number> {
  // `--judge` 是 coding 域的校准开关；team 域当前**没有** judge 评分链路（§5 已把 T-L4 降级为
  // 「决策观测」）。显式拒绝而不是静默忽略，避免用户以为判决已生效。
  if (parsed.judge) {
    process.stderr.write("[team] --judge 在 team 域不支持（T-L4 为决策观测档，无 judge 评分）；已忽略\n");
  }
  const dataset = loadTeamDataset(parsed.dataset);
  const baselinePath = resolve(TEAM_OUT_DIR, "baseline.json");
  const baseline = readBaseline(baselinePath);

  // baseline 在 runTeamEvaluation 内部会经 `toHardGateReport` 投影（剔除趋势指标），
  // 趋势段仍用**原始** baseline 做「决策正确率 vs 基线」对比，两者职责不混。
  const evaluation = await runTeamEvaluation(dataset, {
    tier: parsed.teamTier,
    baseline: parsed.updateBaseline ? null : baseline,
  });

  mkdirSync(TEAM_OUT_DIR, { recursive: true });
  await writeReports(evaluation.report, TEAM_OUT_DIR);

  // 趋势段：独立产出，只告警不阻断（§8「趋势门禁不 block」）。
  const trend = buildTeamTrend({
    runs: evaluation.runs,
    report: evaluation.report,
    baseline,
    tier: parsed.teamTier,
  });
  const reportMdPath = resolve(TEAM_OUT_DIR, "report.md");
  const existingMd = existsSync(reportMdPath) ? readFileSync(reportMdPath, "utf8") : "";
  writeFileSync(reportMdPath, appendTrendSection(existingMd, trend), "utf8");
  writeFileSync(resolve(TEAM_OUT_DIR, "trend.md"), `${trend.markdown}\n`, "utf8");
  writeFileSync(resolve(TEAM_OUT_DIR, "trend.json"), JSON.stringify(trend, null, 2), "utf8");

  if (evaluation.skipReason) {
    // 显式 skip：写到 stderr 让 CI 日志可见，绝不静默。
    process.stderr.write(`[team-skip] ${evaluation.skipReason}\n`);
  }

  // 关键守卫：不可判定的档位（0 条 case 执行，通常是缺 provider 凭据）**禁止写 baseline**。
  // 否则会产出一份「8 个指标全 applicable=false」的基线，之后同档门禁每次都走
  // 「空 diff = 通过」而恒绿——CI 上一条断言都没跑却显示绿灯，等于静默通过。
  if (!evaluation.decidable) {
    if (parsed.updateBaseline) {
      // 建基线请求被拒绝：这是「用户要求了一个做不到的动作」，用 2 与门禁失败(1)区分。
      process.stderr.write(
        `[team-skip] 拒绝写入 baseline：本次无任何 case 执行，本档不可判定（不会产出全不适用的空基线）\n`,
      );
      return 2;
    }
    // 判门禁但本档不可判定：属于门禁失败（exitCode 1），reason 已由 runTeamEvaluation 写明。
    for (const reason of evaluation.gate.reasons) process.stderr.write(`[gate] ${reason}\n`);
    return evaluation.gate.exitCode;
  }

  if (parsed.updateBaseline) {
    writeFileSync(baselinePath, JSON.stringify(evaluation.report, null, 2), "utf8");
    return 0;
  }

  for (const reason of evaluation.gate.reasons) process.stderr.write(`[gate] ${reason}\n`);
  return evaluation.gate.exitCode;
}

/** ohna 编码 Agent 门禁 SLO（编码域，保持 v2.0 Step 4 的既有阈值）。 */
const CODING_SLOS: SloSpec[] = [
  { metric: "fileChangeCorrectness", min: 0.9 },
  { metric: "permissionCompliance", min: 1 },
  { metric: "toolSelectionCorrectness", min: 0.9 },
  { metric: "turnEfficiency", min: 0.8 },
];

/**
 * 主流程：按域分派。
 *
 * @param argv process.argv。
 * @returns 进程退出码（0 通过 / 1 拦截或缺失 baseline）。
 */
export async function main(argv: string[] = process.argv): Promise<number> {
  try {
    const parsed = parseEvalArgs(argv);
    return parsed.domain === "team" ? await runTeamDomain(parsed) : await runCodingDomain(parsed);
  } catch (error) {
    process.stderr.write(`eval 执行失败：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

// 直接执行守卫：仅在「本文件作为入口」运行时启主流程；被 import（如测试）时不自启。
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`eval 执行失败：${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
