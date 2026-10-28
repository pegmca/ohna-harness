import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import type { BatchSummary } from "../../core/types.ts";

/**
 * 建一个稳定可复用的批次摘要。
 *
 * @param overrides 覆盖默认值的字段。
 * @returns 批次摘要。
 */
function makeBatch(overrides: Partial<BatchSummary> = {}): BatchSummary {
  return {
    name: "batch-01",
    draftCount: 2,
    approvedCount: 1,
    pendingCount: 1,
    corruptCount: 0,
    ...overrides
  };
}

describe("App shell routing", () => {
  test("shows the batches workspace at / and lists server batches", async () => {
    const client = {
      listBatches: vi.fn(async () => [makeBatch()]),
      listDrafts: vi.fn(),
      readDraft: vi.fn(),
      saveDraft: vi.fn()
    };
    render(<App client={client as never} initialEntries={["/"]} />);

    expect(await screen.findByRole("heading", { name: "Batches" })).toBeInTheDocument();
    expect(screen.getByText("batch-01")).toBeInTheDocument();
    expect(screen.getByText("2 drafts")).toBeInTheDocument();
  });

  test("surfaces loading, empty, and error states in the main area", async () => {
    const loadingClient = { listBatches: vi.fn(() => new Promise<never[]>(() => undefined)) };
    const first = render(<App client={loadingClient as never} initialEntries={["/"]} />);
    expect(await screen.findByText("Loading batches")).toBeInTheDocument();
    first.unmount();

    const emptyClient = { listBatches: vi.fn(async () => []) };
    const second = render(<App client={emptyClient as never} initialEntries={["/"]} />);
    expect(await screen.findByText("No batches yet")).toBeInTheDocument();
    second.unmount();

    const errorClient = {
      listBatches: vi.fn(async () => {
        throw Object.assign(new Error("offline"), {
          name: "ApiError",
          code: "network_error"
        });
      })
    };
    render(<App client={errorClient as never} initialEntries={["/"]} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  });

  test("opens a batch route and loads its draft list", async () => {
    const client = {
      listBatches: vi.fn(async () => [makeBatch({ name: "batch-long-name" })]),
      listDrafts: vi.fn(async () => []),
      readDraft: vi.fn(),
      saveDraft: vi.fn()
    };
    render(<App client={client as never} initialEntries={["/batch/batch-long-name"]} />);

    expect(
      await screen.findByRole("heading", { name: "batch-long-name" })
    ).toBeInTheDocument();
    expect(await screen.findByText("No drafts yet")).toBeInTheDocument();
    expect(client.listDrafts).toHaveBeenCalledWith("batch-long-name", expect.anything());
  });
});
