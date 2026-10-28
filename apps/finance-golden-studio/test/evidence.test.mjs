/**
 * Finance Golden Studio PDF 证据投影契约测试。
 *
 * 覆盖真实解析块到证据块的投影、页码汇总、元数据保真、路径边界、
 * 缺失文件与解析失败的结构化错误。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPdfEvidence } from "../src/core/evidence.ts";

/** 本文件创建的临时目录，统一在 after 钩子里清理。 */
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 创建最小合法 PDF，内容由真实 pdf-parse worker 解析。
 *
 * @param {string} pageOneText 第一页正文。
 * @param {string} pageTwoText 第二页正文。
 * @returns {Buffer} PDF 字节。
 */
function buildMinimalPdf(pageOneText, pageTwoText) {
  const header = Buffer.from("%PDF-1.4\n", "latin1");
  const content1 = `BT /F1 12 Tf 72 720 Td (${pageOneText}) Tj ET`;
  const content2 = `BT /F1 12 Tf 72 720 Td (${pageTwoText}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content1, "latin1")} >>\nstream\n${content1}\nendstream`,
    `<< /Length ${Buffer.byteLength(content2, "latin1")} >>\nstream\n${content2}\nendstream`
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
  pdf = Buffer.concat([
    pdf,
    Buffer.from(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`,
      "latin1"
    )
  ]);
  return pdf;
}

/**
 * 创建带 corpus 根的隔离工作区配置。
 *
 * @returns {{workspaceRoot: string, corpusRoot: string}} 测试目录。
 */
function makeWorkspace() {
  const workspaceRoot = makeTempDir();
  const corpusRoot = makeTempDir();
  return { workspaceRoot, corpusRoot };
}

/**
 * 创建真实临时目录。
 *
 * @returns {string} 临时目录绝对路径。
 */
function makeTempDir() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "finance-golden-evidence-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * 创建完整 WorkspaceConfig，测试只关心 corpusRoot。
 *
 * @param {{workspaceRoot: string, corpusRoot: string}} roots 测试根目录。
 * @returns {object} WorkspaceConfig。
 */
function makeConfig({ workspaceRoot, corpusRoot }) {
  return {
    repoRoot: workspaceRoot,
    workspaceRoot,
    corpusRoot,
    manifestPath: join(corpusRoot, "manifest", "manifest.jsonl"),
    draftRoot: join(workspaceRoot, "datasets", "finance", "rag-golden", "_drafts"),
    goldenPath: join(workspaceRoot, "datasets", "finance", "rag-golden", "golden.jsonl"),
    generatedPath: join(workspaceRoot, "datasets", "finance", "rag-golden-v1.json"),
    backupRoot: join(workspaceRoot, "datasets", "finance", "rag-golden", "_backups")
  };
}

test("readPdfEvidence 投影真实 PDF 的页码、行号、文本与完整元数据", async () => {
  const roots = makeWorkspace();
  const filePath = "688599.SH/q1/2026Q1.pdf";
  const absolutePath = join(roots.corpusRoot, filePath);
  mkdirSync(join(roots.corpusRoot, "688599.SH", "q1"), { recursive: true });
  writeFileSync(absolutePath, buildMinimalPdf("Revenue 15874924916.38", "Annual Report 2026"));

  const evidence = await readPdfEvidence(makeConfig(roots), filePath);

  assert.equal(evidence.filePath, filePath);
  assert.deepEqual(evidence.pages, [1, 2]);
  assert.deepEqual(
    evidence.blocks.map(({ pageNumber, text, metadata }) => ({ pageNumber, text, metadata })),
    [
      { pageNumber: 1, text: "Revenue 15874924916.38", metadata: {} },
      { pageNumber: 2, text: "Annual Report 2026", metadata: {} }
    ]
  );
  assert.deepEqual(
    evidence.blocks.map(({ lineStart, lineEnd }) => ({ lineStart, lineEnd })),
    [
      { lineStart: 1, lineEnd: 1 },
      { lineStart: 1, lineEnd: 1 }
    ]
  );
});

test("readPdfEvidence 保留真实 PDF 的表格行与列数元数据", async () => {
  const roots = makeWorkspace();
  const filePath = "600111.SH/annual/2025.pdf";
  mkdirSync(join(roots.corpusRoot, "600111.SH", "annual"), { recursive: true });
  writeFileSync(
    join(roots.corpusRoot, filePath),
    buildMinimalPdf("Board secretary     Zhang Lirong", "Revenue   1000   2000")
  );

  const evidence = await readPdfEvidence(makeConfig(roots), filePath);
  const tableBlock = evidence.blocks.find((block) => block.metadata.isTableRow === true);

  assert.ok(tableBlock, "应保留表格行元数据");
  assert.equal(tableBlock.metadata.tableColumnCount, 2);
  assert.equal(tableBlock.pageNumber, 1);
});

test("readPdfEvidence 拒绝 corpus 根之外的相对路径与软链逃逸", async () => {
  const roots = makeWorkspace();
  const outside = makeTempDir();
  writeFileSync(join(outside, "outside.pdf"), buildMinimalPdf("Outside", "Document"));
  mkdirSync(join(roots.corpusRoot, "nested"), { recursive: true });
  symlinkSync(join(outside, "outside.pdf"), join(roots.corpusRoot, "nested", "link.pdf"));
  const config = makeConfig(roots);

  await assert.rejects(
    () => readPdfEvidence(config, "../outside.pdf"),
    (error) => {
      assert.equal(error.code, "path_outside_root");
      return true;
    }
  );
  await assert.rejects(
    () => readPdfEvidence(config, "nested/link.pdf"),
    (error) => {
      assert.equal(error.code, "path_outside_root");
      return true;
    }
  );
});

test("readPdfEvidence 拒绝绝对路径而不把它当成 corpus 相对地址", async () => {
  const roots = makeWorkspace();
  const outside = makeTempDir();
  const absolutePath = join(outside, "outside.pdf");
  writeFileSync(absolutePath, buildMinimalPdf("Outside", "Document"));

  await assert.rejects(
    () => readPdfEvidence(makeConfig(roots), absolutePath),
    (error) => {
      assert.equal(error.code, "evidence_not_found");
      return true;
    }
  );
});

test("readPdfEvidence 对缺失文件返回结构化 evidence_not_found", async () => {
  const roots = makeWorkspace();

  await assert.rejects(
    () => readPdfEvidence(makeConfig(roots), "600519.SH/annual/2025.pdf"),
    (error) => {
      assert.equal(error.code, "evidence_not_found");
      assert.equal(error.details.filePath, "600519.SH/annual/2025.pdf");
      return true;
    }
  );
});

test("readPdfEvidence 对无法解析的 PDF 返回结构化 evidence_parse_failed", async () => {
  const roots = makeWorkspace();
  const filePath = "broken/report.pdf";
  mkdirSync(join(roots.corpusRoot, "broken"), { recursive: true });
  writeFileSync(join(roots.corpusRoot, filePath), "%PDF-1.4\nnot a valid pdf");

  await assert.rejects(
    () => readPdfEvidence(makeConfig(roots), filePath),
    (error) => {
      assert.equal(error.code, "evidence_parse_failed");
      assert.match(error.message, /broken\/report\.pdf/);
      return true;
    }
  );
});
