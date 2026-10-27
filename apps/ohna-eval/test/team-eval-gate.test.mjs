/**
 * ohna team 评测「门禁分层」与「tier 执行语义」单测（v2.0 team-eval §5/§8）。
 *
 * 覆盖：
 * 1. **硬门禁 block**：硬指标退化 → `gateReport` exitCode 1；无 baseline → exitCode 1（不静默放行）；
 * 2. **趋势不 block**：趋势指标退化 / 被人为写进 baseline → exitCode 仍为 0；
 * 3. **`teamCostAmplificationRatio` 永不 block**：即使 SLO 表里出现它，`toHardGateReport` 也会
 *    把趋势指标置 applicable=false，eval-core 的 diff/门禁跳过；
 * 4. **T-L1 / T-L2a 确定性档**：真跑数据集，硬门禁全绿（不需要 provider 凭据）；
 * 5. **趋势段 markdown**：有证据时渲染表格，无证据时写明跳过原因（禁止静默）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { gateReport } from "@aiagent/eval-core";
import {
  COST_AMPLIFICATION_WARN_RATIO,
  TEAM_HARD_GATE_SLOS,
  loadTeamDataset,
  runTeamEvaluation,
  toHardGateReport,
} from "../dist/team/index.js";
import { appendTrendSection, buildTeamTrend } from "../dist/team/trend.js";

const DATASET = fileURLToPath(new URL("../../../datasets/ohna/team-v1.json", import.meta.url));

/**
 * 断言某档位的硬门禁**整体通过**，并逐项核对 `TEAM_HARD_GATE_SLOS` 里的每条 SLO。
 *
 * 这是本文件对确定性档的**核心断言面**：CI 真正消费的信号是 `result.gate.exitCode`，
 * 而逐项核对保证「新增/改动任何硬门禁指标」都会自动进入断言范围，不会再出现
 * 「测试手写指标名 ⊂ 实际门禁指标集」导致的静默通过。
 *
 * 语义边界：指标 `applicable === false` 表示**本档没有产出该证据**（如 T-L1 不驱动成员），
 * 这不计为失败，但若它 applicable 则必须满足 `value >= slo.min`。
 *
 * @param result `runTeamEvaluation` 的返回。
 * @param tier 档位名（仅用于失败信息）。
 */
function assertHardGateSatisfied(result, tier) {
  assert.equal(result.decidable, true, `${tier} 在无 provider 凭据下应仍可判定（纯函数/纯状态档）`);

  // 1) 指标层门禁：不允许任何「低于 SLO 下限」的原因。
  // 注意：`baseline: null` 时门禁会因「无 baseline」而 exitCode=1——那是「还没建基线」的
  // 流程状态，不是指标退化，故此处断言的是「无指标级违规」，并在下面单独校验基线缺失的语义。
  const metricViolations = result.gate.reasons.filter((r) => !r.includes("无 baseline"));
  assert.deepEqual(metricViolations, [], `${tier} 不应有指标级门禁违规：${metricViolations.join(" | ")}`);

  // 2) 逐条 SLO 校验：任何硬门禁指标都不能在「适用但低于下限」的状态下漏过。
  for (const slo of TEAM_HARD_GATE_SLOS) {
    const metric = result.report.metrics.find((m) => m.name === slo.metric);
    assert.ok(metric, `${tier} 报告缺少硬门禁指标 ${slo.metric}`);
    if (metric.applicable === false) continue;
    assert.ok(
      metric.value >= slo.min,
      `${tier} 的 ${slo.metric} 值 ${metric.value} 低于 SLO 下限 ${slo.min}`,
    );
  }

  // 3) 以**自身报告为基线**复判：这才是 CI 上真实执行的「对比基线」路径，
  //    必须 exitCode=0，证明这些指标不仅能算出来，而且回归判定也认可。
  const gateAgainstSelf = gateReport(toHardGateReport(result.report), result.report, [...TEAM_HARD_GATE_SLOS]);
  assert.equal(
    gateAgainstSelf.exitCode,
    0,
    `${tier} 以自身为基线的门禁必须为绿，实际 ${gateAgainstSelf.exitCode}：${gateAgainstSelf.reasons.join(" | ")}`,
  );
}

