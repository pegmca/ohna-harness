/**
 * UI 偏好（03 L3）：主题三态 + 界面字号，统一持久化到 localStorage。
 *
 * 两条原则：
 * 1. **挂载前恢复**：`applyInitialTheme()` 在 `createRoot` 之前同步执行，避免首屏在
 *    浅色/深色或标准/大字号之间闪烁；
 * 2. **纯本地**：偏好只写 localStorage（`ohna.theme` / `ohna.ui.fontSize`），不产生任何服务端
 *    写请求——模型、权限与 CLI 参数都在 ohna 进程侧，web 设置页只读展示。
 *
 * 字号实现走根节点 `font-size` 缩放：全站排版使用 rem，因此改一处即可整体等比缩放。
 */
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";

/** 界面字号档位（根 font-size 缩放比例，标准 100%）。 */
export type FontScalePreference = "small" | "normal" | "large" | "xlarge";

/** 字号档位元数据：按「档位 → label / 百分比」集中定义，设置页与缩放逻辑共用。 */
export const FONT_SCALE_OPTIONS: ReadonlyArray<{
  value: FontScalePreference;
  label: string;
  percent: number;
}> = [
  { value: "small", label: "小", percent: 87.5 },
  { value: "normal", label: "标准", percent: 100 },
  { value: "large", label: "大", percent: 112.5 },
  { value: "xlarge", label: "特大", percent: 125 }
];

interface UiPreferencesContextValue {
  preference: ThemePreference;
  resolvedTheme: "light" | "dark";
  setPreference: (preference: ThemePreference) => void;
  fontScale: FontScalePreference;
  setFontScale: (fontScale: FontScalePreference) => void;
}

// 本地应用独立命名空间，不与 finance-web 共享 localStorage key；`ohna.theme` 保持既有 key 兼容。
const THEME_STORAGE_KEY = "ohna.theme";
const FONT_SCALE_STORAGE_KEY = "ohna.ui.fontSize";

const UiPreferencesContext = createContext<UiPreferencesContextValue | undefined>(undefined);

/**
 * 在 React 挂载前恢复全部 UI 偏好（主题 + 字号），避免首屏闪烁。
 *
 * @returns 当前有效主题偏好。
 */
export function applyInitialTheme(): ThemePreference {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  const preference: ThemePreference = stored === "light" || stored === "dark" || stored === "system"
    ? stored
    : "system";
  applyThemeAttribute(preference);
  applyFontScale(readStoredFontScale(window.localStorage.getItem(FONT_SCALE_STORAGE_KEY)));
  return preference;
}

/**
 * 提供主题与字号偏好并监听系统主题变化。
 *
 * @param props React children。
 * @returns UI 偏好 provider。
 */
export function ThemeProvider(props: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => applyInitialTheme());
  const [fontScale, setFontScaleState] = useState<FontScalePreference>(
    () => readStoredFontScale(window.localStorage.getItem(FONT_SCALE_STORAGE_KEY))
  );
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => applyThemeAttribute(preference), [preference, systemDark]);

  const value = useMemo<UiPreferencesContextValue>(() => ({
    preference,
    resolvedTheme: preference === "system" ? (systemDark ? "dark" : "light") : preference,
    setPreference(next) {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
      setPreferenceState(next);
    },
    fontScale,
    setFontScale(next) {
      window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, next);
      applyFontScale(next);
      setFontScaleState(next);
    }
  }), [preference, systemDark, fontScale]);

  return <UiPreferencesContext.Provider value={value}>{props.children}</UiPreferencesContext.Provider>;
}

/** @deprecated 使用 {@link useUiPreferences}；保留别名以兼容既有主题调用点。 */
export const useTheme = useUiPreferences;

/**
 * 读取 UI 偏好上下文，避免各 feature 直接操作 DOM 或 localStorage。
 *
 * @returns 当前主题、字号状态与更新函数。
 */
export function useUiPreferences(): UiPreferencesContextValue {
  const value = useContext(UiPreferencesContext);
  if (!value) throw new Error("useUiPreferences must be used inside ThemeProvider");
  return value;
}

/**
 * 把偏好解析成实际主题并写入根节点。
 *
 * @param preference 用户主题偏好。
 * @returns void。
 */
function applyThemeAttribute(preference: ThemePreference): void {
  const resolved = preference === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

/**
 * 把字号档位写入根节点 font-size（rem 全站等比缩放）。
 *
 * @param fontScale 字号档位。
 * @returns void。
 */
function applyFontScale(fontScale: FontScalePreference): void {
  const option = FONT_SCALE_OPTIONS.find((item) => item.value === fontScale) ?? FONT_SCALE_OPTIONS[1];
  document.documentElement.style.fontSize = `${option.percent}%`;
  document.documentElement.dataset.fontScale = option.value;
}

/**
 * 收敛存储值到合法字号档位；非法/缺失一律回落「标准」。
 *
 * @param stored localStorage 原始值。
 * @returns 合法字号档位。
 */
function readStoredFontScale(stored: string | null): FontScalePreference {
  return FONT_SCALE_OPTIONS.some((option) => option.value === stored)
    ? stored as FontScalePreference
    : "normal";
}
