import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { GoldenStudioClient } from "../../shared/api/client.ts";
import { GoldenPage } from "./GoldenPage.tsx";

/** 构造明确的作者集与生成物状态。 */
function makeClient() {
  return {
    readGoldenStatus: vi.fn(async () => ({
      authored: {
        path: "/workspace/golden.jsonl",
        caseCount: 14,
        validation: {
          ok: false,
          errors: [
            {
              code: "expected_keywords_required",
              message: "expected_keywords is required.",
              id: "fin-009",
              field: "expected_keywords"
            }
          ],
          warnings: [],
          keywordResults: [
            {
              keyword: "HUMAN-KEYWORD",
              normalizedKeyword: "human-keyword",
              reachable: false,
              reason: "unreachable",
              evidenceIndexes: [],
              caseId: "fin-009",
              caseType: "table",
              keywordIndex: 0,
              evidence: [
                {
                  evidenceIndex: 0,
                  documentFilePath: "raw/cn/600150.SH/2025.pdf",
                  reachable: false
                }
              ]
            }
          ],
          keywordSummary: {
            total: 1,
            reachable: 0,
            unreachable: 1,
            byCase: [
              {
                caseId: "fin-009",
                caseType: "table",
                total: 1,
                reachable: 0,
                unreachable: 1
              }
            ],
            byType: [
              {
                caseType: "table",
                cases: 1,
                total: 1,
                reachable: 0,
                unreachable: 1
              }
            ]
          }
        }
      },
      generated: {
        path: "/workspace/rag-golden-v1.json",
        exists: true,
        caseCount: 12,
        datasetVersion: "finance-rag-golden-v1.0.0",
        modifiedAt: "2026-10-28T15:30:00.000Z",
        sourceModifiedAt: "2026-10-28T15:00:00.000Z",
        freshness: "blocked" as const,
        blockedReason:
          "Authored golden validation must pass before this artifact is usable."
      }
    })),
    runAction: vi.fn(async () => ({
      action: "generate" as const,
      result: {
        ok: true,
        caseCount: 14,
        ragCount: 13,
        failureCount: 1,
        outputPath: "/workspace/rag-golden-v1.json",
        validation: validValidation()
      }
    }))
  } as unknown as GoldenStudioClient;
}

describe("GoldenPage", () => {
  test("separates authored source from generated artifact and exposes health", async () => {
    const client = makeClient();
    render(<GoldenPage client={client} />);

    const authored = await screen.findByRole("region", { name: "作者集" });
    expect(within(authored).getByText("14 条")).toBeInTheDocument();
    expect(within(authored).getByText("校验失败")).toBeInTheDocument();
    expect(within(authored).getByText("fin-009")).toBeInTheDocument();
    expect(within(authored).getByText(/1 个不可达关键词/)).toBeInTheDocument();
    expect(within(authored).getByText(/HUMAN-KEYWORD/)).toBeInTheDocument();

    const generated = screen.getByRole("region", { name: "生成的评测产物" });
    expect(within(generated).getByText("12 条")).toBeInTheDocument();
    expect(within(generated).getByText("finance-rag-golden-v1.0.0")).toBeInTheDocument();
    expect(within(generated).getByText("已阻断")).toBeInTheDocument();
    expect(within(generated).getByText(/validation must pass/i)).toBeInTheDocument();
    expect(within(generated).getByText(/2026/)).toBeInTheDocument();
  });

  test("confirms generation and refreshes both status sections from the server", async () => {
    const client = makeClient();
    render(<GoldenPage client={client} />);

    await screen.findByRole("region", { name: "生成的评测产物" });
    fireEvent.click(screen.getByRole("button", { name: "生成评测集" }));
    fireEvent.click(screen.getByRole("button", { name: "确认生成" }));

    expect(await screen.findByText("已生成 14 条评测用例。")).toBeInTheDocument();
    expect(client.runAction).toHaveBeenCalledWith("generate", undefined);
    await waitFor(() => expect(client.readGoldenStatus).toHaveBeenCalledTimes(2));
  });

  test("shows missing generated artifact without inventing historical metrics", async () => {
    const client = makeClient();
    vi.mocked(client.readGoldenStatus).mockResolvedValueOnce({
      authored: {
        path: "/workspace/golden.jsonl",
        caseCount: 14,
        validation: validValidation()
      },
      generated: {
        path: "/workspace/rag-golden-v1.json",
        exists: false,
        freshness: "missing"
      }
    });
    render(<GoldenPage client={client} />);

    const generated = await screen.findByRole("region", {
      name: "生成的评测产物"
    });
    expect(within(generated).getByText("缺失")).toBeInTheDocument();
    expect(within(generated).queryByText(/cases/)).not.toBeInTheDocument();
  });

  test("shows the actual generated case count from the action result", async () => {
    const client = makeClient();
    render(<GoldenPage client={client} />);

    await screen.findByRole("region", { name: "生成的评测产物" });
    fireEvent.click(screen.getByRole("button", { name: "生成评测集" }));
    fireEvent.click(screen.getByRole("button", { name: "确认生成" }));

    expect(await screen.findByText("已生成 14 条评测用例。")).toBeInTheDocument();
  });

  test("shows stale generated data when the authored source is newer", async () => {
    const client = makeClient();
    vi.mocked(client.readGoldenStatus).mockResolvedValueOnce({
      authored: {
        path: "/workspace/golden.jsonl",
        caseCount: 14,
        validation: validValidation()
      },
      generated: {
        path: "/workspace/rag-golden-v1.json",
        exists: true,
        caseCount: 12,
        datasetVersion: "finance-rag-golden-v1.0.0",
        modifiedAt: "2026-10-28T14:30:00.000Z",
        sourceModifiedAt: "2026-10-28T15:30:00.000Z",
        freshness: "stale"
      }
    });
    render(<GoldenPage client={client} />);

    const generated = await screen.findByRole("region", {
      name: "生成的评测产物"
    });
    expect(within(generated).getByText("已过期")).toBeInTheDocument();
    expect(within(generated).getByText(/重新生成/)).toBeInTheDocument();
  });
});

/** 构造无关键词问题的完整校验报告。 */
function validValidation() {
  return {
    ok: true,
    errors: [],
    warnings: [],
    keywordResults: [],
    keywordSummary: {
      total: 0,
      reachable: 0,
      unreachable: 0,
      byCase: [],
      byType: []
    }
  };
}
