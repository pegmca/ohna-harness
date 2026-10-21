/**
 * 「外观」分区（03 L3-2）：主题三态 + 界面字号。
 *
 * 两项偏好都只写 localStorage（`ohna.theme` / `ohna.ui.fontSize`），改完立即生效、刷新保持；
 * 字号通过根节点 font-size 缩放实现，对话页与 Trace 抽屉随之等比缩放。
 */
import { Monitor, Moon, Sun } from "lucide-react";
import { FONT_SCALE_OPTIONS, type FontScalePreference, type ThemePreference, useUiPreferences } from "../../app/theme";
import { SettingsSection } from "./settings-primitives";

/** 主题选项元数据（图标 + 文案）。 */
const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  hint: string;
  icon: typeof Sun;
}> = [
  { value: "light", label: "浅色", hint: "始终使用浅色界面", icon: Sun },
  { value: "dark", label: "深色", hint: "始终使用深色界面", icon: Moon },
  { value: "system", label: "跟随系统", hint: "随操作系统外观切换", icon: Monitor }
];

/**
 * 渲染外观分区。
 *
 * @returns 外观分区。
 */
export function AppearanceSection() {
  const { preference, setPreference, fontScale, setFontScale } = useUiPreferences();
  return (
    <SettingsSection description="偏好保存在本机浏览器，不写入服务端。" id="appearance" title="外观">
      <div className="settings-subsection">
        <h3>界面主题</h3>
        <div className="theme-options" role="radiogroup" aria-label="界面主题">
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon;
            const active = preference === option.value;
            return (
              <button
                aria-checked={active}
                className={`theme-option ${active ? "is-active" : ""}`}
                key={option.value}
                onClick={() => setPreference(option.value)}
                role="radio"
                type="button"
              >
                <Icon aria-hidden="true" />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.hint}</small>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="settings-subsection">
        <h3>界面字号</h3>
        <p className="settings-helper">调整根字号，全站等比缩放（对话页、Trace 抽屉同步生效）。</p>
        <div className="theme-options settings-font-options" role="radiogroup" aria-label="界面字号">
          {FONT_SCALE_OPTIONS.map((option) => {
            const active = option.value === fontScale;
            return (
              <button
                aria-checked={active}
                className={`theme-option ${active ? "is-active" : ""}`}
                key={option.value}
                onClick={() => setFontScale(option.value as FontScalePreference)}
                role="radio"
                type="button"
              >
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.percent}%</small>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </SettingsSection>
  );
}
