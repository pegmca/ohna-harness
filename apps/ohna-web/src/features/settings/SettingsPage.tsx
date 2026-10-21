/**
 * 设置页（03 L3 / D4）：分区锚点导航 + 内容区，布局对齐 CodeBuddy。
 *
 * 边界（本页刻意不做的事）：
 * - **不做任何写配置**：模型、权限、CLI 参数都在 ohna 进程侧，Web 只读展示；
 *   UI 偏好（主题/字号）只写 localStorage，不产生服务端写请求；
 * - **不做搜索框**：分区少（5 个），收益低，留作开放项。
 *
 * 数据：连接信息与模型目录来自既有只读端点（`/api/health`、`/api/models`）。
 */
import { useMemo } from "react";
import { WorkbenchNav } from "../../app/workbench-nav";
import { AboutSection } from "./AboutSection";
import { AppearanceSection } from "./AppearanceSection";
import { ConnectionSection } from "./ConnectionSection";
import { ModelsSection } from "./ModelsSection";
import { PermissionSection } from "./PermissionSection";
import { useSettingsHealth } from "./settings-health";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./settings-primitives";

/**
 * 渲染设置页。
 *
 * @returns 两栏设置页（左分区导航 + 右内容区）。
 */
export function SettingsPage() {
  const health = useSettingsHealth();
  // 五分区一次渲染、锚点跳转；分区是静态目录，用 memo 避免每次 health 更新重建。
  const sections = useMemo(() => SETTINGS_SECTIONS, []);

  return (
    <main className="settings-page">
      <header className="settings-header">
        <div>
          <p className="md-label">ohna · 本地编码 Agent</p>
          <h1 className="settings-title">设置</h1>
          <p className="settings-subtitle">适用于当前 ohna 进程 · 由启动参数决定</p>
        </div>
        <WorkbenchNav active="settings" />
      </header>

      <div className="settings-layout">
        <nav aria-label="设置分区" className="settings-nav">
          {sections.map((section) => (
            <a className="settings-nav-item" href={`#settings-${section.id}`} key={section.id}>
              <span>{section.label}</span>
              <small>{section.hint}</small>
            </a>
          ))}
        </nav>

        <div className="settings-content">
          <SectionBody id="connection" health={health} />
          <SectionBody id="appearance" health={health} />
          <SectionBody id="models" health={health} />
          <SectionBody id="permission" health={health} />
          <SectionBody id="about" health={health} />
        </div>
      </div>
    </main>
  );
}

/**
 * 按分区 ID 分发到具体分区组件（壳组件只做编排，分区组件只做展示）。
 *
 * @param props.id 分区 ID。
 * @param props.health 健康信息探针（连接/权限/关于共用一次请求）。
 * @returns 分区组件。
 */
function SectionBody(props: {
  id: SettingsSectionId;
  health: ReturnType<typeof useSettingsHealth>;
}) {
  switch (props.id) {
    case "connection":
      return <ConnectionSection health={props.health} />;
    case "appearance":
      return <AppearanceSection />;
    case "models":
      return <ModelsSection />;
    case "permission":
      return <PermissionSection health={props.health} />;
    case "about":
      return <AboutSection health={props.health} />;
    default:
      return null;
  }
}