/** 构造一份最小报告（只含给定指标）。 */
function reportOf(dataset, metrics) {
  return {
    target: "ohna-eval-team",
    dataset,
    createdAt: new Date(0).toISOString(),
    metrics,
    cases: [],
  };
}

// ============ 1. 硬门禁 block ============
test("硬门禁：确定性指标退化到 0.5 → exitCode 1", () => {
  const baseline = reportOf("team-v1", [
    { name: "teamOverBudget", value: 1, unit: "ratio", applicable: true },
    { name: "teamPeakConcurrency", value: 1, unit: "ratio", applicable: true },
  ]);
  const current = reportOf("team-v1", [
    { name: "teamOverBudget", value: 0.5, unit: "ratio", applicable: true },
    { name: "teamPeakConcurrency", value: 1, unit: "ratio", applicable: true },
  ]);
  const gate = gateReport(toHardGateReport(current), baseline, [...TEAM_HARD_GATE_SLOS]);
  assert.equal(gate.exitCode, 1);
  assert.ok(gate.reasons.some((r) => r.includes("teamOverBudget")));
});

test("硬门禁：无 baseline 时 exitCode 1（必须显式 --update-baseline，不静默放行）", () => {
  const current = reportOf("team-v1", [{ name: "teamOverBudget", value: 1, unit: "ratio", applicable: true }]);
  const gate = gateReport(toHardGateReport(current), null, [...TEAM_HARD_GATE_SLOS]);
  assert.equal(gate.exitCode, 1);
  assert.match(gate.reasons.join(), /无 baseline/);
});

// ============ 2. 趋势不 block ============
test("趋势门禁：派发正确率退化 → exitCode 仍为 0", () => {
  const baseline = reportOf("team-v1", [
    { name: "teamOverBudget", value: 1, unit: "ratio", applicable: true },
    { name: "teamDispatchCorrectness", value: 1, unit: "ratio", applicable: true },
  ]);
  const current = reportOf("team-v1", [
    { name: "teamOverBudget", value: 1, unit: "ratio", applicable: true },
    { name: "teamDispatchCorrectness", value: 0, unit: "ratio", applicable: true },
  ]);
  const gate = gateReport(toHardGateReport(current), baseline, [...TEAM_HARD_GATE_SLOS]);
  assert.equal(gate.exitCode, 0, "趋势指标退化绝不能阻断");
});

test("趋势门禁：即使趋势指标被写进 baseline（applicable=true），也不参与门禁", () => {
  // 模拟「基线里残留了趋势指标的聚合值」：当前侧同等值 → toHardGateReport 会把它置为不适用，
  // eval-core 的 diff 两侧都不含它，SLO 不会命中。
  const baseline = reportOf("team-v1", [{ name: "teamCostAmplificationRatio", value: 1, unit: "ratio", applicable: true }]);
  const current = reportOf("team-v1", [{ name: "teamCostAmplificationRatio", value: 0, unit: "ratio", applicable: true }]);
  const gate = gateReport(toHardGateReport(current), toHardGateReport(baseline), [...TEAM_HARD_GATE_SLOS]);
  assert.equal(gate.exitCode, 0);
});

test("costAmplificationRatio 永不 block：即便人为加入 SLO 表", () => {
  const baseline = reportOf("team-v1", [{ name: "teamCostAmplificationRatio", value: 1, unit: "ratio", applicable: true }]);
  const current = reportOf("team-v1", [{ name: "teamCostAmplificationRatio", value: 0, unit: "ratio", applicable: true }]);
  const hostileSlos = [...TEAM_HARD_GATE_SLOS, { metric: "teamCostAmplificationRatio", min: 1 }];
  // 与 runTeamEvaluation 一致：curr 与 baseline **两侧**都过硬门禁投影。
  const gate = gateReport(toHardGateReport(current), toHardGateReport(baseline), hostileSlos);
  assert.equal(gate.exitCode, 0, "数据层（applicable=false）应挡住配置层的误配");
});

test("TEAM_HARD_GATE_SLOS 只含硬门禁指标", () => {
  const names = TEAM_HARD_GATE_SLOS.map((slo) => slo.metric);
  assert.ok(!names.includes("teamCostAmplificationRatio"));
  assert.ok(!names.includes("teamDispatchCorrectness"));
  assert.ok(!names.includes("teamTokenAttributionToMember"));
  for (const slo of TEAM_HARD_GATE_SLOS) assert.equal(slo.min, 1);
});

