import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { GoldenStudioClient } from "../../shared/api/client.ts";
import { ThemeProvider } from "../../app/theme.tsx";
import { SettingsPage } from "./SettingsPage.tsx";

/** 构造只读工作区配置。 */
function makeClient() {
  return {
    readWorkspaceSettings: vi.fn(async () => ({
      workspaceRoot: "/workspace/finance",
      corpusRoot: "/corpus/finance",
      manifestPath: "/corpus/finance/manifest/manifest.jsonl",
      goldenPath: "/workspace/finance/datasets/finance/rag-golden/golden.jsonl",
      generatedPath: "/workspace/finance/datasets/finance/rag-golden-v1.json"
    }))
  } as unknown as GoldenStudioClient;
}

describe("SettingsPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.removeProperty("--ui-font-size");
  });

  test("shows server workspace and corpus configuration as read-only", async () => {
    const client = makeClient();
    render(<SettingsPage client={client} />);

    expect(await screen.findByText("/workspace/finance")).toBeInTheDocument();
    expect(screen.getByText("/corpus/finance")).toBeInTheDocument();
    expect(screen.getByText("/corpus/finance/manifest/manifest.jsonl")).toBeInTheDocument();
    expect(screen.getByText("只读")).toBeInTheDocument();
  });

  test("persists theme and font size as local preferences", async () => {
    const client = makeClient();
    render(
      <ThemeProvider>
        <SettingsPage client={client} />
      </ThemeProvider>
    );
    await screen.findByText("/workspace/finance");

    fireEvent.click(screen.getByRole("radio", { name: "深色" }));
    fireEvent.click(screen.getByRole("radio", { name: "大" }));

    expect(window.localStorage.getItem("golden-studio-theme")).toBe("dark");
    expect(window.localStorage.getItem("golden-studio-font-size")).toBe("large");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-font-size", "large");
  });

  test("surfaces settings loading failure", async () => {
    const client = makeClient();
    vi.mocked(client.readWorkspaceSettings).mockRejectedValueOnce(
      new Error("manifest missing")
    );
    render(<SettingsPage client={client} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("manifest missing");
  });
});
