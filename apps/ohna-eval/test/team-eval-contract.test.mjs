/**
 * ohna team 评测域单测：**契约指标**（v2.0 team-eval §7/§8）。
 *
 * 本文件与 `team-eval-core.test.mjs` 拆分的原因：后者已覆盖数据集校验 / 八个指标纯函数 /
 * 指标归属，加上本文件的契约断言就超过 500 行单文件上限（AGENTS.md）。
 * 边界：这里只覆盖「数据集里声明的期望必须真的被断言」这条硬门禁
 * （`teamContractStatuses` / `teamL1Contract`），以及「不允许声明了却没触发」的 loader 校验。
 *
 * 本文件不含任何 provider 调用（T-L2b/T-L4 的显式 skip 语义在 `team-eval-provider.test.mjs`）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadTeamDataset, parseTeamDataset, runTeamEvaluation } from "../dist/team/index.js";

const DATASET = fileURLToPath(new URL("../../../datasets/ohna/team-v1.json", import.meta.url));

/**
 * 构造一个「全部有证据」的最小证据对象（各测试按需覆盖字段）。
 *
 * 与 `team-eval-core.test.mjs` 同名 helper 各自持有一份：测试文件之间不共享 helper 是有意的，
 * 避免一个文件的结构改动连带弄红另一个文件（vitest/node:test 的模块作用域本就隔离）。
 *
 * @param {object} [overrides] 需要覆盖的字段。
 * @returns {object} 证据对象。
 */
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

// ============ 4. 契约指标：声明必须真的被断言 ============
test("teamContractStatuses：成员终态与声明不符 → 0 分", async () => {
  const { contractStatuses } = await import("../dist/team/metrics.js");
  const base = {
    executed: true,
    memberStatus: { a: "failed" },
    spawnedMembers: [],
    sends: [{ recipient: "a", content: "x" }],
    toolTrajectory: [],
    subagentResults: [{ member: "a", status: "failed", ran: true }],
    deniedTools: [],
    grantedToolsByMember: {},
    teamUsage: { totalTokens: 0, totalCost: 0 },
    budgetExceeded: false,
    peakConcurrency: 1,
    maxConcurrentMembers: 1,
    memberUsage: {},
  };
  const bad = contractStatuses({ expectedMemberStatus: { a: "done" } }, base);
  assert.equal(bad.score, 0);
  assert.match(bad.detail, /终态/);
  const ok = contractStatuses({ expectedMemberStatus: { a: "failed" } }, base);
  assert.equal(ok.score, 1);
});

test("teamContractStatuses：maxTurns 超限 → 0 分", async () => {
  const { contractStatuses } = await import("../dist/team/metrics.js");
  const ev = evidence({ actualTurns: { a: 5 }, subagentResults: [{ member: "a", status: "done", ran: true }] });
  assert.equal(contractStatuses({ maxTurns: 3 }, ev).score, 0);
  assert.equal(contractStatuses({ maxTurns: 5 }, ev).score, 1);
});

test("teamContractStatuses：失败注入未生效 → 0 分（不允许声明了却没触发）", async () => {
  const { contractStatuses } = await import("../dist/team/metrics.js");
  const ev = evidence({ subagentResults: [{ member: "a", status: "done", ran: true }] });
  const missing = contractStatuses({ failedMember: "a", failTool: "write" }, ev);
  assert.equal(missing.score, 0);
  assert.match(missing.detail, /失败注入未生效/);

  const thrown = contractStatuses(
    { failedMember: "a", failTool: "write" },
    evidence({
      subagentResults: [{ member: "a", status: "failed", ran: true }],
      failureInjected: { member: "a", tool: "write", thrown: true },
    }),
  );
  assert.equal(thrown.score, 1);
});

