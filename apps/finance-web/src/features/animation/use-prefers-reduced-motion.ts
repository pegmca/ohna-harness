import { useEffect, useState } from "react";

/**
 * 读取系统「减少动效」偏好并监听变化。
 *
 * @returns 是否应减少动效。
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    getInitialReducedMotion(),
  );

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    )
      return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = (event: MediaQueryListEvent): void =>
      setReduced(event.matches);
    setReduced(media.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  return reduced;
}

/**
 * 读取初始减少动效偏好；非浏览器环境交给播放器的环境守卫处理。
 *
 * @returns 是否减少动效。
 */
function getInitialReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
