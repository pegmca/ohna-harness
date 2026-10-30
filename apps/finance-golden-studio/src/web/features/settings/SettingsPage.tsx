import { useEffect, useState } from "react";
import { FolderCog, Palette, Type } from "lucide-react";
import { useOptionalApiClient } from "../../app/context.tsx";
import { useOptionalTheme } from "../../app/theme.tsx";
import type { ThemePreference } from "../../app/theme.tsx";
import type { FontSizePreference } from "../../app/font-size.ts";
import { readFontSizePreference } from "../../app/font-size.ts";
import type { GoldenStudioClient } from "../../shared/api/client.ts";
import type { WorkspaceSettings } from "../../shared/api/types.ts";

export type { FontSizePreference } from "../../app/font-size.ts";

/** 主题枚举的中文展示文案。 */
const THEME_LABELS: Record<ThemePreference, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色"
};

/** 字号枚举的中文展示文案。 */
const FONT_SIZE_LABELS: Record<FontSizePreference, string> = {
  compact: "紧凑",
  comfortable: "舒适",
  large: "大"
};

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
          <p className="eyebrow">工作区</p>
          <h1 className="page-title">设置</h1>
          <p className="page-subtitle">
            服务端配置为只读，外观偏好保存在当前浏览器。
          </p>
        </div>
      </header>
      {state.status === "loading" ? (
        <p aria-live="polite" className="empty-state">
          正在加载工作区设置
        </p>
      ) : null}
      {state.status === "error" ? (
        <div className="error-state" role="alert">
          <p className="error-title">无法加载工作区设置</p>
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
          <h2 id="settings-workspace">工作区与语料</h2>
          <p>由本地服务端进程解析。</p>
        </div>
        <span className="badge badge-neutral">只读</span>
      </div>
      <dl className="settings-list">
        <SettingPath label="工作区根目录" value={settings.workspaceRoot} />
        <SettingPath label="语料根目录" value={settings.corpusRoot} />
        <SettingPath label="清单" value={settings.manifestPath} />
        <SettingPath label="作者集" value={settings.goldenPath} />
        <SettingPath label="生成的评测集" value={settings.generatedPath} />
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
          <h2 id="settings-appearance">外观</h2>
          <p>仅保存在当前浏览器。</p>
        </div>
      </div>
      <div className="settings-control-row">
        <div>
          <Palette aria-hidden="true" size={15} />
          <span>主题</span>
        </div>
        <div aria-label="主题" className="segmented-control" role="radiogroup">
          {(["system", "light", "dark"] as const).map((option) => (
            <button
              aria-checked={preference === option}
              className="segment"
              key={option}
              onClick={() => theme?.setPreference(option)}
              role="radio"
              type="button"
            >
              {THEME_LABELS[option]}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-control-row">
        <div>
          <Type aria-hidden="true" size={15} />
          <span>字号</span>
        </div>
        <div aria-label="字号" className="segmented-control" role="radiogroup">
          {(["compact", "comfortable", "large"] as const).map((option) => (
            <button
              aria-checked={fontSize === option}
              className="segment"
              key={option}
              onClick={() => setFontSize(option)}
              role="radio"
              type="button"
            >
              {FONT_SIZE_LABELS[option]}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * 提取可展示错误。
 *
 * @param error 捕获值。
 * @returns 错误文本。
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知请求错误。";
}
import { ThemeProvider, useTheme } from "../../app/theme.tsx";
