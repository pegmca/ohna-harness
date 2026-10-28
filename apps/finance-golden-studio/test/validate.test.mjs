/**
 * Finance Golden Studio 统一校验契约测试。
 *
 * 使用真实临时 JSONL、manifest 与最小 PDF 覆盖作者字段、manifest 精确引用、
 * section 完成度、关键词可达性、反例题、稀疏表格行和 golden 文件级诊断。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDraft, validateGolden } from "../src/core/validate.ts";

/** 本测试文件创建的临时目录，统一在 after 钩子中清理。 */
const tempDirs = [];
/** 仓库内真实作者集路径，用于读取已知 fin-009 稀疏行。 */
const GOLDEN_PATH = fileURLToPath(
  new URL("../../../datasets/finance/rag-golden/golden.jsonl", import.meta.url)
);
/** 默认来源 PDF 相对路径。 */
const DEFAULT_PDF_PATH = "raw/cn/000776.SZ/2025Q1.pdf";
/** 默认来源中可由最小 PDF 编码的英文关键词。 */
const DEFAULT_KEYWORD = "Revenue 184,679";

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateDraft 对完整草稿返回可达关键词结果", async () => {
  const { config } = makeWorkspace();
  writePdf(config, DEFAULT_PDF_PATH, `${DEFAULT_KEYWORD} in 2025Q1`);

  const report = await validateDraft(config, makeDraft());

  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.keywordResults, [
    {
      keyword: DEFAULT_KEYWORD,
      normalizedKeyword: "revenue184,679",
      reachable: true,
      evidenceIndexes: [0]
    }
  ]);
});

test("manifest 同时含精确三元组与重复三元组时仍拒绝歧义", async () => {
  const { config } = makeWorkspace({
    manifest: [
      manifestRecord("000776.SZ", "q1", "2025Q1", DEFAULT_PDF_PATH),
      manifestRecord("000776.SZ", "q1", "2025Q1", "raw/cn/other.pdf")
    ]
  });
  writePdf(config, DEFAULT_PDF_PATH, DEFAULT_KEYWORD);

  const report = await validateDraft(config, makeDraft());

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.errors.map((issue) => issue.code),
    ["manifest_triple_duplicate"]
  );
});

test("非负例题缺少 expected_keywords 时校验失败", async () => {
  const { config } = makeWorkspace();
  writePdf(config, DEFAULT_PDF_PATH, DEFAULT_KEYWORD);
  const { expected_keywords: ignored, ...withoutKeywords } = makeDraft();

  assert.equal(ignored === undefined, false);
  const report = await validateDraft(config, withoutKeywords);

  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some(
      (issue) =>
        issue.code === "expected_keywords_required" &&
        issue.field === "expected_keywords"
    )
  );
});

test("非负例题的空数组与空白关键词均不能通过", async () => {
  const { config } = makeWorkspace();
  writePdf(config, DEFAULT_PDF_PATH, DEFAULT_KEYWORD);

  const emptyReport = await validateDraft(config, {
    ...makeDraft(),
    expected_keywords: []
  });
  const blankReport = await validateDraft(config, {
    ...makeDraft(),
    expected_keywords: ["  "]
  });

  assert.ok(
    emptyReport.errors.some((issue) => issue.code === "expected_keywords_required")
  );
  assert.ok(
    blankReport.errors.some(
      (issue) =>
        issue.code === "expected_keyword_empty" &&
        issue.field === "expected_keywords[0]"
    )
  );
});

test("非负例题缺少 evidence 时不能通过", async () => {
  const { config } = makeWorkspace();

  const report = await validateDraft(config, {
    ...makeDraft(),
    evidence: []
  });

  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some(
      (issue) =>
        issue.code === "evidence_required" && issue.field === "evidence"
    ),
    JSON.stringify(report.errors)
  );
});

test("expected_keywords 含非字符串时返回字段级结构错误", async () => {
  const { config } = makeWorkspace();
  writePdf(config, DEFAULT_PDF_PATH, DEFAULT_KEYWORD);

  const report = await validateDraft(config, {
    ...makeDraft(),
    expected_keywords: [42]
  });

  assert.ok(
    report.errors.some(
      (issue) =>
        issue.code === "required_string_invalid" &&
        issue.field === "expected_keywords[0]"
    ),
    JSON.stringify(report.errors)
  );
});

