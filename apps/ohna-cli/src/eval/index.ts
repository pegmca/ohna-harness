/**
 * ohna-cli 评测 CLI 入口（v2.0 评测体系 Step 4 / §5 强制接口）。
 *
 * 本文件是 `pnpm eval:ohna` 的入口：解析 process.argv → 加载数据集 → runOhnaEval
 * 产出 EvalReportDto → 用 eval-core 的 writeReports / gateReport 落盘报告并判 CI 门禁。
 *
 * 关键语义（§5 / eval-core gateReport 写死）：
 * - 首次跑（无 baseline.json）：gateReport 返回 exitCode 1（"无 baseline，需先 --update-baseline"），
 *   但 report.json 已写出——对应 Step 4 验收「跑通并写 report.json」。
 * - `--update-baseline`：把本次报告写为 baseline.json 并 exit 0（不判门禁）。
 * - 其余情形：读已有 baseline（无则 null）调 gateReport 决定 exitCode。
 *
 * slos 用合理编码 Agent 阈值：fileChangeCorrectness min 0.9、permissionCompliance min 1、
 * toolSelectionCorrectness min 0.9、turnEfficiency min 0.8。
 *
 * 守卫：用 import.meta.url 仅在「作为入口被直接执行」时才启主流程；被 test import 时不自启。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gateReport, writeReports } from "@aiagent/eval-core";
import type { SloSpec } from "@aiagent/eval-core";
import type { EvalReportDto } from "@aiagent/types";
import { loadOhnaDataset } from "./dataset.js";
import { runOhnaEval } from "./run.js";
import { createOhnaCodingJudge } from "./judge-rubrics.js";

/** 当前脚本所在目录（兼容 tsx/编译后两种形态）。 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认数据集路径：<repo>/datasets/ohna/coding-v1.json。 */
const DEFAULT_DATASET = resolve(HERE, "../../../../datasets/ohna/coding-v1.json");

/** 报告与 baseline 输出目录：<app>/eval/（HERE 为 src/eval，向上两级到 app 根再进 eval）。 */
const OUT_DIR = resolve(HERE, "../../eval");

/**
 * ohna 编码 Agent 门禁 SLO（合理阈值）。
 *
 * 仅卡可稳定判定的闭环指标：
 * - fileChangeCorrectness：文件快照 mustContain/forbid 精确匹配（coding case 必达 1.0）；
 * - permissionCompliance：应拒工具必须确实被拒（permission case 必达 1.0）；
 * - toolSelectionCorrectness：实际轨迹命中期望序列（控制流闭环）；
 * - turnEfficiency：实际轮数不超预算太多（宽松卡 0.8）。
 */
const OHNA_CODING_SLOS: SloSpec[] = [
  { metric: "fileChangeCorrectness", min: 0.9 },
  { metric: "permissionCompliance", min: 1 },
  { metric: "toolSelectionCorrectness", min: 0.9 },
  { metric: "turnEfficiency", min: 0.8 },
];

/**
 * 解析 CLI 参数。
 *
 * @param argv process.argv（含 node + 脚本两项前缀）。
 * @returns 解析后的选项。
 */
function parseArgs(argv: string[]): { tier: "integration" | "live"; judge: boolean; updateBaseline: boolean; dataset: string } {
  const args = argv.slice(2);
  let tier: "integration" | "live" = "integration";
  let judge = false;
  let updateBaseline = false;
  let dataset = DEFAULT_DATASET;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--tier") {
      const value = args[index + 1];
      if (value === "integration" || value === "live") {
        tier = value;
        index += 1;
      } else {
        throw new Error(`--tier 取值非法：${String(value)}（应为 integration|live）`);
      }
    } else if (arg === "--judge") {
      judge = true;
    } else if (arg === "--update-baseline") {
      updateBaseline = true;
    } else if (arg === "--dataset") {
      const value = args[index + 1];
      if (value) {
        dataset = resolve(value);
        index += 1;
      } else {
        throw new Error("--dataset 缺少路径参数");
      }
    }
  }

  return { tier, judge, updateBaseline, dataset };
}

/**
 * 主流程：加载 → 运行 → 写报告 → 判门禁。
 *
 * @param argv process.argv。
 * @returns 进程退出码（0 通过 / 1 拦截或缺失 baseline）。
 */
export async function main(argv: string[] = process.argv): Promise<number> {
  try {
    const { tier, judge, updateBaseline, dataset } = parseArgs(argv);
    const loaded = loadOhnaDataset(dataset);

    const judgeAdapter = judge ? createOhnaCodingJudge() ?? undefined : undefined;
    const report: EvalReportDto = await runOhnaEval(loaded, {
      tier,
      judge: judgeAdapter,
      baseline: null,
    });

    // 落盘 report.json + report.md（eval-core 负责）。
    await writeReports(report, OUT_DIR);

    if (updateBaseline) {
      const baselinePath = resolve(OUT_DIR, "baseline.json");
      writeFileSync(baselinePath, JSON.stringify(report, null, 2), "utf8");
      return 0;
    }

    // 读已有 baseline（无则 null）。
    const baselinePath = resolve(OUT_DIR, "baseline.json");
    const baseline: EvalReportDto | null = existsSync(baselinePath)
      ? (JSON.parse(readFileSync(baselinePath, "utf8")) as EvalReportDto)
      : null;

    const gate = gateReport(report, baseline, OHNA_CODING_SLOS);
    if (!gate.passed) {
      for (const reason of gate.reasons) {
        process.stderr.write(`[gate] ${reason}\n`);
      }
    }
    return gate.exitCode;
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
