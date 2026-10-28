import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { ThemeProvider, useTheme } from "./theme.tsx";
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

  test("replaces the draft placeholder with the evidence-aware editor route", async () => {
    const draft = {
      id: "fin-D001",
      query: "What was revenue?",
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
          section: "Highlights",
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
      _draft: { file_path: "reports/600000.SH/annual/2025.pdf" }
    };
    const client = {
      readDraft: vi.fn(async () => draft),
      readEvidence: vi.fn(async () => ({
        filePath: "reports/600000.SH/annual/2025.pdf",
        pages: [1, 2],
        blocks: [
          {
            pageNumber: 1,
            lineStart: 1,
            lineEnd: 1,
            text: "Revenue 100",
            metadata: {}
          },
          {
            pageNumber: 2,
            lineStart: 1,
            lineEnd: 1,
            text: "Revenue 100",
            metadata: {}
          }
        ]
      })),
      evidenceContentUrl: vi.fn(
        () => "http://127.0.0.1:4318/api/evidence/content?path=reports%2F600000.SH%2Fannual%2F2025.pdf"
      ),
      validateBatch: vi.fn(),
      saveDraft: vi.fn()
    };
    render(
      <App
        client={client as never}
        initialEntries={["/draft/batch-01/fin-D001"]}
      />
    );

    expect(
      await screen.findByRole("heading", { name: "fin-D001" })
    ).toBeInTheDocument();
    expect(
      await within(screen.getByLabelText("Evidence blocks")).findByText(
        "Revenue 100"
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("This workspace is not wired yet.")).not.toBeInTheDocument();
  });
});

beforeAll(() => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
});

describe("ThemeProvider", () => {
  test("updates context, applies the selected theme, and persists it", async () => {
    let preference: string | undefined;

    function ThemeValue() {
      const { preference: current, setPreference } = useTheme();
      preference = current;
      return <button onClick={() => setPreference("dark")}>Set dark</button>;
    }

    render(
      <ThemeProvider>
        <ThemeValue />
      </ThemeProvider>
    );

    expect(preference).toBe("system");
    fireEvent.click(screen.getByRole("button", { name: "Set dark" }));

    expect(preference).toBe("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(window.localStorage.getItem("golden-studio-theme")).toBe("dark");
  });

  test("restores a persisted dark preference on initialization", () => {
    window.localStorage.setItem("golden-studio-theme", "dark");
    let preference: string | undefined;

    function ThemeValue() {
      preference = useTheme().preference;
      return null;
    }

    render(
      <ThemeProvider>
        <ThemeValue />
      </ThemeProvider>
    );

    expect(preference).toBe("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });
});
