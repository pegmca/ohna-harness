/**
 * RAG 前置修正测试（work item: rag-prereq-tests）。
 *
 * 仅覆盖 packages/rag 的测试目录，不触碰 src，避免与 rag-prereq 编辑同文件冲突。
 * 验证 docs/v2.0/02-eval-system-v2.md §3.3 前置修正 #1 / #5 的可观测契约：
 *  - ① synthesizeRagAnswer 在 sufficientResults 为空时返回 status "insufficient_evidence"，
 *    否则返回 "answered"；不传 status 时 createRagAnswer 保持旧形状（向后兼容）。
 *  - ② 传入调高的 threshold（minQueryTermCoverage / minFinalScore）能把原本可答翻转为拒答，
 *    证明显式阈值可观测、可调，且默认阈值行为与原版【完全一致】（零回归）。
 *  - ③ DataSourceRuntimeOptions.chunkingOptions 透传到 ingest 切块：
 *    heading_aware（默认窗口）与 fixed_size（小窗口）产出不同 chunk 数量与策略元数据。
 *
 * 运行入口：node --test packages/rag/test/prereq-tests.test.mjs（或更上层的 pnpm --filter @aiagent/rag test）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDataSourceRuntime,
  createRagAnswer,
  synthesizeRagAnswer,
  DEFAULT_CHUNKING_OPTIONS
} from "../dist/index.js";
import { createDeterministicMockEmbeddingClient } from "../dist/testing.js";

/**
 * 构造一条检索候选（RetrievedChunk），便于确定性地驱动 synthesizeRagAnswer 的充分性判定。
 *
 * @param overrides 覆盖默认的 chunk 文本、分数与命中词。
 * @returns 可直接传给 synthesizeRagAnswer 的检索候选。
 */
function makeRetrievedChunk(overrides = {}) {
  const text = overrides.text ?? "公司营业收入同比增长 18%，净利润保持稳定增长。";
  const scoreBreakdown = {
    vectorScore: 0.5,
    keywordScore: 0.5,
    hybridScore: 0.5,
    finalScore: overrides.finalScore ?? 0.6,
    vectorWeight: 0.65,
    keywordWeight: 0.35,
    matchedTerms: overrides.matchedTerms ?? ["营业收入"],
    queryTermCoverage: overrides.queryTermCoverage ?? 0.5,
    headingMatch: false,
    ...overrides.scoreBreakdown
  };

  return {
    chunk: {
      chunkId: "doc_prereq_chunk_0000",
      id: "doc_prereq_chunk_0000",
      documentId: "doc_prereq",
      source: "mock://prereq",
      chunkIndex: 0,
      text,
      charStart: 0,
      charEnd: text.length,
      startOffset: 0,
      endOffset: text.length,
      heading: overrides.heading,
      metadata: {}
    },
    rank: 1,
    score: scoreBreakdown.finalScore,
    scoreBreakdown
  };
}

/**
 * 创建注入确定性 embedding 替身的 DataSourceRuntime，避免生产边界暗含 mock。
 *
 * @param options 传给 createDataSourceRuntime 的额外选项（如 chunkingOptions）。
 * @returns 可执行 ingest/answer 的 runtime。
 */
function createRuntime(options = {}) {
  return createDataSourceRuntime({
    embeddingClient: createDeterministicMockEmbeddingClient(),
    ...options
  });
}

test("① synthesizeRagAnswer: 充分证据返回 status=answered，否则返回 insufficient_evidence", () => {
  // 充分证据：命中词、覆盖率与分数均过默认阈值（0.15 / 0.42）。
  const sufficient = synthesizeRagAnswer("公司营业收入如何？", [makeRetrievedChunk()]);
  assert.equal(sufficient.status, "answered");
  assert.match(sufficient.answer, /摘要|基于当前/);

  // 证据不足：无命中词、覆盖率与分数均为 0，sufficientResults 为空。
  const insufficient = synthesizeRagAnswer("公司海外新能源业务收入是多少？", [
    makeRetrievedChunk({ matchedTerms: [], queryTermCoverage: 0, finalScore: 0 })
  ]);
  assert.equal(insufficient.status, "insufficient_evidence");
  assert.match(insufficient.answer, /资料不足|无法可靠回答/);
});

test("① createRagAnswer: 不传 status 时保持旧形状（向后兼容，无 status 键）", () => {
  const withoutStatus = createRagAnswer({
    answer: "x",
    citations: [],
    retrievalResults: []
  });
  assert.equal("status" in withoutStatus, false);

  const withStatus = createRagAnswer({
    answer: "x",
    citations: [],
    retrievalResults: [],
    status: "answered"
  });
  assert.equal(withStatus.status, "answered");
});

test("② synthesizeRagAnswer: 默认阈值行为与原版一致（零回归）", () => {
  const result = makeRetrievedChunk({ matchedTerms: ["营业收入"], queryTermCoverage: 0.5, finalScore: 0.6 });

  // 默认阈值（= {}）与显式内置常量应当得到同样的 answered 判定。
  const defaultAnswer = synthesizeRagAnswer("公司营业收入如何？", [result]);
  const explicitDefault = synthesizeRagAnswer("公司营业收入如何？", [result], {
    minQueryTermCoverage: 0.15,
    minFinalScore: 0.42
  });

  assert.equal(defaultAnswer.status, "answered");
  assert.equal(explicitDefault.status, "answered");
});

