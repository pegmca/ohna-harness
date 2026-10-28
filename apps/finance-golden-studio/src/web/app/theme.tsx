import { createContext, useContext, useEffect, useMemo } from "react";
import type { ReactNode } from "react";

/** 主题偏好值。 */
export type ThemePreference = "system" | "light" | "dark";

/** 主题上下文暴露的当前偏好与更新方法。 */
interface ThemeContextValue {
  preference: ThemePreference;
  setPreference: (value: ThemePreference) => void;
}

/** React 主题上下文。 */
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/** localStorage 中保存主题偏好的键。 */
const THEME_STORAGE_KEY = "golden-studio-theme";

/**
 * 主题提供者：把用户偏好同步到 documentElement 的 data-theme。
 *
 * @param children React 子节点。
 * @returns 主题上下文提供者。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const preference = readStoredPreference();

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = preference;
    if (preference !== "system") return;
    root.removeAttribute("data-theme");
  }, [preference]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      setPreference: (next) => {
        globalThis.localStorage?.setItem(THEME_STORAGE_KEY, next);
      }
    }),
    [preference]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * 读取当前主题上下文。
 *
 * @returns 主题偏好与更新方法。
 * @throws {Error} 未包裹 ThemeProvider 时抛出。
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider.");
  return context;
}

/**
 * 从 localStorage 读取主题偏好。
 *
 * @returns 合法主题偏好；非法或缺省时为 system。
 */
function readStoredPreference(): ThemePreference {
  const value = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" ? value : "system";
}
