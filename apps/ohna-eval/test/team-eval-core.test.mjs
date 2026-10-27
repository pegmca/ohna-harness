/**
 * ohna team 评测域单测：数据集 / 指标纯函数 / 指标归属（v2.0 team-eval §7，）
 *
 * 覆盖三层，断言分层清晰（与 coding 评测单测同风格：node:test + assert/strict，
 * 从编译产物 `../dist/team/*.js` 导入）：
 * 1. **dataset 校验**：team-v1.json 可加载、≥20 条、六类 mode 全覆盖、重复 id / 语义缺字段被拦；
 * 2. **metrics 纯函数**：八个指标逐一给出确定性输入 → 期望得分，含 applicable=false 语义；
 * 3. **门禁分层**：硬门禁退化 → exitCode 1；趋势指标退化 → exitCode 0；
 *    `teamCostAmplificationRatio` 永不 block（即使有人在 baseline 里写入它）；
 * 4. **指标归属**：每个指标的 tier / 门禁归属与 §7 表一致，且指标名与 coding 零交集。
 *
 * 本文件不含任何 provider 调用：T-L2b / T-L4 的显式 skip 语义在
 * `team-eval-provider.test.mjs` 单独覆盖。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  HARD_GATE_METRICS,
  TEAM_METRIC_SPECS,
  TREND_METRICS,
  countTeamCasesByMode,
  loadTeamDataset,
  parseTeamDataset,
} from "../dist/team/index.js";
import {
  teamConvergence,
  teamCostAmplificationRatio,
  teamDispatchCorrectness,
  teamOverBudget,
  teamPeakConcurrency,
  teamPermissionInheritanceCorrectness,
  teamSubagentCompletionRate,
  teamTokenAttributionToMember,
  aggregateTeamMetrics,
} from "../dist/team/metrics.js";
import { resolveExpectedTools } from "../dist/team/adapter.js";

const DATASET = fileURLToPath(new URL("../../../datasets/ohna/team-v1.json", import.meta.url));
const CODING_DATASET = fileURLToPath(new URL("../../../datasets/ohna/coding-v1.json", import.meta.url));

/** 构造一个「全部有证据」的最小证据对象（各测试按需覆盖字段）。 */
function evidence(overrides = {}) {
  return {
    executed: true,
    memberStatus: {},
    spawnedMembers: [],
    sends: [],
    toolTrajectory: [],
    subagentResults: [],
    deniedTools: [],
    grantedToolsByMember: {},
    teamUsage: { totalTokens: 0, totalCost: 0 },
    budgetExceeded: false,
    peakConcurrency: 0,
    maxConcurrentMembers: 1,
    memberUsage: {},
    ...overrides,
  };
}

// ============ 1. dataset 校验 ============
test("team-v1.json 可加载，case 数 ≥ 20 且六类 mode 全覆盖", () => {
  const ds = loadTeamDataset(DATASET);
  assert.ok(ds.cases.length >= 20, `case 数应 ≥ 20，实际 ${ds.cases.length}`);
  assert.equal(ds.datasetVersion, "team-v1");
  const counts = countTeamCasesByMode(ds.cases);
  for (const mode of ["dispatch", "member_not_found", "over_budget", "permission_deny", "concurrency", "failure_isolation"]) {
    assert.ok(counts[mode] > 0, `mode ${mode} 应至少 1 条，实际 ${counts[mode]}`);
  }
});

test("team 数据集与 coding 数据集互不混用（id 前缀与 mode 无交集）", () => {
  const team = loadTeamDataset(DATASET);
  const coding = JSON.parse(readFileSync(CODING_DATASET, "utf8"));
  const codingModes = new Set(coding.cases.map((c) => c.mode));
  for (const c of team.cases) {
    assert.ok(c.id.startsWith("team-"), `team case id 应以 team- 前缀，实际 ${c.id}`);
    assert.ok(!codingModes.has(c.mode), `team mode ${c.mode} 不应出现在 coding 数据集`);
    assert.ok(!("expectedFileChanges" in c), `team case ${c.id} 不应含 coding 的文件改动期望`);
  }
  const teamIds = new Set(team.cases.map((c) => c.id));
  for (const c of coding.cases) assert.ok(!teamIds.has(c.id), `id ${c.id} 在两个数据集中重复`);
});

test("loader 拦下重复 id", () => {
  const base = JSON.parse(readFileSync(DATASET, "utf8"));
  // 保持 20 条以上，使「重复 id」先于「数量下限」被命中（校验顺序即报告顺序）。
  const cases = base.cases.slice(0, 20);
  cases[19] = cases[0];
  assert.throws(() => parseTeamDataset(JSON.stringify({ cases }), "dup.json"), /重复 case id/);
});

