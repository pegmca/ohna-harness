import assert from "node:assert/strict";
import test from "node:test";
import {
  calibrateJudgeScores,
  createInMemoryCalibrationStore,
} from "../dist/index.js";

test("无人工标注时偏差为 0，calibratedScore 等于 rawScore", () => {
  const store = createInMemoryCalibrationStore();
  const out = calibrateJudgeScores([{ caseId: "c1", score: 0.7 }], store);
  assert.equal(out[0].bias, 0);
  assert.equal(out[0].calibratedScore, 0.7);
  assert.equal(out[0].hasHumanLabel, false);
});

test("依据带标注 case 计算全局偏差并平移", () => {
  const store = createInMemoryCalibrationStore();
  // case c1：judge 0.5，人工 0.8；case c2：judge 0.5，人工 0.6
  // 人类均值 = 0.7，judge 均值 = 0.5，bias = 0.2
  store.recordLabel("c1", 0.8);
  store.recordLabel("c2", 0.6);
  const out = calibrateJudgeScores(
    [
      { caseId: "c1", score: 0.5 },
      { caseId: "c2", score: 0.5 },
      { caseId: "c3", score: 0.6 }, // 无标注不参与偏差计算，但全局偏差同样平移
    ],
    store,
  );
  assert.equal(out[0].calibratedScore, 0.7);
  assert.equal(out[1].calibratedScore, 0.7);
  assert.ok(Math.abs(out[2].calibratedScore - 0.8) < 1e-9);
  assert.ok(Math.abs(out[0].bias - 0.2) < 1e-9);
});

test("同一 case 多条人工标注取平均", () => {
  const store = createInMemoryCalibrationStore();
  store.recordLabel("c1", 0.4);
  store.recordLabel("c1", 0.8); // 均值 0.6
  const out = calibrateJudgeScores([{ caseId: "c1", score: 0.5 }], store);
  // 人类均值 0.6 - judge 0.5 = 0.1
  assert.ok(Math.abs(out[0].bias - 0.1) < 1e-9);
  assert.ok(Math.abs(out[0].calibratedScore - 0.6) < 1e-9);
});

test("校准结果钳制到 [0,1]，非有限分归 0", () => {
  const store = createInMemoryCalibrationStore();
  store.recordLabel("c1", 1.0);
  const out = calibrateJudgeScores([{ caseId: "c1", score: 0.95 }], store);
  // 偏差 = 1.0 - 0.95 = 0.05 → 0.95 + 0.05 = 1.0（钳制不超 1）
  assert.equal(out[0].calibratedScore, 1.0);
  const out2 = calibrateJudgeScores([{ caseId: "c1", score: NaN }], store);
  assert.equal(out2[0].calibratedScore, 0);
});

test("内存 store 可清空与列出", () => {
  const store = createInMemoryCalibrationStore();
  store.recordLabel("c1", 0.5);
  assert.deepEqual(store.getLabels("c1"), [0.5]);
  store.clear();
  assert.deepEqual(store.getLabels("c1"), []);
});
