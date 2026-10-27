/**
 * ohna team 评测「provider 档（T-L2b / T-L4）」语义单测（v2.0 team-eval §4.2 / §5）。
 *
 * 本文件的断言重点是**红线守卫**，而不是「模型输出质量」：
 * 1. 无 provider 凭据时 T-L2b / T-L4 必须**显式 skip**：`executed=false` + 明确原因，
 *    报告里逐 case 标 `skipped:no_provider_credentials`，且 **exitCode 不因 skip 变成 1**
 *    （缺凭据是环境约束，不是实现回归）；
 * 2. skip 绝不静默：原因必须出现在报告 `summary` 与 `run.skipReason`、并写入 stderr（CLI 侧）
 *    与趋势段 markdown；
 * 3. team 域**没有任何 streamFn 替身**：源码级断言 `run.ts` / `adapter.ts` 不出现
 *    `createMockStreamFn` / `createOfflineStreamFn`，真实档位只接 `streamSimple`；
 * 4. 凭据探测函数本身可被注入覆盖（测试可确定性驱动「有凭据」分支而不触网）。
 *
 * 为什么这样测：T-L2b/T-L4 若用「回放 expectedToolCalls 的假 provider」驱动，
 * 编排决策就成了自证循环（§4.2 红线），因此这里只验证「真 provider 边界」与「显式跳过」。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadTeamDataset, runTeamEval, runTeamEvaluation } from "../dist/team/index.js";
import { detectProviderCredentials } from "../dist/team/adapter.js";
import { buildTeamTrend } from "../dist/team/trend.js";

const DATASET = fileURLToPath(new URL("../../../datasets/ohna/team-v1.json", import.meta.url));
const RUN_SRC = fileURLToPath(new URL("../src/team/run.ts", import.meta.url));
// 真 provider 执行器在 run-provider.ts（run.ts 只做分派）：红线扫描必须覆盖真正持有
// `streamSimple` 的文件，否则「真 provider 路径存在」这条断言会因为拆文件而失去意义。
const PROVIDER_SRC = fileURLToPath(new URL("../src/team/run-provider.ts", import.meta.url));
const L1_SRC = fileURLToPath(new URL("../src/team/run-l1.ts", import.meta.url));
const ADAPTER_SRC = fileURLToPath(new URL("../src/team/adapter.ts", import.meta.url));

// ============ 1. 无凭据显式 skip ============
test("无凭据时 T-L2b 全部 case 显式 skip（executed=false + 明确原因）", async () => {
  const ds = loadTeamDataset(DATASET);
  const runs = await runTeamEval(ds, { tier: "T-L2b", credentials: { available: false, reason: "单测注入：无凭据" } });
  assert.equal(runs.length, ds.cases.length);
  for (const run of runs) {
    assert.equal(run.executed, false, `${run.id} 不应被执行`);
    assert.match(run.skipReason, /无 provider 凭据/, "skip 原因必须写明缺凭据");
    assert.deepEqual(run.metrics, [], "skip 的 case 不得产出任何得分（禁止静默按 0/1 记分）");
  }
});

test("无凭据时 T-L4 同样显式 skip，且报告写明跳过原因", async () => {
  const ds = loadTeamDataset(DATASET);
  const result = await runTeamEvaluation(ds, {
    tier: "T-L4",
    baseline: null,
    credentials: { available: false, reason: "单测注入：无凭据" },
  });
  assert.ok(result.skipReason, "必须产出显式 skip 原因");
  assert.match(result.skipReason, /无 provider 凭据/);
  assert.match(result.summary, /显式跳过/, "报告 summary 必须写明跳过");
  // skip 的 case 记为 not passed 并带 taxonomy 标注，绝不记为通过。
  for (const c of result.report.cases) {
    assert.equal(c.passed, false, `${c.id} 未执行不得记为通过`);
    assert.equal(c.failedTaxonomy, "skipped:no_provider_credentials");
  }
});

test("无凭据 skip 不产生虚假硬门禁失败（硬指标全部 applicable=false）", async () => {
  const ds = loadTeamDataset(DATASET);
  const result = await runTeamEvaluation(ds, {
    tier: "T-L2b",
    baseline: null,
    credentials: { available: false, reason: "单测注入：无凭据" },
  });
  // 没有任何 case 执行 → 所有指标都无证据；此时不得出现「applicable=true 且 value=0」的假失败。
  for (const metric of result.report.metrics) {
    assert.equal(metric.applicable, false, `${metric.name} 在无凭据时不应适用`);
  }
  // 门禁返回 1，但原因必须是「本档不可判定」而不是「指标低于下限」——两者含义完全不同：
  // 前者说明根本没跑，后者会被误读成实现回归。
  assert.equal(result.decidable, false);
  assert.match(result.gate.reasons.join(), /不可判定/);
  assert.ok(!/低于 SLO 下限/.test(result.gate.reasons.join()), "不得把没跑报成指标失败");
});

// ============ 2. skip 必须出现在趋势段 ============
test("趋势段在无凭据 skip 时写明原因，不渲染趋势表", async () => {
  const ds = loadTeamDataset(DATASET);
  const result = await runTeamEvaluation(ds, {
    tier: "T-L4",
    baseline: null,
    credentials: { available: false, reason: "单测注入：无凭据" },
  });
  const trend = buildTeamTrend({ runs: result.runs, report: result.report, baseline: null, tier: "T-L4" });
  assert.equal(trend.applicable, false);
  assert.match(trend.markdown, /无 provider 凭据/);
  assert.ok(!trend.markdown.includes("| 指标 |"));
});

// ============ 3. 红线：无 streamFn 替身 ============
test("team 域源码中不存在 mock streamFn / 回放 provider（§4.2 红线）", () => {
  for (const file of [RUN_SRC, PROVIDER_SRC, ADAPTER_SRC]) {
    const source = readFileSync(file, "utf8");
    // 判据是「真实调用」而非「文档提及」：注释里说明「为何不用」是允许甚至鼓励的，
    // 因此先剥掉注释再断言，避免把解释性文字误判为违规使用。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!code.includes("createMockStreamFn"), `${file} 不得调用 createMockStreamFn`);
    assert.ok(!code.includes("createOfflineStreamFn"), `${file} 不得调用 createOfflineStreamFn`);
    // 回放式 provider 的典型特征：用 dataset 的 expectedToolCalls 直接编造 assistant 消息。
    assert.ok(
      !/streamFn\s*[:=]\s*\(?\s*async\s*\(\s*\)?\s*\)?\s*=>\s*.*expectedToolCalls/s.test(source),
      `${file} 不得用 expectedToolCalls 伪造 streamFn`,
    );
  }
  // 真实档位必须接真 provider 的 streamSimple（持有者随拆文件迁移到 run-provider.ts）。
  assert.match(readFileSync(PROVIDER_SRC, "utf8"), /streamSimple/);
});

test("provider 档只在真 provider 分支被驱动：T-L1/T-L2a 源码路径不引用 streamSimple", () => {
  // 拆文件后的结构：run.ts 负责 L1/L2a 与分派，run-provider.ts 独占真 provider 驱动。
  // 因此「确定性档不触达传输层」应断言在 run.ts（且它整体不含 streamSimple），
  // 而 streamSimple 只允许出现在 run-provider.ts。
  const runSource = readFileSync(RUN_SRC, "utf8");
  const providerSource = readFileSync(PROVIDER_SRC, "utf8");
  assert.ok(!runSource.includes("streamSimple"), "run.ts（L1/L2a 与分派）不得触达 model 传输层");
  assert.ok(providerSource.includes("streamSimple"), "真 provider 驱动必须存在于 run-provider.ts");

  const l1Source = readFileSync(L1_SRC, "utf8");
  assert.ok(!l1Source.includes("streamSimple"), "T-L1 不得触达 model 传输层");
});

// ============ 4. 凭据探测可注入 / 当前环境如实报告 ============
test("detectProviderCredentials 返回结构化结果（当前环境无凭据时 reason 非空）", async () => {
  const probe = await detectProviderCredentials();
  assert.equal(typeof probe.available, "boolean");
  if (!probe.available) {
    assert.ok(probe.reason && probe.reason.length > 0, "不可用时必须给出原因，禁止静默");
    assert.match(probe.reason, /无 provider 凭据/);
  }
});

test("凭据探测支持注入覆盖（不触网即可驱动两条分支）", async () => {
  const forcedYes = await detectProviderCredentials(() => ({ model: { id: "x" }, apiKey: "k" }));
  assert.equal(forcedYes.available, true);
  const forcedNo = await detectProviderCredentials(() => null);
  assert.equal(forcedNo.available, false);
  assert.match(forcedNo.reason, /无 provider 凭据/);
});
