/**
 * TUI Esc 手势的纯解析逻辑（F-2）：从原始 stdin chunk 中识别「独立 Esc」与双击窗口。
 *
 * 为什么独立成模块：raw mode 下方向键、Alt+键、粘贴和真实 Esc 都是字节流，是否算
 * Esc 不能靠「首字节是 \x1b」判断；把这套判定抽成纯函数后，TuiApp 只负责消费结果，
 * 测试也能直接覆盖边界（`\x1b` / `\x1b\x1b` / `\x1b[A` / `\x1bA`）。
 */

/** 双击 Esc 识别窗口（毫秒）：两次 Esc 间隔小于该值视为「编辑上一条输入」手势。 */
export const ESC_DOUBLE_WINDOW_MS = 500;

/** 一段输入的前导 Esc 解析结果。 */
export interface EscPrefix {
  /** 可判定为独立按下的 Esc 个数（仅连续 `\x1b` 且后面不是其它字节时计数）。 */
  escapes: number;
  /** 未被消费的剩余输入（功能键序列 / Alt+键整体交回编辑器）。 */
  remainder: string;
}

/**
 * 拆出输入开头可判定为「独立 Esc」的字节。
 *
 * 规则：
 * - `\x1b` 是 chunk 末尾（后无字节）→ 算一次独立 Esc；
 * - `\x1b\x1b` → 连续两次独立 Esc（双击）；
 * - `\x1b[` / `\x1bO` → 功能键序列，整体交回编辑器；
 * - `\x1bA` 等 Alt+键 → 整体交回编辑器，绝不当作中断，避免误杀 run。
 *
 * @param data 原始 stdin chunk。
 * @returns 前导独立 Esc 数量与剩余输入。
 */
export function splitLeadingEscapes(data: string): EscPrefix {
  let escapes = 0;
  while (escapes < data.length && data[escapes] === "\x1b") {
    const next = data[escapes + 1];
    // 只有「后面没有字节」或「后面还是 ESC」才继续计数；其它字节说明这不是独立 Esc。
    if (next !== undefined && next !== "\x1b") break;
    escapes += 1;
  }
  return { escapes, remainder: data.slice(escapes) };
}

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
