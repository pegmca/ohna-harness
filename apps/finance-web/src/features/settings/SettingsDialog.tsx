/**
 * 金融工作台设置弹窗：视觉与信息层级对齐 ohna-desktop 的左下角入口与玻璃浮层。
 *
 * 金融产品保留自己的账户、QQ 绑定和图表声明；关闭即卸载内容，轮询随之中止。
 */
import type {
  ApiResult,
  QqBindingChallengeDto,
  QqBindingStatusDto,
} from "@aiagent/types";
import {
  Copy,
  Link2,
  Monitor,
  Moon,
  RefreshCw,
  Settings as SettingsIcon,
  Sun,
  Unlink,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIdentity } from "../../app/identity";
import {
  FONT_SCALE_OPTIONS,
  type FontScalePreference,
  type ThemePreference,
  useTheme,
} from "../../app/theme";
import { useDialogFocus } from "./use-dialog-focus";

const options: Array<{
  value: ThemePreference;
  label: string;
  description: string;
  icon: typeof Sun;
}> = [
  { value: "light", label: "浅色", description: "暖白研究画布", icon: Sun },
  { value: "dark", label: "深色", description: "低眩光深色画布", icon: Moon },
  {
    value: "system",
    label: "跟随系统",
    description: "随系统外观切换",
    icon: Monitor,
  },
];

/**
 * 渲染设置弹窗；关闭状态下不产生 DOM，也不启动 QQ 绑定轮询。
 *
 * @param props 展开状态与关闭回调。
 * @returns 设置弹窗。
 */
export function SettingsDialog(props: {
  isOpen: boolean;
  onClose: () => void;
}) {
  if (!props.isOpen) return null;
  return <SettingsDialogContent onClose={props.onClose} />;
}

/**
 * 设置弹窗的挂载期内容，负责分区导航、焦点与轮询。
 *
 * @param props 关闭回调。
 * @returns 遮罩与设置面板。
 */
