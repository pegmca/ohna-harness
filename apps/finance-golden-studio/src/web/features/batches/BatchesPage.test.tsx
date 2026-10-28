import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { GoldenStudioClient } from "../../shared/api/client.ts";
import { BatchesPage } from "./BatchesPage.tsx";

/** 构造覆盖完整状态的批次夹具。 */
const batches = [
  {
    name: "batch-approved",
    draftCount: 4,
    approvedCount: 3,
    pendingCount: 1,
    corruptCount: 0
  },
  {
    name: "batch-corrupt",
    draftCount: 2,
    approvedCount: 0,
    pendingCount: 1,
    corruptCount: 1
  }
];

/** 构造刷新后仍由 server 返回的批次列表。 */
function makeClient(result = actionResult("promote")) {
  return {
    listBatches: vi.fn(async () => batches),
    runAction: vi.fn(async () => result)
  } as unknown as GoldenStudioClient;
}

/** 构造服务端动作返回的真实发布摘要。 */
function actionResult(
  _action: "promote"
) {
  return {
    action: "promote" as const,
    result: {
      ok: true,
      batch: "batch-approved",
      approvedCount: 3,
      promotedCount: 3,
      pendingCount: 1,
      promoted: [],
      validation: { ok: true, errors: [], warnings: [], keywordResults: [] }
    }
  };
}

describe("BatchesPage", () => {
  test("renders real counts as progress and separates corrupt drafts", async () => {
    const client = makeClient();
    render(
      <MemoryRouter>
        <BatchesPage client={client} />
      </MemoryRouter>
    );

    const approvedRow = await screen.findByRole("row", { name: /batch-approved/i });
    expect(within(approvedRow).getByText("3 / 4")).toBeInTheDocument();
    expect(within(approvedRow).getByText("75%")).toBeInTheDocument();
    expect(within(approvedRow).getByText("1 pending")).toBeInTheDocument();

    const corruptRow = screen.getByRole("row", { name: /batch-corrupt/i });
    expect(within(corruptRow).getByText("1 corrupt")).toBeInTheDocument();
    expect(within(corruptRow).getByRole("link", { name: "Review drafts" })).toHaveAttribute(
      "href",
      "/batch/batch-corrupt"
    );
  });

  test("confirms promotion, refreshes batches, and shows the server result", async () => {
    const client = makeClient();
    const onChanged = vi.fn();
    render(
      <MemoryRouter>
        <BatchesPage client={client} onChanged={onChanged} />
      </MemoryRouter>
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Promote approved" })
    );
    expect(
      screen.getByRole("dialog", { name: "Promote approved?" })
    ).toBeInTheDocument();
    expect(client.runAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm promotion" }));

    expect(await screen.findByText("Promoted 3 drafts.")).toBeInTheDocument();
    expect(client.runAction).toHaveBeenCalledWith("promote", {
      batch: "batch-approved"
    });
    await waitFor(() => expect(client.listBatches).toHaveBeenCalledTimes(2));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("keeps rows stable and reports refresh errors without fake data", async () => {
    const client = makeClient();
    vi.mocked(client.listBatches).mockRejectedValueOnce(
      new Error("corpus manifest unavailable")
    );
    render(
      <MemoryRouter>
        <BatchesPage client={client} />
      </MemoryRouter>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "corpus manifest unavailable"
    );
    expect(screen.queryByText("batch-approved")).not.toBeInTheDocument();
  });

  test("shows the real promoted count from the raw server action contract", async () => {
    const client = makeClient(actionResult("promote"));
    render(
      <MemoryRouter>
        <BatchesPage client={client} />
      </MemoryRouter>
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Promote approved" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm promotion" }));

    expect(await screen.findByText("Promoted 3 drafts.")).toBeInTheDocument();
  });

  test("mines a selected candidates file after confirmation and shows real results", async () => {
    const client = makeClient();
    render(
      <MemoryRouter>
        <BatchesPage client={client} />
      </MemoryRouter>
    );
    await screen.findByRole("button", { name: "Mine candidates" });

    fireEvent.change(screen.getByLabelText("Batch name"), {
      target: { value: "mined-batch" }
    });
    fireEvent.change(screen.getByLabelText("Candidates JSON file"), {
      target: {
        files: [
          new File(
            [
              JSON.stringify([
                {
                  ticker: "600000.SH",
                  report_type: "annual",
                  period: "2025",
                  type: "numeric_fact"
                }
              ])
            ],
            "candidates.json",
            { type: "application/json" }
          )
        ]
      }
    });
    expect(
      await screen.findByText((_content, element) =>
        element?.tagName === "P" &&
        element.textContent?.includes("1 candidate ready from candidates.json") === true
      )
    ).toBeInTheDocument();

    const mineTrigger = screen.getByRole("button", { name: "Mine candidates" });
    await waitFor(() => expect(mineTrigger).toBeEnabled());
    fireEvent.click(mineTrigger);
    expect(
      await screen.findByRole("dialog", { name: "Mine candidates?" })
    ).toBeInTheDocument();
    expect(client.runAction).not.toHaveBeenCalled();

    vi.mocked(client.runAction).mockResolvedValueOnce({
      action: "mine",
      result: {
        ok: true,
        complete: true,
        batch: "mined-batch",
        draftedCount: 2,
        skippedCount: 1,
        drafts: [{ id: "fin-D001" }, { id: "fin-D002" }],
        skipped: [{ id: "fin-D003", reason: "text_too_short" }]
      }
    });
    const confirmation = screen.getByRole("dialog", { name: "Mine candidates?" });
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Mine candidates" })
    );

    expect(
      await screen.findByText("Mined 2 drafts; skipped 1 candidate.")
    ).toBeInTheDocument();
    expect(client.runAction).toHaveBeenCalledWith("mine", {
      batch: "mined-batch",
      candidates: [
        {
          ticker: "600000.SH",
          report_type: "annual",
          period: "2025",
          type: "numeric_fact"
        }
      ]
    });
    await waitFor(() => expect(client.listBatches).toHaveBeenCalledTimes(2));
  });
});
