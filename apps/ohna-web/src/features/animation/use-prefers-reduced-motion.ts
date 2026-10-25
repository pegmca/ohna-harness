import { useEffect, useState } from "react";

/**
 * 读取系统「减少动效」偏好，并在用户切换时实时更新。
 *
 * Immersive 设计系统要求所有动效尊重 `prefers-reduced-motion`：命中时 Lottie 等
 * 非必要动画必须回落到静态渲染（见 DESIGN.md 的 Motion 章节）。该 hook 同时处理 SSR /
 * jsdom 测试环境（无 `window.matchMedia` 时一律视为「允许动效」，由 LottiePlayer 的
 * 测试守卫随后安全降级）。
 *
 * @returns 是否应减少动效（true = 用户要求尽量静态）。
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => getInitialReducedMotion());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = (event: MediaQueryListEvent): void => setReduced(event.matches);
    setReduced(media.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  return reduced;
}

/** 取初始「减少动效」状态；环境缺失时返回 false，交由渲染层守卫处理。 */
function getInitialReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
