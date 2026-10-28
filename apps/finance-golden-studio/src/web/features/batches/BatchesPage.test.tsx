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
function makeClient() {
  return {
    listBatches: vi.fn(async () => batches),
    runAction: vi.fn(async () => ({
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
    }))
  } as unknown as GoldenStudioClient;
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
});
