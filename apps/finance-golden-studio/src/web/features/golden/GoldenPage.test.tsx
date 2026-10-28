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
          keywordResults: []
        }
      },
      generated: {
        path: "/workspace/rag-golden-v1.json",
        exists: true,
        caseCount: 12,
        datasetVersion: "finance-rag-golden-v1.0.0",
        modifiedAt: "2026-10-28T15:30:00.000Z"
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
        validation: { ok: true, errors: [], warnings: [], keywordResults: [] }
      }
    }))
  } as unknown as GoldenStudioClient;
}

describe("GoldenPage", () => {
  test("separates authored source from generated artifact and exposes health", async () => {
    const client = makeClient();
    render(<GoldenPage client={client} />);

    const authored = await screen.findByRole("region", { name: "Authored golden" });
    expect(within(authored).getByText("14 cases")).toBeInTheDocument();
    expect(within(authored).getByText("Validation failed")).toBeInTheDocument();
    expect(within(authored).getByText("fin-009")).toBeInTheDocument();

    const generated = screen.getByRole("region", { name: "Generated eval artifact" });
    expect(within(generated).getByText("12 cases")).toBeInTheDocument();
    expect(within(generated).getByText("finance-rag-golden-v1.0.0")).toBeInTheDocument();
    expect(within(generated).getByText("Available")).toBeInTheDocument();
    expect(within(generated).getByText(/2026/)).toBeInTheDocument();
  });

  test("confirms generation and refreshes both status sections from the server", async () => {
    const client = makeClient();
    render(<GoldenPage client={client} />);

    await screen.findByRole("region", { name: "Generated eval artifact" });
    fireEvent.click(screen.getByRole("button", { name: "Generate eval set" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm generation" }));

    expect(await screen.findByText("Generated 14 evaluation cases.")).toBeInTheDocument();
    expect(client.runAction).toHaveBeenCalledWith("generate", undefined);
    await waitFor(() => expect(client.readGoldenStatus).toHaveBeenCalledTimes(2));
  });

  test("shows missing generated artifact without inventing historical metrics", async () => {
    const client = makeClient();
    vi.mocked(client.readGoldenStatus).mockResolvedValueOnce({
      authored: {
        path: "/workspace/golden.jsonl",
        caseCount: 14,
        validation: { ok: true, errors: [], warnings: [], keywordResults: [] }
      },
      generated: {
        path: "/workspace/rag-golden-v1.json",
        exists: false
      }
    });
    render(<GoldenPage client={client} />);

    const generated = await screen.findByRole("region", {
      name: "Generated eval artifact"
    });
    expect(within(generated).getByText("Not generated")).toBeInTheDocument();
    expect(within(generated).queryByText(/cases/)).not.toBeInTheDocument();
  });
});
