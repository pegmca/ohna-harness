import assert from "node:assert/strict";
import test from "node:test";
import { canTransitionCitationVerifierStatus } from "../dist/index.js";

test("citation verifier 状态迁移：人工/自动终态不可被覆盖", () => {
  // unverified 可迁移到任意状态。
  for (const next of ["verified", "rejected", "manual_verified", "manual_rejected"]) {
    assert.equal(canTransitionCitationVerifierStatus("unverified", next), true);
  }
  // 自动终态只允许人工覆盖，不允许自动结果互改或回退。
  assert.equal(canTransitionCitationVerifierStatus("verified", "rejected"), false);
  assert.equal(canTransitionCitationVerifierStatus("rejected", "verified"), false);
  assert.equal(canTransitionCitationVerifierStatus("verified", "unverified"), false);
  assert.equal(canTransitionCitationVerifierStatus("verified", "manual_verified"), true);
  assert.equal(canTransitionCitationVerifierStatus("rejected", "manual_rejected"), true);
  // 人工终态不可被任何更新覆盖。
  for (const next of ["unverified", "verified", "rejected", "manual_verified", "manual_rejected"]) {
    assert.equal(canTransitionCitationVerifierStatus("manual_verified", next), next === "manual_verified");
    assert.equal(canTransitionCitationVerifierStatus("manual_rejected", next), next === "manual_rejected");
  }
});
