import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInMemoryCalibrationStore,
  calibrateJudgeScores
} from "../dist/index.js";

test("in-memory store averages multiple labels for same case", async () => {
  const store = createInMemoryCalibrationStore();
  store.recordLabel("c1", 0.8);
  store.recordLabel("c1", 0.6);
  assert.deepEqual(store.getLabels("c1"), [0.8, 0.6]);
  assert.equal(store.getLabels("c1").reduce((a, b) => a + b, 0) / 2, 0.7);
  store.clear();
  assert.deepEqual(store.getLabels("c1"), []);
});

test("calibrateJudgeScores shifts raw scores by non-zero bias with human labels", async () => {
  const store = createInMemoryCalibrationStore();
  // 人类给 c1 打了 1.0，而 judge 给 0.6 → 偏差 = 1.0 - 0.6 = 0.4（judge 系统性偏低）。
  store.recordLabel("c1", 1.0);

  const out = calibrateJudgeScores(
    [{ caseId: "c1", score: 0.6 }, { caseId: "c2", score: 0.2 }],
    store
  );

  assert.equal(out[0].hasHumanLabel, true);
  assert.equal(out[1].hasHumanLabel, false);
  assert.equal(out[0].bias, 0.4);
  // rawScore 0.6 + bias 0.4 = 1.0，钳制后仍为 1.0。
  assert.equal(out[0].calibratedScore, 1.0);
  // 无标注的 c2 不偏移（bias 来自 c1 集合，但此处 bias 是全句恒定，按规格用全局偏差）。
  assert.equal(out[1].calibratedScore, clampCheck(out[1].rawScore + out[1].bias));
});

test("calibrateJudgeScores with no labels: bias=0, calibrated equals raw", async () => {
  const store = createInMemoryCalibrationStore();
  const out = calibrateJudgeScores([{ caseId: "x", score: 0.5 }], store);

  assert.equal(out[0].bias, 0);
  assert.equal(out[0].calibratedScore, 0.5);
  assert.equal(out[0].hasHumanLabel, false);
});

test("calibrateJudgeScores clamps calibrated score into [0,1]", async () => {
  // 上界钳制：人类偏高 → 正偏差，把高分样本顶过 1.0 钳回 1.0。
  const up = createInMemoryCalibrationStore();
  up.recordLabel("c1", 1.0); // bias = 1.0 - 0.2 = 0.8
  const out = calibrateJudgeScores([{ caseId: "c1", score: 0.2 }, { caseId: "c2", score: 0.9 }], up);
  assert.equal(out[0].bias, 0.8);
  assert.equal(out[1].calibratedScore, 1.0);

  // 下界钳制：人类偏低 → 负偏差，把低分样本压到 0.0 以下钳回 0.0。
  const down = createInMemoryCalibrationStore();
  down.recordLabel("c1", 0.0); // bias = 0.0 - 0.9 = -0.9
  const out2 = calibrateJudgeScores([{ caseId: "c1", score: 0.9 }, { caseId: "c2", score: 0.1 }], down);
  assert.equal(out2[0].bias, -0.9);
  assert.equal(out2[1].calibratedScore, 0.0);
});

/** 校验钳制边界（与实现 clamp01 口径一致）。 */
function clampCheck(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}
