/**
 * TUI Esc 手势的纯判定逻辑（F-2）：双击 Esc 识别窗口。
 *
 * 为什么独立成模块：raw mode 下方向键、Alt+键、粘贴和真实 Esc 都是字节流。跨 chunk
 * 半截转义序列（`\x1b` 可能是 Esc，也可能是 CSI 前缀）的拼装已由 `input-assembler.ts`
 * 接管（缓冲未闭合序列 + 超时兜底），因此这里只保留「两次 Esc 间隔是否落在双击窗口内」
 * 这一条与字节流无关的纯判定，供 `TuiApp` 消费。
 */

/** 双击 Esc 识别窗口（毫秒）：两次 Esc 间隔小于该值视为「编辑上一条输入」手势。 */
export const ESC_DOUBLE_WINDOW_MS = 500;

/**
 * 判断一次 Esc 是否落在双击窗口内。
 *
 * @param previousAt 上一次 Esc 的时间戳（0 表示无）。
 * @param now 本次 Esc 的时间戳。
 * @returns 是否应识别为双击。
 */
export function isDoubleEscape(previousAt: number, now: number): boolean {
  return previousAt > 0 && now - previousAt < ESC_DOUBLE_WINDOW_MS;
}
