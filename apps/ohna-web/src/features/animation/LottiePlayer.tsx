import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

/**
 * lottie-web 的 light 构建（无表达式解释器）体积更小，足够渲染本项目内置的纯形状动画。
 * 该子路径自带 `lottie_light.d.ts`，因此这里直接使用真实类型；运行时经动态 import
 * 懒加载，由 Vite 拆成独立 chunk，不进入首屏主包。
 */

/** lottie-web `loadAnimation` 返回的实例最小契约（本项目只用 destroy）。 */
interface LottieInstance {
  destroy(): void;
}

/** lottie-web `loadAnimation` 配置最小契约。 */
interface LottieConfig {
  container: Element;
  renderer: "svg";
  loop: boolean;
  autoplay: boolean;
  animationData: object;
}

/** 懒加载 lottie-web light 构建（静态字面量让打包器正确拆包）。 */
async function loadLottie(): Promise<{ loadAnimation(config: LottieConfig): LottieInstance }> {
  const mod = await import("lottie-web/build/player/lottie_light");
  return mod.default as unknown as { loadAnimation(config: LottieConfig): LottieInstance };
}

/** 测试 / 非浏览器环境守卫：jsdom 没有 SVG 渲染上下文，必须降级静态回退。 */
function isAnimationSafeEnvironment(): boolean {
  return typeof window !== "undefined"
    && typeof document !== "undefined"
    && typeof window.matchMedia === "function";
}

/** 把 `#RGB` / `#RRGGBB` / `rgb()` / `rgba()` 解析成 lottie 的 0–1 归一化 RGBA 数组。 */
function parseColorToRgba01(value: string): [number, number, number, number] | undefined {
  const text = value.trim();
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1].length === 3
      ? hex[1].split("").map((ch) => ch + ch).join("")
      : hex[1];
    const r = Number.parseInt(raw.slice(0, 2), 16) / 255;
    const g = Number.parseInt(raw.slice(2, 4), 16) / 255;
    const b = Number.parseInt(raw.slice(4, 6), 16) / 255;
    return [r, g, b, 1];
  }
  const rgb = text.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgb) {
    return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, 1];
  }
  return undefined;
}

/** 读取当前主题的青绿强调色（亮档为深薄荷，暗档为亮青绿）。 */
function readThemeAccent(): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue("--md-color-primary").trim();
}

/**
 * 递归把动画里的填充/描边颜色替换为目标色。
 *
 * lottie 的形状节点以 `ty: "fl"`（填充）或 `ty: "st"`（描边）标识，颜色在 `c.k` 数组里。
 * 本项目内置动画均使用静态颜色（`c.a === 0`），因此只改写数组形态的 `k`。
 *
 * @param node 动画 JSON 子树（应为深拷贝后的副本）。
 * @param rgba 归一化 RGBA。
 * @returns void。
 */
function tintShapes(node: unknown, rgba: [number, number, number, number]): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const ty = record.ty;
  if ((ty === "fl" || ty === "st") && record.c && typeof record.c === "object") {
    const color = record.c as { a?: unknown; k?: unknown };
    if (color.a === 0 && Array.isArray(color.k) && color.k.length >= 3) {
      color.k = [...rgba];
    }
  }
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (child && typeof child === "object") tintShapes(child, rgba);
  }
}

interface LottiePlayerProps {
  /** 已解析的 Lottie 动画数据（JSON 对象），由调用方静态 import 后传入。 */
  animationData: unknown;
  /** 是否循环播放；一次性完成动画（如 task-complete）应设为 false。 */
  loop?: boolean;
  /** 是否自动播放（默认 true；reduced-motion 时强制静态，不播放）。 */
  autoplay?: boolean;
  /** 渲染尺寸，单位 px；默认跟随容器。 */
  size?: number;
  /** 覆盖着色（`#rrggbb` / `rgb()`）；缺省读取 `--md-color-primary` 跟随主题。 */
  color?: string;
  /** 是否保留动画 JSON 中的原始配色；多色动画应启用，默认仍跟随主题强调色。 */
  preserveOriginalColors?: boolean;
  /** 附加样式（用于对齐 / 间距，不覆盖尺寸）。 */
  style?: CSSProperties;
  /** 无障碍标签；装饰性动画应传空字符串并配合 aria-hidden。 */
  ariaLabel?: string;
  /** 静态降级内容：reduced-motion、加载失败或测试环境下替换动画渲染。 */
  fallback?: ReactNode;
  /** 渲染失败时（含非浏览器环境）是否显示 fallback，默认 true。 */
  showFallbackOnError?: boolean;
}

/**
 * 懒加载的 Lottie 播放器，统一承载 ohna-web 的轻量动效。
 *
 * 设计约束（docs/design/glass-tokens.md + DESIGN.md Motion）：
 * - 不常驻首屏关键路径：`lottie-web` 仅在组件挂载时动态 import。
 * - 尊重 `prefers-reduced-motion`：命中时直接渲染 `fallback`，不实例化播放器。
 * - 测试 / jsdom 安全：环境无 SVG 上下文时降级 fallback，不触发动画库。
 * - 主题跟随：形状颜色默认按 `--md-color-primary` 着色，多色动画可保留原始配色。
 * - 卸载即销毁实例，避免内存泄漏与游离定时器。
 *
 * @param props 动画数据与展示选项。
 * @returns 受控 Lottie 容器或静态降级。
 */
export function LottiePlayer(props: LottiePlayerProps) {
  const {
    animationData,
    loop = true,
    autoplay = true,
    size,
    color,
    preserveOriginalColors = false,
    style,
    ariaLabel,
    fallback,
    showFallbackOnError = true
  } = props;
  const reducedMotion = usePrefersReducedMotion();
  const containerRef = useRef<HTMLSpanElement>(null);
  const animationRef = useRef<LottieInstance | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // reduced-motion：不实例化播放器，保持静态。
    if (reducedMotion || !isAnimationSafeEnvironment()) return;
    let disposed = false;
    void loadLottie().then((lottie) => {
      if (disposed || !containerRef.current) return;
      // 深拷贝动画数据：lottie 会改写传入对象，重复挂载共享对象会报错。
      const copy = JSON.parse(JSON.stringify(animationData)) as object;
      if (!preserveOriginalColors) {
        const rgba = parseColorToRgba01(color || readThemeAccent());
        if (rgba) tintShapes(copy, rgba);
      }
      const config: LottieConfig = {
        container: containerRef.current,
        renderer: "svg",
        loop,
        autoplay,
        animationData: copy
      };
      try {
        animationRef.current = lottie.loadAnimation(config);
      } catch {
        setFailed(true);
      }
    }).catch(() => setFailed(true));

    return () => {
      disposed = true;
      animationRef.current?.destroy();
      animationRef.current = undefined;
    };
  }, [animationData, loop, autoplay, reducedMotion, color, preserveOriginalColors]);

  const shouldRenderStatic = reducedMotion || failed || !isAnimationSafeEnvironment();
  if (shouldRenderStatic) {
    if (showFallbackOnError && fallback) return <>{fallback}</>;
    return <span aria-hidden="true" className="lottie-static-fallback" style={style} />;
  }

  const sizing: CSSProperties = size ? { width: size, height: size } : {};
  return (
    <span
      ref={containerRef}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel || undefined}
      aria-hidden={ariaLabel ? undefined : true}
      className="lottie-player"
      style={{ ...sizing, ...style }}
    />
  );
}
