import type { ApiResult, QqBindingChallengeDto, QqBindingStatusDto } from "@aiagent/types";
import { Copy, Link2, Monitor, Moon, RefreshCw, Sun, Unlink } from "lucide-react";
import { useEffect, useState } from "react";
import { useIdentity } from "../../app/identity";
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
  const identity = useIdentity();
  const [challenge, setChallenge] = useState<QqBindingChallengeDto>();
  const [bindingStatus, setBindingStatus] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  useEffect(() => {
    if (!challenge) return;
    const timer = window.setInterval(() => {
      void fetch(`/api/identity/qq-binding-challenges/${encodeURIComponent(challenge.challengeId)}`)
        .then((response) => response.json() as Promise<ApiResult<QqBindingStatusDto>>)
        .then(async (result) => {
          if (!result.ok) {
            setActionError(result.error.message);
            return;
          }
          setBindingStatus(result.data.status);
          if (result.data.status === "bound") {
            window.clearInterval(timer);
            setChallenge(undefined);
            await identity.refresh();
          }
        });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [challenge, identity]);

  async function createBinding(): Promise<void> {
    setActionError(undefined);
    const response = await fetch("/api/identity/qq-binding-challenges", { method: "POST" });
    const result = await response.json() as ApiResult<QqBindingChallengeDto>;
    if (!result.ok) {
      setActionError(result.error.message);
      return;
    }
    setChallenge(result.data);
    setBindingStatus("pending");
  }

  async function unbind(): Promise<void> {
    setActionError(undefined);
    const response = await fetch("/api/identity/qq-identity", { method: "DELETE" });
    const result = await response.json() as ApiResult<unknown>;
    if (!result.ok) {
      setActionError(result.error.message);
      return;
    }
    await identity.refresh();
  }
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
        <section className="settings-card identity-settings-card">
          <div>
            <h3>QQ 机器人</h3>
          </div>
          <dl className="identity-facts">
            <div><dt>User ID</dt><dd>{identity.identity.userId}</dd></div>
            <div><dt>QQ Bot</dt><dd>{identity.identity.qqBot.status}</dd></div>
            <div><dt>QQ 绑定</dt><dd>{identity.identity.qqIdentity ? `已绑定 · ${identity.identity.qqIdentity.botAccountId}` : "未绑定"}</dd></div>
          </dl>
          {identity.identity.qqIdentity ? (
            <button className="secondary-action" onClick={() => void unbind()} type="button"><Unlink aria-hidden="true" />解除 QQ 绑定</button>
          ) : challenge ? (
            <div className="qq-binding-panel">
              {challenge.botQrUrl ? <img alt="QQ Bot 二维码" className="qq-bot-qr" src={challenge.botQrUrl} /> : <div className="qq-qr-missing">未配置固定二维码 URL</div>}
              <div>
                <p>扫描统一 Bot 二维码后，在 QQ 私聊发送：</p>
                <code>{challenge.command}</code>
                <p className="settings-helper">状态：{bindingStatus} · {new Date(challenge.expiresAt).toLocaleTimeString()} 前有效</p>
                <button className="secondary-action" onClick={() => void navigator.clipboard.writeText(challenge.command)} type="button"><Copy aria-hidden="true" />复制命令</button>
              </div>
            </div>
          ) : (
            <button className="primary-action" disabled={!identity.identity.qqBot.enabled} onClick={() => void createBinding()} type="button">
              {identity.identity.qqBot.enabled ? <Link2 aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              {identity.identity.qqBot.enabled ? "绑定 QQ" : "QQ Bot 尚未配置"}
            </button>
          )}
          {actionError ? <p className="settings-error" role="alert">{actionError}</p> : null}
        </section>
        <section className="settings-card">
          <div><h3>图表声明</h3><p>金融图表由 TradingView Lightweight Charts™ 提供渲染能力，行情数据由 Immersive 工具层提供。</p></div>
          <a href="https://www.tradingview.com/" rel="noreferrer" target="_blank">TradingView</a>
        </section>
      </div>
    </section>
  );
}
