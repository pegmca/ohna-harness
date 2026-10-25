/**
 * ohna 编码 Agent 评测单测（Step 4 · ohna-eval-tests 工作项）。
 *
 * 覆盖：
 * - metrics 四个指标：fileChangeCorrectness / permissionCompliance / toolSelectionCorrectness / turnEfficiency；
 * - aggregateToReport 的 G5（applicable=false 指标不进聚合分母）+ cases.failedMetrics；
 * - runOhnaEval 在 integration 档 + 离线确定性 streamFn 下真实跑 agentLoop，产出 EvalReportDto
 *   （验证 streamFn 注入 + 临时工作区 + 投影 ToolCallStep[] + 门禁 + 清理）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  fileChangeCorrectness,
  permissionCompliance,
  toolSelectionCorrectness,
  turnEfficiency,
  aggregateToReport,
} from "../dist/eval/metrics.js";
import { runOhnaEval } from "../dist/eval/run.js";
import { loadOhnaDataset } from "../dist/eval/dataset.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

/** 构造一个工作区快照 Map 的小工具。 */
function snapshotOf(entries) {
  return new Map(Object.entries(entries));
}

// ============ metrics: fileChangeCorrectness ============
test("fileChangeCorrectness：内容必须包含给满分", () => {
  const score = fileChangeCorrectness(
    { expectedFileChanges: [{ path: "a.txt", mustContain: ["hi"] }] },
    snapshotOf({ "a.txt": "hi" }),
  );
  assert.equal(score.name, "fileChangeCorrectness");
  assert.equal(score.score, 1);
  assert.equal(score.applicable, true);
});

test("fileChangeCorrectness：内容不含必须子串给 0 分", () => {
  const score = fileChangeCorrectness(
    { expectedFileChanges: [{ path: "a.txt", mustContain: ["hi"] }] },
    snapshotOf({ "a.txt": "bye" }),
  );
  assert.equal(score.score, 0);
});

test("fileChangeCorrectness：forbid 命中给 0 分", () => {
  const score = fileChangeCorrectness(
    { expectedFileChanges: [{ path: "a.txt", forbid: ["oops"] }] },
    snapshotOf({ "a.txt": "oops happened" }),
  );
  assert.equal(score.score, 0);
});

test("fileChangeCorrectness：无期望字段 → applicable=false（修 G5）", () => {
  const score = fileChangeCorrectness({ expectedFileChanges: undefined }, snapshotOf({}));
  assert.equal(score.applicable, false);
});

// ============ metrics: permissionCompliance ============
test("permissionCompliance：期望拒的都拒了、没误拒 → 满分", () => {
  const score = permissionCompliance({ expectedPermissionDenials: ["bash"] }, ["bash"]);
  assert.equal(score.score, 1);
  assert.equal(score.applicable, true);
});

test("permissionCompliance：期望拒但没拒 → 0 分", () => {
  const score = permissionCompliance({ expectedPermissionDenials: ["bash"] }, []);
  assert.equal(score.score, 0);
});

test("permissionCompliance：未期望拒却拒了 → 0 分", () => {
  const score = permissionCompliance({ expectedPermissionDenials: [] }, ["bash"]);
  assert.equal(score.score, 0);
});

// ============ metrics: toolSelectionCorrectness ============
test("toolSelectionCorrectness：实际轨迹含期望序列（subset）→ 满分", () => {
  const score = toolSelectionCorrectness(
    { expectedToolCalls: [{ tool: "read" }, { tool: "edit" }] },
    [{ tool: "read" }, { tool: "edit" }, { tool: "read" }],
  );
  assert.equal(score.score, 1);
});

test("toolSelectionCorrectness：期望工具缺失 → 0 分", () => {
  const score = toolSelectionCorrectness(
    { expectedToolCalls: [{ tool: "edit" }] },
    [{ tool: "read" }],
  );
  assert.equal(score.score, 0);
});

test("toolSelectionCorrectness：无期望轨迹 → applicable=false（修 G5）", () => {
  const score = toolSelectionCorrectness({ expectedToolCalls: undefined }, [{ tool: "read" }]);
  assert.equal(score.applicable, false);
});

// ============ metrics: turnEfficiency ============
test("turnEfficiency：实际轮数 ≤ 预算 → 满分", () => {
  const score = turnEfficiency({ maxTurns: 3 }, 2);
  assert.equal(score.score, 1);
});

