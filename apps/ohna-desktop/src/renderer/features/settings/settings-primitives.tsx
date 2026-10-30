/**
 * 设置页的共享展示原语（03 L3）：分区容器 + 只读键值行 + 状态徽标。
 *
 * 设置页是「纯展示 + 本地偏好」，因此分区组件只消费这些原语，不各自发明排版；
 * 视觉沿用既有 `md-card` / `identity-facts` 语言（D5）。
 */
import type { ReactNode } from "react";

/** 设置页分区锚点 ID（分区导航与内容区共用）。 */
export type SettingsSectionId = "connection" | "appearance" | "models" | "permission" | "about";

/** 分区目录：顺序即导航顺序（对齐 CodeBuddy 的左侧分区导航）。 */
export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSectionId; label: string; hint: string }> = [
  { id: "connection", label: "连接状态", hint: "runtime 与工作区" },
  { id: "appearance", label: "外观", hint: "主题与界面字号" },
  { id: "models", label: "模型", hint: "用户配置与模型" },
  { id: "permission", label: "权限模式", hint: "只读与自动批准语义" },
  { id: "about", label: "关于", hint: "版本与项目链接" }
];

/**
 * 渲染一个设置分区（标题 + 说明 + 内容）。
 *
 * @param props.id 锚点 ID。
 * @param props.title 分区标题。
 * @param props.description 分区说明行。
 * @param props.children 分区内容。
 * @returns 分区容器。
 */
export function SettingsSection(props: {
  id: SettingsSectionId;
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`settings-${props.id}-title`} className="settings-section md-card" id={`settings-${props.id}`}>
      <header className="settings-section-header">
        <h2 id={`settings-${props.id}-title`}>{props.title}</h2>
        <p>{props.description}</p>
      </header>
      {props.children}
    </section>
  );
}

/**
 * 渲染只读键值列表（地址、目录、模式等事实）。
 *
 * @param props.items 键值对。
 * @returns 定义列表。
 */
export function SettingsFacts(props: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="identity-facts settings-facts">
      {props.items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 渲染状态徽标（复用 `md-badge` 配色语义）。
 *
 * @param props.tone 语义色。
 * @param props.children 文案。
 * @returns 徽标。
 */
export function SettingsBadge(props: { tone: "success" | "danger" | "info" | "neutral"; children: ReactNode }) {
  const cls = props.tone === "success"
    ? "md-badge-success"
    : props.tone === "danger"
      ? "md-badge-danger"
      : props.tone === "info"
        ? "md-badge-info"
        : "";
  return <span className={`md-badge ${cls}`.trim()}>{props.children}</span>;
}
