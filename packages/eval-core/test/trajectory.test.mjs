import assert from "node:assert/strict";
import test from "node:test";
import * as evalCore from "../dist/index.js";
import { matchTrajectory } from "../dist/index.js";

// 期望项与实际项同为 ToolCallStep[]；期望项的 args 键集即必填参数。
const step = (tool, args) => ({ tool, args });

// Step 2 边界硬约束：内核只做「匹配」不做「从 run 事件投影轨迹」，
// 投影（含 extractToolTrajectory）留各 app。因此内核不得导出该函数。
test("内核不导出 extractToolTrajectory（投影留 app）", () => {
  assert.equal("extractToolTrajectory" in evalCore, false);
});

test("strict 模式顺序数量一致则 matched", () => {
  const actual = [step("search_filings"), step("generate_report")];
  const expected = [step("search_filings"), step("generate_report")];
  const r = matchTrajectory(actual, expected, "strict");
  assert.equal(r.matched, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.extra, []);
});

test("strict 模式数量不一致则 extra 导致不 matched", () => {
  const actual = [step("search_filings"), step("generate_report"), step("send_email")];
  const expected = [step("search_filings"), step("generate_report")];
  const r = matchTrajectory(actual, expected, "strict");
  assert.equal(r.matched, false);
  assert.deepEqual(r.extra, ["send_email"]);
});

test("subset 模式允许多余工具：matched 仍为 true（extra 仅记录不触发失败）", () => {
  const actual = [step("a"), step("b"), step("c")];
  const expected = [step("a"), step("c")];
  const r = matchTrajectory(actual, expected, "subset");
  // subset 只要求期望是实际轨迹的保序子序列；多余工具 b 记进 extra 供报告展示，
  // 但**不**因此判为不匹配。
  assert.equal(r.matched, true);
  assert.deepEqual(r.extra, ["b"]);
});

test("subset 模式顺序错则不匹配", () => {
  const actual = [step("b"), step("a")];
  const expected = [step("a"), step("b")];
  const r = matchTrajectory(actual, expected, "subset");
  assert.equal(r.matched, false);
});

test("缺失期望工具记 missing 且不匹配", () => {
  const actual = [step("search_filings")];
  const expected = [step("search_filings"), step("generate_report")];
  const r = matchTrajectory(actual, expected, "strict");
  assert.equal(r.matched, false);
  assert.deepEqual(r.missing, ["generate_report"]);
});

test("参数级校验：期望项 args 键集缺失记入 paramMismatches", () => {
  // 期望 search_filings 必须携带 query 与 topK 两个参数键。
  const actual = [step("search_filings", { query: "x" })];
  const expected = [step("search_filings", { query: "x", topK: 5 })];
  const r = matchTrajectory(actual, expected, "subset");
  assert.equal(r.matched, false);
  assert.deepEqual(r.paramMismatches, [{ tool: "search_filings", missingArgs: ["topK"] }]);
});

test("参数齐备则 matched", () => {
  const actual = [step("search_filings", { query: "x", topK: 5 })];
  const expected = [step("search_filings", { query: "x", topK: 5 })];
  const r = matchTrajectory(actual, expected, "subset");
  assert.equal(r.matched, true);
  assert.deepEqual(r.paramMismatches, []);
});

test("期望项无 args 时不触发参数校验", () => {
  const actual = [step("search_filings", {})];
  const expected = [step("search_filings")];
  const r = matchTrajectory(actual, expected, "subset");
  assert.equal(r.matched, true);
});