test("loader 拦下 mode 语义缺字段（over_budget 缺预算上限）", () => {
  const base = JSON.parse(readFileSync(DATASET, "utf8"));
  const bad = base.cases.find((c) => c.mode === "over_budget");
  const broken = { ...bad, maxTokensTotal: undefined, maxCostPerMember: undefined };
  // 索引对齐：把坏 case 放回它原本的位置，其余 24 条保持不变（总数仍 ≥20）。
  const cases = base.cases.map((c) => (c === bad ? broken : c));
  assert.throws(() => parseTeamDataset(JSON.stringify({ ...base, cases }), "bad.json"), /必须至少配置 maxTokensTotal/);
});

test("loader 拦下不满足 §8 下限（<20 条）的数据集", () => {
  const base = JSON.parse(readFileSync(DATASET, "utf8"));
  const small = { ...base, minCases: 2, cases: base.cases.slice(0, 3) };
  assert.throws(() => parseTeamDataset(JSON.stringify(small), "small.json"), /低于下限 20/);
});

test("loader 拦下非法 mode 与失败隔离缺声明", () => {
  const base = JSON.parse(readFileSync(DATASET, "utf8"));
  const badMode = base.cases.map((c, i) => (i === 0 ? { ...c, mode: "bogus" } : c));
  assert.throws(() => parseTeamDataset(JSON.stringify({ ...base, cases: badMode }), "m.json"), /mode 非法/);

  // 失败隔离：删掉精确注入点后必须被拦（旧写法 failSubagentExecution 已不足以定位）。
  const failures = base.cases.map((c) => ({ ...c }));
  const fi = failures.find((c) => c.mode === "failure_isolation");
  delete fi.failedMember;
  delete fi.failTool;
  assert.throws(() => parseTeamDataset(JSON.stringify({ ...base, cases: failures }), "f.json"), /failedMember \+ failTool/);
});

// ============ 2. metrics 纯函数 ============
test("teamSubagentCompletionRate：真实运行的 done/total，早退不计入", () => {
  const m = teamSubagentCompletionRate(
    evidence({ subagentResults: [{ member: "a", status: "done", ran: true }, { member: "b", status: "failed", ran: true }] }),
  );
  assert.equal(m.score, 0.5);
  assert.equal(m.applicable, true);
  // 早退结果（ran=false）不参与完成率：0/0 → 不适用。
  const early = teamSubagentCompletionRate(evidence({ subagentResults: [{ member: "ghost", status: "failed", ran: false }] }));
  assert.equal(early.applicable, false);
});

test("teamPermissionInheritanceCorrectness：期望拒绝未生效 → fail-closed 0 分", () => {
  const failed = teamPermissionInheritanceCorrectness(
    { expectedPermission: { deniedTools: ["write"] } },
    evidence({ deniedTools: [], grantedToolsByMember: { a: ["read"] } }),
  );
  assert.equal(failed.score, 0);
  assert.match(failed.detail, /期望拒绝未生效/);

  const ok = teamPermissionInheritanceCorrectness(
    { expectedPermission: { deniedTools: ["write"], grantedTools: ["read"] } },
    evidence({ deniedTools: ["write"], grantedToolsByMember: { a: ["read"] } }),
  );
  assert.equal(ok.score, 1);
});

test("teamPermissionInheritanceCorrectness：简写字段与完整字段去重（不重复期望）", () => {
  const m = teamPermissionInheritanceCorrectness(
    { expectedPermission: { deniedTools: ["write"] }, expectedPermissionDenials: ["write"] },
    evidence({ deniedTools: ["write"], grantedToolsByMember: { a: ["read"] } }),
  );
  assert.equal(m.score, 1, "同一工具被两种写法各期望一次，应去重后仍判通过");
});

test("teamPermissionInheritanceCorrectness：权限探测自证与真实拒绝同权", () => {
  const m = teamPermissionInheritanceCorrectness(
    { expectedPermission: { deniedTools: ["bash"] } },
    evidence({ permissionProbe: { tool: "bash", blocked: true }, grantedToolsByMember: { a: ["read"] } }),
  );
  assert.equal(m.score, 1);
});

test("teamOverBudget：无预检证据判不适用（累计 0 ≤ 任何上限没有区分力）", () => {
  // 只比「累计用量」是零区分力的：整档没跑时累计恒 0，任何上限都"通过"。
  const noEvidence = teamOverBudget({ maxTokensTotal: 100 }, evidence({ teamUsage: { totalTokens: 0, totalCost: 0 } }));
  assert.equal(noEvidence.applicable, false, "无预检证据必须不适用，不能记成 1");
  assert.match(noEvidence.detail, /无派发前预算预检证据/);

  const na = teamOverBudget({}, evidence({}));
  assert.equal(na.applicable, false);
});

