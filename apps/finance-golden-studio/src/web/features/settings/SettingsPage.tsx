import { useEffect, useState } from "react";
import { FolderCog, Palette, Type } from "lucide-react";
import { useOptionalApiClient } from "../../app/context.tsx";
import { useOptionalTheme } from "../../app/theme.tsx";
import type { FontSizePreference } from "../../app/font-size.ts";
import { readFontSizePreference } from "../../app/font-size.ts";
import type { GoldenStudioClient } from "../../shared/api/client.ts";
import type { WorkspaceSettings } from "../../shared/api/types.ts";

export type { FontSizePreference } from "../../app/font-size.ts";

/** 设置页加载状态。 */
type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: WorkspaceSettings };

/** 设置页属性；客户端可注入以便组件测试。 */
export interface SettingsPageProps {
  /** 可选注入客户端；缺省读取 App 上下文。 */
  client?: GoldenStudioClient;
}

/**
 * 工作区配置与应用外观设置页面。
 *
 * @param props 注入的客户端。
 * @returns 只读 server 配置和本地偏好控件。
 */
export function SettingsPage({ client: injected }: SettingsPageProps = {}) {
  const client = useInjectedClient(injected);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    client
      .readWorkspaceSettings({ signal: controller.signal })
      .then((data) => setState({ status: "ready", data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: errorMessage(error) });
      });
    return () => controller.abort();
  }, [client]);

  return (
    <section className="workspace workspace-wide settings-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">
            Server configuration is read-only. Appearance preferences stay in this browser.
          </p>
        </div>
      </header>
      {state.status === "loading" ? (
        <p aria-live="polite" className="empty-state">
          Loading workspace settings
        </p>
      ) : null}
      {state.status === "error" ? (
        <div className="error-state" role="alert">
          <p className="error-title">Workspace settings could not be loaded</p>
          <p className="error-message">{state.message}</p>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <div className="settings-layout">
          <WorkspaceSection settings={state.data} />
          <AppearanceSection />
        </div>
      ) : null}
    </section>
  );
}

/**
 * 优先使用注入客户端；仅在路由组合根中读取上下文。
 *
 * @param injected 可选注入客户端。
 * @returns 数据客户端。
 */
function useInjectedClient(injected: GoldenStudioClient | undefined): GoldenStudioClient {
  const contextClient = useOptionalApiClient();
  const client = injected ?? contextClient;
  if (!client) throw new Error("SettingsPage requires an injected client or AppProvider.");
  return client;
}

/**
 * 渲染只读工作区与语料路径。
 *
 * @param props server 配置。
 * @returns 工作区配置分区。
 */
function WorkspaceSection({ settings }: { settings: WorkspaceSettings }) {
  return (
    <section aria-labelledby="settings-workspace" className="settings-panel">
      <div className="settings-heading">
        <FolderCog aria-hidden="true" size={18} />
        <div>
          <h2 id="settings-workspace">Workspace and corpus</h2>
          <p>Resolved by the local server process.</p>
        </div>
        <span className="badge badge-neutral">Read-only</span>
      </div>
      <dl className="settings-list">
        <SettingPath label="Workspace root" value={settings.workspaceRoot} />
        <SettingPath label="Corpus root" value={settings.corpusRoot} />
        <SettingPath label="Manifest" value={settings.manifestPath} />
        <SettingPath label="Authored golden" value={settings.goldenPath} />
        <SettingPath label="Generated eval" value={settings.generatedPath} />
      </dl>
    </section>
  );
}

/**
 * 渲染单个只读路径行。
 *
 * @param props 标签与路径。
 * @returns 定义列表行。
 */
function SettingPath({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-list-row">
      <dt>{label}</dt>
      <dd>
        <code>{value}</code>
      </dd>
    </div>
  );
}

/**
 * 渲染并持久化主题与字号偏好。
 *
 * @returns 本地外观分区。
 */
function AppearanceSection() {
  const theme = useOptionalTheme();
  const preference = theme?.preference ?? "system";
  const [localFontSize, setLocalFontSize] = useState<FontSizePreference>(
    readFontSizePreference
  );
  const fontSize = theme?.fontSize ?? localFontSize;

  useEffect(() => {
    if (theme) return;
    document.documentElement.dataset.fontSize = localFontSize;
  }, [localFontSize, theme]);

  const setFontSize = (next: FontSizePreference): void => {
    if (theme) {
      theme.setFontSize(next);
      return;
    }
    setLocalFontSize(next);
  };

  return (
    <section aria-labelledby="settings-appearance" className="settings-panel">
      <div className="settings-heading">
        <Palette aria-hidden="true" size={18} />
        <div>
          <h2 id="settings-appearance">Appearance</h2>
          <p>Saved locally for this browser.</p>
        </div>
      </div>
      <div className="settings-control-row">
        <div>
          <Palette aria-hidden="true" size={15} />
          <span>Theme</span>
        </div>
        <div aria-label="Theme" className="segmented-control" role="radiogroup">
          {(["system", "light", "dark"] as const).map((option) => (
            <button
              aria-checked={preference === option}
              className="segment"
              key={option}
              onClick={() => theme?.setPreference(option)}
              role="radio"
              type="button"
            >
              {titleCase(option)}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-control-row">
        <div>
          <Type aria-hidden="true" size={15} />
          <span>Font size</span>
        </div>
        <div aria-label="Font size" className="segmented-control" role="radiogroup">
          {(["compact", "comfortable", "large"] as const).map((option) => (
            <button
              aria-checked={fontSize === option}
              className="segment"
              key={option}
              onClick={() => setFontSize(option)}
              role="radio"
              type="button"
            >
              {titleCase(option)}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * 将小写枚举转为标题式文案。
 *
 * @param value 枚举文本。
 * @returns 首字母大写文本。
 */
function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * 提取可展示错误。
 *
 * @param error 捕获值。
 * @returns 错误文本。
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown request failure.";
}
import { ThemeProvider, useTheme } from "../../app/theme.tsx";
