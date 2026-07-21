import { Monitor, Moon, Sun } from "lucide-react";
import { type ThemePreference, useTheme } from "../../app/theme";

const options: Array<{ value: ThemePreference; label: string; description: string; icon: typeof Sun }> = [
  { value: "light", label: "浅色", description: "使用 Kimi 风格的暖白研究工作台。", icon: Sun },
  { value: "dark", label: "深色", description: "使用低眩光深色研究工作台。", icon: Moon },
  { value: "system", label: "跟随系统", description: "随操作系统主题自动切换。", icon: Monitor }
];

/**
 * 渲染工作台设置页，主题选择只更新全局语义 token。
 *
 * @param props 打开移动导航的回调。
 * @returns 设置页面。
 */
export function SettingsPage(props: { onMenuClick: () => void }) {
  const theme = useTheme();
  return (
    <section className="data-sources-main settings-main" aria-label="Settings">
      <header className="data-header">
        <button className="icon-button mobile-only" onClick={props.onMenuClick} type="button" aria-label="打开导航">☰</button>
        <div><p className="md-label">Immersive</p><h2 className="chat-title">Settings</h2></div>
      </header>
      <div className="settings-content">
        <section className="settings-card">
          <div><h3>外观</h3><p>选择界面主题。当前实际主题：{theme.resolvedTheme === "light" ? "浅色" : "深色"}。</p></div>
          <div className="theme-options" role="radiogroup" aria-label="主题">
            {options.map((option) => {
              const Icon = option.icon;
              return (
                <button
                  aria-checked={theme.preference === option.value}
                  className={`theme-option ${theme.preference === option.value ? "is-active" : ""}`}
                  key={option.value}
                  onClick={() => theme.setPreference(option.value)}
                  role="radio"
                  type="button"
                >
                  <Icon aria-hidden="true" />
                  <span><strong>{option.label}</strong><small>{option.description}</small></span>
                </button>
              );
            })}
          </div>
        </section>
        <section className="settings-card">
          <div><h3>图表声明</h3><p>金融图表由 TradingView Lightweight Charts™ 提供渲染能力，行情数据由 Immersive 工具层提供。</p></div>
          <a href="https://www.tradingview.com/" rel="noreferrer" target="_blank">TradingView</a>
        </section>
      </div>
    </section>
  );
}