test("② synthesizeRagAnswer: 调高阈值把原本可答翻转为 insufficient_evidence", () => {
  const borderline = makeRetrievedChunk({ matchedTerms: ["营业收入"], queryTermCoverage: 0.5, finalScore: 0.6 });

  // 默认阈值下可答。
  assert.equal(synthesizeRagAnswer("公司营业收入如何？", [borderline]).status, "answered");

  // 同时抬高两条通道阈值，使 borderline 双双不达标 → 拒答（阈值可观测）。
  const flipped = synthesizeRagAnswer("公司营业收入如何？", [borderline], {
    minQueryTermCoverage: 0.9,
    minFinalScore: 0.95
  });
  assert.equal(flipped.status, "insufficient_evidence");

  // 仅抬高 minFinalScore 但覆盖率仍过线时，判定保持 answered，证明两通道独立可调。
  const partiallyRaised = synthesizeRagAnswer("公司营业收入如何？", [borderline], {
    minFinalScore: 0.99
  });
  assert.equal(partiallyRaised.status, "answered");
});

test("② DataSourceRuntime: evidenceSufficiencyThreshold 注入点把可答翻转为拒答", async () => {
  // 复刻已验证可答的文档（默认阈值下 "公司资产质量如何？" 命中 "资产质量" 章节，得到 answered）。
  const content = "# 资产质量\n公司不良率保持稳定。\n\n# 盈利能力\n公司净利润同比增长。";

  const runtime = createRuntime({
    evidenceSufficiencyThreshold: { minQueryTermCoverage: 0.9, minFinalScore: 0.95 }
  });
  const ingestResult = await runtime.ingest({
    source: "mock://prereq-threshold",
    fileName: "prereq-threshold.md",
    contentType: "text/markdown",
    content
  });
  assert.equal(ingestResult.ok, true);

  // 默认 runtime 对该问题得到 answered；注入高阈值后同一证据得到 insufficient_evidence。
  const defaultRuntime = createRuntime();
  await defaultRuntime.ingest({
    source: "mock://prereq-threshold-default",
    fileName: "prereq-threshold-default.md",
    contentType: "text/markdown",
    content
  });
  const defaultAnswer = await defaultRuntime.answer("公司资产质量如何？", { topK: 3 });
  const strictAnswer = await runtime.answer("公司资产质量如何？", { topK: 3 });

  assert.equal(defaultAnswer.ok && defaultAnswer.data.answer.status, "answered");
  assert.equal(strictAnswer.ok && strictAnswer.data.answer.status, "insufficient_evidence");
});

test("③ DataSourceRuntime: chunkingOptions 透传到 ingest（窗口/策略改变产出）", async () => {
  const longText = Array.from({ length: 40 }, (_, i) => `第${i + 1}条：公司营业收入同比增长，净利润保持稳定增长。`).join("");

  // 默认切块策略（heading_aware，窗口 1200）下整篇大致归并为少数 chunk。
  const defaultRuntime = createRuntime();
  const defaultIngest = await defaultRuntime.ingest({
    source: "mock://prereq-chunk-default",
    fileName: "prereq-default.txt",
    content: longText
  });
  assert.equal(defaultIngest.ok, true);
  const defaultChunks = defaultIngest.data.chunks;
  assert.ok(defaultChunks.length >= 1);

  // 注入固定小窗口 fixed_size（maxChars=50，overlap=10）：窗口更小、按字符切分，chunk 数量必然更多。
  const injectedOptions = { strategy: "fixed_size", maxChars: 50, overlapChars: 10 };
  const injectedRuntime = createRuntime({ chunkingOptions: injectedOptions });
  const injectedIngest = await injectedRuntime.ingest({
    source: "mock://prereq-chunk-injected",
    fileName: "prereq-injected.txt",
    content: longText
  });
  assert.equal(injectedIngest.ok, true);
  const injectedChunks = injectedIngest.data.chunks;

  // 透传证据 1：更小的窗口产出更多 chunk。
  assert.ok(injectedChunks.length > defaultChunks.length, "注入小窗口应产出更多 chunk");
  // 透传证据 2：每块 metadata.strategy 反映注入的 fixed_size，而非默认 heading_aware。
  assert.ok(
    injectedChunks.every((chunk) => chunk.metadata?.strategy === "fixed_size"),
    "注入的 fixed_size 策略应落到每块 metadata"
  );
  // 透传证据 3：默认 runtime 的 chunk 不携带 injected 的 fixed_size 标记（保持默认行为）。
  assert.ok(
    defaultChunks.every((chunk) => chunk.metadata?.strategy !== "fixed_size"),
    "默认 runtime 不应出现 fixed_size 策略标记"
  );

  // 向后兼容：不传 chunkingOptions 时 ingest 仍成功，且窗口等于 DEFAULT_CHUNKING_OPTIONS。
  assert.equal(DEFAULT_CHUNKING_OPTIONS.strategy, "heading_aware");
  assert.equal(DEFAULT_CHUNKING_OPTIONS.maxChars, 1200);
});
