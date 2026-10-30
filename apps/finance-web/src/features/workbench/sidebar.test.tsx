import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationSidebar } from "./sidebar";

afterEach(() => cleanup());

/**
 * 渲染侧栏并返回视图切换引用，供二级入口回归断言使用。
 *
 * @returns 侧栏回调。
 */
function renderSidebar() {
  const onSelectView = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <ConversationSidebar
      activeConversationId={undefined}
      conversations={[]}
      error={undefined}
      hasMore={false}
      isLoading={false}
      isOpen={false}
      onArchiveConversation={vi.fn()}
      onClose={vi.fn()}
      onLoadMore={vi.fn()}
      onNewConversation={vi.fn()}
      onOpenSettings={onOpenSettings}
      onRetry={vi.fn()}
      onSelectConversation={vi.fn()}
      onSelectView={onSelectView}
      workspaceView="chat"
    />,
  );
  return { onSelectView, onOpenSettings };
}

describe("ConversationSidebar profile menu", () => {
  it("keeps every workspace entry and routes Settings to the dialog callback", () => {
    const { onSelectView, onOpenSettings } = renderSidebar();
    fireEvent.click(
      screen.getByRole("button", { name: /捡垃圾的小帅|不化妆的小美/ }),
    );

    for (const label of [
      "Data Sources",
      "Report Workflow",
      "Citation Checker",
      "Eval Report",
      "Architecture",
      "Settings",
    ]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onSelectView).not.toHaveBeenCalled();
  });

  it("keeps non-Settings profile entries routed to their workspace views", () => {
    const { onSelectView, onOpenSettings } = renderSidebar();
    fireEvent.click(
      screen.getByRole("button", { name: /捡垃圾的小帅|不化妆的小美/ }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Data Sources" }));
    expect(onSelectView).toHaveBeenCalledWith("data-sources");
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it("keeps the first-level workspace navigation", () => {
    renderSidebar();
    expect(screen.getByRole("navigation", { name: "工作区导航" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Immersive" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "定时任务" })).toBeTruthy();
  });
});
