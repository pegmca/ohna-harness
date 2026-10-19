/**
 * 非 TTY 整屏之外的 readline 输入框宽度修正：终端 resize 时重绘输入框顶线。
 *
 * 从 repl.ts 抽出的原因：这是一段与对话主循环无关、只依赖 readline 视觉状态的终端细节；
 * 抽出后 repl 保持在线数上限内，且「同宽虚假 resize 事件」与「重绘防重入」两处易踩的
 * 幂等保护集中在一个文件里，便于单测 / 复查。
 */
import { inputTopBar, paint } from "./theme.js";
import { write } from "./render.js";

/** resize 重绘需要的宿主能力。 */
export interface ResizeRedrawOptions {
  /** 当前是否允许重绘（空闲、未 EOF、输入行为空）。 */
  shouldRedraw(): boolean;
  /** 读取当前输入行内容（用于判断输入行是否为空）。 */
  currentLine(): string;
  /** 重新打印 readline prompt。 */
  prompt(): void;
}

/** resize 重绘句柄。 */
export interface ResizeRedraw {
  /** 开始监听 resize 事件（重复调用无副作用）。 */
  start(): void;
  /** 记录最近一次绘制的列宽，避免同宽 resize 反复重绘。 */
  noteWidth(columns: number): void;
}

/**
 * 创建 resize 重绘监听器。
 *
 * @param options 宿主状态读取与重绘回调。
 * @returns 监听句柄。
 */
export function createResizeRedraw(options: ResizeRedrawOptions): ResizeRedraw {
  let lastColumns = process.stdout.columns || 80;
  /** 重绘防重入：rl.prompt() 可能同步派发 resize，包成临界区避免递归风暴。 */
  let redrawing = false;
  let started = false;

  return {
    noteWidth(columns: number): void {
      lastColumns = columns;
    },

    start(): void {
      if (started) return;
      started = true;
      process.stdout.on("resize", () => {
        if (!options.shouldRedraw()) return;
        if (options.currentLine() !== "") return;
        if (redrawing) return;
        const cols = process.stdout.columns || 80;
        if (cols === lastColumns) return;
        redrawing = true;
        try {
          lastColumns = cols;
          write("\r\x1b[1A\x1b[2K"); // 回到顶线行并清空
          write(paint(inputTopBar(cols), "dim")); // 新宽度顶线
          write("\r\x1b[2K"); // 清空旧 prompt 行
          options.prompt();
        } finally {
          redrawing = false;
        }
      });
    },
  };
}
