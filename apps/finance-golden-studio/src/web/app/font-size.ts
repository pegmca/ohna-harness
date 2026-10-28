/** 浏览器本地字号偏好。 */
export type FontSizePreference = "compact" | "comfortable" | "large";

/** localStorage 中保存字号偏好的键。 */
export const FONT_SIZE_STORAGE_KEY = "golden-studio-font-size";

/**
 * 读取合法字号偏好。
 *
 * @returns 已保存偏好，缺省为 comfortable。
 */
export function readFontSizePreference(): FontSizePreference {
  const value = globalThis.localStorage?.getItem(FONT_SIZE_STORAGE_KEY);
  return value === "compact" || value === "large" ? value : "comfortable";
}

/**
 * 持久化字号偏好。
 *
 * @param value 目标字号。
 */
export function saveFontSizePreference(value: FontSizePreference): void {
  globalThis.localStorage?.setItem(FONT_SIZE_STORAGE_KEY, value);
}
