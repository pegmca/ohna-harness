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

    expect(await screen.findByRole("heading", { name: "批次" })).toBeInTheDocument();
    expect(screen.getByText("batch-01")).toBeInTheDocument();
    expect(screen.getByText("2 份草稿")).toBeInTheDocument();
  });

  test("surfaces loading, empty, and error states in the main area", async () => {
    const loadingClient = { listBatches: vi.fn(() => new Promise<never[]>(() => undefined)) };
    const first = render(<App client={loadingClient as never} initialEntries={["/"]} />);
    expect(await screen.findByText("正在加载批次")).toBeInTheDocument();
    first.unmount();

    const emptyClient = { listBatches: vi.fn(async () => []) };
    const second = render(<App client={emptyClient as never} initialEntries={["/"]} />);
    expect(await screen.findByText("暂无草稿批次。")).toBeInTheDocument();
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
    expect(await screen.findByText("暂无草稿")).toBeInTheDocument();
    expect(client.listDrafts).toHaveBeenCalledWith("batch-long-name", expect.anything());
  });

  test("opens the draft editor from a batch draft row", async () => {
    const draft = makeDraft();
    const client = {
      listBatches: vi.fn(async () => [makeBatch({ name: "batch-01" })]),
      listDrafts: vi.fn(async () => [
        {
          id: draft.id,
          query: draft.query,
          type: draft.type,
          approved: false,
          corrupt: false
        }
      ]),
      readDraft: vi.fn(async () => draft),
      readEvidence: vi.fn(async () => evidenceDocument()),
      evidenceContentUrl: vi.fn(
        () => "/api/evidence/content?path=reports%2F600000.SH%2Fannual%2F2025.pdf"
      ),
      validateDraft: vi.fn(),
      saveDraft: vi.fn()
    };
    render(<App client={client as never} initialEntries={["/batch/batch-01"]} />);

    fireEvent.click(
      await screen.findByRole("link", { name: "What was revenue?" })
    );

    expect(
      await screen.findByRole("heading", { name: "fin-D001" })
    ).toBeInTheDocument();
    expect(client.readDraft).toHaveBeenCalledWith(
      "batch-01",
      "fin-D001",
      expect.anything()
    );
    expect(
      await within(screen.getByLabelText("证据区块")).findByText(
        "Revenue 100"
      )
    ).toBeInTheDocument();
  });

  test("replaces the draft placeholder with the evidence-aware editor route", async () => {
    const client = {
      readDraft: vi.fn(async () => makeDraft()),
      readEvidence: vi.fn(async () => evidenceDocument()),
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
      await within(screen.getByLabelText("证据区块")).findByText(
        "Revenue 100"
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("此工作区尚未接入。")).not.toBeInTheDocument();
  });

  test("routes Golden and Settings to their real workbench pages", async () => {
    const client = {
      readGoldenStatus: vi.fn(async () => ({
        authored: {
          path: "/workspace/golden.jsonl",
          caseCount: 2,
          validation: {
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
          }
        },
        generated: {
          path: "/workspace/rag-golden-v1.json",
          exists: false
        }
      })),
      readWorkspaceSettings: vi.fn(async () => ({
        workspaceRoot: "/workspace",
        corpusRoot: "/corpus",
        manifestPath: "/corpus/manifest/manifest.jsonl",
        goldenPath: "/workspace/golden.jsonl",
        generatedPath: "/workspace/rag-golden-v1.json"
      }))
    };
    const golden = render(
      <App client={client as never} initialEntries={["/golden"]} />
    );
    expect(
      await screen.findByRole("region", { name: "作者集" })
    ).toBeInTheDocument();
    golden.unmount();

    render(<App client={client as never} initialEntries={["/settings"]} />);
    expect(
      await screen.findByRole("heading", { name: "工作区与语料" })
    ).toBeInTheDocument();
    expect(screen.queryByText("此工作区尚未接入。")).not.toBeInTheDocument();
  });
});

/**
 * 构造可渲染完整编辑器的草稿。
 *
 * @returns 草稿夹具。
 */
function makeDraft() {
  return {
    id: "fin-D001",
    query: "What was revenue?",
    type: "numeric_fact" as const,
    difficulty: "easy" as const,
    answer_type: "number" as const,
    gold_answer: "100",
    answer_unit: "CNY",
    evidence: [
      {
        ticker: "600000.SH",
        report_type: "annual" as const,
        period: "2025",
        section: "Highlights",
        page: 1,
        quote: "Revenue 100",
        source_kind: "text" as const
      }
    ],
    requires_multi_doc: false,
    distractors: [],
    is_negative: false,
    note: "",
    expected_keywords: ["Revenue"],
    _draft: {
      file_path: "reports/600000.SH/annual/2025.pdf",
      extraction_health: "ok"
    }
  };
}

/**
 * 构造编辑器读取的真实证据投影夹具。
 *
 * @returns 证据文档。
 */
function evidenceDocument() {
  return {
    filePath: "reports/600000.SH/annual/2025.pdf",
    pages: [1],
    blocks: [
      {
        pageNumber: 1,
        lineStart: 1,
        lineEnd: 1,
        text: "Revenue 100",
        metadata: {}
      }
    ]
  };
}

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

  test("applies a persisted font-size preference on app boot before Settings is visited", async () => {
    window.localStorage.setItem("golden-studio-font-size", "large");
    const client = {
      listBatches: vi.fn(async () => [makeBatch()])
    };
    render(<App client={client as never} initialEntries={["/"]} />);

    await screen.findByRole("heading", { name: "批次" });
    expect(document.documentElement).toHaveAttribute("data-font-size", "large");
  });
});