test("teamOverBudget：有预检证据时按拒绝次数与累计用量判定", () => {
  const rejected = teamOverBudget(
    { maxTokensTotal: 100 },
    evidence({ budgetPrecheck: { checked: 2, rejected: 2, drivenAfterReject: 0, declaredEstimates: [500, 600] } }),
  );
  assert.equal(rejected.score, 1, "超限派发都被拒绝，说明预检生效");
  assert.match(rejected.detail, /拒绝 2 次/);

  const penetrated = teamOverBudget(
    { maxTokensTotal: 100 },
    evidence({ budgetPrecheck: { checked: 1, rejected: 1, drivenAfterReject: 1, declaredEstimates: [500] } }),
  );
  assert.equal(penetrated.score, 0, "判了拒绝却仍驱动成员 = 预检被穿透");
});

test("teamOverBudget：声明超限但预检一次没拒绝 → 判失败（暴露预检失效）", () => {
  // 这是 createBudgetGuard 忽略 maxTokensTotal 的直接后果：必须显形为红灯。
  const broken = teamOverBudget(
    { maxTokensTotal: 10 },
    evidence({ budgetPrecheck: { checked: 1, rejected: 0, drivenAfterReject: 0, declaredEstimates: [100000] } }),
  );
  assert.equal(broken.score, 0);
  assert.match(broken.detail, /预检未生效/);
});

test("teamConvergence：无成员真实执行 → 不适用（不把合成收尾记成 1）", () => {
  // T-L1/T-L2a 记录派发但不驱动成员，此时「已收尾」是合成结论。
  const synthetic = teamConvergence(
    evidence({ memberStatus: { a: "done" }, sends: [{ recipient: "a", content: "x" }] }),
  );
  assert.equal(synthetic.applicable, false);
  assert.match(synthetic.detail, /无成员真实执行/);
});

test("teamConvergence：有成员真实执行时按收敛状态判定", () => {
  const dangling = teamConvergence(
    evidence({
      memberStatus: { a: "running" },
      sends: [{ recipient: "a", content: "x" }],
      subagentResults: [{ member: "a", status: "failed", ran: true }],
    }),
  );
  assert.equal(dangling.score, 0);

  const idleNotDispatched = teamConvergence(
    evidence({
      memberStatus: { a: "done", b: "idle" },
      sends: [{ recipient: "a", content: "x" }],
      subagentResults: [{ member: "a", status: "done", ran: true }],
    }),
  );
  assert.equal(idleNotDispatched.score, 1, "b 从未被派发，不应算未收敛");
});

test("teamPeakConcurrency：峰值 ≤ 上限得 1，突破得 0；无成员执行不适用", () => {
  const ran = [{ member: "a", status: "done", ran: true }];
  const ok = teamPeakConcurrency(
    evidence({ memberStatus: { a: "done" }, sends: [{ recipient: "a", content: "x" }], peakConcurrency: 2, maxConcurrentMembers: 2, subagentResults: ran }),
  );
  assert.equal(ok.score, 1);
  const bad = teamPeakConcurrency(
    evidence({ memberStatus: { a: "done" }, sends: [{ recipient: "a", content: "x" }], peakConcurrency: 3, maxConcurrentMembers: 2, subagentResults: ran }),
  );
  assert.equal(bad.score, 0);

  // 不跑成员的档位：峰值并发根本没观测到，不能记成 applicable 的 1。
  const notObserved = teamPeakConcurrency(
    evidence({ memberStatus: { a: "done" }, sends: [{ recipient: "a", content: "x" }], peakConcurrency: 1, maxConcurrentMembers: 1 }),
  );
  assert.equal(notObserved.applicable, false);
});

test("teamDispatchCorrectness：成员/派发/轨迹全对齐得 1，缺成员得 <1", () => {
  const case_ = {
    members: [{ name: "a" }],
    expectedSends: [{ recipient: "a", content: "x" }],
    expectedToolCalls: [{ tool: "TeamCreate" }, { tool: "SendMessage" }],
  };
  const aligned = teamDispatchCorrectness(
    case_,
    evidence({
      spawnedMembers: ["a"],
      sends: [{ recipient: "a", content: "x" }],
      toolTrajectory: [{ tool: "TeamCreate" }, { tool: "SendMessage" }],
    }),
  );
  assert.equal(aligned.score, 1);

  const missing = teamDispatchCorrectness(
    case_,
    evidence({ spawnedMembers: [], sends: [], toolTrajectory: [{ tool: "TeamCreate" }] }),
  );
  assert.ok(missing.score < 1, "缺成员必须扣分");
});

test("teamDispatchCorrectness：无派发轨迹证据时 applicable=false（不把没测判成失败）", () => {
  const m = teamDispatchCorrectness({ members: [{ name: "a" }], expectedSends: [{ recipient: "a", content: "x" }] }, evidence({}));
  assert.equal(m.applicable, false);
});

