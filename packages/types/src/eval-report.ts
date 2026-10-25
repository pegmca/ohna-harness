/**
 * 跨边界线格式：评测报告 / baseline 差异 / 门禁结果。
 *
 * 归属修正（见 docs/v2.0/02-eval-system-v2.md §2.1）：
 * `EvalReportDto`/`BaselineDiff`/`GateResult` 是「跨进程 / 跨包 / 跨 app 边界消费」的
 * 线格式——由 `packages/eval-core` 产出（聚合 / diff / 门禁），被各 app 的
 * `<app>/eval/report.json`、CI 门禁、未来 Web `/eval` 路由共用。它属于 `@aiagent/types`
 * 而非 `@aiagent/eval-core`，否则 Web 要消费报告就只能直接依赖 `@aiagent/eval-core`，
 * 违反「app 只依赖浏览器库 + `@aiagent/types`」的硬约束。
 *
 * 硬边界：本文件**不 import 任何其他包**（零 `@aiagent/*` 运行时 / 类型依赖）。
 * 字段类型只用原生 string/number/boolean，保持线格式自包含、可序列化。
 */

/**
 * 单项评测指标值。
 *
 * `value` 为跨 case 聚合后的数值；`unit` 仅用于报告展示，不影响聚合 / 门禁逻辑。
 * `applicable` 缺省 `true`；为 `false` 时该指标**不参与聚合、不进门禁判定的分母**
 * （修 G5：无期望字段的指标满分参与聚合会虚高、掩盖回退）。聚合方（eval-core）必须
 * 在均值 / regression 计算前过滤掉 `applicable === false` 的项。
 */
export interface EvalMetricValue {
  /** 指标名（如 retrievalHitRate / fileChangeCorrectness），由各 app 自行约定，内核不枚举。 */
  name: string;
  /** 聚合后的指标数值，约定归一化到 [0, 1] 区间（ratio），其他单位见 `unit`。 */
  value: number;
  /** 展示用单位，仅影响报告渲染，不参与聚合 / 门禁计算。 */
  unit?: "ratio" | "count" | "ms" | "tokens" | "currency";
  /**
   * 该指标是否计入聚合与门禁。缺省 `true`。
   * `false` 表示该指标在当前 dataset 下无期望基准（如某类 chat case 没有 citation 预期），
   * 内核在聚合 / baseline diff / SLO 判定时必须跳过。
   */
  applicable?: boolean;
}

/**
 * 单条 case 的评测结果。
 *
 * `failedMetrics` 承载「哪几个指标挂了」，否则逐 case 归因在扁平化进 `EvalReportDto`
 * 时会丢失、内层失败归因退化（见 §3.3）。`failedTaxonomy` 为失败分类标签，供失败回灌
 * 闭环按类别分流（检索缺失 / 幻觉 / 工具误用…），语义由各 app 自定。
 */
export interface EvalCaseOutcome {
  /** case 唯一 id。 */
  id: string;
  /** 该 case 是否整体通过（通常 = 其所有 applicable 指标均 passed）。 */
  passed: boolean;
  /** 该 case 失败的具体指标名；空或省略表示通过。 */
  failedMetrics?: string[];
  /** 失败分类标签（自由字符串），供失败归因 / 回灌分流使用。 */
  failedTaxonomy?: string;
}

/**
 * 一次评测运行的跨边界报告线格式。
 *
 * `target`/`dataset` 用 `string` 而非字面量联合：内核「不认识任何 app」，不枚举
 * `"finance-api" | "ohna"`，保持纯机制。该 DTO 由 eval-core 与各 app 共用为唯一报告形状。
 */
export interface EvalReportDto {
  /** 被测目标标识（如 "finance-api" / "ohna-cli"），字符串不约束内核。 */
  target: string;
  /** 数据集标识（如 "rag-v1" / "coding-v1"），用于 baseline 对齐。 */
  dataset: string;
  /** 报告生成时间（ISO 8601 字符串）。 */
  createdAt: string;
  /** 聚合后的指标列表；`applicable === false` 的项不计入聚合。 */
  metrics: EvalMetricValue[];
  /** 逐 case 结果列表。 */
  cases: EvalCaseOutcome[];
  /** 可选的人类可读摘要。 */
  summary?: string;
}

/**
 * 单指标相对 baseline 的差异。
 *
 * `status` 由 eval-core 的 `diffBaseline` 推导：
 * - `"new"`：baseline 中无该指标（首次出现）；
 * - `"missing"`：当前报告缺失 baseline 中存在的指标（该指标本次既未产出、也未声明不适用）；
 * - `"not_applicable"`：baseline 有该指标，但当前报告把它标为 `applicable === false`
 *   （如整个评测档位因缺 provider 凭据被跳过）——**不算回归**，门禁不据此判定；
 * - `"regression"`：当前值相对 baseline 退化（delta 为负且超过回归阈值，由门禁 SloSpec 判定）；
 * - `"improvement"`：当前值相对 baseline 改善（delta 为正）；
 * - `"unchanged"`：变化在可接受范围内。
 */
export type BaselineDiff = {
  /** 指标名。 */
  metric: string;
  /** 当前报告中的指标值。 */
  current: number;
  /** baseline 中的指标值。 */
  baseline: number;
  /** current - baseline。 */
  delta: number;
  /** 差异状态标签。 */
  status: "regression" | "improvement" | "unchanged" | "new" | "missing" | "not_applicable";
};

/**
 * CI 门禁结果。
 *
 * `exitCode` 直接作为进程退出码：0 放行，1 拦截。首次跑（baseline 为 null）时
 * eval-core `gateReport`（`evaluateGate` 的封装）将写死返回
 * `{ passed: false, reasons: ["无 baseline，需先 --update-baseline"], exitCode: 1 }`，
 * 避免各 app 各自解释「无 baseline 是放行还是拦停」（见 §5）；`evaluateGate` 本身只负责
 * 有 baseline 时的纯 SLO 判定。
 */
export type GateResult = {
  /** 是否通过门禁。 */
  passed: boolean;
  /** 未通过原因列表；通过时可为空。 */
  reasons: string[];
  /** 进程退出码：0 通过，1 拦截。 */
  exitCode: 0 | 1;
};
