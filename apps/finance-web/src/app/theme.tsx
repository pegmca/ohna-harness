/**
 * 金融工作台 UI 偏好：主题三态 + 界面字号。
 *
 * 视觉与 ohna-desktop 共用同一套 Glass Depths 偏好模型，但 localStorage 命名空间
 * 保持产品隔离；字号通过根节点 font-size 缩放，所有 rem 排版同步生效。
 */
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type FontScalePreference = "small" | "normal" | "large" | "xlarge";

/** 字号档位元数据：设置页与根字号缩放共用。 */
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

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: "light" | "dark";
  setPreference: (preference: ThemePreference) => void;
  fontScale: FontScalePreference;
  setFontScale: (fontScale: FontScalePreference) => void;
}

const STORAGE_KEY = "immersive.theme";
const FONT_SCALE_STORAGE_KEY = "immersive.ui.fontSize";
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/**
 * 在 React 挂载前恢复主题，避免浅色和深色之间出现首屏闪烁。
 *
 * @returns 当前有效主题偏好。
 */
export function applyInitialTheme(): ThemePreference {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  const preference: ThemePreference = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  applyThemeAttribute(preference);
  applyFontScale(readStoredFontScale(window.localStorage.getItem(FONT_SCALE_STORAGE_KEY)));
  return preference;
}

/**
 * 提供主题偏好并监听系统主题变化。
 *
 * @param props React children。
 * @returns 主题 provider。
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

  const value = useMemo<ThemeContextValue>(() => ({
    preference,
    resolvedTheme: preference === "system" ? (systemDark ? "dark" : "light") : preference,
    setPreference(next) {
      window.localStorage.setItem(STORAGE_KEY, next);
      setPreferenceState(next);
    },
    fontScale,
    setFontScale(next) {
      window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, next);
      applyFontScale(next);
      setFontScaleState(next);
    }
  }), [preference, systemDark, fontScale]);

  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>;
}

/**
 * 读取主题上下文，避免各 feature 直接操作 DOM 或 localStorage。
 *
 * @returns 当前主题状态和更新函数。
 */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
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
 * 把字号档位写入根节点 font-size。
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
 * 收敛存储值到合法字号档位；非法或缺失值回落标准档。
 *
 * @param stored localStorage 原始值。
 * @returns 合法字号档位。
 */
function readStoredFontScale(stored: string | null): FontScalePreference {
  return FONT_SCALE_OPTIONS.some((option) => option.value === stored)
    ? stored as FontScalePreference
    : "normal";
}
