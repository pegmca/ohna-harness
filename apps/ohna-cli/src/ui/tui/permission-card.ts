/**
 * 权限卡（Phase C3 · D7/D8）：替换输入区的三选项确认界面。
 *
 * 设计动机（v1.4 计划 C3）：
 * - 改造前权限确认是「向对话流追加一行文字问答 + 复用普通编辑器收集 1/2/3」，
 *   Esc 只能靠"挂起 Promise 再超时取消"的 hack 表达拒绝；提示也会污染对话历史。
 * - 这里把确认升级为**卡状态 + 纯渲染 + 纯按键解析**：卡片激活时由 `TuiApp` 把它
 *   合成到输入框槽位（D8 全帧模型没有浮层），对话流不再出现权限问题文本。
 * - 渲染是纯函数（同输入同输出）：`render` 只按 width / maxRows 产行，每行
 *   `truncateToWidth`，diff 预览超长走 {@link foldLinesToBudget} 的头尾折叠；
 *   计时 / 输入路由 / 终端写入全不在这里，因此可脱离终端单测。
 *
 * diff 预览来源（D7）：由 `permission/confirm.ts` 调用 `renderToolDiff` 生成 unified 文本
 * 后随 {@link PermissionCardInfo.diff} 传入；`>120 列侧侧分栏` 是远期（计划 §9 不做清单）。
 */
import { truncateToWidth, visibleWidth } from "@aiagent/term";
import { paint, paintBg, paintOnSurface } from "../theme.js";
import { foldLinesToBudget } from "../stream/print-format.js";

/** 权限卡的三选项裁决（与 `permission/confirm.ts` 的 AskAdapter 回答一一对应）。 */
export type PermissionCardDecision = "allow" | "session" | "deny";

/** 打开权限卡所需的信息（结构化 ask 协议，D7）。 */
export interface PermissionCardInfo {
  /** 工具名（如 write / bash）。 */
  tool: string;
  /** 已本地化的单行摘要（含工具名与目标）。 */
  summary: string;
  /** 可选写前 unified diff 预览文本。 */
  diff?: string;
}

/** {@link PermissionCard.render} 的排版选项。 */
export interface PermissionCardRenderOptions {
  /** 终端列数；每行最终按此宽度截断。 */
  width: number;
  /** 卡片可用高度（由 `TuiApp.buildFrame` 按输入区预算传入）。 */
  maxRows: number;
}

/** 卡内三个选项：序号、按键别名与展示文案（顺序即 ↑↓ 导航顺序）。 */
export const PERMISSION_CARD_OPTIONS: readonly {
  decision: PermissionCardDecision;
  /** 数字直选键。 */
  key: string;
  /** 字母别名（y / a / n）。 */
  alias: string;
  /** 展示文案。 */
  label: string;
}[] = [
  { decision: "allow", key: "1", alias: "y", label: "允许一次" },
  { decision: "session", key: "2", alias: "a", label: "本会话一律" },
  { decision: "deny", key: "3", alias: "n", label: "拒绝" },
];

/**
 * 权限卡状态 + 按键解析 + 纯渲染。
 *
 * 生命周期：`TuiApp.askToolCall` 为每次确认 new 一个实例，settle 后丢弃；
 * `selected` 是导航游标（0..2），数字 / 字母直选与 `↑↓ + Enter` 都归一到
 * {@link PERMISSION_CARD_OPTIONS} 的 decision。
 */
export class PermissionCard {
  /** 工具名。 */
  readonly tool: string;
  /** 单行摘要。 */
  readonly summary: string;
  /** 写前 diff 预览（可空）。 */
  readonly diff?: string;
  /** 当前选中下标（0=允许一次，1=本会话一律，2=拒绝）。 */
  selected = 0;

  /**
   * @param info 工具名 / 摘要 / 可选 diff。
   */
  constructor(info: PermissionCardInfo) {
    this.tool = info.tool;
    this.summary = info.summary;
    this.diff = info.diff;
  }

