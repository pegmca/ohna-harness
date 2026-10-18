import type { ConversationDto } from "@aiagent/types";
import { Archive, Plus, X } from "lucide-react";
import { formatRelativeTime } from "./format";

interface ConversationSidebarProps {
  activeConversationId: string | undefined;
  conversations: ConversationDto[];
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

/**
 * 展示服务端会话列表；移动端作为 drawer，桌面端作为固定左栏。
 * 本地版无工作区导航与个人中心（W-1/W-6：无登录、无 SaaS 块）。
 *
 * @param props 组件属性。
 * @returns 会话侧栏。
 */
export function ConversationSidebar(props: ConversationSidebarProps) {
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
          {props.conversations.map((conversation) => (
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
          ))}
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
