/**
 * 输入区合成（Phase C3 · D8「合成槽」）。
 *
 * 全帧模型下「输入框 / 权限卡 / Toast」不是浮层，而是 `buildFrame` 里按固定顺序
 * 合成的几行：对话区 → toast（≤1 行）→ 卡片或输入框 → 面板 → 状态行。
 * 这里把这一段的**行合成**从 `tui-app.ts` 拆出（守住 ≤500 行），保持 `TuiApp`
 * 只做「谁在栈顶 / 取哪些状态」的编排。
 *
 * 高度分配规则：
 * - toast 恒占 1 行（`+N more` 追加在同一行，不额外占位）；
 * - 权限卡替换输入框，行数受「终端高度 - 状态行 - toast - 1」约束且不超过
 *   {@link PERMISSION_CARD_MAX_ROWS}；普通输入框恒 3 行（边框 / 输入 / 边框）。
 *   预算下界取 1 而非固定 3：极小终端优先「不越界」，卡片自身会裁剪固定行（M1）。
 */
import { box, truncateToWidth } from "@aiagent/term";
import { paintOnSurface } from "../theme.js";
import { formatToastLine, type ToastEntry } from "./toast.js";
import { PermissionCard } from "./permission-card.js";
import type { LineEditor } from "./tui-editor.js";

/** 权限卡的高度上限：占满整屏会吞掉对话区，18 行足够容纳一次写前 diff 预览。 */
export const PERMISSION_CARD_MAX_ROWS = 18;

/** {@link buildComposerLines} 的输入。 */
export interface ComposerInput {
  /** 常驻输入编辑器（非卡片态渲染它）。 */
  editor: LineEditor;
  /** 当前权限卡；存在时替换输入区。 */
  card?: PermissionCard;
  /** 当前显示的 toast；undefined 表示无提示。 */
  toast?: ToastEntry;
  /** 排队等待的 toast 条数（用于 `+N more`）。 */
  pending: number;
  /** 终端总列数（toast 整行截断基准）。 */
  width: number;
  /** box / 卡片可用宽度（终端宽 - 2）。 */
  innerWidth: number;
  /** 终端总高（卡片预算用）。 */
  height: number;
  /** 状态行占用高度（0 或 1）。 */
  statusHeight: number;
}

/** 合成结果：toast 行与输入 / 卡片行。 */
export interface ComposerLines {
  /** toast 行（最多 1 行）。 */
  toast: string[];
  /** 输入框或权限卡的行。 */
  input: string[];
}

/**
 * 合成 toast 槽与输入槽。
 *
 * @param input 编辑器 / 卡片 / toast 状态与可用尺寸。
 * @returns 两组最终行（已按宽度截断，toast 恒 1 行，普通输入框 3 行、卡片按预算裁剪）。
 */
export function buildComposerLines(input: ComposerInput): ComposerLines {
  const toast = input.toast
    ? [truncateToWidth(formatToastLine(input.toast, input.pending), input.width)]
    : [];

  const cardBudget = Math.max(
    1,
    Math.min(input.height - input.statusHeight - toast.length - 1, PERMISSION_CARD_MAX_ROWS),
  );
  const cardLines = input.card?.render({ width: input.innerWidth, maxRows: cardBudget });
  const boxLines = box([input.editor.render(input.innerWidth - 2)], { title: "ohna", width: input.innerWidth });
  // C5：输入框正文铺 panel、上下边框铺 stroke（更亮的暖棕），形成面板 / 边框分层。
  const inputLines =
    cardLines ??
    boxLines.map((line, index) =>
      paintOnSurface(line, index === 0 || index === boxLines.length - 1 ? "stroke" : "panel"),
    );

  return { toast, input: inputLines };
}
