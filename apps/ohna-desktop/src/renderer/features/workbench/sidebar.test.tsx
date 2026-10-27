import type { ConversationSummaryDto } from "@aiagent/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationSidebar, groupConversationsByWorkspace } from "./sidebar";

/**
 * 构造会话 fixture。
 *
 * @param id 会话 id。
 * @param title 标题。
 * @param workspaceId 产生工作区 ID。
 * @param lastMessageAt 最近更新时间。
 * @returns 会话 DTO。
 */
function conversation(
  id: string,
  title: string,
  workspaceId: string,
  lastMessageAt: string
): ConversationSummaryDto {
  return {
    conversationId: id,
    title,
    status: "active",
    createdAt: lastMessageAt,
    updatedAt: lastMessageAt,
    lastMessageAt,
    workspaceId
  };
}

afterEach(() => cleanup());

const conversations = [
  conversation("c1", "目录 A 新会话", "work-a", "2026-10-20T03:00:00.000Z"),
  conversation("c2", "目录 A 旧会话", "work-a", "2026-10-20T01:00:00.000Z"),
  conversation("c3", "目录 B 会话", "work-b", "2026-10-20T02:00:00.000Z")
];

describe("groupConversationsByWorkspace", () => {
  it("按工作区分组、组内按时间倒序、组间按组内最新时间倒序", () => {
    const groups = groupConversationsByWorkspace(conversations);
    expect(groups.map((group) => group.workspaceId)).toEqual(["work-a", "work-b"]);
    expect(groups[0].label).toBe("work-a");
    expect(groups[0].conversations.map((item) => item.conversationId)).toEqual(["c1", "c2"]);
    expect(groups[1].conversations.map((item) => item.conversationId)).toEqual(["c3"]);
  });
});

/**
 * 渲染侧栏并返回常用回调。
 *
 * @returns 渲染结果与选择/归档回调。
 */
function renderSidebar() {
  const onSelectConversation = vi.fn();
  const onArchiveConversation = vi.fn();
  render(
    <ConversationSidebar
      activeConversationId="c1"
      conversations={conversations}
      error={undefined}
      hasMore={false}
      isLoading={false}
      isOpen={false}
      onArchiveConversation={onArchiveConversation}
      onClose={vi.fn()}
      onLoadMore={vi.fn()}
      onNewConversation={vi.fn()}
      onOpenSettings={vi.fn()}
      onRetry={vi.fn()}
      onSelectConversation={onSelectConversation}
    />
  );
  return { onSelectConversation, onArchiveConversation };
}

/**
 * 取工作区分组头按钮。
 *
 * 组头可访问名形如 `工作区 <label>（<count> 个会话）`；会话按钮的可访问名是标题+相对时间，
 * 两者的命令空间不同，不会混淆。
 *
 * @param label 组头目录名。
 * @param count 组内会话数量。
 * @returns 组头按钮元素。
 */
function groupHeader(label: string, count: number): HTMLElement {
  return screen.getByRole("button", { name: `工作区 ${label}（${count} 个会话）` });
}

/**
 * 取组内会话选择按钮（按标题前缀精确匹配，排除归档按钮）。
 *
 * @param title 会话标题。
 * @returns 会话选择按钮。
 */
function conversationButton(title: string): HTMLElement | null {
  return screen.queryByRole("button", { name: new RegExp(`^${title}最近更新`) });
}

describe("ConversationSidebar 分组", () => {
  it("渲染工作区分组头，展示目录名与数量", () => {
    renderSidebar();
    expect(conversationButton("目录 A 新会话")).toBeTruthy();
    expect(groupHeader("work-a", 2)).toBeTruthy();
    expect(groupHeader("work-b", 1)).toBeTruthy();
  });

  it("折叠组只隐藏该组会话，其他组不受影响", () => {
    renderSidebar();
    const header = groupHeader("work-a", 2);
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(conversationButton("目录 A 新会话")).toBeNull();
    expect(conversationButton("目录 A 旧会话")).toBeNull();
    // B 组仍可见。
    expect(conversationButton("目录 B 会话")).toBeTruthy();
  });

  it("组头点击可再次展开", () => {
    renderSidebar();
    const header = groupHeader("work-a", 2);
    fireEvent.click(header);
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(conversationButton("目录 A 新会话")).toBeTruthy();
  });
});
