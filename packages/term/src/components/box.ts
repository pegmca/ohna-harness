/**
 * box：极简边框组件，把内容行包进 `╭─…─╮` / `│ … │` / `╰─…─╯`。
 *
 * 设计取舍（只取最小子集）：
 * - 边框用纯 box-drawing 字符，不带色——颜色由调用方在传入的 `lines` 里已 paint 好的文本携带；
 * - 宽度取内容最大「可见宽」（`visibleWidth`，已剥离 ANSI）+ 左右内边距，保证含 ANSI 的行不计转义宽度；
 * - 不做复杂对齐/换行/背景填充，保持简单可靠，作为后续整屏布局的基石组件。
 *
 * 宽度契约（M6 整屏 TUI 的关键约束）：调用方按终端列数算布局，因此**显式 `width` 是硬约束**
 * ——内容超宽时按可见列截断，盒子绝不比 `width + 2` 更宽；否则整帧会被终端折行折下去，
 * 输入框等贴底组件整体错位。省略 `width` 时（自动宽度）仍以内容为准，保证最长行完整显示。
 */
import { visibleWidth } from "../utils.js";

/** box 的可选参数。 */
export interface BoxOptions {
  /**
   * 内容区宽度（不含左右边框，但含内容两侧各 1 个内边距空格）。
   * 省略时取「内容最大可见宽 + 2」，保证最长行也能完整放入内边距之间；
   * 显式给出时作为**硬约束**：更宽的内容行会被截断到 `width - 2` 列。
   */
  width?: number;
  /** 可选标题，渲染在顶边左侧（如 `╭─ title ─…─╮`）。 */
  title?: string;
}

/**
 * 把内容行包进单边框盒子，返回整盒的每一行文本。
 *
 * 每行结构：`│ ` + 内容（右补空格） + ` │`，盒子总可见宽恒为 `contentWidth + 2`
 * （左右各一个边框字符）；内容区扣掉两侧内边距后，留给行文本的是 `contentWidth - 2` 列。
 * 标题出现在顶边，会占用部分上边框宽度。
 *
 * 显式 `width` 下：contentWidth = width，超宽内容先被 {@link truncateToWidth} 裁到
 * `width - 2` 列再入框，因此三行（上边框 / body / 下边框）可见宽恒等于 `width + 2`。
 *
 * @param lines 内容行（可已含 ANSI 颜色，宽度按可见列计算）。
 * @param opts 可选宽度/标题。
 * @returns 包含上下边框与内容行的字符串数组（顺序即绘制顺序）。
 */
export function box(lines: string[], opts?: BoxOptions): string[] {
  const title = opts?.title;
  // 顶边左侧已占用部分：无标题时为空格 0，有标题时为 `─ title `。
  const titlePrefix = title ? `─ ${title} ` : "";
  const titlePrefixWidth = visibleWidth(titlePrefix);

  // 内容区宽度取舍：
  // - 显式 width 是硬约束（不因内容超宽而撑开盒子），但标题过长时仍会占宽
  //   （否则 `╭─title─╮` 会被 title 挤爆）；有内容时下限为 2，容纳左右内边距，
  //   保证 body 行不会被内容顶得比上下边框宽。
  // - 省略 width 时按内容的自适应宽度（`最长行可见宽 + 2`）撑开，最长行完整显示。
  const minContentWidth =
    lines.length === 0 ? 0 : Math.max(...lines.map((l) => visibleWidth(l))) + 2;
  const contentWidth =
    opts?.width !== undefined
      ? Math.max(opts.width, titlePrefixWidth, lines.length > 0 ? 2 : 0)
      : Math.max(minContentWidth, titlePrefixWidth);
  const topFill = Math.max(0, contentWidth - titlePrefixWidth);
  const top = `╭${titlePrefix}${"─".repeat(topFill)}╮`;
  const bottom = `╰${"─".repeat(contentWidth)}╯`;

  const innerWidth = Math.max(0, contentWidth - 2);
  const out: string[] = [top];
  for (const line of lines) {
    // 内容区两侧各有一个空格（`│ ` / ` │`），故内文可见宽 = contentWidth - 2；
    // 超宽的行先按可见列截断，再据此补空格，使 body 行总宽与顶/底边框一致。
    const clamped = truncateToWidth(line, innerWidth);
    const pad = innerWidth - visibleWidth(clamped);
    out.push(`│ ${clamped}${" ".repeat(pad)} │`);
  }
  out.push(bottom);
  return out;
}

/** ANSI 转义序列的首部形态：SGR/CSI、OSC（BEL 或 ST 结束）、字符集切换。 */
const ESCAPE_HEAD = /^\x1b(?:\[[0-9;?]*[0-9A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][AB0-2])/;

/**
 * 按可见列宽截断单行文本（宽字符算 2 列，ANSI 转义算 0 列）。
 *
 * 为什么手写而不是按 `visibleWidth` 反向切片：转义序列不占列，直接按下标裁会出现
 * 「颜色序列被切断」的残帧；这里边走边拷——遇转义序列整段搬运、遇可见字符按列计数，
 * 并在确实截断且行内含转义时补一次 `\x1b[0m`，防止着色状态泄漏到后续终端输出。
 *
 * @param line 原始行文本（可含 ANSI 颜色与 CJK 宽字符）。
 * @param maxWidth 允许的最大可见列宽。
 * @returns 可见宽 <= `maxWidth` 的行；未超宽时原样返回（不额外补复位）。
 */
function truncateToWidth(line: string, maxWidth: number): string {
  if (visibleWidth(line) <= maxWidth) return line;

  const out: string[] = [];
  let width = 0;
  let hasEscape = false;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const escape = ESCAPE_HEAD.exec(line.slice(i));
      // 孤立 ESC（无法识别的形态）：不当作可见内容，跳过 1 个字符继续。
      if (escape) {
        out.push(escape[0]);
        hasEscape = true;
        i += escape[0].length;
      } else {
        i += 1;
      }
      continue;
    }
    const codePoint = line.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(codePoint);
    const charWidth = visibleWidth(char);
    if (width + charWidth > maxWidth) break; // 再放一个字符就溢出（宽字符可能放不下半格）
    out.push(char);
    width += charWidth;
    i += char.length;
  }
  return out.join("") + (hasEscape ? "\x1b[0m" : "");
}
