import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";
import type {
  GoldenDraft,
  PdfEvidenceDocument,
  ValidationReport
} from "../../../core/types.ts";
import { AppProvider } from "../../app/context.tsx";
import type { GoldenStudioClient } from "../../shared/api/client.ts";
import { DraftPage } from "./DraftPage.tsx";

describe("DraftPage", () => {
  test("fills the evidence quote from text selected in an evidence block", async () => {
    const client = makeClient();
    renderDraftPage(client);

    const block = await screen.findByText("Revenue 12,384,638,268.11");
    selectElementText(block);
    fireEvent.mouseUp(block);

    expect(screen.getByLabelText("Quote for evidence 1")).toHaveValue(
      "Revenue 12,384,638,268.11"
    );
    expect(client.readEvidence).toHaveBeenCalledWith(
      "reports/600000.SH/annual/2025.pdf",
      expect.anything()
    );
  });

  test("filters evidence and moves the PDF page controls independently", async () => {
    renderDraftPage(makeClient());

    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
    expect(screen.getByTitle("PDF page 2")).toHaveAttribute(
      "src",
      expect.stringContaining("#page=2")
    );
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Page 3 of 3")).toBeInTheDocument();
    expect(screen.getByText("董事会秘书 张利荣")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter evidence"), {
      target: { value: "董事会" }
    });
    expect(
      within(screen.getByLabelText("Evidence blocks")).queryByText(
        "Revenue 12,384,638,268.11"
      )
    ).not.toBeInTheDocument();
    expect(screen.getByText("董事会秘书 张利荣")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  test("adds and removes keywords with immediate source reachability", async () => {
    renderDraftPage(makeClient());

    const keywordInput = await screen.findByLabelText("New expected keyword");
    fireEvent.change(keywordInput, { target: { value: "张利荣" } });
    fireEvent.click(screen.getByRole("button", { name: "Add keyword" }));
    const reachableRow = screen
      .getByText("张利荣", { selector: ".keyword-text" })
      .closest(".keyword-row");
    expect(reachableRow).not.toBeNull();
    expect(within(reachableRow as HTMLElement).getByText("Reachable in 1 source")).toBeInTheDocument();
    expect(screen.getByText("张利荣", { selector: ".keyword-text" })).toBeInTheDocument();

    fireEvent.change(keywordInput, { target: { value: "商誉" } });
    fireEvent.click(screen.getByRole("button", { name: "Add keyword" }));
    expect(
      within(screen.getByLabelText("Expected keyword list")).getByText(
        "Not found in evidence"
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove keyword 商誉" }));
    expect(screen.queryByText("商誉", { selector: ".keyword-text" })).not.toBeInTheDocument();
  });

  test("blocks approval when server validation reports field errors", async () => {
    const invalidReport: ValidationReport = {
      ok: false,
      errors: [
        {
          code: "required_string_invalid",
          message: "query must not be empty.",
          field: "query"
        }
      ],
      warnings: [],
      keywordResults: [],
      keywordSummary: emptyKeywordSummary()
    };
    const client = makeClient(invalidReport);
    renderDraftPage(client);

    fireEvent.click(await screen.findByRole("button", { name: "Save and validate" }));

    await screen.findByRole("button", { name: "Save and validate" });
    expect(
      await within(screen.getByRole("list", { name: "errors" })).findByText(
        "query must not be empty."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve draft" })).toBeDisabled();
    expect(
      client.saveDraft.mock.calls.every(([, , draft]) => draft._draft.approved !== true)
    ).toBe(true);
    fireEvent.click(
      within(screen.getByRole("list", { name: "errors" })).getByRole(
        "button",
        { name: /query must not be empty/ }
      )
    );
    expect(screen.queryByText(/Issue field:/)).not.toBeInTheDocument();
    expect(screen.getByText("query", { selector: "code" })).toBeInTheDocument();
  });

  test("persists the validation snapshot after save and validate", async () => {
    const client = makeClient();
    renderDraftPage(client);

    fireEvent.click(
      await screen.findByRole("button", { name: "Save and validate" })
    );
    await screen.findByText("Draft saved and validated.");
    await waitFor(() =>
      expect(
        client.saveDraft.mock.calls.some(
          ([, , saved]) =>
            saved._draft.validation?.ok === true &&
            saved._draft.validation.keywordResults.length === 1
        )
      ).toBe(true)
    );
  });

  test("approves explicitly only after a successful fresh validation", async () => {
    const client = makeClient();
    renderDraftPage(client);

    fireEvent.click(await screen.findByRole("button", { name: "Approve draft" }));

    await waitFor(() => expect(client.validateDraft).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        client.saveDraft.mock.calls.some(
          ([, , draft]) =>
            draft._draft.approved === true &&
            draft._draft.validation?.ok === true
        )
      ).toBe(true)
    );
  });

  test("does not save or approve a dirty draft", async () => {
    const client = makeClient();
    renderDraftPage(client);

    fireEvent.change(await screen.findByLabelText("Query"), {
      target: { value: "Updated question?" }
    });
    const approve = screen.getByRole("button", { name: "Approve draft" });

    expect(approve).toBeDisabled();
    expect(screen.getByText("Save changes before approving.")).toBeInTheDocument();
    fireEvent.click(approve);
    await waitFor(() => expect(client.saveDraft).not.toHaveBeenCalled());
    expect(client.validateDraft).not.toHaveBeenCalled();
  });

  test("validates the current draft, not the whole batch", async () => {
    const client = makeClient();
    renderDraftPage(client);

    fireEvent.click(
      await screen.findByRole("button", { name: "Save and validate" })
    );

    await screen.findByText("Draft saved and validated.");
    expect(client.validateDraft).toHaveBeenCalledWith("batch-01", "fin-D001");
    expect(client.validateBatch).not.toHaveBeenCalled();
  });

  test("edits table rows and keeps long cell values available without clipping", async () => {
    renderDraftPage(makeClient());

    fireEvent.click(await screen.findByRole("button", { name: "Add row" }));
    fireEvent.change(screen.getByLabelText("Row 2, Metric"), {
      target: { value: "A very long financial metric cell that must remain fully editable" }
    });
    fireEvent.change(screen.getByLabelText("Row 2, 2025"), {
      target: { value: "12,384,638,268.11" }
    });

    expect(screen.getByLabelText("Row 2, Metric")).toHaveValue(
      "A very long financial metric cell that must remain fully editable"
    );
    expect(document.querySelector(".table-scroll")).toHaveAttribute("tabindex", "0");
  });

  test("edits form groups and items when the answer type changes to form", async () => {
    renderDraftPage(makeClient(validReport(), { answer_type: "form" }));

    fireEvent.click(await screen.findByRole("button", { name: "Add group" }));
    fireEvent.change(screen.getByLabelText("Group 1"), {
      target: { value: "Governance" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add form item" }));
    fireEvent.change(screen.getByLabelText("Item 1 key"), {
      target: { value: "Board secretary" }
    });
    fireEvent.change(screen.getByLabelText("Item 1 value"), {
      target: { value: "Zhang Lirong" }
    });

    expect(screen.getByLabelText("Group 1")).toHaveValue("Governance");
    expect(screen.getByLabelText("Item 1 key")).toHaveValue("Board secretary");
    expect(screen.getByLabelText("Item 1 value")).toHaveValue("Zhang Lirong");
  });

  test("adds distractors and edits evidence source fields", async () => {
    renderDraftPage(makeClient());

    fireEvent.change(await screen.findByLabelText("Evidence 1 section"), {
      target: { value: "Key accounting data" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add distractor" }));
    fireEvent.change(screen.getByLabelText("Distractor 1 ticker"), {
      target: { value: "000001.SZ" }
    });
    fireEvent.change(screen.getByLabelText("Distractor 1 report type"), {
      target: { value: "interim" }
    });

    expect(screen.getByLabelText("Evidence 1 section")).toHaveValue(
      "Key accounting data"
    );
    expect(screen.getByLabelText("Distractor 1 ticker")).toHaveValue("000001.SZ");
    expect(screen.getByLabelText("Distractor 1 report type")).toHaveValue(
      "interim"
    );
  });
});

interface TestClient extends GoldenStudioClient {
  readEvidence: Mock<GoldenStudioClient["readEvidence"]>;
  validateBatch: Mock<GoldenStudioClient["validateBatch"]>;
  validateDraft: Mock<GoldenStudioClient["validateDraft"]>;
  saveDraft: Mock<GoldenStudioClient["saveDraft"]>;
}

/**
 * 构造只替换网络边界的注入客户端。
 *
 * @param validation 校验端点返回的报告。
 * @param draftOverrides 草稿覆盖字段。
 * @returns 可观察调用的客户端。
 */
function makeClient(
  validation: ValidationReport = validReport(),
  draftOverrides: Partial<GoldenDraft> = {}
): TestClient {
  const draft = makeDraft(draftOverrides);
  return {
    listBatches: vi.fn(),
    listDrafts: vi.fn(),
    readDraft: vi.fn(async () => structuredClone(draft)),
    saveDraft: vi.fn(async (_batch, _id, next) => ({
      ...structuredClone(next),
      _draft: {
        ...next._draft,
        savedAt: "2026-10-28T00:00:00.000Z"
      }
    })),
    readEvidence: vi.fn(async () => evidenceDocument()),
    validateBatch: vi.fn(async () => ({
      batch: "batch-01",
      draftCount: 1,
      validation
    })),
    validateDraft: vi.fn(async () => ({
      batch: "batch-01",
      id: "fin-D001",
      validation
    }))
  } as unknown as TestClient;
}

/**
 * 以真实路由和客户端上下文渲染标注页。
 *
 * @param client 注入的客户端。
 */
function renderDraftPage(client: GoldenStudioClient): void {
  render(
    <AppProvider client={client}>
      <MemoryRouter initialEntries={["/draft/batch-01/fin-D001"]}>
        <Routes>
          <Route element={<DraftPage />} path="/draft/:batch/:id" />
        </Routes>
      </MemoryRouter>
    </AppProvider>
  );
}

/**
 * 选中元素内的全部文本，模拟浏览器原文选择。
 *
 * @param element 证据文本节点宿主。
 */
function selectElementText(element: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) throw new Error("Selection API is unavailable.");
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * 构造一条可审核的有效草稿。
 *
 * @param overrides 需要覆盖的字段。
 * @returns 完整草稿。
 */
function makeDraft(overrides: Partial<GoldenDraft> = {}): GoldenDraft {
  return {
    id: "fin-D001",
    query: "2025 annual revenue?",
    type: "table",
    difficulty: "medium",
    answer_type: "table",
    gold_answer: "Revenue was 12,384,638,268.11 CNY.",
    gold_answer_table: {
      columns: ["Metric", "2025"],
      units: { Metric: "", "2025": "CNY" },
      rows: [["Revenue", "12,384,638,268.11"]]
    },
    gold_answer_form: {
      groups: [],
      items: []
    },
    answer_unit: "CNY",
    evidence: [
      {
        ticker: "600000.SH",
        report_type: "annual",
        period: "2025",
        section: "Financial highlights",
        page: 2,
        quote: "Revenue 12,384,638,268.11",
        source_kind: "text"
      }
    ],
    requires_multi_doc: false,
    distractors: [],
    is_negative: false,
    note: "Compare table values.",
    expected_keywords: ["Revenue"],
    _draft: {
      ticker: "600000.SH",
      file_path: "reports/600000.SH/annual/2025.pdf",
      extraction_health: "ok"
    },
    ...overrides
  };
}

/**
 * 构造带正文、表格行与字符间距来源层的证据文档。
 *
 * @returns PDF 证据投影。
 */
function evidenceDocument(): PdfEvidenceDocument {
  return {
    filePath: "reports/600000.SH/annual/2025.pdf",
    pages: [2, 3],
    blocks: [
      {
        pageNumber: 2,
        lineStart: 10,
        lineEnd: 10,
        text: "Revenue 12,384,638,268.11",
        metadata: {}
      },
      {
        pageNumber: 3,
        lineStart: 18,
        lineEnd: 18,
        text: "董事会秘书 张利荣",
        metadata: {
          isTableRow: true,
          tableColumnCount: 2,
          sourceLayer: "char_spaced"
        }
      }
    ]
  };
}

/**
 * 构造通过校验的报告。
 *
 * @returns 空错误报告。
 */
function validReport(): ValidationReport {
  return {
    ok: true,
    errors: [],
    warnings: [],
    keywordResults: [
      {
        keyword: "Revenue",
        normalizedKeyword: "revenue",
        reachable: true,
        evidenceIndexes: [0],
        caseId: "fin-D001",
        caseType: "numeric_fact",
        keywordIndex: 0,
        evidence: [
          {
            evidenceIndex: 0,
            documentFilePath: "raw/cn/000776.SZ/2025Q1.pdf",
            reachable: true
          }
        ]
      }
    ],
    keywordSummary: {
      total: 1,
      reachable: 1,
      unreachable: 0,
      byCase: [
        {
          caseId: "fin-D001",
          caseType: "numeric_fact",
          total: 1,
          reachable: 1,
          unreachable: 0
        }
      ],
      byType: [
        {
          caseType: "numeric_fact",
          cases: 1,
          total: 1,
          reachable: 1,
          unreachable: 0
        }
      ]
    }
  };
}

/** 空关键词汇总。 */
function emptyKeywordSummary() {
  return {
    total: 0,
    reachable: 0,
    unreachable: 0,
    byCase: [],
    byType: []
  };
}