test("evidence.section 含待补或候选标记时校验失败", async () => {
  const { config } = makeWorkspace();
  writePdf(config, DEFAULT_PDF_PATH, DEFAULT_KEYWORD);

  for (const section of ["（待补：股东信息）", "（候选：股东信息）"]) {
    const draft = makeDraft();
    draft.evidence[0].section = section;
    const report = await validateDraft(config, draft);

    assert.ok(
      report.errors.some(
        (issue) =>
          issue.code === "section_unresolved" &&
          issue.field === "evidence[0].section"
      ),
      section
    );
  }
});

test("evidence 必须精确命中 manifest 三元组而不回退同 ticker", async () => {
  const { config } = makeWorkspace();
  writePdf(config, DEFAULT_PDF_PATH, DEFAULT_KEYWORD);
  const draft = makeDraft();
  draft.evidence[0].period = "2025";

  const report = await validateDraft(config, draft);

  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some(
      (issue) =>
        issue.code === "evidence_not_in_manifest" &&
        issue.field === "evidence[0]"
    )
  );
  assert.deepEqual(report.keywordResults, []);
});

test("关键词不在来源 PDF 文本中时报告 unreachable", async () => {
  const { config } = makeWorkspace();
  writePdf(config, DEFAULT_PDF_PATH, "Annual report without that amount");

  const report = await validateDraft(config, {
    ...makeDraft(),
    expected_keywords: ["184,679"]
  });

  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some(
      (issue) =>
        issue.code === "keyword_unreachable" &&
        issue.field === "expected_keywords[0]"
    )
  );
  assert.deepEqual(report.keywordResults, [
    {
      keyword: "184,679",
      normalizedKeyword: "184,679",
      reachable: false,
      reason: "unreachable",
      evidenceIndexes: []
    }
  ]);
});

