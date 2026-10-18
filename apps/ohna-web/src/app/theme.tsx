import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: "light" | "dark";
  setPreference: (preference: ThemePreference) => void;
}

// 本地应用独立命名空间，不与 finance-web 共享 localStorage key。
const STORAGE_KEY = "ohna.theme";
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
    }
  }), [preference, systemDark]);

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
