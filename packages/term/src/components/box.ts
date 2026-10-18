/**
 * box：极简边框组件，把内容行包进 `╭─…─╮` / `│ … │` / `╰─…─╯`。
 *
 * 设计取舍（只取最小子集）：
 * - 边框用纯 box-drawing 字符，不带色——颜色由调用方在传入的 `lines` 里已 paint 好的文本携带；
 * - 宽度默认取内容最大「可见宽」（`visibleWidth`，已剥离 ANSI），保证含 ANSI 的行不计转义宽度；
 * - 不做复杂对齐/换行/背景填充，保持简单可靠，作为后续整屏布局的基石组件。
 */
import { visibleWidth } from "../utils.js";

/** box 的可选参数。 */
export interface BoxOptions {
  /** 内容区宽度（不含左右边框）。省略时取内容最大可见宽。 */
  width?: number;
  /** 可选标题，渲染在顶边左侧（如 `╭─ title ─…─╮`）。 */
  title?: string;
}

/**
 * 把内容行包进单边框盒子，返回整盒的每一行文本。
 *
 * 每行结构：`│ ` + 内容（右补空格至 width） + ` │`，因此盒内可见宽恒为 `width`，
 * 盒子总可见宽 = `width + 2`（左右各一个边框字符）。标题出现在顶边，会占用部分上边框宽度。
 *
 * @param lines 内容行（可已含 ANSI 颜色，宽度按可见列计算）。
 * @param opts 可选宽度/标题。
 * @returns 包含上下边框与内容行的字符串数组（顺序即绘制顺序）。
 */
export function box(lines: string[], opts?: BoxOptions): string[] {
  const contentWidth = opts?.width ?? Math.max(0, ...lines.map((l) => visibleWidth(l)));

  const title = opts?.title;
  // 顶边左侧已占用部分：无标题时为空格 0，有标题时为 `─ title `。
  const titlePrefix = title ? `─ ${title} ` : "";
  const titlePrefixWidth = visibleWidth(titlePrefix);
  const topFill = Math.max(0, contentWidth - titlePrefixWidth);
  const top = `╭${titlePrefix}${"─".repeat(topFill)}╮`;
  const bottom = `╰${"─".repeat(contentWidth)}╯`;

  const out: string[] = [top];
  for (const line of lines) {
    const pad = Math.max(0, contentWidth - visibleWidth(line));
    out.push(`│ ${line}${" ".repeat(pad)} │`);
  }
  out.push(bottom);
  return out;
}
