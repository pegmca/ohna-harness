/**
 * 整屏帧组合（Phase C1b）：把 `TuiApp.buildFrame` 的**纯组合逻辑**独立成模块。
 *
 * 为什么拆：`tui-app.ts` 的职责是「输入路由 / 模式生命周期 / 宿主钩子」，而
 * 「对话区 + toast + 输入区 + 面板 + 状态行 + 高度钳制」是一段无副作用的纯计算。
 * 把它抽到这里后，外壳稳定在 ≤500 行纪律内，帧组合也可被单测直接验证。
 *
 * 本模块不持有状态、不读终端：所有输入（部件 + 尺寸 + 状态快照）由调用方传入。
 * `buildFrame` 只在调用前后读写 `lastWidth` / `lastDialogueBudget` 两个滚动复用字段（C4），
 * 因此组合函数自身无副作用。
 */
import { truncateToWidth } from "@aiagent/term";
import { buildComposerLines } from "./composer.js";
import { buildPanelLines, buildStatusLine, type TuiStatus } from "./panels.js";
import { transcriptView } from "./transcript.js";
import type { LineEditor } from "./tui-editor.js";
import type { FileReferencePalette } from "./tui-file-palette.js";
import type { SessionPicker } from "./tui-session-picker.js";
import type { PermissionCard } from "./permission-card.js";
import type { ToastEntry } from "./toast.js";
import type { TuiEntry, TuiVerbosity } from "../stream/entries.js";

/** {@link composeFrame} 的输入：各部件 + 尺寸 + 状态快照（全部只读）。 */
export interface FrameInput {
  /** 终端总列数。 */
  width: number;
  /** 终端总行数。 */
  height: number;
  /** 常驻输入编辑器（非卡片态渲染它）。 */
  editor: LineEditor;
  /** 当前权限卡；存在时替换输入区（D8 合成槽）。 */
  card?: PermissionCard;
  /** 当前显示的 toast；undefined 表示无提示。 */
  toast?: ToastEntry;
  /** 排队等待的 toast 条数（用于 `+N more`）。 */
  pending: number;
  /** `/resume` 会话选择器。 */
  sessionPicker: SessionPicker;
  /** `@` 文件候选面板。 */
  filePalette: FileReferencePalette;
  /** `/` 命令面板选中下标（调用方需已夹紧）。 */
  selectedIndex: number;
  /** 当前语义条目序列。 */
  entries: readonly TuiEntry[];
  /** 三档 verbosity。 */
  verbosity: TuiVerbosity;
  /** 用户展开状态。 */
  expanded: ReadonlyMap<string, boolean>;
  /** 可见预算之外额外挂载的行数（C4）。 */
  backfill: number;
  /** 可见窗口底边距挂载区底边的行数（C4，0 = 贴底）。 */
  historyOffset: number;
  /** 宿主状态行快照；undefined 表示不显示状态行。 */
  status: TuiStatus | undefined;
}

/** 帧组合结果：最终行 + 语义信息。 */
export interface Frame {
  /** 整屏每一行（已是带 ANSI 的最终文本，无任何行超过 width，且不超过 height 行）。 */
  lines: string[];
  /** 对话区行预算（滚动复用的 `lastDialogueBudget`）。 */
  dialogueBudget: number;
}

/**
 * 组合整屏帧：对话区（条目纯投影的尾部）→ toast → 输入框 → 面板 → 状态行，全部按屏宽裁剪。
 *
 * 布局顺序（上 → 下）：对话区 → 输入框 → 命令/文件/会话面板 → 状态行；面板与状态行
 * 高度都从对话区扣除，面板自身再按剩余高度裁剪候选（C2）。
 *
 * @param input 部件、尺寸与状态快照。
 * @returns 最终行与对话区预算。
 */
export function composeFrame(input: FrameInput): Frame {
  const { width, height } = input;
  const innerWidth = Math.max(1, width - 2);
  const statusHeight = input.status === undefined ? 0 : 1;

  // 合成槽（D8）：toast（≤1 行）+ 权限卡 / 输入框；行合成与高度分配见 composer.ts。
  const composer = buildComposerLines({
    editor: input.editor,
    ...(input.card ? { card: input.card } : {}),
    ...(input.toast ? { toast: input.toast } : {}),
    pending: input.pending,
    width,
    innerWidth,
    height,
    statusHeight,
  });
  const toastLines = composer.toast;
  const toastHeight = toastLines.length;
  const inputLines = composer.input;
  const inputHeight = inputLines.length;

  // 候选面板可用高度 = 终端高度 - 输入区 - toast - 状态行；超出的候选由 buildPalette 开窗提示。
  const panelBudget = Math.max(0, height - inputHeight - statusHeight - toastHeight);

  // 候选面板：`/` 命令面板、`@` 文件面板、`/resume` 会话选择器统一渲染在输入框下方。
  // 三者输入形态互斥（命令已提交 / `@fragment` / 空输入），正常不会同时有内容。
  const panelLines = buildPanelLines(
    { sessionPicker: input.sessionPicker, filePalette: input.filePalette, editor: input.editor },
    input.selectedIndex, panelBudget, width,
  );
  const panelHeight = panelLines.length;

  const dialogueHeight = Math.max(0, height - inputHeight - panelHeight - statusHeight - toastHeight);

  // C4：按挂载预算从尾部对齐切片，并把「↑ 历史 N 条」并入状态行。
  const view = transcriptView(
    {
      entries: input.entries,
      verbosity: input.verbosity,
      expanded: input.expanded,
      width,
      budget: dialogueHeight,
      backfill: input.backfill,
      historyOffset: input.historyOffset,
    },
    input.status,
  );
  const statusLine = buildStatusLine(view.status, width);

  const combined = [
    ...view.lines,
    ...toastLines,
    ...inputLines,
    ...panelLines,
    ...(statusLine === undefined ? [] : [statusLine]),
  ];
  // 宽度安全兜底：任何一行（含长欢迎头 / 面板行）都不超过屏宽，因此永不折行。
  const truncated = combined.map((line) => truncateToWidth(line, width));
  // 高度钳制（M1）：极小终端下「对话区 + toast + 输入区 + 面板 + 状态行」可能超过终端
  // 高度（composer 的输入框恒 3 行、卡片有最小预算）。保留**底部** height 行——输入区 /
  // 面板 / 状态行是用户下一步操作所必需，优先于顶部的对话区与 toast 让位，保证帧永不越界。
  if (height <= 0) return { lines: [], dialogueBudget: dialogueHeight };
  const lines = truncated.length > height ? truncated.slice(truncated.length - height) : truncated;
  return { lines, dialogueBudget: dialogueHeight };
}
