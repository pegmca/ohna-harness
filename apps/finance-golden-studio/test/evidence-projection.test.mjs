/**
 * PDF block 到证据文档的纯投影测试。
 *
 * 用真实解析器产生的 block 形状固定纯函数边界，避免读取文件的行为与投影规则耦合。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPdfBlocks } from "@aiagent/parsing";
import { projectPdfEvidence } from "../src/core/evidence.ts";

test("projectPdfEvidence 生成有序页码并逐项复制 block 元数据", () => {
  const pages = [2, 1, 2, 3];
  const blocks = [
    {
      text: "华美公司　子公司",
      lineStart: 3,
      lineEnd: 4,
      pageNumber: pages[0],
      metadata: { isTableRow: true, tableColumnCount: 2 }
    },
    {
      text: "213,252.00  462,419.73",
      lineStart: 1,
      lineEnd: 1,
      pageNumber: pages[1],
      metadata: { sourceLayer: "char_spaced", empty: null }
    },
    {
      text: "董事会秘书　张利荣",
      lineStart: 8,
      lineEnd: 8,
      pageNumber: pages[2],
      metadata: { isTableRow: true, tableColumnCount: 2 }
    },
    {
      text: "华美公司　子公司",
      lineStart: 5,
      lineEnd: 5,
      pageNumber: pages[3],
      metadata: { sourceLayer: "char_spaced" }
    }
  ];

  assert.deepEqual(projectPdfEvidence("report.pdf", blocks), {
    filePath: "report.pdf",
    pages: [1, 2, 3],
    blocks
  });
  assert.notEqual(projectPdfEvidence("report.pdf", blocks).blocks[0], blocks[0]);
  assert.notEqual(projectPdfEvidence("report.pdf", blocks).blocks[0].metadata, blocks[0].metadata);
});

test("projectPdfEvidence 保留真实解析 block 的 char-spaced sourceLayer", () => {
  const parsedBlocks = buildPdfBlocks([
    {
      text: "华 美 公 司　子 公 司\n213,252.00  462,419.73",
      sourceLayer: "char_spaced"
    }
  ]);

  const evidence = projectPdfEvidence("char-spaced.pdf", parsedBlocks);
  const tableBlock = evidence.blocks.find((block) => block.metadata.isTableRow === true);

  assert.ok(tableBlock, "应投影解析器生成的字符间距表格行");
  assert.equal(tableBlock.metadata.sourceLayer, "char_spaced");
  assert.equal(tableBlock.metadata.tableColumnCount, 2);
  assert.ok(evidence.blocks.every((block) => block.metadata.sourceLayer === "char_spaced"));
});
