/**
 * box：极简边框组件，把内容行包进 `╭─…─╮` / `│ … │` / `╰─…─╯`。
 *
 * 设计取舍（只取最小子集）：
 * - 边框用纯 box-drawing 字符，不带色——颜色由调用方在传入的 `lines` 里已 paint 好的文本携带；
 * - 宽度取内容最大「可见宽」（`visibleWidth`，已剥离 ANSI）+ 左右内边距，保证含 ANSI 的行不计转义宽度；
 * - 不做复杂对齐/换行/背景填充，保持简单可靠，作为后续整屏布局的基石组件。
 */
import { visibleWidth } from "../utils.js";

/** box 的可选参数。 */
export interface BoxOptions {
  /**
   * 内容区宽度（不含左右边框，但含内容两侧各 1 个内边距空格）。
   * 省略时取「内容最大可见宽 + 2」，保证最长行也能完整放入内边距之间。
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
 * @param lines 内容行（可已含 ANSI 颜色，宽度按可见列计算）。
 * @param opts 可选宽度/标题。
 * @returns 包含上下边框与内容行的字符串数组（顺序即绘制顺序）。
 */
export function box(lines: string[], opts?: BoxOptions): string[] {
  const title = opts?.title;
  // 顶边左侧已占用部分：无标题时为空格 0，有标题时为 `─ title `。
  const titlePrefix = title ? `─ ${title} ` : "";
  const titlePrefixWidth = visibleWidth(titlePrefix);

  // 内容区必须同时容纳行文本与左右各 1 个内边距空格，否则 body 行会比上下边框宽 2 列。
  // 因此最小宽度取「最长行可见宽 + 2」（无行时为 0），并让标题过长时也撑开内容区，
  // 使三行（上边框 / body / 下边框）可见宽恒等于 contentWidth + 2；显式 width 不足时以内容为准。
  const minContentWidth =
    lines.length === 0 ? 0 : Math.max(...lines.map((l) => visibleWidth(l))) + 2;
  const contentWidth = Math.max(opts?.width ?? 0, minContentWidth, titlePrefixWidth);
  const topFill = Math.max(0, contentWidth - titlePrefixWidth);
  const top = `╭${titlePrefix}${"─".repeat(topFill)}╮`;
  const bottom = `╰${"─".repeat(contentWidth)}╯`;

  const out: string[] = [top];
  for (const line of lines) {
    // 内容区两侧各有一个空格（`│ ` / ` │`），故内文可见宽 = contentWidth - 2；
    // 据此补空格，使 body 行总宽与顶/底边框一致（contentWidth + 2）。
    // contentWidth 已保证 >= 行宽 + 2，故 pad 不会为负，无需再夹取。
    const pad = contentWidth - 2 - visibleWidth(line);
    out.push(`│ ${line}${" ".repeat(pad)} │`);
  }
  out.push(bottom);
  return out;
}
