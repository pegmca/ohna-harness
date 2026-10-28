import { describe, expect, test } from "vitest";
import type { GoldenDraft, PdfEvidenceDocument } from "../../../core/types.ts";
import {
  createEvidenceQuote,
  findKeywordReachability,
  resolveDraftSourcePath,
  updateTableColumn,
  updateTableRow
} from "./evidencing.ts";

describe("draft evidence helpers", () => {
  test("creates a quote from the selected text inside an evidence block", () => {
    expect(
      createEvidenceQuote("Revenue 12,384,638,268.11", "  Revenue 12,384,638,268.11  ")
    ).toBe("Revenue 12,384,638,268.11");
  });

  test("rejects selection text that is not an exact block substring", () => {
    expect(createEvidenceQuote("Revenue 12,384", "Cash flow 99")).toBeUndefined();
  });

  test("reports keyword reachability across evidence documents without whitespace sensitivity", () => {
    const documents = [
      evidenceDocument("annual.pdf", "营业收入 12,384,638,268.11"),
      evidenceDocument("governance.pdf", "董事会秘书    张利荣")
    ];

    expect(
      findKeywordReachability(documents, ["营业收入12,384,638,268.11", "张利荣", "商誉"])
    ).toEqual([
      {
        keyword: "营业收入12,384,638,268.11",
        reachable: true,
        evidenceIndexes: [0]
      },
      {
        keyword: "张利荣",
        reachable: true,
        evidenceIndexes: [1]
      },
      {
        keyword: "商誉",
        reachable: false,
        evidenceIndexes: []
      }
    ]);
  });

  test("resolves the source path from draft metadata or an image reference", () => {
    const draft = makeDraft();
    expect(resolveDraftSourcePath(draft)).toBe("reports/annual.pdf");

    const imageDraft = {
      ...draft,
      _draft: {},
      evidence: [
        {
          ...draft.evidence[0],
          page_image_ref: "reports/image-only.pdf#page=25"
        }
      ]
    };
    expect(resolveDraftSourcePath(imageDraft)).toBe("reports/image-only.pdf");
  });

  test("updates table headers and rows without mutating the draft value", () => {
    const table = {
      columns: ["Metric", "2025"],
      units: { Metric: "", "2025": "CNY" },
      rows: [
        ["Revenue", "100"],
        ["Profit", "20"]
      ]
    };

    const renamed = updateTableColumn(table, 0, "Indicator");
    const updated = updateTableRow(renamed, 1, 1, "25");

    expect(table.columns).toEqual(["Metric", "2025"]);
    expect(table.rows[1]).toEqual(["Profit", "20"]);
    expect(renamed.columns).toEqual(["Indicator", "2025"]);
    expect(renamed.units).toEqual({ Indicator: "", "2025": "CNY" });
    expect(updated.rows[1]).toEqual(["Profit", "25"]);
  });
});

/**
 * 构造只包含页面与文本块的最小证据文档。
 *
 * @param filePath 语料相对路径。
 * @param text 证据文本。
 * @returns 可交给 UI 投影的证据文档。
 */
function evidenceDocument(filePath: string, text: string): PdfEvidenceDocument {
  return {
    filePath,
    pages: [1],
    blocks: [
      {
        pageNumber: 1,
        lineStart: 1,
        lineEnd: 1,
        text,
        metadata: {}
      }
    ]
  };
}

/**
 * 构造带可解析来源路径的完整草稿。
 *
 * @returns 测试草稿。
 */
function makeDraft(): GoldenDraft {
  return {
    id: "fin-D001",
    query: "Revenue?",
    type: "numeric_fact",
    difficulty: "easy",
    answer_type: "number",
    gold_answer: "100",
    answer_unit: "CNY",
    evidence: [
      {
        ticker: "600000.SH",
        report_type: "annual",
        period: "2025",
        section: "Financial highlights",
        page: 1,
        quote: "Revenue 100",
        source_kind: "text"
      }
    ],
    requires_multi_doc: false,
    distractors: [],
    is_negative: false,
    note: "",
    expected_keywords: ["Revenue"],
    _draft: {
      ticker: "600000.SH",
      file_path: "reports/annual.pdf"
    }
  };
}