test("真实 fin-009 记录仅产生稀疏行 warning", async () => {
  const record = readGoldenRecord("fin-009");
  const { config } = makeWorkspace({
    manifest: [manifestRecord("600150.SH", "annual", "2025", "raw/cn/600150.SH/2025.pdf")]
  });
  writePdf(config, "raw/cn/600150.SH/2025.pdf", "Long-term receivables 1,277,081,658.18");

  const report = await validateDraft(config, {
    ...record,
    evidence: record.evidence.map((evidence) => ({
      ...evidence,
      section: "财务报表附注-长期应收款"
    })),
    expected_keywords: ["Long-term receivables"],
    _draft: {}
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(
    report.warnings.map(({ code, field }) => ({ code, field })),
    [{ code: "table_sparse_row", field: "gold_answer_table.rows[1]" }]
  );
});

test("表格列、行和单元格结构非法时返回字段级错误", async () => {
  const { config } = makeWorkspace();
  writePdf(config, DEFAULT_PDF_PATH, DEFAULT_KEYWORD);

  const report = await validateDraft(config, {
    ...makeDraft(),
    type: "table",
    answer_type: "table",
    gold_answer_table: {
      columns: [],
      rows: ["not-an-array"]
    }
  });

  assert.ok(
    report.errors.some(
      (issue) =>
        issue.code === "table_columns_required" &&
        issue.field === "gold_answer_table.columns"
    )
  );
  assert.ok(
    report.errors.some(
      (issue) =>
        issue.code === "table_row_not_array" &&
        issue.field === "gold_answer_table.rows[0]"
    )
  );
});

test("空 gold_answer 只报告一次字段错误", async () => {
  const { config } = makeWorkspace();
  writePdf(config, DEFAULT_PDF_PATH, DEFAULT_KEYWORD);

  const report = await validateDraft(config, {
    ...makeDraft(),
    type: "numeric_fact",
    gold_answer: ""
  });

  assert.equal(
    report.errors.filter(
      (issue) =>
        issue.code === "required_string_invalid" &&
        issue.field === "gold_answer"
    ).length,
    1,
    JSON.stringify(report.errors)
  );
});

test("合法 negative 不要求 expected_keywords，并要求 scoped ticker 缺席", async () => {
  const { config } = makeWorkspace();
  const draft = makeNegativeDraft();

  const validReport = await validateDraft(config, draft);
  assert.equal(validReport.ok, true);
  assert.deepEqual(validReport.keywordResults, []);

  const presentReport = await validateDraft(config, {
    ...draft,
    resolution: {
      ...draft.resolution,
      scope: "ticker=000776.SZ"
    }
  });
  assert.ok(
    presentReport.errors.some(
      (issue) => issue.code === "negative_ticker_present"
    )
  );
});

test("negative 带 evidence、类型不一致或缺少 ticker_absent resolution 时校验失败", async () => {
  const { config } = makeWorkspace();
  const draft = makeNegativeDraft();

  const evidenceReport = await validateDraft(config, {
    ...draft,
    evidence: makeDraft().evidence
  });
  const typeReport = await validateDraft(config, {
    ...draft,
    type: "numeric_fact"
  });
  const resolutionReport = await validateDraft(config, {
    ...draft,
    resolution: undefined
  });

  assert.ok(
    evidenceReport.errors.some(
      (issue) => issue.code === "negative_evidence_present"
    )
  );
  assert.ok(
    typeReport.errors.some(
      (issue) => issue.code === "negative_type_required" && issue.field === "type"
    )
  );
  assert.ok(
    resolutionReport.errors.some(
      (issue) =>
        issue.code === "negative_resolution_required" &&
        issue.field === "resolution"
    )
  );
});

test("validateGolden 读取无 _draft 的作者集并校验可达关键词", async () => {
  const { config } = makeWorkspace({
    golden: [{ ...withoutDraft(makeDraft()), id: "fin-001" }]
  });
  writePdf(config, DEFAULT_PDF_PATH, DEFAULT_KEYWORD);

  const report = await validateGolden(config);

  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.keywordResults.length, 1);
  assert.equal(report.keywordResults[0].reachable, true);
});

test("validateGolden 保留可解析行结果并将坏 JSON 行报告为错误", async () => {
  const { config } = makeWorkspace();
  writePdf(config, DEFAULT_PDF_PATH, DEFAULT_KEYWORD);
  writeFileSync(
    config.goldenPath,
    `${JSON.stringify({ ...withoutDraft(makeDraft()), id: "fin-001" })}\n{not-json}\n`,
    "utf8"
  );

  const report = await validateGolden(config);

  assert.equal(report.ok, false);
  assert.equal(report.warnings.length, 0);
  assert.equal(report.keywordResults[0].reachable, true);
  assert.ok(
    report.errors.some((issue) => issue.code === "golden_json_invalid" && issue.line === 2),
    JSON.stringify(report.errors)
  );
});

test("validateGolden 报告重复 ID 与缺少 expected_keywords", async () => {
  const { config } = makeWorkspace();
  writePdf(config, DEFAULT_PDF_PATH, DEFAULT_KEYWORD);
  const missingKeywords = withoutDraft(makeDraft());
  delete missingKeywords.expected_keywords;
  const validRecord = { ...withoutDraft(makeDraft()), id: "fin-001" };
  missingKeywords.id = "fin-002";
  const duplicateRecord = { ...validRecord };
  writeFileSync(
    config.goldenPath,
    `${JSON.stringify(validRecord)}\n${JSON.stringify(
      missingKeywords
    )}\n${JSON.stringify(duplicateRecord)}\n`,
    "utf8"
  );

  const report = await validateGolden(config);

  assert.ok(
    report.errors.some((issue) => issue.code === "golden_id_duplicate"),
    JSON.stringify(report.errors)
  );
  assert.ok(
    report.errors.some((issue) => issue.code === "expected_keywords_required"),
    JSON.stringify(report.errors)
  );
});

test("manifest 坏行不会被静默跳过，且不会继续制造 evidence 缺失噪声", async () => {
  const { config } = makeWorkspace();
  writeFileSync(
    config.manifestPath,
    `${JSON.stringify(
      manifestRecord("000776.SZ", "q1", "2025Q1", DEFAULT_PDF_PATH)
    )}\n{broken\n`,
    "utf8"
  );
  writePdf(config, DEFAULT_PDF_PATH, DEFAULT_KEYWORD);

  const report = await validateDraft(config, makeDraft());

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.errors.map((issue) => issue.code),
    ["manifest_json_invalid"]
  );
});

test("manifest 记录字段不完整或三元组重复时 fail-closed", async () => {
  const incomplete = makeWorkspace();
  writeFileSync(incomplete.config.manifestPath, '{"ticker":"000776.SZ"}\n', "utf8");
  const incompleteReport = await validateDraft(incomplete.config, makeDraft());
  assert.deepEqual(
    incompleteReport.errors.map((issue) => issue.code),
    ["manifest_record_invalid"]
  );

  const duplicate = makeWorkspace({
    manifest: [
      manifestRecord("000776.SZ", "q1", "2025Q1", DEFAULT_PDF_PATH),
      manifestRecord("000776.SZ", "q1", "2025Q1", "raw/cn/other.pdf")
    ]
  });
  const duplicateReport = await validateDraft(duplicate.config, makeDraft());
  assert.deepEqual(
    duplicateReport.errors.map((issue) => issue.code),
    ["manifest_triple_duplicate"]
  );
});

