/**
 * TUI 面板与状态行的排版工具（Phase C1b，从 `tui-app.ts` 拆出以守住 ≤500 行）。
 *
 * 这里只放**纯函数**：命令面板行、选中下标夹紧、状态行左/右两端对齐。
 * 面板的开合状态仍由 `TuiApp` 持有（它需要把按键分发给 picker / palette / editor），
 * 本模块不持有任何可变状态、不读终端。
 *
 * Phase C2：命令候选从命令注册表过滤；面板高度由 `buildFrame` 按可用行数裁剪，
 * 不再有固定条数上限；候选超出可用高度时以 overflow 提示收尾，用户可继续
 * 输入前缀缩小范围，不会「静默吞命令」。
 */
import { truncateToWidth, visibleWidth } from "@aiagent/term";
import { paint, paintBg, paintOnSurface, type ThemeRole } from "../theme.js";
import { filterSlashCommands, type SlashCommandDef } from "../../commands/registry.js";
import { paletteFooter } from "./keymap.js";
import type { LineEditor } from "./tui-editor.js";
import type { FileReferencePalette } from "./tui-file-palette.js";
import type { SessionPicker } from "./tui-session-picker.js";

/**
 * 状态行内容：输入框下方居右展示的一行「模型 + 上下文占比」。
 *
 * 由上层（repl）通过 `setStatus` 注入一个求值函数，`buildFrame` 每帧调用它以实时
 * 反映最新的模型（`/model` 切换）与上下文占比（tracker 随每轮增长）。
 */
export interface TuiStatus {
  /** 模型名（如 hy3-x）。 */
  model: string;
  /** 上下文占比（0..100 的百分比）；负值 / 超界由 {@link buildStatusLine} 侧夹紧。 */
  contextPercent: number;
  /** 当前权限模式（default / acceptEdits / plan / bypass），状态行左侧展示。 */
  permissionMode?: string;
  /** 可见窗口上方隐藏的历史条目数（C4）；>0 时左侧展示「↑ 历史 N 条」。 */
  historyAbove?: number;
}

/**
 * 权限模式对应的语义色：default 低调、acceptEdits 强调、plan 警示、bypass 危险。
 *
 * @param mode 权限模式名。
 * @returns 主题色位；未知模式回退 dim。
 */
function permissionModeRole(mode: string): ThemeRole {
  switch (mode) {
    case "acceptEdits":
      return "accent";
    case "plan":
      return "warn";
    case "bypass":
      return "error";
    default:
      return "dim";
  }
}

/**
 * 把过滤后的命令渲染成 `/` 面板行：`  /cmd        描述`，选中行用主题色背景块高亮。
 *
 * 纯函数（不依赖 TuiApp 状态），便于单测；宽度策略：显式传入 `width` 时先按可见列
 * 截断再右侧补空格，使整行背景铺满终端；不传时保持旧行为（由调用方统一裁剪）。
 * 背景 ANSI 不占可见列，因此不会破坏 `truncateToWidth` 的宽度计算。
 *
 * Phase C2：`maxRows` 由 `buildFrame` 按终端可用高度传入；候选多于可用行数时，
 * 以选中项为中心开窗，末行给出 `… 还有 N 条` 提示（`maxRows >= 2` 时）。
 *
 * @param commands 已过滤的命令列表（保持顺序）。
 * @param selectedIndex 选中下标（调用方需已夹紧到 [0, len)）。
 * @param maxRows 最多显示行数；缺省显示全部（保持旧行为）。
 * @param width 面板目标可见宽；0 表示不补齐（单测 / 旧调用）。
 * @returns 面板文本（选中行 selected 背景，其余行 panel 表面 + dim overflow 提示）。
 */
export function buildPalette(
  commands: readonly SlashCommandDef[],
  selectedIndex: number,
  maxRows: number = commands.length,
  width: number = 0,
): string[] {
  if (commands.length === 0 || maxRows <= 0) return [];
  const selected = clampIndex(selectedIndex, commands.length);

  let shown: readonly SlashCommandDef[] = commands;
  let startIndex = 0;
  let overflow = 0;
  if (commands.length > maxRows) {
    // 保留 1 行给 overflow 提示；maxRows===1 时只能显示 1 条，不放提示。
    const withHint = maxRows >= 2;
    const visible = withHint ? maxRows - 1 : maxRows;
    startIndex = Math.min(Math.max(0, selected - Math.floor(visible / 2)), commands.length - visible);
    shown = commands.slice(startIndex, startIndex + visible);
    overflow = withHint ? commands.length - visible : 0;
  }

  const nameWidth = Math.max(...shown.map((c) => c.name.length));
  const lines = shown.map((c, i) => {
    const label = `  ${c.name.padEnd(nameWidth)}  ${c.description}`;
    const fitted = fitToWidth(label, width);
    return startIndex + i === selected
      ? paintBg(fitted, "selected", "selectedText")
      : paintOnSurface(fitted, "panel");
  });
  if (overflow > 0) {
    const hint = paint(`  … 还有 ${overflow} 条，继续输入筛选`, "dim");
    lines.push(paintOnSurface(fitToWidth(hint, width), "panel"));
  }
  return lines;
}