function SettingsDialogContent(props: { onClose: () => void }) {
  const theme = useTheme();
  const identity = useIdentity();
  const [challenge, setChallenge] = useState<QqBindingChallengeDto>();
  const [bindingStatus, setBindingStatus] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => props.onClose(), [props.onClose]);
  useDialogFocus(panelRef, close);

  useEffect(() => {
    if (!challenge) return;
    const timer = window.setInterval(() => {
      void fetch(
        `/api/identity/qq-binding-challenges/${encodeURIComponent(challenge.challengeId)}`,
      )
        .then(
          (response) =>
            response.json() as Promise<ApiResult<QqBindingStatusDto>>,
        )
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

  /**
   * 创建一次性 QQ 绑定挑战。
   *
   * @returns 请求完成 Promise。
   */
  async function createBinding(): Promise<void> {
    setActionError(undefined);
    const response = await fetch("/api/identity/qq-binding-challenges", {
      method: "POST",
    });
    const result = (await response.json()) as ApiResult<QqBindingChallengeDto>;
    if (!result.ok) {
      setActionError(result.error.message);
      return;
    }
    setChallenge(result.data);
    setBindingStatus("pending");
  }

  /**
   * 解除当前用户的 QQ 绑定。
   *
   * @returns 请求完成 Promise。
   */
  async function unbind(): Promise<void> {
    setActionError(undefined);
    const response = await fetch("/api/identity/qq-identity", {
      method: "DELETE",
    });
    const result = (await response.json()) as ApiResult<unknown>;
    if (!result.ok) {
      setActionError(result.error.message);
      return;
    }
    await identity.refresh();
  }

  return (
    <div
      className="settings-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        aria-labelledby="finance-settings-title"
        aria-modal="true"
        className="settings-dialog"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="settings-dialog-header">
          <div className="settings-dialog-title-group">
            <p className="md-label">
              <SettingsIcon aria-hidden="true" className="icon-size" />
              设置
            </p>
            <h1 className="settings-title" id="finance-settings-title">
              设置
            </h1>
            <p className="settings-subtitle">适用于当前金融研究工作台</p>
          </div>
          <button
            aria-label="关闭设置"
            className="icon-button"
            onClick={close}
            title="关闭"
            type="button"
          >
            <X className="icon-size" />
          </button>
        </header>

        <div className="settings-dialog-layout">
          <nav aria-label="设置分区" className="settings-nav">
            <a className="settings-nav-item" href="#settings-appearance">
              <span>外观</span>
              <small>主题与界面字号</small>
            </a>
            <a className="settings-nav-item" href="#settings-account">
              <span>账户与连接</span>
              <small>身份与 QQ 绑定</small>
            </a>
            <a className="settings-nav-item" href="#settings-about">
              <span>关于</span>
              <small>图表与数据说明</small>
            </a>
          </nav>

          <div className="settings-content">
            <section className="settings-section" id="settings-appearance">
              <header className="settings-section-header">
                <h2>外观</h2>
                <p>偏好保存在本机浏览器，不写入服务端。</p>
              </header>
              <div className="settings-subsection">
                <h3>界面主题</h3>
                <div
                  className="theme-options"
                  role="radiogroup"
                  aria-label="界面主题"
                >
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
                        <span>
                          <strong>{option.label}</strong>
                          <small>{option.description}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="settings-subsection">
                <h3>界面字号</h3>
                <p className="settings-helper">
                  调整根字号，对话、图表与详情同步缩放。当前主题：
                  {theme.resolvedTheme === "light" ? "浅色" : "深色"}。
                </p>
                <div
                  className="theme-options settings-font-options"
                  role="radiogroup"
                  aria-label="界面字号"
                >
                  {FONT_SCALE_OPTIONS.map((option) => (
                    <button
                      aria-checked={theme.fontScale === option.value}
                      className={`theme-option ${theme.fontScale === option.value ? "is-active" : ""}`}
                      key={option.value}
                      onClick={() =>
                        theme.setFontScale(option.value as FontScalePreference)
                      }
                      role="radio"
                      type="button"
                    >
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.percent}%</small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="settings-section" id="settings-account">
              <header className="settings-section-header">
                <h2>账户与连接</h2>
                <p>当前浏览器身份和 QQ Bot 绑定状态。</p>
              </header>
              <dl className="identity-facts">
                <div>
                  <dt>User ID</dt>
                  <dd>{identity.identity?.userId ?? "正在校验身份…"}</dd>
                </div>
                <div>
                  <dt>QQ Bot</dt>
                  <dd>{identity.identity?.qqBot.status ?? "正在读取…"}</dd>
                </div>
                <div>
                  <dt>QQ 绑定</dt>
                  <dd>
                    {identity.identity?.qqIdentity
                      ? `已绑定 · ${identity.identity.qqIdentity.botAccountId}`
                      : identity.identity
                        ? "未绑定"
                        : "正在校验身份…"}
                  </dd>
                </div>
              </dl>
              {identity.identity?.qqIdentity ? (
                <button
                  className="secondary-action"
                  onClick={() => void unbind()}
                  type="button"
                >
                  <Unlink aria-hidden="true" />
                  解除 QQ 绑定
                </button>
              ) : challenge ? (
                <div className="qq-binding-panel">
                  {challenge.botQrUrl ? (
                    <img
                      alt="QQ Bot 二维码"
                      className="qq-bot-qr"
                      src={challenge.botQrUrl}
                    />
                  ) : (
                    <div className="qq-qr-missing">未配置固定二维码 URL</div>
                  )}
                  <div>
                    <p>扫描统一 Bot 二维码后，在 QQ 私聊发送：</p>
                    <code>{challenge.command}</code>
                    <p className="settings-helper">
                      状态：{bindingStatus} ·{" "}
                      {new Date(challenge.expiresAt).toLocaleTimeString()}{" "}
                      前有效
                    </p>
                    <button
                      className="secondary-action"
                      onClick={() =>
                        void navigator.clipboard.writeText(challenge.command)
                      }
                      type="button"
                    >
                      <Copy aria-hidden="true" />
                      复制命令
                    </button>
                  </div>
                </div>
              ) : identity.identity ? (
                <button
                  className="primary-action"
                  disabled={!identity.identity.qqBot.enabled}
                  onClick={() => void createBinding()}
                  type="button"
                >
                  {identity.identity.qqBot.enabled ? (
                    <Link2 aria-hidden="true" />
                  ) : (
                    <RefreshCw aria-hidden="true" />
                  )}
                  {identity.identity.qqBot.enabled
                    ? "绑定 QQ"
                    : "QQ Bot 尚未配置"}
                </button>
              ) : null}
              {actionError ? (
                <p className="settings-error" role="alert">
                  {actionError}
                </p>
              ) : null}
            </section>

            <section className="settings-section" id="settings-about">
              <header className="settings-section-header">
                <h2>关于</h2>
                <p>金融图表和行情数据来源说明。</p>
              </header>
              <p className="settings-helper">
                金融图表由 TradingView Lightweight Charts™
                提供渲染能力，行情数据由 Immersive 工具层提供。
              </p>
              <a
                href="https://www.tradingview.com/"
                rel="noreferrer"
                target="_blank"
              >
                访问 TradingView
              </a>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
