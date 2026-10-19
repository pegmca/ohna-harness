/**
 * spinner 的**帧序列常量与纯函数**（Phase C1 · D5 状态收编后）。
 *
 * 历史：改造前本模块持有 7 个模块级可变变量（verb / startedAt / visible / lastWriteAt /
 * timer / suspended / enabled）并直接写 `process.stdout`。C1 把这些状态与写入逻辑全部收编进
 * `ui/stream/print.ts` 的 `PrintPresenter` 实例（非 TTY / readline 打印路径的唯一写者），
 * 本模块退化为无状态的常量 / 纯函数，供 presenter（以及将来 TUI 的 rows 投影）复用：
 *
 * - 非 TTY 下 presenter 不启帧（`supportsAnsi()` 门控），因此管道输出不含 `\x1b`；
 * - TTY readline 下 presenter 用 {@link FRAME_INTERVAL_MS} 定时重绘同一帧；
 * - `setSpinnerEnabled` / `suspendSpinner` / `resumeSpinner` 等**有状态入口**仍是对外
 *   公共符号，但已迁移到 `ui/render.ts`（委托默认 presenter），调用方无需感知本模块。
 */
import { SPIN } from "./theme.js";

/** 帧刷新间隔（毫秒）。 */
export const FRAME_INTERVAL_MS = 200;

/** 首帧延迟：正文写入后至少等待该时长才绘制下一帧（撕裂防护）。 */
export const FIRST_FRAME_DELAY_MS = 300;

/** 默认动词文案（agent_start 时使用）。 */
export const DEFAULT_SPINNER_VERB = "思考中";

/**
 * spinner 帧序列（当前单帧）。
 *
 * 保留为数组是为了对齐 opencode 的多帧字符动画形态；C1b 的 TUI 投影可在此扩展帧集合，
 * 而打印路径仍只取当前帧。
 */
export const SPINNER_FRAMES = [SPIN] as const;

/**
 * 构造一帧 spinner 文案（未上色；着色由调用方按 `paint(..., "dim")` 决定）。
 *
 * @param verb 动词文案（如「思考中」「执行 bash」）。
 * @param elapsedSeconds 已耗时秒数（负值按 0 处理，与旧 draw 的夹紧一致）。
 * @returns `✻ 动词… (Ns)` 形式的单行文本。
 */
export function spinnerFrame(verb: string, elapsedSeconds: number): string {
  const elapsed = Math.max(0, Math.floor(elapsedSeconds));
  return `${SPIN} ${verb}… (${elapsed}s)`;
}
