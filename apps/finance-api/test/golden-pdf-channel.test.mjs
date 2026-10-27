import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeterministicFinanceRagRuntime } from "../dist/eval/adapter.js";
import { loadFinanceDataset } from "../dist/eval/dataset.js";

/**
 * 构造带三列表行的最小 PDF。
 *
 * @returns {Uint8Array} PDF 字节。
 */
function buildTablePdf() {
  const pageContent = [
    "BT /F1 12 Tf 72 720 Td (Company   Capital   Revenue) Tj ET",
    "BT /F1 12 Tf 72 700 Td (Huamei   213,252.00   411,947.55) Tj ET",
    "BT /F1 12 Tf 72 680 Td (North Magnet   179,994.71   944,806.24) Tj ET"
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(pageContent, "latin1") + 1} >>\nstream\n${pageContent}\nendstream`
  ];
  let buffer = Buffer.from("%PDF-1.4\n", "latin1");
  const offsets = objects.map((body, index) => {
    const offset = buffer.length;
    buffer = Buffer.concat([buffer, Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1")]);
    return offset;
  });
  const xrefStart = buffer.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  buffer = Buffer.concat([buffer, Buffer.from(xref, "latin1")]);
  buffer = Buffer.concat([
    buffer,
    Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`, "latin1")
  ]);
  return new Uint8Array(buffer);
}

test("golden loader decodes byte documents while preserving text documents", () => {
  const dir = mkdtempSync(join(tmpdir(), "golden-pdf-channel-"));
  const path = join(dir, "dataset.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: "2.0.0",
      datasetVersion: "test",
      minCases: 1,
      cases: [
        {
          id: "fin-pdf",
          query: "table",
          mode: "rag",
          documents: [
            {
              source: "pdf-source",
              fileName: "annual.pdf",
              content: {
                contentEncoding: "base64",
                contentBase64: Buffer.from(buildTablePdf()).toString("base64")
              }
            },
            { source: "text-source", fileName: "annual.md", content: "# heading\nbody" }
          ]
        }
      ]
    })
  );

  try {
    const dataset = loadFinanceDataset(path);
    assert.ok(dataset.cases[0].documents[0].content instanceof Uint8Array);
    assert.equal(dataset.cases[0].documents[1].content, "# heading\nbody");
    assert.deepEqual(
      dataset.cases[0].documents[0].content.subarray(0, 5),
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("golden deterministic runtime ingests PDF bytes and exposes table chunks", async () => {
  const runtime = await createDeterministicFinanceRagRuntime([
    { source: "pdf-source", fileName: "annual.pdf", content: buildTablePdf() }
  ]);
  const chunks = await runtime.listChunks();

  assert.ok(chunks.chunks.some((chunk) => chunk.metadata.isTableChunk === true));
  assert.ok(chunks.chunks.some((chunk) => chunk.metadata.isTableSummary === true));
  assert.ok(
    chunks.chunks
      .filter((chunk) => chunk.metadata.isTableChunk === true)
      .every((chunk) => typeof chunk.metadata.tableGroupId === "string")
  );
});