test("validateGolden 对空作者集报告错误", async () => {
  const { config } = makeWorkspace();

  const report = await validateGolden(config);

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.errors.map((issue) => issue.code),
    ["golden_line_count_invalid"]
  );
});

test("manifest 命中但 PDF 缺失时返回结构化校验错误而不是抛异常", async () => {
  const { config } = makeWorkspace();

  const report = await validateDraft(config, makeDraft());

  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some(
      (issue) =>
        issue.code === "evidence_not_found" && issue.field === "evidence[0]"
    )
  );
  assert.deepEqual(report.keywordResults, []);
});

test("validateGolden 对缺失 PDF 报逐行结构化错误且不伪造不可达关键词", async () => {
  const { config } = makeWorkspace();
  const record = { ...withoutDraft(makeDraft()), id: "fin-001" };
  writeJsonLines(config.goldenPath, [record]);

  const report = await validateGolden(config);

  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some(
      (issue) =>
        issue.code === "evidence_not_found" &&
        issue.field === "evidence[0]" &&
        issue.line === 1 &&
        issue.id === "fin-001"
    ),
    JSON.stringify(report.errors)
  );
  assert.deepEqual(report.keywordResults, []);
});

test("validateGolden 在单行证据结构损坏时不读取来源 PDF", async () => {
  const { config } = makeWorkspace();
  const record = {
    ...withoutDraft(makeDraft()),
    id: "fin-001",
    evidence: [{ ticker: "000776.SZ", report_type: "q1" }]
  };
  writeJsonLines(config.goldenPath, [record]);

  const report = await validateGolden(config);

  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some(
      (issue) =>
        issue.code === "required_string_invalid" &&
        issue.field === "evidence[0].period"
    ),
    JSON.stringify(report.errors)
  );
  assert.deepEqual(report.keywordResults, []);
});

test("validateGolden 对非法 keyword 类型不伪造不可达结果", async () => {
  const { config } = makeWorkspace();
  writePdf(config, DEFAULT_PDF_PATH, DEFAULT_KEYWORD);
  writeJsonLines(config.goldenPath, [
    {
      ...withoutDraft(makeDraft()),
      id: "fin-001",
      expected_keywords: [42]
    }
  ]);

  const report = await validateGolden(config);

  assert.ok(
    report.errors.some(
      (issue) =>
        issue.code === "required_string_invalid" &&
        issue.field === "expected_keywords[0]"
    ),
    JSON.stringify(report.errors)
  );
  assert.deepEqual(report.keywordResults, []);
});

test("validateGolden 对无法解析的 PDF 保留 evidence_parse_failed", async () => {
  const { config } = makeWorkspace();
  const absolutePath = join(config.corpusRoot, DEFAULT_PDF_PATH);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, "%PDF-1.4\nnot a valid pdf", "utf8");
  writeJsonLines(config.goldenPath, [
    { ...withoutDraft(makeDraft()), id: "fin-001" }
  ]);

  const report = await validateGolden(config);

  assert.ok(
    report.errors.some(
      (issue) =>
        issue.code === "evidence_parse_failed" &&
        issue.field === "evidence[0]" &&
        issue.line === 1
    ),
    JSON.stringify(report.errors)
  );
  assert.deepEqual(report.keywordResults, []);
});

/**
 * 创建隔离工作区，并写入测试 manifest 与可选的 golden 文件。
 *
 * @param {{manifest?: object[], golden?: object[]}} input 初始数据。
 * @returns {{workspaceRoot: string, corpusRoot: string, config: object}} 测试配置。
 */
function makeWorkspace(input = {}) {
  const workspaceRoot = makeTempDir("workspace");
  const corpusRoot = makeTempDir("corpus");
  const goldenRoot = join(workspaceRoot, "datasets", "finance", "rag-golden");
  mkdirSync(join(corpusRoot, "manifest"), { recursive: true });
  mkdirSync(goldenRoot, { recursive: true });

  const config = {
    repoRoot: workspaceRoot,
    workspaceRoot,
    corpusRoot,
    manifestPath: join(corpusRoot, "manifest", "manifest.jsonl"),
    draftRoot: join(goldenRoot, "_drafts"),
    goldenPath: join(goldenRoot, "golden.jsonl"),
    generatedPath: join(workspaceRoot, "datasets", "finance", "rag-golden-v1.json"),
    backupRoot: join(goldenRoot, "_backups")
  };
  const manifest =
    input.manifest ??
    [manifestRecord("000776.SZ", "q1", "2025Q1", DEFAULT_PDF_PATH)];
  writeJsonLines(config.manifestPath, manifest);
  writeJsonLines(config.goldenPath, input.golden ?? []);
  return { workspaceRoot, corpusRoot, config };
}

