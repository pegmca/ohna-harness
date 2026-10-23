/**
 * 设置弹窗（FR-001 / 03 L3 改造）：左下角入口点击后就地弹出，不再有 `/settings` 路由。
 *
 * 边界（迁移自原 `SettingsPage`，刻意不做的事保持不变）：
 * - **不做任何写配置**：模型、权限、CLI 参数都在 ohna 进程侧，Web 只读展示；
 *   UI 偏好（主题/字号）只写 localStorage，不产生服务端写请求；
 * - **不做搜索框**：分区少（5 个），收益低，留作开放项。
 *
 * 弹窗职责只做「编排」：分区目录来自 `settings-primitives`，健康探针来自 `settings-health`，
 * 五个分区组件只做展示。关闭即卸载内容 → `useSettingsHealth` 的 AbortController 随之中止请求。
 */
import { Settings as SettingsIcon, X } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import { AboutSection } from "./AboutSection";
import { AppearanceSection } from "./AppearanceSection";
import { ConnectionSection } from "./ConnectionSection";
import { ModelsSection } from "./ModelsSection";
import { PermissionSection } from "./PermissionSection";
import { useSettingsHealth } from "./settings-health";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./settings-primitives";
import { useDialogFocus } from "./use-dialog-focus";

/** 弹窗关闭动因：只用于可选回调，测试与埋点可按来源区分。 */
export type SettingsDialogCloseReason = "button" | "backdrop" | "escape";

interface SettingsDialogProps {
  /** 是否展开；收起时整体不渲染，保证分区组件与探针随之卸载。 */
  isOpen: boolean;
  /** 请求关闭（ESC / 遮罩 / 关闭按钮）。 */
  onClose: (reason: SettingsDialogCloseReason) => void;
}

/**
 * 渲染设置弹窗；未打开时不渲染任何 DOM（避免后台继续触发只读探针）。
 *
 * @param props 组件属性。
 * @returns 设置弹窗；关闭态返回 null。
 */
export function SettingsDialog(props: SettingsDialogProps) {
  if (!props.isOpen) return null;
  return <SettingsDialogContent onClose={props.onClose} />;
}

/**
 * 弹窗内容壳：只在打开期挂载，因此健康探针与会话级副作用都随关闭卸载。
 *
 * 交互：
 * - ESC / 遮罩点击 / 右上角关闭按钮关闭；
 * - 打开前记录焦点、把焦点移入面板，关闭后归还给触发按钮（左下角设置按钮）；
 * - 轻量 Tab 焦点环：焦点不逃逸到遮罩之外的页面内容。
 *
 * @param props.onClose 请求关闭回调。
 * @returns 遮罩 + 居中面板。
 */
function SettingsDialogContent(props: { onClose: (reason: SettingsDialogCloseReason) => void }) {
  // 解构 props：hook 依赖必须指向具体回调，而不是每次渲染都换引用的 props 对象。
  const { onClose } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const health = useSettingsHealth();
  // 五分区一次渲染、锚点跳转；分区是静态目录，用 memo 避免每次 health 更新重建。
  const sections = useMemo(() => SETTINGS_SECTIONS, []);
  // 稳定引用：useDialogFocus 的依赖里含 onClose，每次渲染换新函数会导致监听反复重绑。
  const requestClose = useCallback(() => onClose("escape"), [onClose]);
  useDialogFocus(panelRef, requestClose);

  return (
    <div
      className="settings-dialog-backdrop"
      // 只有「按下点就是遮罩本身」才关闭：在面板内按下、拖到遮罩上松开（选中文本）不应关窗。
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose("backdrop");
      }}
    >
      <div
        aria-labelledby="settings-dialog-title"
        aria-modal="true"
        className="settings-dialog md-card"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="settings-dialog-header">
          <div className="settings-dialog-title-group">
            <p className="md-label"><SettingsIcon aria-hidden="true" className="icon-size" />设置</p>
            <h1 className="settings-title" id="settings-dialog-title">设置</h1>
            <p className="settings-subtitle">适用于当前 ohna 进程 · 由启动参数决定</p>
          </div>
          <button
            aria-label="关闭设置"
            className="icon-button"
            onClick={() => onClose("button")}
            title="关闭"
            type="button"
          >
            <X className="icon-size" />
          </button>
        </header>

        <div className="settings-dialog-layout">
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
      </div>
    </div>
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
