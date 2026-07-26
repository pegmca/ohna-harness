import type { ConversationDto } from "@aiagent/types";
import {
  Activity,
  Archive,
  Bot,
  ChevronDown,
  Clock3,
  Database,
  Plus,
  ShieldCheck,
  Network,
  BarChart3,
  Settings,
  X
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { formatRelativeTime } from "./format";
import type { WorkspaceView } from "./types";

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
  onSelectView: (view: WorkspaceView) => void;
  workspaceView: WorkspaceView;
}

/**
 * 展示服务端会话列表；移动端作为 drawer，桌面端作为固定左栏。
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
          <h1 className="sidebar-title"><span className="brand-mark sidebar-brand-mark" aria-hidden="true" /><span>Immersive</span></h1>
          <button className="icon-button mobile-only" onClick={props.onClose} type="button" aria-label="关闭">
            <X className="icon-size" />
          </button>
        </div>

        <button className="new-chat-button" onClick={props.onNewConversation} type="button">
          <Plus className="icon-size" />
          <span>New Chat</span>
        </button>

        <nav className="workspace-nav" aria-label="工作区导航">
          <button
            className={props.workspaceView === "chat" ? "is-active" : ""}
            onClick={() => props.onSelectView("chat")}
            type="button"
          >
            <Bot className="icon-size" />
            <span>Immersive</span>
          </button>
          <button
            className={props.workspaceView === "scheduled-tasks" ? "is-active" : ""}
            onClick={() => props.onSelectView("scheduled-tasks")}
            type="button"
          >
            <Clock3 className="icon-size" />
            <span>定时任务</span>
          </button>
        </nav>

        <div className="conversation-list">
          {props.isLoading && props.conversations.length === 0 ? <p className="muted-row">正在加载会话…</p> : null}
          {props.error ? (
            <div className="conversation-list-error">
              <span>{props.error}</span>
              <button className="secondary-button" onClick={props.onRetry} type="button">重试</button>
            </div>
          ) : null}
          {!props.isLoading && !props.error && props.conversations.length === 0
            ? <p className="muted-row">暂无历史会话，创建一个开始研究。</p>
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

        <SidebarProfileFooter
          onSelectView={props.onSelectView}
          workspaceView={props.workspaceView}
        />
      </aside>
    </>
  );
}

/** 二级入口中的工作区视图；点击一级头像入口后从上方弹出。 */
const PROFILE_MENU_VIEWS: ReadonlyArray<{ view: WorkspaceView; label: string; icon: ReactNode }> = [
  { view: "data-sources", label: "Data Sources", icon: <Database className="icon-size" /> },
  { view: "workflow", label: "Report Workflow", icon: <Activity className="icon-size" /> },
  { view: "citations", label: "Citation Checker", icon: <ShieldCheck className="icon-size" /> },
  { view: "eval", label: "Eval Report", icon: <BarChart3 className="icon-size" /> },
  { view: "architecture", label: "Architecture", icon: <Network className="icon-size" /> },
  { view: "settings", label: "Settings", icon: <Settings className="icon-size" /> }
];

/** 默认头像；昵称头像当前只做展示占位，不提供编辑功能。 */
const DEFAULT_AVATAR_URL = "http://43.130.49.34/cdn/img/march7-avatar-300.jpg";
const NICKNAME_STORAGE_KEY = "immersive:nickname";
const NICKNAME_POOL = ["捡垃圾的小帅", "不化妆的小美"] as const;

/**
 * 读取当前浏览器的展示昵称；首次访问时从固定昵称池随机挑一个写入 localStorage。
 *
 * @returns 稳定昵称。
 */
function useNickname(): string {
  const [nickname] = useState(() => {
    // 部分测试环境（Node 内置 localStorage 未启用时）没有 Web Storage，这里退化为每次随机。
    const storage = typeof window.localStorage === "undefined" ? undefined : window.localStorage;
    const existing = storage?.getItem(NICKNAME_STORAGE_KEY);
    if (existing) return existing;
    const picked = NICKNAME_POOL[Math.floor(Math.random() * NICKNAME_POOL.length)];
    storage?.setItem(NICKNAME_STORAGE_KEY, picked);
    return picked;
  });
  return nickname;
}

/**
 * 侧栏底部一级入口：头像 + 昵称；点击后向上弹出二级入口菜单。
 *
 * @param props 当前视图与视图切换回调。
 * @returns 底部用户信息区。
 */
function SidebarProfileFooter(props: { onSelectView: (view: WorkspaceView) => void; workspaceView: WorkspaceView }) {
  const nickname = useNickname();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const isMenuViewActive = PROFILE_MENU_VIEWS.some((item) => item.view === props.workspaceView);

  return (
    <footer className="sidebar-footer">
      {isMenuOpen ? (
        <button aria-label="关闭菜单" className="profile-menu-backdrop" onClick={() => setIsMenuOpen(false)} type="button" />
      ) : null}
      <div className="profile-menu-anchor">
        <button
          aria-expanded={isMenuOpen}
          aria-haspopup="menu"
          className={`profile-trigger ${isMenuOpen || isMenuViewActive ? "is-active" : ""}`}
          onClick={() => setIsMenuOpen((open) => !open)}
          type="button"
        >
          <img alt="" className="profile-avatar" src={DEFAULT_AVATAR_URL} />
          <span className="profile-nickname">{nickname}</span>
          <ChevronDown className={`icon-size profile-chevron ${isMenuOpen ? "is-open" : ""}`} />
        </button>
        {isMenuOpen ? (
          <div aria-label="工作区二级入口" className="profile-menu" role="menu">
            {PROFILE_MENU_VIEWS.map((item) => (
              <button
                className={props.workspaceView === item.view ? "is-active" : ""}
                key={item.view}
                onClick={() => {
                  setIsMenuOpen(false);
                  props.onSelectView(item.view);
                }}
                role="menuitem"
                type="button"
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </footer>
  );
}
