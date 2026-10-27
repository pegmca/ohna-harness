/**
 * Chat 主区域容器（`chat-main`）：头部 / 确认卡片 / 时间线 / composer 的网格排版。
 * 「设置」入口已移至左侧会话栏（`sidebar.tsx` 底部），不再在此处渲染。
 *
 * 边界：本组件只负责排版，不持有业务状态；面板内容由页面以 children 注入，
 * 设置弹窗的开关状态留在 `Workbench`（弹窗挂在 `App` 的 ThemeProvider 之下）。
 */
import type { ReactNode } from "react";

interface ChatMainProps {
  /** 顶部栏。 */
  header: ReactNode;
  /** 待确认卡片（无卡片时传 null，不占网格行）。 */
  confirmations: ReactNode;
  /** 中央时间线。 */
  timeline: ReactNode;
  /** 底部 composer。 */
  composer: ReactNode;
  /** composer 表单 id：仅用于关联 composer 内部的提交控件。 */
  composerFormId: string;
}

/**
 * 渲染 chat 主区域（`chat-main` 网格，最后一行是 composer）。
 *
 * @param props 组件属性。
 * @returns chat 主区域。
 */
export function ChatMain(props: ChatMainProps) {
  return (
    <section className="chat-main" aria-label="Agent Chat 主区域">
      {props.header}
      {props.confirmations}
      {props.timeline}
      <div className="chat-main-footer">{props.composer}</div>
    </section>
  );
}
