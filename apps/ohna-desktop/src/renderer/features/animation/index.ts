/**
 * ohna-web 轻量动效模块（Lottie 承载）。
 *
 * 集合设计系统的克制动效：空状态插画、Agent 活动指示、完成微动画。
 * 全部经由 {@link LottiePlayer} 懒加载，并尊重 `prefers-reduced-motion` 与测试环境降级。
 */
export { LottiePlayer } from "./LottiePlayer";
export { usePrefersReducedMotion } from "./use-prefers-reduced-motion";
