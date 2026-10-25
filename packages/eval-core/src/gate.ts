/**
 * baseline diff 与 CI 门禁（v2.0 薄内核方案 §2.2 / 修 G5 / §5）：
 *
 * 门禁泛化到 `EvalReportDto`，不再依赖任何 app 指标类型。本模块只放纯函数，零运行时依赖。
 *
 * 关键语义：
 * - G5 修复：`applicable === false` 的指标在聚合 / diff / 门禁中被跳过，不进分母、不进回归判定。
 * - 「首次跑 `baseline === null` 时需先 --update-baseline」的提示语义**收敛在 `gateReport` 一处**
 *   （见 §5）：`evaluateGate` 仅负责「有 baseline 时」的纯 SLO 判定，因此空 diff（两报告都只含
 *   `applicable===false` 指标等真实情况）不会被误报为「无 baseline」。app 的 eval 域 / CLI
 *   应统一调用 `gateReport(curr, baseline, slos)`，勿各自手写 baseline 缺失分支。
 */

import type { BaselineDiff, EvalReportDto, GateResult } from "@aiagent/types";

/**
 * 每指标 SLO 规约（通用、不枚举 app）：
 * - `min`：指标允许的最低值（低于即回归，单位与指标一致，通常 [0,1]）；
 * - `maxRegression`：相对 baseline 允许的最大负向 delta（绝对值），超过即门禁失败。
 */
export interface SloSpec {
  /** 指标名（与 `EvalReportDto.metrics[].name` 对齐）。 */
  metric: string;
  /** 指标允许的最低绝对阈值（缺省不校验绝对下限）。 */
  min?: number;
  /** 相对 baseline 允许的最大回退量（≥0，缺省不校验回归）。 */
  maxRegression?: number;
}

/** 仅保留参与聚合 / 门禁的指标：过滤 `applicable === false`。 */
function applicableMetrics(report: EvalReportDto): EvalReportDto["metrics"] {
  return report.metrics.filter((metric) => metric.applicable !== false);
}

/**
 * 构造「baseline 有值、当前侧无适用值」的 diff 条目。
 *
 * 抽出成独立函数有两个理由：一是把 `diffBaseline` 的圈复杂度降回阈值内；
 * 二是让这条**语义微妙**的判定有一处可读的实现——当前侧「不适用」（`applicable===false`，
 * 如整个档位因缺 provider 凭据被跳过）表示「本次没有产出该指标的证据」，而**不是**
 * 「测出来是 0」，因此记 `not_applicable` 而非 `missing`，门禁会跳过它。
 *
 * @param name 指标名。
 * @param baselineValue baseline 中的值。
 * @param currMetrics 当前报告的全部指标（含不适用的）。
 * @returns 单条 diff。
 */
function missingDiff(name: string, baselineValue: number, currMetrics: EvalReportDto["metrics"]): BaselineDiff {
  const rawCurr = currMetrics.find((metric) => metric.name === name);
  return {
    metric: name,
    current: 0,
    baseline: baselineValue,
    delta: -baselineValue,
    status: rawCurr?.applicable === false ? "not_applicable" : "missing",
  };
}

/**
 * 计算当前报告相对 baseline 的逐指标 diff。
 *
 * 仅比较「两侧都 applicable 的指标」；缺省 `applicable` 视为 `true`（G5）。某指标在任一侧
 * 被标为不适用时，它不参与 diff（既不算回归也不算新增）——「本次没有产出证据」不等于
 * 「测出来是 0」。baseline 为 null 时返回空数组——`evaluateGate` 负责在 baseline 缺失时
 * 单独返回「需先建基线」语义。
 *
 * @param curr 当前报告。
 * @param baseline 基线报告（为 null 时返回空数组）。
 * @returns 逐指标 diff 列表。
 */
export function diffBaseline(curr: EvalReportDto, baseline: EvalReportDto | null): BaselineDiff[] {
  if (baseline === null) return [];

  // 两侧都必须先过滤 applicable（G5 对称性）：某指标在「某一侧」不适用时，它就不该出现在
  // diff 里。此前只过滤 curr，导致「baseline 记为不适用、当前也无该证据」的指标被当成
  // regression/missing 推入 current=0，再被判为低于 min=1 的假失败（team 评测域实测复现）。
  const baselineByName = new Map(applicableMetrics(baseline).map((metric) => [metric.name, metric]));
  const currByName = new Map(applicableMetrics(curr).map((metric) => [metric.name, metric]));
  // 名字集合同样只取「两侧 applicable 之后」的键：否则 baseline 侧显式不适用的指标
  // 会以 `new`（baseline=0）的形态混进 diff。
  const names = new Set([...baselineByName.keys(), ...currByName.keys()]);

  const diffs: BaselineDiff[] = [];
  for (const name of names) {
    const currMetric = currByName.get(name);
    const baseMetric = baselineByName.get(name);

    if (baseMetric && !currMetric) {
      diffs.push(missingDiff(name, baseMetric.value, curr.metrics));
      continue;
    }
    if (!baseMetric && currMetric) {
      diffs.push({
        metric: name,
        current: currMetric.value,
        baseline: 0,
        delta: currMetric.value,
        status: "new",
      });
      continue;
    }
    if (!baseMetric || !currMetric) continue;

    const delta = currMetric.value - baseMetric.value;
    let status: BaselineDiff["status"];
    if (Math.abs(delta) < Number.EPSILON) {
      status = "unchanged";
    } else if (delta < 0) {
      status = "regression";
    } else {
      status = "improvement";
    }
    diffs.push({ metric: name, current: currMetric.value, baseline: baseMetric.value, delta, status });
  }

  return diffs;
}