test("teamTokenAttributionToMember：成员合计不得超过团队累计", () => {
  const ok = teamTokenAttributionToMember(
    evidence({ memberUsage: { a: { tokens: 10, cost: 0.1 } }, teamUsage: { totalTokens: 10, totalCost: 0.1 } }),
  );
  assert.equal(ok.score, 1);
  const bad = teamTokenAttributionToMember(
    evidence({ memberUsage: { a: { tokens: 10, cost: 0.1 } }, teamUsage: { totalTokens: 5, totalCost: 0.1 } }),
  );
  assert.equal(bad.score, 0);
});

test("teamCostAmplificationRatio：≤ warn 阈值得 1，超过按 warn/ratio 衰减", () => {
  const under = teamCostAmplificationRatio(
    evidence({ memberUsage: { a: { tokens: 1, cost: 1 }, b: { tokens: 1, cost: 1 } }, teamUsage: { totalTokens: 2, totalCost: 2 } }),
  );
  // baseline = max 成员成本 = 1，ratio = 2 ≤ 3 → 1
  assert.equal(under.score, 1);
  const over = teamCostAmplificationRatio(
    evidence({ memberUsage: { a: { tokens: 1, cost: 1 }, b: { tokens: 1, cost: 1 } }, teamUsage: { totalTokens: 2, totalCost: 6 } }),
  );
  // ratio = 6 → score = 3/6 = 0.5
  assert.equal(over.score, 0.5);
  assert.match(over.detail, /永不 block/);
});

test("aggregateTeamMetrics：applicable=false 不进分母（G5）", () => {
  const metrics = aggregateTeamMetrics([
    [
      { name: "teamOverBudget", score: 1, applicable: true },
      { name: "teamSubagentCompletionRate", score: 0, applicable: false },
    ],
    [{ name: "teamOverBudget", score: 0, applicable: true }],
  ]);
  const overBudget = metrics.find((m) => m.name === "teamOverBudget");
  assert.equal(overBudget.value, 0.5);
  const completion = metrics.find((m) => m.name === "teamSubagentCompletionRate");
  assert.equal(completion.applicable, false);
});

test("resolveExpectedTools：undefined=全量、[]=零工具（不被误判为全量）", () => {
  assert.deepEqual(resolveExpectedTools(["read", "write"], undefined), ["read", "write"]);
  assert.deepEqual(resolveExpectedTools(["read", "write"], []), []);
  assert.deepEqual(resolveExpectedTools(["read", "write", "bash"], ["read", "bash"]), ["read", "bash"]);
});

// ============ 3. 指标归属（§7 表） ============
test("§7 八条指标 + 两条契约指标全部登记，且 tier / 门禁归属与规范一致", () => {
  const byName = new Map(TEAM_METRIC_SPECS.map((s) => [s.name, s]));
  // 八条 §7 表单指标 + teamContractStatuses / teamL1Contract 两条契约指标。
  assert.equal(byName.size, 10);
  // 契约指标也必须是硬门禁：否则数据集里的声明就又退化成「校验但不生效」。
  assert.equal(byName.get("teamContractStatuses").gate, "hard");
  assert.equal(byName.get("teamL1Contract").gate, "hard");
  assert.equal(byName.get("teamDispatchCorrectness").gate, "trend");
  assert.equal(byName.get("teamCostAmplificationRatio").gate, "trend");
  assert.equal(byName.get("teamTokenAttributionToMember").gate, "trend");
  for (const name of [
    "teamSubagentCompletionRate",
    "teamPermissionInheritanceCorrectness",
    "teamConvergence",
    "teamOverBudget",
    "teamPeakConcurrency",
  ]) {
    assert.equal(byName.get(name).gate, "hard", `${name} 应为硬门禁`);
  }
  // 硬+趋势 = 全集，且两者不交叠（分层必须互斥）。
  assert.equal(HARD_GATE_METRICS.length + TREND_METRICS.length, TEAM_METRIC_SPECS.length);
  for (const name of HARD_GATE_METRICS) assert.ok(!TREND_METRICS.includes(name));
  // 每个规约都必须有证据源与确定性说明（§7 要求的「证据源 → tier → 可确定性」注释落地）。
  for (const spec of TEAM_METRIC_SPECS) {
    assert.ok(spec.evidenceSource.length > 0);
    assert.ok(spec.note.length > 0);
  }
});

test("team 指标名与 coding 指标名零交集", () => {
  const coding = ["fileChangeCorrectness", "permissionCompliance", "toolSelectionCorrectness", "turnEfficiency"];
  for (const spec of TEAM_METRIC_SPECS) assert.ok(!coding.includes(spec.name));
});