  /**
   * 解析一次按键输入。
   *
   * 语义（对齐 opencode 的显式选项，不再是 hanging promise hack）：
   * - `1` / `y` → 允许一次；`2` / `a` → 本会话一律；`3` / `n` → 拒绝（直选即结算）；
   * - `↑` / `↓` 移动选中，`Enter` 结算当前选中项；
   * - `Esc` / `Ctrl+C` → 显式拒绝（保证 Promise 必定 resolve，绝不悬挂）。
   *
   * @param data 原始 stdin 输入。
   * @returns 已决裁决；null 表示仅移动选中 / 未识别，卡片继续。
   */
  handleKey(data: string): PermissionCardDecision | null {
    if (data === "\x1b" || data === "\x03") return "deny";

    // 粘贴 / 管道注入可能把 Enter 与文本放在同一 chunk：先取 Enter 结算当前选中。
    if (/[\r\n]/.test(data)) return this.decisionAt(this.selected);

    const key = data.trim().toLowerCase();
    const direct = PERMISSION_CARD_OPTIONS.find((option) => option.key === key || option.alias === key);
    if (direct) return direct.decision;

    if (data === "\x1b[A") {
      this.selected = (this.selected + PERMISSION_CARD_OPTIONS.length - 1) % PERMISSION_CARD_OPTIONS.length;
      return null;
    }
    if (data === "\x1b[B") {
      this.selected = (this.selected + 1) % PERMISSION_CARD_OPTIONS.length;
      return null;
    }
    return null;
  }

  /**
   * 渲染卡片行（标题 → diff 预览 → 选项行 → 键位提示），每行按 width 截断。
   *
   * 视觉（C5）：标题与左侧竖线用 `focused`（确认态强调，区别于 warn）；整卡铺
   * `panel` 表面，选中项用 `selected` / `selectedText` 颜色块。高度预算：标题 + 选项行
   * 恒保留，键位提示在极窄预算下让位；diff 预览取 `maxRows - 固定行数` 并用
   * {@link foldLinesToBudget} 折叠，保证总行数 <= maxRows。
   *
   * @param options 终端宽度与卡片可用高度。
   * @returns 卡片每一行（已上色、已按宽度截断）。
   */
  render(options: PermissionCardRenderOptions): string[] {
    const width = Math.max(1, options.width);
    const maxRows = Math.max(1, options.maxRows);

    const renderedDiff = this.renderDiff(maxRows);
    const optionsLine = this.renderOptions();
    const hintLine = paint("↑/↓ 选择 · Enter 确认 · Esc 拒绝", "dim");
    const titleLine = paint(`? 权限确认：${this.summary}`, "focused");

    let lines = [titleLine, ...renderedDiff, optionsLine, hintLine];
    if (lines.length > maxRows) {
      // 预算不足以放下提示行时优先保住标题 / diff / 选项。
      lines = [titleLine, ...renderedDiff, optionsLine];
    }
    return lines
      .slice(0, maxRows)
      .map((line) => paintOnSurface(fitToWidth(`${paint("│ ", "focused")}${line}`, width), "panel"));
  }

  /**
   * 渲染 diff 预览：按预算折叠 + 语义着色（新增 / 删除 / hunk 头 / 上下文）。
   *
   * @param maxRows 卡片总预算（用于扣除标题 / 选项 / 提示固定行）。
   * @returns diff 行；无 diff 返回空数组；预算不足时返回空数组。
   */
  private renderDiff(maxRows: number): string[] {
    if (!this.diff) return [];
    // 固定行：标题 1 + 选项行 1 + 提示行 1。
    const reserved = 3;
    const budget = maxRows - reserved;
    if (budget <= 0) return [];
    return foldLinesToBudget(this.diff.split("\n"), budget).map((line) => `  ${colorDiffLine(line)}`);
  }

  /**
   * 渲染选项行：选中项以 selected 颜色块高亮，未选中项普通文本。
   *
   * @returns 单行选项文本（未按宽度截断，由 {@link render} 统一处理）。
   */
  private renderOptions(): string {
    const labels = PERMISSION_CARD_OPTIONS.map((option, index) => {
      const label = `[${option.key}] ${option.label}`;
      return index === this.selected ? paintBg(label, "selected", "selectedText") : label;
    });
    return `  ${labels.join("  ")}`;
  }

  /**
   * 取下标对应的裁决；越界按拒绝兜底（安全默认，与 readline 路径一致）。
   *
   * @param index 选项下标。
   * @returns 裁决。
   */
  private decisionAt(index: number): PermissionCardDecision {
    return PERMISSION_CARD_OPTIONS[index]?.decision ?? "deny";
  }
}

/**
 * 按目标可见宽裁剪并补空格（供背景铺满整行）。
 *
 * @param line 原始行（可含 ANSI）。
 * @param width 目标可见宽。
 * @returns 可见宽恰为 width 的行。
 */
function fitToWidth(line: string, width: number): string {
  const clipped = truncateToWidth(line, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/**
 * diff 行语义着色（新增 / 删除 / hunk 头 / 上下文），与 `rows.ts` 的工具 diff 配色一致。
 *
 * @param line unified diff 行。
 * @returns 已上色行。
 */
function colorDiffLine(line: string): string {
  if (line.startsWith("@@")) return paint(line, "property");
  if (line.startsWith("+")) return paint(line, "success");
  if (line.startsWith("-")) return paint(line, "error");
  return paint(line, "dim");
}
