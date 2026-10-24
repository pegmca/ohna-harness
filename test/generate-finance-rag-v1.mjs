/**
 * 数据集权威生成器（v2.0 Step 3 · finance-eval-tests 工作项确立为**唯一**生成器）。
 *
 * ⚠️ provenance 唯一性声明：本文件是 `datasets/finance/rag-v1.json` 的**单一权威来源**。
 * 仓库内**不得**再保留会写 `expectedDocumentIds` 的旧 `test/migrate-finance-eval-dataset.mjs`，
 * 重跑它会按 source 列表回填 `expectedDocumentIds`，而真实 `citation.documentId` 是 ingest 时
 * 生成的 UUID，无法预知，会让 metrics.ts 的 documentId 优先匹配分支恒为 0，令
 * `retrievalHitRate`/`mrr`/`ndcg` 跌至 ~0、破坏 CI 门禁（见 reviewer 反馈）。若需调整数据集，
 * 一律改本脚本后重跑。
 *
 * 迁移映射（见 docs/v2.0/02-eval-system-v2.md 新旧 dataset 迁移要点，并结合 deterministic 档
 * 真实检索的可达成性做务实收敛）：
 * - 按 source **全局聚合** chunks 为一篇文档（content 拼接该 source 跨所有 case 的事实），
 *   使文档更丰富、确定性 embedding 检索更易命中、降低误拒（修 G1 真实链路有意义）。
 * - expectedSources = 原 expectedCitations（source 级命中，真实 citation.source 可见）。
 * - expectedDocumentIds **不设**：真实 citation.documentId 是 ingest 生成的 UUID，无法预知，
 *   设成 source 列表会让 metrics 的 documentId 匹配分支恒为 0（见 metrics.ts 优先 documentId 分支）。
 * - expectedKeywords = 原 expectedFacts 的 label 列表。
 * - goldEvidence = [原 fixture.answer, ...expectedFacts 文本化]。
 * - minCitations = 2（与 run 工作项 generate 脚本口径一致，非 1）：金融 RAG 的 citationCoverage
 *   语义要求答案至少引用 2 个独立证据片段才算「充分佐证」。deterministic 档每条 case 通常只 ingest
 *   单 source 单文档，真实 citation 数常为 1，设 2 能让 citationCountScore 比例（1/2=0.5）如实暴露
 *   「引用不足」信号，而非掩盖。由于 citationCoverage 当前不在门禁 SLO 中（termCoverage 主导、
 *   算法待 metrics 工作项修订），此取值不会误伤门禁，仅影响指标内部构成与失败归因。
 * - chat/report/failure 类 documents 留空数组（deterministic 档只跑 rag 类，留 Step 5）。
 * - 保持全部 case 迁移、id 不变。
 *
 * 输出在数据集根写入 `generatedBy` 字段，声明生成器与版本，使制品**自描述 provenance**，
 * 可被 loader（宽松忽略未知字段）跳过、也可被审计比对。
 *
 * 可复现：node test/generate-finance-rag-v1.mjs（幂等，每次基于源文件重生成，字节级一致）。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../datasets/eval-financial-v1.json");
const DST = resolve(HERE, "../datasets/finance/rag-v1.json");

const old = JSON.parse(readFileSync(SRC, "utf8"));

function factText(fact) {
  const parts = [fact.label];
  if (fact.value !== undefined) parts.push(String(fact.value));
  if (fact.unit) parts.push(fact.unit);
  if (fact.period) parts.push(fact.period);
  return parts.join(" ");
}

// 第一遍：按 source 全局聚合所有 case 的 retrievedChunks 为一篇文档。
const globalBySource = new Map();
for (const c of old.cases) {
  const fixture = c.fixture ?? {};
  const chunks = Array.isArray(fixture.retrievedChunks) ? fixture.retrievedChunks : [];
  for (const chunk of chunks) {
    const src = chunk.source ?? "unknown";
    const list = globalBySource.get(src) ?? [];
    list.push(chunk.text ?? "");
    globalBySource.set(src, list);
  }
}
const globalDocs = new Map();
for (const [source, texts] of globalBySource) {
  globalDocs.set(source, {
    source,
    fileName: `${source}.md`,
    content: texts.join("\n\n")
  });
}

function migrateCase(c) {
  const mode = c.mode;
  const fixture = c.fixture ?? {};
  const expectedSources = Array.isArray(c.expectedCitations) ? c.expectedCitations : [];

  // 每 case 的 documents = 其 expectedSources 对应的全局文档（rag 类才有）。
  const documents =
    mode === "rag"
      ? expectedSources
          .map((src) => globalDocs.get(src))
          .filter(Boolean)
          .map((doc) => ({ ...doc }))
      : [];

  const expectedKeywords = Array.isArray(c.expectedFacts) ? c.expectedFacts.map((f) => f.label) : [];
  const goldEvidence = [
    ...(fixture.answer ? [fixture.answer] : []),
    ...(Array.isArray(c.expectedFacts) ? c.expectedFacts.map(factText) : [])
  ];

  return {
    id: c.id,
    query: c.query,
    mode,
    documents,
    expectedSources,
    expectedKeywords,
    goldEvidence,
    minCitations: 2,
    tags: Array.isArray(c.tags) ? c.tags : []
  };
}

const migrated = old.cases.map(migrateCase);
const out = {
  schemaVersion: "2.0.0",
  datasetVersion: "finance-rag-v1.0.0",
  // 自描述 provenance：声明本数据集由哪个生成器、哪个版本产生，便于审计复现（loader 宽松忽略未知字段）。
  generatedBy: {
    generator: "test/generate-finance-rag-v1.mjs",
    version: "1.0.0",
    source: "datasets/eval-financial-v1.json",
    note: "唯一权威生成器；禁止改用会写 expectedDocumentIds 的旧 migrate 脚本，否则门禁指标跌至~0。"
  },
  seed: old.seed ?? 20260719,
  domain: "finance",
  minCases: 1,
  cases: migrated
};

mkdirSync(dirname(DST), { recursive: true });
writeFileSync(DST, JSON.stringify(out, null, 2), "utf8");
console.log(`migrated ${migrated.length} cases → ${DST}`);
const ragCount = migrated.filter((c) => c.mode === "rag").length;
console.log(`rag cases (deterministic 档执行): ${ragCount}`);
console.log(`全局 source 文档数: ${globalDocs.size} -> ${[...globalDocs.keys()].join(", ")}`);