test("turnEfficiency：超预算线性衰减，下限 0", () => {
  const score = turnEfficiency({ maxTurns: 1 }, 2); // 超出 1 → 0.8
  assert.equal(score.score, 0.8);
  const worse = turnEfficiency({ maxTurns: 1 }, 10); // 超出 9 → 0
  assert.equal(worse.score, 0);
});

test("turnEfficiency：无预算 → applicable=false（修 G5）", () => {
  const score = turnEfficiency({ maxTurns: undefined }, 5);
  assert.equal(score.applicable, false);
});

// ============ aggregateToReport：G5 + failedMetrics ============
test("aggregateToReport：applicable=false 指标不进聚合分母（G5）", () => {
  const report = aggregateToReport("ohna-cli", "coding-v1", [
    {
      id: "c1",
      metrics: [
        { name: "fileChangeCorrectness", score: 1, applicable: true },
        { name: "fileChangeCorrectness", score: 1, applicable: false }, // 不应进分母
      ],
      passed: true,
      failedMetrics: [],
    },
  ]);
  const metric = report.metrics.find((m) => m.name === "fileChangeCorrectness");
  assert.equal(metric.applicable, true);
  assert.equal(metric.value, 1); // 只聚合 applicable 的 1 个 1
});

test("aggregateToReport：cases 携带 failedMetrics 且 passed 收敛正确", () => {
  const report = aggregateToReport("ohna-cli", "coding-v1", [
    {
      id: "ok",
      metrics: [
        { name: "fileChangeCorrectness", score: 1, applicable: true },
        { name: "toolSelectionCorrectness", score: 1, applicable: true },
      ],
      passed: true,
      failedMetrics: [],
    },
    {
      id: "bad",
      metrics: [
        { name: "fileChangeCorrectness", score: 0, applicable: true },
        { name: "toolSelectionCorrectness", score: 1, applicable: true },
      ],
      passed: false,
      failedMetrics: ["fileChangeCorrectness"],
    },
  ]);
  const badCase = report.cases.find((c) => c.id === "bad");
  assert.equal(badCase.passed, false);
  assert.deepEqual(badCase.failedMetrics, ["fileChangeCorrectness"]);
  const okCase = report.cases.find((c) => c.id === "ok");
  assert.equal(okCase.passed, true);
  assert.equal(okCase.failedMetrics, undefined);
});

