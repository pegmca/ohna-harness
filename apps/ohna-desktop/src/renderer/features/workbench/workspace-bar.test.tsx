import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBar } from "./workspace-bar";

vi.mock("../../shared/sdk/ohna-client", () => ({
  readWorkspaceGitBranch: vi.fn(async () => ({ ok: true, requestId: "git", data: "main" }))
}));

afterEach(() => {
  cleanup();
});

describe("WorkspaceBar", () => {
  it("展示当前目录与 Git 分支，并可切换工作区", async () => {
    const onPick = vi.fn();
    const onSelect = vi.fn();
    const active = {
      workspaceId: "ws-a",
      displayPath: "/Users/me/code/project-a",
      status: "authorized" as const
    };
    const other = {
      workspaceId: "ws-b",
      displayPath: "/Users/me/code/project-b",
      status: "authorized" as const
    };

    render(
      <WorkspaceBar
        active={active}
        isLoading={false}
        isPicking={false}
        onPick={onPick}
        onSelect={onSelect}
        workspaces={[active, other]}
      />
    );

    expect(screen.getByRole("button", { name: `当前工作区 ${active.displayPath}` })).toBeTruthy();
    expect(screen.getByText("project-a")).toBeTruthy();
    expect(screen.getByText(active.displayPath)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("main")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: `当前工作区 ${active.displayPath}` }));
    fireEvent.click(await screen.findByRole("button", { name: /project-b/ }));
    expect(onSelect).toHaveBeenCalledWith("ws-b");

    fireEvent.click(screen.getByRole("button", { name: `当前工作区 ${active.displayPath}` }));
    fireEvent.click(await screen.findByRole("button", { name: /选择其他目录/ }));
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