/**
 * 依据逐指标 diff 与 SLO 规约判定 CI 门禁。
 *
 * 语义边界（解耦「baseline 是否存在」）：
 * - 本函数**只负责「有 baseline 时」的 SLO 判定**；它不再承担「baseline 缺失」提示语义。
 *   `diff` 为空可能源于「baseline 为 null」之外的多种真实情况（两报告都只含
 *   `applicable === false` 指标、dataset 完全不交叠等），不应被误报为「无 baseline」。
 * - 「首次跑需先 --update-baseline」的提示由调用方（app 的 eval 域 / CLI）在已知
 *   `baseline === null` 时直接给出，再调用本函数做真实 SLO 判定。这样 `evaluateGate`
 *   的语义单一、可单测，且不会掩盖真实门禁结果。
 *
 * 逐 SLO 校验：绝对下限 `min` 与相对回归 `maxRegression`（仅当 baseline 有该指标）。
 * 任一 SLO 不满足即 `passed: false`、收集 reason、`exitCode: 1`；全部通过时
 * `passed: true`、`exitCode: 0`、reasons 空。
 *
 * 注意：`applicable === false` 的指标以两条路径被排除在 SLO 判定之外（G5 修复）——
 * 其一，两侧都适用的指标才进入 diff，任一侧不适用的指标根本不出现在 `names` 集合里；
 * 其二，baseline 有值而当前侧不适用的指标会以 `status: "not_applicable"` 出现在 diff 中
 * （保留可观测性），本函数显式跳过它。因此 `not_applicable` **不算回归**：缺 provider
 * 凭据被跳过的档位不会把指标「归零」再判低于下限。这是 finance-api（RAG 域）与
 * ohna（coding / team 域）**共用**的门禁语义，不是某一域的专属修复。
 *
 * @param diff 由 `diffBaseline` 产出的逐指标 diff（baseline 为 null 时传入空数组由调用方决定）。
 * @param slos 每指标 SLO 规约列表。
 * @returns 门禁结果（含 exitCode）。
 */
export function evaluateGate(diff: BaselineDiff[], slos: SloSpec[]): GateResult {
  const reasons: string[] = [];
  const diffByName = new Map(diff.map((item) => [item.metric, item]));

  for (const slo of slos) {
    const item = diffByName.get(slo.metric);
    // 未出现在 diff 中的指标（可能 applicable=false 被跳过，或 dataset 改变）→ 跳过该校验。
    if (!item) continue;
    // 本次无证据（不适用）→ 不判 SLO：既不算通过也不算失败，由调用方在报告里显式说明。
    if (item.status === "not_applicable") continue;

    if (typeof slo.min === "number" && item.current < slo.min) {
      reasons.push(`指标 ${slo.metric} 当前值 ${item.current} 低于 SLO 下限 ${slo.min}`);
    }
    if (typeof slo.maxRegression === "number" && item.baseline !== 0) {
      const regression = item.baseline - item.current; // 正向表示退化
      if (regression > slo.maxRegression) {
        reasons.push(
          `指标 ${slo.metric} 相对 baseline 回退 ${regression.toFixed(4)} 超过允许 ${slo.maxRegression}`,
        );
      }
    }
  }

  if (reasons.length > 0) {
    return { passed: false, reasons, exitCode: 1 };
  }
  return { passed: true, reasons: [], exitCode: 0 };
}

/**
 * 端到端门禁封装（baseline 语义收口点，§5 统一语义 + Step 2 验收条款）：
 *
 * 把 `diffBaseline` 与 `evaluateGate` 串成一条「两 app 共享」的代码路径，避免每个 app 各自
 * 解释「无 baseline 是放行还是拦停」。本函数是 app 的 eval 域 / CLI **唯一应当调用**的入口：
 *
 * - `baseline === null`（首次跑）：写死返回
 *   `{ passed: false, reasons: ["无 baseline，需先 --update-baseline"], exitCode: 1 }`，
 *   强制一致语义，杜绝双 app 各自硬编码。
 * - 否则：`return evaluateGate(diffBaseline(curr, baseline), slos)`，由纯 SLO 判定接管。
 *
 * `evaluateGate(diff, slos)` 仍保持「只负责有 baseline 时的 SLO 判定」的纯签名（不收 baseline），
 * 因此空 diff 等真实情况不会被误报为「无 baseline」；baseline 缺失提示语义**收敛在 gateReport 一处**。
 *
 * @param curr 当前报告。
 * @param baseline 基线报告（首次跑传 null）。
 * @param slos 每指标 SLO 规约列表。
 * @returns 门禁结果（含 exitCode）。
 */
export function gateReport(
  curr: EvalReportDto,
  baseline: EvalReportDto | null,
  slos: SloSpec[],
): GateResult {
  if (baseline === null) {
    return {
      passed: false,
      reasons: ["无 baseline，需先 --update-baseline"],
      exitCode: 1,
    };
  }
  return evaluateGate(diffBaseline(curr, baseline), slos);
}