/**
 * 按目标可见宽裁剪并右侧补空格（背景铺满整行用）。
 *
 * `width <= 0` 时原样返回，保持 `buildPalette(commands, index)` 旧调用的输出形态。
 * 补空格发生在裁剪之后、上色之前，因此 `visibleWidth` 与背景 ANSI 互不干扰。
 *
 * @param line 原始行（可含 ANSI）。
 * @param width 目标可见宽；0 表示不处理。
 * @returns 可见宽恰为 width 的行（width > 0 时）。
 */
function fitToWidth(line: string, width: number): string {
  if (width <= 0) return line;
  const clipped = truncateToWidth(line, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/**
 * 把选中下标夹紧到 `[0, length-1]`（过滤结果变化后调用，防止越界）。
 *
 * @param index 当前选中下标。
 * @param length 过滤结果条数。
 * @returns 夹紧后的下标；length <= 0 时返回 0。
 */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}

/**
 * 求值并渲染状态行：左侧「⏵⏵ 权限模式」，右侧「模型 · 上下文占比」。
 *
 * 布局动机（对齐 Claude Code）：权限模式是当前会话的「操作约束」，放在左下角与输入区
 * 同侧，用户不用扫到右侧数字区就能确认当前是 default / acceptEdits / plan / bypass；
 * 模型与上下文占比仍居右，保持原有视觉锚点。
 *
 * 宽度策略：先按可见宽（ANSI 不占列）计算中间填充；极窄终端（左右之和超过屏宽）时
 * 截断左侧模式文本、优先保留右侧模型/占比。占比先四舍五入再夹紧到 [0, 100]。
 *
 * @param status 状态求值结果；undefined 表示不显示状态行。
 * @param width 终端列数。
 * @returns 左模式 + 右模型/占比的状态行；status 为空时返回 undefined。
 */
export function buildStatusLine(status: TuiStatus | undefined, width: number): string | undefined {
  if (!status) return undefined;
  const percent = Math.min(100, Math.max(0, Math.round(status.contextPercent)));
  const mode = status.permissionMode ?? "default";
  // C4：左侧权限模式后追加「↑ 历史 N 条」（仅在可见窗口上方确有隐藏条目时）。
  const history =
    status.historyAbove !== undefined && status.historyAbove > 0
      ? paint(`  ↑ 历史 ${status.historyAbove} 条`, "dim")
      : "";
  const left = paint(`⏵⏵ ${mode}`, permissionModeRole(mode)) + history;
  const right = paint(status.model, "accent") + paint(` · ${percent}%`, "dim");

  // 极窄终端：保留右侧（模型/占比更关键），左侧按剩余列截断。
  if (visibleWidth(left) + visibleWidth(right) >= width) {
    const availableLeft = Math.max(0, width - visibleWidth(right) - 1);
    const trimmedLeft = availableLeft > 0 ? truncateToWidth(left, availableLeft) : "";
    const gap = Math.max(0, width - visibleWidth(trimmedLeft) - visibleWidth(right));
    return trimmedLeft + " ".repeat(gap) + right;
  }

  const gap = width - visibleWidth(left) - visibleWidth(right);
  return left + " ".repeat(gap) + right;
}

/** 面板组合的输入：三个互斥面板 + 当前编辑器。 */
export interface PanelInput {
  /** `/resume` 会话选择器。 */
  sessionPicker: SessionPicker;
  /** `@` 文件候选面板。 */
  filePalette: FileReferencePalette;
  /** 输入编辑器（读取 value 判断面板类型）。 */
  editor: LineEditor;
}

/**
 * `/` 面板是否激活：输入以 `/` 开头且尚未敲空格（仍在选命令名，未进入参数）。
 *
 * Phase C2 起由 palette 模式的注册 / 注销逻辑消费（不再作为 `TuiApp` 的优先级判断），
 * 因此这里只暴露纯字符串判定。
 *
 * @param value 输入框内容。
 * @returns 面板激活时返回 true。
 */
export function paletteActive(value: string): boolean {
  return value.startsWith("/") && !/\s/.test(value);
}

/**
 * 当前过滤后的命令（面板激活时）；未激活时为空数组。
 *
 * @param value 输入框内容。
 * @returns 过滤后的命令列表。
 */
export function filteredCommands(value: string): SlashCommandDef[] {
  if (!paletteActive(value)) return [];
  return filterSlashCommands(value);
}

/**
 * 组合输入框下方三个互斥面板的行：会话选择器 → 命令面板 → 文件面板。
 *
 * @param input 面板输入。
 * @param selectedIndex 命令面板当前选中下标。
 * @param budget 面板可用行数（由 buildFrame 按终端高度扣除输入区 / 状态行后传入）；
 *   命令面板超出时由 {@link buildPalette} 开窗并给出 overflow 提示。
 * @param width 面板目标可见宽（用于背景铺满整行）；0 表示不补齐。
 * @returns 面板行（命令面板为空时省略；总行数不超过 budget）。
 */
export function buildPanelLines(
  input: PanelInput,
  selectedIndex: number,
  budget: number = Number.POSITIVE_INFINITY,
  width: number = 0,
): string[] {
  const commands = filteredCommands(input.editor.value);
  // footer 需要 1 行；预算只有 1 行时优先显示候选本身。
  const reserveFooter = budget >= 2;
  const paletteRows = reserveFooter ? budget - 1 : budget;
  const commandLines =
    commands.length === 0
      ? []
      : buildPalette(commands, clampIndex(selectedIndex, commands.length), paletteRows, width);
  if (reserveFooter && commandLines.length > 0) {
    const footer = paint(paletteFooter(), "dim");
    commandLines.push(paintOnSurface(fitToWidth(footer, width), "panel"));
  }
  const lines = [
    ...input.sessionPicker.buildLines(width),
    ...commandLines,
    ...input.filePalette.buildLines(input.editor.value, width),
  ];
  return budget === Number.POSITIVE_INFINITY ? lines : lines.slice(0, budget);
}

/**
 * 面板打开时消费面板专属键。
 *
 * 键序：Esc 关闭面板；Up/Down 移动选中；Tab 补全选中命令；Enter 直接提交；
 * 其余按键穿透给编辑器。
 *
 * @param input 面板输入与当前选中下标。
 * @param data 原始输入。
 * @returns `consumed` 是否已消费；`selectedIndex` 为夹紧后的新下标。
 */
export function handlePanelKey(
  input: PanelInput & { selectedIndex: number },
  data: string,
): { consumed: boolean; selectedIndex: number } {
  const editor = input.editor;
  if (data === "\x1b") {
    editor.value = "";
    editor.cursor = 0;
    editor.onChange?.();
    return { consumed: true, selectedIndex: 0 };
  }
  const commands = filteredCommands(editor.value);
  if (commands.length === 0) return { consumed: false, selectedIndex: input.selectedIndex };
  const selected = clampIndex(input.selectedIndex, commands.length);
  switch (data) {
    case "\x1b[A": // Up
      return { consumed: true, selectedIndex: clampIndex(selected - 1, commands.length) };
    case "\x1b[B": // Down
      return { consumed: true, selectedIndex: clampIndex(selected + 1, commands.length) };
    case "\t": // Tab：补全选中命令，末尾补空格便于继续输入参数。
      editor.value = `${commands[selected].name} `;
      editor.cursor = editor.value.length;
      editor.onChange?.();
      return { consumed: true, selectedIndex: 0 };
    case "\r":
    case "\n": // Enter：把命令名写入输入框后走编辑器既有提交路径。
      editor.value = commands[selected].name;
      editor.cursor = editor.value.length;
      editor.handleInput("\r");
      return { consumed: true, selectedIndex: 0 };
    default:
      return { consumed: false, selectedIndex: input.selectedIndex };
  }
}

/**
 * `@` 文件面板按键；Tab / Enter 命中候选时把输入替换为 `@<相对路径> `。
 *
 * @param editor 输入编辑器。
 * @param filePalette 文件候选面板。
 * @param data 原始输入。
 * @returns 是否已消费（true 时调用方应重绘）。
 */
export function handleFilePaletteKey(editor: LineEditor, filePalette: FileReferencePalette, data: string): boolean {
  const result = filePalette.handleKey(data, editor.value);
  if (!result.consumed) return false;
  if (result.value !== undefined) {
    editor.value = result.value;
    editor.cursor = result.value.length;
    editor.onChange?.();
  }
  return true;
}