test("teamL1Contract：探针分支真实参与计分（非 T-L1 档不适用）", async () => {
  const { contractL1 } = await import("../dist/team/metrics.js");
  assert.equal(contractL1({}, evidence({})).applicable, false);

  const good = contractL1(
    {},
    evidence({
      l1: {
        probeMode: "clean",
        artifactCount: 2,
        expectedArtifactCount: 2,
        summaryIsPlaceholder: false,
        abortFailClosed: true,
        abortCodeTransparent: true,
        configHasNoHook: true,
        budgetAllowed: true,
      },
    }),
  );
  assert.equal(good.score, 1);

  const badConfig = contractL1(
    {},
    evidence({
      l1: {
        probeMode: "with_hooks",
        artifactCount: 1,
        expectedArtifactCount: 1,
        summaryIsPlaceholder: false,
        abortFailClosed: false,
        abortCodeTransparent: true,
        configHasNoHook: false,
        budgetAllowed: true,
      },
    }),
  );
  assert.equal(badConfig.score, 0);
  assert.match(badConfig.detail, /钩子/);

  // misuse 分支（§6.1.2）：误传非 assistant 时为「非 fail-closed」，且该判据有牙齿——
  // 翻成 false 必须让指标判 0，否则这条断言就是恒真的假绿灯。
  const misuseOk = contractL1(
    {},
    evidence({
      l1: {
        probeMode: "misuse",
        artifactCount: 1,
        expectedArtifactCount: 1,
        summaryIsPlaceholder: false,
        abortFailClosed: false,
        abortCodeTransparent: true,
        abortMisuseNotFailClosed: true,
        configHasNoHook: true,
        budgetAllowed: true,
      },
    }),
  );
  assert.equal(misuseOk.score, 1, "misuse 分支落在非 fail-closed 一侧应满分");

  const misuseBad = contractL1(
    {},
    evidence({
      l1: {
        probeMode: "misuse",
        artifactCount: 1,
        expectedArtifactCount: 1,
        summaryIsPlaceholder: false,
        abortFailClosed: false,
        abortCodeTransparent: false,
        abortMisuseNotFailClosed: false,
        configHasNoHook: true,
        budgetAllowed: true,
      },
    }),
  );
  assert.equal(misuseBad.score, 0, "误传非 assistant 时若 fail-closed，必须判 0");
  assert.match(misuseBad.detail, /错误地 fail-closed/);
});

test("runTeamL1Case：misuse 探针构造违约入参，证据为正（aborted:false 且无 error 键）", async () => {
  const { runTeamL1Case } = await import("../dist/team/run-l1.js");
  const base = {
    mode: "dispatch",
    availableTools: ["read"],
    members: [{ name: "probe", role: "L1 探针成员", allowedTools: ["read"] }],
    expectedToolCalls: [
      { tool: "TeamCreate", args: { name: "probe" } },
      { tool: "SendMessage", args: { recipient: "probe" } },
    ],
  };

  const misuse = await runTeamL1Case({ ...base, id: "probe-misuse", l1ProbeMode: "misuse" });
  assert.equal(misuse.evidence.l1.probeMode, "misuse");
  assert.equal(misuse.evidence.l1.abortMisuseNotFailClosed, true);
  assert.equal(misuse.metrics.find((m) => m.name === "teamL1Contract").score, 1);

  // 对照组：非 misuse 分支不得产出该证据（否则 teamL1Contract 的判据会串档）。
  for (const mode of ["clean", "end_error", "stop_reason_error", "with_hooks"]) {
    const run = await runTeamL1Case({ ...base, id: `probe-${mode}`, l1ProbeMode: mode });
    assert.equal(run.evidence.l1.abortMisuseNotFailClosed, undefined, `${mode} 不应带 misuse 证据`);
  }
});

test("team-v1.json：failure_isolation 均声明精确注入点（成员 + 工具）且被授权", () => {
  const ds = loadTeamDataset(DATASET);
  const failures = ds.cases.filter((c) => c.mode === "failure_isolation");
  assert.ok(failures.length >= 4);
  for (const c of failures) {
    assert.ok(c.failedMember && c.failTool, `${c.id} 缺 failedMember/failTool`);
    const member = c.members.find((m) => m.name === c.failedMember);
    assert.ok(member, `${c.id} 的 failedMember 不在 members 中`);
    assert.ok(member.allowedTools?.includes(c.failTool), `${c.id} 的 failTool 未被授权`);
    assert.ok(!("failSubagentExecution" in c), `${c.id} 不应再用已废弃的 failSubagentExecution`);
  }
});

test("loader 拦下失败注入点未被授权 / 缺失的 case", () => {
  const base = JSON.parse(readFileSync(DATASET, "utf8"));
  const fi = base.cases.find((c) => c.mode === "failure_isolation");
  const invalid = base.cases.map((c) => (c === fi ? { ...c, failTool: "bash" } : c));
  assert.throws(() => parseTeamDataset(JSON.stringify({ ...base, cases: invalid }), "x.json"), /不在成员/);

  const missing = base.cases.map((c) => {
    if (c !== fi) return c;
    const copy = { ...c };
    delete copy.failedMember;
    return copy;
  });
  assert.throws(() => parseTeamDataset(JSON.stringify({ ...base, cases: missing }), "y.json"), /必须成对声明/);
});

