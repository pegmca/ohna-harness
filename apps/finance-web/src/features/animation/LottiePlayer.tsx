import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion.js";

/** Lottie 实例的最小生命周期契约。 */
interface LottieInstance {
  destroy(): void;
}

/** Lottie 播放配置；生产代码只使用 SVG 渲染。 */
interface LottieConfig {
  container: Element;
  renderer: "svg";
  loop: boolean;
  autoplay: boolean;
  animationData: object;
}

/**
 * 懒加载 lottie-web light 构建，避免动画库进入首屏主包。
 *
 * @returns Lottie 播放器模块。
 */
async function loadLottie(): Promise<{
  loadAnimation(config: LottieConfig): LottieInstance;
}> {
  const mod = await import("lottie-web/build/player/lottie_light");
  return mod.default as unknown as {
    loadAnimation(config: LottieConfig): LottieInstance;
  };
}

/**
 * 判断当前环境能否安全实例化 SVG 动画。
 *
 * @returns 是否可播放 Lottie。
 */
function isAnimationSafeEnvironment(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof window.matchMedia === "function" &&
    !navigator.userAgent.includes("jsdom")
  );
}

interface LottiePlayerProps {
  /** 已解析的动画 JSON。 */
  animationData: unknown;
  /** 是否循环；空态入场动画应播放一次。 */
  loop?: boolean;
  /** 渲染尺寸，单位 px。 */
  size?: number;
  /** 静态降级内容。 */
  fallback?: ReactNode;
  /** 附加样式。 */
  style?: CSSProperties;
}

/**
 * 金融工作台 Lottie 容器：尊重减少动效，卸载即销毁，异常时安全降级。
 *
 * @param props 动画数据与展示选项。
 * @returns Lottie 动画容器或静态回退。
 */
export function LottiePlayer(props: LottiePlayerProps) {
  const { animationData, loop = true, size, fallback, style } = props;
  const reducedMotion = usePrefersReducedMotion();
  const containerRef = useRef<HTMLSpanElement>(null);
  const animationRef = useRef<LottieInstance | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (reducedMotion || !isAnimationSafeEnvironment()) return;
    let disposed = false;
    void loadLottie()
      .then((lottie) => {
        if (disposed || !containerRef.current) return;
        const copy = JSON.parse(JSON.stringify(animationData)) as object;
        try {
          animationRef.current = lottie.loadAnimation({
            container: containerRef.current,
            renderer: "svg",
            loop,
            autoplay: true,
            animationData: copy,
          });
        } catch {
          setFailed(true);
        }
      })
      .catch(() => setFailed(true));

    return () => {
      disposed = true;
      animationRef.current?.destroy();
      animationRef.current = undefined;
    };
  }, [animationData, loop, reducedMotion]);

  if (failed) {
    return <>{fallback ?? null}</>;
  }

  return (
    <span
      data-lottie-animation={
        isAnimationSafeEnvironment() && !reducedMotion ? "" : "fallback"
      }
      ref={containerRef}
      aria-hidden="true"
      className="lottie-player"
      style={{ ...(size ? { width: size, height: size } : {}), ...style }}
    >
      {reducedMotion || !isAnimationSafeEnvironment() ? fallback : null}
    </span>
  );
}