// ============ 3. 确定性档真跑 ============
test("T-L1：依赖成员执行的指标必须不适用（不制造假覆盖）", async () => {
  const ds = loadTeamDataset(DATASET);
  const result = await runTeamEvaluation(ds, { tier: "T-L1", baseline: null });

  // T-L1 是纯函数档、不驱动成员：这些指标在 §7 里的证据源都要求真实执行，
  // 在 L1 判 applicable 就等于「看起来覆盖了、其实没测」。
  for (const name of [
    "teamSubagentCompletionRate",
    "teamConvergence",
    "teamPeakConcurrency",
    "teamDispatchCorrectness",
    "teamCostAmplificationRatio",
  ]) {
    const metric = result.report.metrics.find((m) => m.name === name);
    assert.equal(metric.applicable, false, `${name} 在 T-L1 必须不适用，实际 ${metric.applicable}`);
  }

  // L1 真正能确定性判定的：纯函数契约 + 继承通道自证。
  const l1Contract = result.report.metrics.find((m) => m.name === "teamL1Contract");
  assert.equal(l1Contract.applicable, true);
  assert.equal(l1Contract.value, 1);
  const permission = result.report.metrics.find((m) => m.name === "teamPermissionInheritanceCorrectness");
  assert.equal(permission.value, 1, "继承通道在 L1 由确定性自证覆盖");

  // 盲区防护：逐个校验**全部**硬门禁 SLO，而不是只挑几个手写指标名。
  // 旧写法只断言 5 个 applicable + 2 个满分，恰好漏掉 teamOverBudget / teamContractStatuses，
  // 于是这两档在 CI 上实际 exit 1（红）时本测试仍全绿——正是 §4.2/§8 要防的「静默通过」。
  assertHardGateSatisfied(result, "T-L1");
});

test("T-L2a 真跑数据集：纯状态迁移全绿，且权限继承用确定性自证", async () => {
  const ds = loadTeamDataset(DATASET);
  const result = await runTeamEvaluation(ds, { tier: "T-L2a", baseline: null });
  // L2a 真正能判的：派发正确性 + 继承通道。收敛 / 峰值并发依赖成员执行，
  // 在 L2a 必须不适用（否则就是「恒为 1 的假门禁」）。
  for (const name of ["teamPermissionInheritanceCorrectness", "teamDispatchCorrectness"]) {
    const metric = result.report.metrics.find((m) => m.name === name);
    assert.equal(metric.value, 1, `${name} 应在 T-L2a 满分，实际 ${metric.value}`);
  }
  for (const name of ["teamConvergence", "teamPeakConcurrency", "teamSubagentCompletionRate"]) {
    const metric = result.report.metrics.find((m) => m.name === name);
    assert.equal(metric.applicable, false, `${name} 在 T-L2a 必须不适用`);
  }
  // 权限类 case 必须真的产生了「探测自证」而不是空过。
  const permissionRuns = result.runs.filter((run) => run.mode === "permission_deny");
  assert.ok(permissionRuns.length > 0);
  for (const run of permissionRuns) {
    assert.equal(run.evidence.permissionProbe?.blocked, true, `${run.id} 应有被闸门拒绝的确定性证据`);
  }

  // 同样校验非手写指标的硬门禁项（含 teamOverBudget 的派发前预算预检）。
  assertHardGateSatisfied(result, "T-L2a");
});

test("T-L2a 的 member_not_found 负例：走早退返回结构化失败，不崩溃", async () => {
  const ds = loadTeamDataset(DATASET);
  const result = await runTeamEvaluation(ds, { tier: "T-L2a", baseline: null });
  const run = result.runs.find((r) => r.mode === "member_not_found");
  assert.ok(run.executed);
  assert.equal(run.evidence.subagentResults.length, 1);
  assert.equal(run.evidence.subagentResults[0].status, "failed");
  assert.equal(run.evidence.subagentResults[0].ran, false, "早退不能算「真实运行」");
});

