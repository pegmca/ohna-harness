/**
 * Finance Golden Studio 关键词可达性契约测试。
 *
 * 覆盖 PDF 空白差异、全角空白、表行/字符间距文本、重复命中、
 * 空关键词去重以及跨证据文档的命中索引。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findKeywordMatches,
  validateKeywordReachability
} from "../src/core/keywords.ts";

test("findKeywordMatches 去除 PDF 空白后保留原关键词并报告每次出现", () => {
  const matches = findKeywordMatches(
    "营业收入 12,384,638,268.11 元\n营业收入 12,384,638,268.11 元",
    ["营业收入12,384,638,268.11元"]
  );

  assert.deepEqual(matches, [
    {
      keyword: "营业收入12,384,638,268.11元",
      normalizedKeyword: "营业收入12,384,638,268.11元",
      occurrences: 2
    }
  ]);
});

test("findKeywordMatches 跨全角空白和字符间距命中真实表行", () => {
  const parsedText =
    "华 美 公 司　子 公 司\n213,252.00  462,419.73\n董事会秘书　张利荣";
  const matches = findKeywordMatches(parsedText, [
    "华美公司子公司",
    "213,252.00462,419.73",
    "董事会秘书张利荣"
  ]);

  assert.deepEqual(
    matches.map((match) => [match.keyword, match.occurrences]),
    [
      ["华美公司子公司", 1],
      ["213,252.00462,419.73", 1],
      ["董事会秘书张利荣", 1]
    ]
  );
});

test("findKeywordMatches 忽略空关键词且不去重内容相同的关键词", () => {
  const matches = findKeywordMatches("毛利率 18.24%", ["", "   ", "毛利率18.24%", "毛利率18.24%"]);

  assert.deepEqual(matches, [
    {
      keyword: "毛利率18.24%",
      normalizedKeyword: "毛利率18.24%",
      occurrences: 1
    },
    {
      keyword: "毛利率18.24%",
      normalizedKeyword: "毛利率18.24%",
      occurrences: 1
    }
  ]);
});

test("validateKeywordReachability 对每个关键词扫描全部证据并保留文档索引", () => {
  const evidence = [
    {
      filePath: "600111.SH/annual/2025.pdf",
      pages: [12],
      blocks: [
        {
          pageNumber: 12,
          lineStart: 8,
          lineEnd: 8,
          text: "华美公司  462,419.73",
          metadata: { isTableRow: true, tableColumnCount: 2 }
        }
      ]
    },
    {
      filePath: "600111.SH/annual/2024.pdf",
      pages: [9],
      blocks: [
        {
          pageNumber: 9,
          lineStart: 3,
          lineEnd: 3,
          text: "华美公司  411,947.55",
          metadata: { isTableRow: true, tableColumnCount: 2 }
        }
      ]
    }
  ];

  const result = validateKeywordReachability(evidence, [
    "华美公司",
    "462,419.73",
    "不存在关键词"
  ]);

  assert.deepEqual(result, {
    ok: false,
    keywordResults: [
      { keyword: "华美公司", reachable: true, evidenceIndexes: [0, 1] },
      { keyword: "462,419.73", reachable: true, evidenceIndexes: [0] },
      { keyword: "不存在关键词", reachable: false, evidenceIndexes: [] }
    ]
  });
});

test("validateKeywordReachability 在无关键词或全部可达时返回 ok", () => {
  const evidence = [
    {
      filePath: "601006.SH/annual/2025.pdf",
      pages: [4],
      blocks: [
        {
          pageNumber: 4,
          lineStart: 1,
          lineEnd: 2,
          text: "董事会秘书　张利荣\n电话 0351-2620620",
          metadata: { isTableRow: true, tableColumnCount: 2 }
        }
      ]
    }
  ];

  assert.deepEqual(validateKeywordReachability(evidence, []), {
    ok: true,
    keywordResults: []
  });
  assert.deepEqual(validateKeywordReachability(evidence, ["董事会秘书张利荣"]), {
    ok: true,
    keywordResults: [
      { keyword: "董事会秘书张利荣", reachable: true, evidenceIndexes: [0] }
    ]
  });
});

test("validateKeywordReachability 不把换行差异之外的内容归一掉", () => {
  const evidence = [
    {
      filePath: "601888.SH/interim/2026H1.pdf",
      pages: [1],
      blocks: [
        {
          pageNumber: 1,
          lineStart: 1,
          lineEnd: 1,
          text: "营业收入 27,655,202,065.43 元",
          metadata: {}
        }
      ]
    }
  ];

  assert.deepEqual(
    validateKeywordReachability(evidence, ["营业收入27,655,202,065.43"]).keywordResults,
    [
      {
        keyword: "营业收入27,655,202,065.43",
        reachable: true,
        evidenceIndexes: [0]
      }
    ]
  );
});
