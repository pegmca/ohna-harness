/**
 * @aiagent/term 公共入口：整屏 TUI 基础包（零外部依赖）。
 *
 * 包边界（保持精简稳定）：
 * - `RawTerminal` / `Terminal`：raw mode 终端原语（尺寸/输入/清屏/光标）。
 * - `Screen`：节流 + 幂等全量重绘的整屏渲染循环。
 * - `box` / `visibleWidth`：极简边框组件与可见宽度计算。
 * - ANSI 原语 `rgb`/`reset`/`bold`/…：仅暴露转义序列生成，不内置语义调色板
 *   （颜色语义由调用方如 ohna-cli 的 theme.ts 负责，避免跨层重复）。
 */

export { RawTerminal } from "./terminal.js";
export type { Terminal } from "./terminal.js";

export { Screen } from "./screen.js";
export type { RenderFn, InputFn } from "./screen.js";

export { box, truncateToWidth } from "./components/box.js";
export type { BoxOptions } from "./components/box.js";

export { visibleWidth, stripAnsi } from "./utils.js";

/**
 * 24-bit 真彩前景色前缀：`\x1b[38;2;r;g;bm`。
 *
 * 注意：term 不内置语义调色板，调用方（ohna-cli）应把 `rgb` 与自己的 ThemeRole 绑定后使用，
 * 这样颜色语义留在应用层，包只提供渲染原语。
 *
 * @param r 红（0-255）。
 * @param g 绿（0-255）。
 * @param b 蓝（0-255）。
 * @returns SGR 前景色前缀序列。
 */
export function rgb(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** 复位所有 SGR 属性（`\x1b[0m`），通常接在带色文本之后。 */
export function reset(): string {
  return "\x1b[0m";
}

/** 加粗（`\x1b[1m`）。 */
export function bold(): string {
  return "\x1b[1m";
}

/** 暗淡/次级（`\x1b[2m`）。 */
export function dim(): string {
  return "\x1b[2m";
}

/** 斜体（`\x1b[3m`）。 */
export function italic(): string {
  return "\x1b[3m";
}

/** 下划线（`\x1b[4m`）。 */
export function underline(): string {
  return "\x1b[4m";
}