// ============ 4. 趋势段 markdown ============
test("趋势段：无执行 case（无凭据 skip）时写明原因，不渲染假数据", () => {
  const trend = buildTeamTrend({
    runs: [{ id: "a", mode: "dispatch", executed: false, skipReason: "无 provider 凭据，跳过 T-L2b", evidence: {}, metrics: [] }],
    report: reportOf("team-v1", []),
    baseline: null,
    tier: "T-L2b",
  });
  assert.equal(trend.applicable, false);
  assert.match(trend.markdown, /无 provider 凭据，跳过 T-L2b/);
  assert.ok(!trend.markdown.includes("| 指标 |"), "不应渲染表格");
});

test("趋势段：有证据时渲染三行趋势指标并标注不 block", () => {
  const metrics = [
    { name: "teamDispatchCorrectness", value: 0.8, unit: "ratio", applicable: true },
    { name: "teamCostAmplificationRatio", value: 0.5, unit: "ratio", applicable: true },
    { name: "teamTokenAttributionToMember", value: 1, unit: "ratio", applicable: true },
  ];
  const trend = buildTeamTrend({
    runs: [
      {
        id: "a",
        mode: "dispatch",
        executed: true,
        evidence: {},
        metrics: metrics.map((m) => ({ name: m.name, score: m.value, applicable: true })),
      },
    ],
    report: reportOf("team-v1", metrics),
    baseline: reportOf("team-v1", [
      { name: "teamDispatchCorrectness", value: 1, unit: "ratio", applicable: true },
      { name: "teamTokenAttributionToMember", value: 1, unit: "ratio", applicable: true },
    ]),
    tier: "T-L4",
  });
  assert.equal(trend.applicable, true);
  assert.equal(trend.rows.length, 3);
  const dispatch = trend.rows.find((r) => r.metric === "teamDispatchCorrectness");
  assert.equal(dispatch.warn, true, "低于基线应告警");
  const cost = trend.rows.find((r) => r.metric === "teamCostAmplificationRatio");
  assert.equal(cost.warn, true, "归一化得分 <1 表示超过 warn 阈值");
  assert.match(trend.markdown, /不 block/);
  assert.match(trend.markdown, new RegExp(`${COST_AMPLIFICATION_WARN_RATIO}`));
});

test("appendTrendSection：追加到 report.md 末尾且不破坏原文", () => {
  const trend = buildTeamTrend({
    runs: [{ id: "a", mode: "dispatch", executed: false, skipReason: "无 provider 凭据", evidence: {}, metrics: [] }],
    report: reportOf("team-v1", []),
    baseline: null,
    tier: "T-L4",
  });
  const merged = appendTrendSection("# 原报告\n\n内容", trend);
  assert.ok(merged.startsWith("# 原报告"));
  assert.match(merged, /趋势门禁/);
});

// ============ 5. 可判定性（review blocker 回归） ============
test("无凭据档：不可判定 → gate.passed=false 且 exitCode 1（不落空 diff=通过）", async () => {
  const ds = loadTeamDataset(DATASET);
  const result = await runTeamEvaluation(ds, {
    tier: "T-L2b",
    baseline: null,
    credentials: { available: false, reason: "单测注入：无凭据" },
  });
  assert.equal(result.decidable, false);
  assert.equal(result.gate.passed, false);
  assert.equal(result.gate.exitCode, 1);
  assert.match(result.gate.reasons.join(), /不可判定/);
  assert.match(result.summary, /本档不可判定/, "summary 顶部必须标注不可判定");
});

test("不可判定档即使给了 baseline 也不能「空 diff 通过」", async () => {
  const ds = loadTeamDataset(DATASET);
  const emptyBaseline = reportOf("team-v1", []);
  const result = await runTeamEvaluation(ds, {
    tier: "T-L4",
    baseline: emptyBaseline,
    credentials: { available: false, reason: "单测注入：无凭据" },
  });
  assert.equal(result.decidable, false);
  assert.equal(result.gate.exitCode, 1, "空 diff 不得被当作通过");
});

test("可判定档的 summary 带【本档可判定】标注", async () => {
  const ds = loadTeamDataset(DATASET);
  const result = await runTeamEvaluation(ds, { tier: "T-L2a", baseline: null });
  assert.equal(result.decidable, true);
  assert.match(result.summary, /本档可判定/);
});