// ============ runOhnaEval：integration 档 + 离线 streamFn + 临时工作区 ============
test("runOhnaEval：integration 档真实跑 agentLoop，产出 EvalReportDto 并清理临时工作区", async () => {
  // 注入独立 tmpRoot，使清理断言与本进程内其它并发 runOhnaEval 调用隔离
  // （node:test 同进程并发；共享 os.tmpdir() 命名空间会让「残留计数」竞态误判）。
  const tmpRoot = mkdtempSync(join(tmpdir(), "ohna-eval-it-"));
  try {
    // 跑前统计该独立根下的残留（验证 finally 清理）。
    const before = countEvalTmpDirs(tmpRoot);

    const dataset = {
      schemaVersion: "2.0.0",
      datasetVersion: "coding-v1",
      minCases: 1,
      cases: [
        {
          id: "t-write",
          prompt: "创建一个文件 out.txt，内容为 hello",
          mode: "coding",
          expectedToolCalls: [{ tool: "write", args: { path: "out.txt", content: "hello" } }],
          expectedFileChanges: [{ path: "out.txt", mustContain: ["hello"] }],
          maxTurns: 3,
        },
        {
          id: "t-deny",
          prompt: "执行危险命令 rm -rf /",
          mode: "permission",
          expectedToolCalls: [{ tool: "bash", args: { command: "rm -rf /" } }],
          expectedPermissionDenials: ["bash"],
          maxTurns: 3,
        },
        {
          id: "t-read",
          prompt: "读取 a.md",
          mode: "coding",
          workspaceSeed: [{ path: "a.md", content: "x" }],
          expectedToolCalls: [{ tool: "read", args: { path: "a.md" } }],
          maxTurns: 3,
        },
      ],
    };

    const report = await runOhnaEval(dataset, { tier: "integration", tmpRoot });

    assert.equal(report.target, "ohna-cli");
    assert.equal(report.dataset, "coding-v1");
    assert.equal(report.cases.length, 3);

    const byName = Object.fromEntries(report.metrics.map((m) => [m.name, m]));

    // fileChangeCorrectness 仅对 t-write 适用（其余 applicable=false），写类应满分。
    assert.equal(byName.fileChangeCorrectness.applicable, true);
    assert.equal(byName.fileChangeCorrectness.value, 1);
    // permissionCompliance 全部适用且满分（t-deny 期望拒 bash 实际拒）。
    assert.equal(byName.permissionCompliance.value, 1);
    // toolSelectionCorrectness 全部适用且满分（离线替身驱动轨迹 == 期望）。
    assert.equal(byName.toolSelectionCorrectness.value, 1);
    // turnEfficiency 聚合：t-write/deny/read 预算 3 实际 2 均满分 → 1。
    assert.equal(byName.turnEfficiency.value, 1);

    // 所有 case 通过（确定性闭环）。
    for (const c of report.cases) {
      assert.equal(c.passed, true, `case ${c.id} 应通过`);
    }

    // 临时工作区应被清理（该独立根下残留数不变）。
    const after = countEvalTmpDirs(tmpRoot);
    assert.equal(after, before, "临时工作区应被清理，无残留");
  } finally {
    // 清理注入的独立 tmpRoot 本身。
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runOhnaEval：可加载权威数据集 datasets/ohna/coding-v1.json 并跑通 integration", async () => {
  const datasetPath = join(REPO_ROOT, "datasets/ohna/coding-v1.json");
  let loaded;
  try {
    loaded = loadOhnaDataset(datasetPath);
  } catch {
    // 数据集不存在则跳过（仓库根必须包含该数据集）。
    return;
  }
  assert.ok(loaded.cases.length >= 20, "数据集应 ≥20 cases");

  const report = await runOhnaEval(loaded, { tier: "integration" });
  assert.equal(report.cases.length, loaded.cases.length);
  // 关键闭环指标应全部满分（确定性证据）。
  const byName = Object.fromEntries(report.metrics.map((m) => [m.name, m]));
  assert.equal(byName.fileChangeCorrectness.value, 1);
  assert.equal(byName.permissionCompliance.value, 1);
  assert.equal(byName.toolSelectionCorrectness.value, 1);
  assert.ok(byName.turnEfficiency.value >= 0.8, "turnEfficiency 应过门禁下限 0.8");
});

// 回归：移除 Math.max(turns,1) 地板后，真实超预算必须暴露（修 review-major）。
// 离线 deterministic streamFn 必跑 2 轮（第 1 轮 toolUse、第 2 轮 stop 收敛），
// 故 maxTurns=1 的 case 实际 2 轮 → turnEfficiency = 1 - 0.2 = 0.8，应进 failedMetrics。
test("runOhnaEval：maxTurns=1 的 case 真实暴露超预算（turnEfficiency=0.8，不过门禁）", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "ohna-eval-floor-"));
  try {
    const dataset = {
      schemaVersion: "2.0.0",
      datasetVersion: "coding-v1",
      minCases: 1,
      cases: [
        {
          id: "over-budget",
          prompt: "创建 out.txt",
          mode: "budget",
          expectedToolCalls: [{ tool: "write", args: { path: "out.txt", content: "x" } }],
          expectedFileChanges: [{ path: "out.txt", mustContain: ["x"] }],
          maxTurns: 1, // 预算 1，离线驱动必 2 轮
        },
      ],
    };

    const report = await runOhnaEval(dataset, { tier: "integration", tmpRoot });
    const te = report.metrics.find((m) => m.name === "turnEfficiency");
    assert.equal(te.value, 0.8, "maxTurns=1 → 2 实际轮 → 0.8");
    const theCase = report.cases.find((c) => c.id === "over-budget");
    assert.equal(theCase.passed, false);
    assert.deepEqual(theCase.failedMetrics, ["turnEfficiency"]);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

/** 统计给定根下 ohna-eval- 前缀的残留目录数（默认 os.tmpdir()）。 */
function countEvalTmpDirs(root = tmpdir()) {
  try {
    return readdirSync(root).filter((name) => name.startsWith("ohna-eval-")).length;
  } catch {
    return 0;
  }
}