test("loader 拦下非法 l1ProbeMode（否则探针静默退回 clean，指标判 1 却什么都没测）", () => {
  const base = JSON.parse(readFileSync(DATASET, "utf8"));
  const probe = base.cases.find((c) => c.l1ProbeMode === "misuse");
  assert.ok(probe, "数据集必须含 misuse 探针 case（§6.1.2）");
  // 拼错的分支必须加载期报错，而不是落进 `abortInputFor` 的缺省返回（= clean 探针）。
  const typo = base.cases.map((c) => (c === probe ? { ...c, l1ProbeMode: "typo_mode" } : c));
  assert.throws(() => parseTeamDataset(JSON.stringify({ ...base, cases: typo }), "z.json"), /l1ProbeMode 非法/);
});

test("teamCostAmplificationRatio：团队有成本但成员成本为 0 时，理由不得写成「成本为 0」", async () => {
  const { teamCostAmplificationRatio } = await import("../dist/team/metrics.js");
  const m = teamCostAmplificationRatio(
    evidence({ teamUsage: { totalTokens: 10, totalCost: 0.5 }, memberUsage: { a: { tokens: 0, cost: 0 } } }),
  );
  // 仍不适用（不制造假告警），但 detail 必须如实说明是「无基线」而非「成本为 0」。
  assert.equal(m.applicable, false);
  assert.match(m.detail, /无成本基线/);
  assert.doesNotMatch(m.detail, /^无成本证据/);
  assert.match(m.detail, /团队成本 0\.5/);
  // 对照组：真的零成本仍走原口径。
  const zero = teamCostAmplificationRatio(evidence({ teamUsage: { totalTokens: 0, totalCost: 0 }, memberUsage: { a: { tokens: 0, cost: 0 } } }));
  assert.match(zero.detail, /成本为 0/);
});

// ============ 5. 契约断言不得静默跳过（review 回归） ============
test("contractStatuses：期望 done / 实际 failed → 0 分", async () => {
  const { contractStatuses } = await import("../dist/team/metrics.js");
  const ev = evidence({
    memberStatus: { a: "failed" },
    sends: [{ recipient: "a", content: "x" }],
    subagentResults: [{ member: "a", status: "failed", ran: true }],
  });
  const m = contractStatuses({ expectedResultStatus: "done" }, ev);
  assert.equal(m.score, 0);
  assert.match(m.detail, /期望整体 done/);
});

test("contractStatuses：期望 failed / 实际全 done → 0 分", async () => {
  const { contractStatuses } = await import("../dist/team/metrics.js");
  const ev = evidence({
    memberStatus: { a: "done" },
    sends: [{ recipient: "a", content: "x" }],
    subagentResults: [{ member: "a", status: "done", ran: true }],
  });
  const m = contractStatuses({ expectedResultStatus: "failed" }, ev);
  assert.equal(m.score, 0);
  assert.match(m.detail, /期望整体 failed/);
});

test("contractStatuses：无成员真实执行时不适用（不制造假覆盖，也不伪造失败）", async () => {
  const { contractStatuses } = await import("../dist/team/metrics.js");
  const m = contractStatuses({ expectedMemberStatus: { a: "done" }, expectedResultStatus: "done" }, evidence({}));
  assert.equal(m.applicable, false);
});

test("确定性档：L1/L2a 的 teamOverBudget 用预算纯函数证据，而非累计用量", async () => {
  const ds = loadTeamDataset(DATASET);
  const result = await runTeamEvaluation(ds, { tier: "T-L1", baseline: null });
  const overBudgetRuns = result.runs.filter((run) => run.mode === "over_budget");
  assert.ok(overBudgetRuns.length > 0);
  for (const run of overBudgetRuns) {
    const metric = run.metrics.find((m) => m.name === "teamOverBudget");
    // 必须真的读了 L1 的 budgetAllowed / declaredEstimates，而不是「累计 0 ≤ 上限」。
    assert.ok(
      metric.applicable === false || /预检|预算纯函数/.test(metric.detail),
      `${run.id} 的 teamOverBudget 没有用预算证据：${metric.detail}`,
    );
  }
});