/**
 * 创建 realpath 规范化后的临时目录。
 *
 * @param {string} label 目录标签。
 * @returns {string} 临时目录绝对路径。
 */
function makeTempDir(label) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), `finance-golden-validate-${label}-`));
  tempDirs.push(dir);
  return dir;
}

/**
 * 写入 JSONL 测试数据。
 *
 * @param {string} path 目标文件。
 * @param {object[]} records 记录列表。
 */
function writeJsonLines(path, records) {
  writeFileSync(
    path,
    records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "",
    "utf8"
  );
}

/**
 * 构造 manifest 记录。
 *
 * @param {string} ticker 证券代码。
 * @param {string} reportType 报告类型。
 * @param {string} period 报告期。
 * @param {string} filePath 语料相对路径。
 * @returns {object} manifest 行。
 */
function manifestRecord(ticker, reportType, period, filePath) {
  return {
    ticker,
    report_type: reportType,
    period,
    file_path: filePath,
    disclosure_date: "2025-04-30"
  };
}

/**
 * 构造默认完整非负例草稿。
 *
 * @returns {object} 草稿。
 */
function makeDraft() {
  return {
    id: "fin-D001",
    query: "广发证券 2025Q1 股东人数是多少？",
    type: "numeric_fact",
    difficulty: "easy",
    answer_type: "number",
    gold_answer: "合计 184,679 户",
    answer_unit: "户",
    evidence: [
      {
        ticker: "000776.SZ",
        report_type: "q1",
        period: "2025Q1",
        section: "股东信息",
        page: 12,
        quote: "Revenue 184,679",
        source_kind: "table"
      }
    ],
    requires_multi_doc: false,
    distractors: [],
    is_negative: false,
    note: "测试草稿",
    expected_keywords: [DEFAULT_KEYWORD],
    _draft: {}
  };
}

/**
 * 构造默认合法反例草稿。
 *
 * @returns {object} 反例草稿。
 */
function makeNegativeDraft() {
  return {
    ...makeDraft(),
    id: "fin-D012",
    type: "negative",
    answer_type: "text",
    gold_answer: "语料中无此公司",
    evidence: [],
    is_negative: true,
    expected_keywords: undefined,
    resolution: {
      type: "ticker_absent",
      scope: "ticker=002340.SZ",
      expected_report: "（无）",
      note: "manifest 中无该公司"
    }
  };
}

/**
 * 去掉草稿本地状态，模拟作者集记录。
 *
 * @param {object} draft 草稿。
 * @returns {object} 作者集记录。
 */
function withoutDraft(draft) {
  const { _draft: ignored, ...record } = draft;
  assert.equal(ignored !== undefined || _draftWasAbsent(draft), true);
  return record;
}

/**
 * 判断输入是否本来就没有 _draft 字段。
 *
 * @param {object} draft 输入对象。
 * @returns {boolean} 无该字段时为 true。
 */
function _draftWasAbsent(draft) {
  return !Object.hasOwn(draft, "_draft");
}

/**
 * 从真实 golden.jsonl 读取指定记录。
 *
 * @param {string} id case ID。
 * @returns {object} golden 记录。
 */
function readGoldenRecord(id) {
  const record = readFileSync(GOLDEN_PATH, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .find((candidate) => candidate.id === id);
  assert.ok(record, `未找到 ${id}`);
  return record;
}

/**
 * 在隔离语料根内写入可由真实解析器读取的单页 PDF。
 *
 * @param {object} config 工作区配置。
 * @param {string} relativePath 语料相对路径。
 * @param {string} text PDF 文本。
 */
function writePdf(config, relativePath, text) {
  const absolutePath = join(config.corpusRoot, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, buildMinimalPdf(text), "latin1");
}

/**
 * 构造最小单页 PDF。
 *
 * @param {string} text 页面文本。
 * @returns {Buffer} PDF 字节。
 */
function buildMinimalPdf(text) {
  const header = Buffer.from("%PDF-1.4\n", "latin1");
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];

  let pdf = Buffer.from(header);
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf = Buffer.concat([pdf, Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1")]);
  });

  const xrefStart = pdf.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  }
  pdf = Buffer.concat([pdf, Buffer.from(xref, "latin1")]);
  return Buffer.concat([
    pdf,
    Buffer.from(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`,
      "latin1"
    )
  ]);
}
