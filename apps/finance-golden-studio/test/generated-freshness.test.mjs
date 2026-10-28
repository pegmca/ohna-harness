import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyGeneratedFreshness } from "../src/core/generated-freshness.ts";

test("classifyGeneratedFreshness treats equal timestamps as fresh", () => {
  const time = { mtimeMs: 1_000, mtimeNs: 1_000_000_000n };
  assert.equal(classifyGeneratedFreshness(time, time), "fresh");
});

test("classifyGeneratedFreshness treats a newer generated artifact as fresh", () => {
  assert.equal(
    classifyGeneratedFreshness(
      { mtimeMs: 1_000, mtimeNs: 1_000_000_000n },
      { mtimeMs: 2_000, mtimeNs: 2_000_000_000n }
    ),
    "fresh"
  );
});

test("classifyGeneratedFreshness treats an older generated artifact as stale", () => {
  assert.equal(
    classifyGeneratedFreshness(
      { mtimeMs: 2_000, mtimeNs: 2_000_000_000n },
      { mtimeMs: 1_000, mtimeNs: 1_000_000_000n }
    ),
    "stale"
  );
});

test("classifyGeneratedFreshness reports a missing generated artifact", () => {
  assert.equal(
    classifyGeneratedFreshness(
      { mtimeMs: 1_000, mtimeNs: 1_000_000_000n },
      undefined
    ),
    "missing"
  );
});
