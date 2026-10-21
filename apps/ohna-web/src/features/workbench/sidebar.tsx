import type { WorkspaceConversationDto } from "@aiagent/types";
import { Archive, ChevronDown, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { formatRelativeTime } from "./format";

interface ConversationSidebarProps {
  activeConversationId: string | undefined;
  conversations: WorkspaceConversationDto[];
  error: string | undefined;
  hasMore: boolean;
  isLoading: boolean;
  isOpen: boolean;
  onArchiveConversation: (conversationId: string) => void;
  onClose: () => void;
  onLoadMore: () => void;
  onNewConversation: () => void;
  onRetry: () => void;
  onSelectConversation: (conversationId: string) => void;
}

/** 同一工作区下分组的会话。 */
interface WorkspaceGroup {
  /** 产生该组会话的 serve 实例工作区根目录（绝对路径）。 */
  workspaceRoot: string;
  /** 展示用目录名（路径最后一段）。 */
  label: string;
  /** 组内会话按 lastMessageAt 倒序。 */
  conversations: WorkspaceConversationDto[];
  /** 组内最新更新时间，用于组间排序。 */
  latestAt: string;
}

/**
 * 把绝对路径收敛为目录名（最后一段）。浏览器无 node:path，这里手写避免引入运行时依赖。
 *
 * @param root 工作区绝对路径。
 * @returns 目录 basename。
 */
function basenameOf(root: string): string {
  const segments = root.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : root;
}

/**
 * 按 workspaceRoot 把会话分组，组内按 lastMessageAt 倒序，组间按组内最新时间倒序。
 *
 * @param conversations 会话列表（已按 updatedAt 倒序）。
 * @returns 分组后的数组（顺序可直接渲染）。
 */
export function groupConversationsByWorkspace(conversations: WorkspaceConversationDto[]): WorkspaceGroup[] {
  const byRoot = new Map<string, WorkspaceConversationDto[]>();
  for (const conversation of conversations) {
    const root = conversation.workspaceRoot || "未分组";
    const list = byRoot.get(root);
    if (list) list.push(conversation);
    else byRoot.set(root, [conversation]);
  }
  const groups: WorkspaceGroup[] = [];
  for (const [workspaceRoot, list] of byRoot) {
    const sorted = [...list].sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt));
    groups.push({
      workspaceRoot,
      label: basenameOf(workspaceRoot),
      conversations: sorted,
      latestAt: sorted[0]?.lastMessageAt ?? ""
    });
  }
  return groups.sort((left, right) => right.latestAt.localeCompare(left.latestAt));
}

/**
 * 展示服务端会话列表；移动端作为 drawer，桌面端作为固定左栏。
 * 按 `workspaceRoot` 分组展示不同 CLI 工作目录产生的会话（D1），组头可折叠（仅影响该组）。
 *
 * @param props 组件属性。
 * @returns 会话侧栏。
 */
export function ConversationSidebar(props: ConversationSidebarProps) {
  // 折叠态只记在组件内，不持久化（会话列表是临时视图）。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groups = useMemo(() => groupConversationsByWorkspace(props.conversations), [props.conversations]);

  function toggleGroup(workspaceRoot: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(workspaceRoot)) next.delete(workspaceRoot);
      else next.add(workspaceRoot);
      return next;
    });
  }

  return (
    <>
      <button
        aria-label="关闭会话列表"
        className={`sidebar-backdrop ${props.isOpen ? "is-visible" : ""}`}
        onClick={props.onClose}
        type="button"
      />
      <aside className={`conversation-sidebar ${props.isOpen ? "is-open" : ""}`} aria-label="会话列表">
        <div className="sidebar-header">
          <h1 className="sidebar-title"><span className="brand-mark sidebar-brand-mark" aria-hidden="true" /><span>ohna</span></h1>
          <button className="icon-button mobile-only" onClick={props.onClose} type="button" aria-label="关闭">
            <X className="icon-size" />
          </button>
        </div>

        <button className="new-chat-button" onClick={props.onNewConversation} type="button">
          <Plus className="icon-size" />
          <span>New Chat</span>
        </button>

        <div className="conversation-list">
          {props.isLoading && props.conversations.length === 0 ? <p className="muted-row">正在加载会话…</p> : null}
          {props.error ? (
            <div className="conversation-list-error">
              <span>{props.error}</span>
              <button className="secondary-button" onClick={props.onRetry} type="button">重试</button>
            </div>
          ) : null}
          {!props.isLoading && !props.error && props.conversations.length === 0
            ? <p className="muted-row">暂无历史会话，创建一个开始编码。</p>
            : null}
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.workspaceRoot);
            return (
              <section className="conversation-group" key={group.workspaceRoot}>
                <button
                  aria-expanded={!isCollapsed}
                  // 可访问名固定为「工作区 <目录名>（<数量> 个会话）」，title 只补充全路径（不参与命令）。
                  aria-label={`工作区 ${group.label}（${group.conversations.length} 个会话）`}
                  className="conversation-group-header"
                  onClick={() => toggleGroup(group.workspaceRoot)}
                  title={group.workspaceRoot}
                  type="button"
                >
                  <ChevronDown className={`icon-size group-chevron ${isCollapsed ? "is-collapsed" : ""}`} />
                  <span className="conversation-group-label">{group.label}</span>
                  <span className="conversation-group-count">{group.conversations.length}</span>
                </button>
                {!isCollapsed ? (
                  group.conversations.map((conversation) => (
                    <div
                      className={`conversation-item ${
                        conversation.conversationId === props.activeConversationId ? "is-active" : ""
                      }`}
                      key={conversation.conversationId}
                    >
                      <button className="conversation-select" onClick={() => props.onSelectConversation(conversation.conversationId)} type="button">
                        <span className="conversation-title">{conversation.title}</span>
                        <span className="conversation-preview">最近更新 {formatRelativeTime(conversation.lastMessageAt)}</span>
                      </button>
                      <button
                        aria-label={`归档 ${conversation.title}`}
                        className="conversation-archive"
                        onClick={() => props.onArchiveConversation(conversation.conversationId)}
                        type="button"
                      ><Archive className="icon-size" /></button>
                    </div>
                  ))
                ) : null}
              </section>
            );
          })}
          {props.hasMore ? (
            <button className="secondary-button conversation-load-more" disabled={props.isLoading} onClick={props.onLoadMore} type="button">
              {props.isLoading ? "加载中…" : "加载更多"}
            </button>
          ) : null}
        </div>
      </aside>
    </>
  );
}
