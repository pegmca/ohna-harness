/**
 * TUI 会话选择面板（`/resume` 无参时打开）。
 *
 * 设计目标（对齐 Claude Code 的会话选择器）：不再把最近会话「打印成一段文本 + 让用户
 * 手动输入 id」，而是在输入框下方展示可上下选择、Enter 切换、Esc 取消的列表。
 *
 * 为什么独立成模块：选择器有独立状态（候选、选中下标、开关），与 `/` 命令面板、`@`
 * 文件面板的「输入过滤」语义不同；独立类让 TuiApp 只保留几行接线，也便于无终端单测。
 *
 * 展示取舍：
 * - 只展示最近 {@link MAX_SESSION_PICKER_ITEMS} 个（store.list() 已按 updatedAt 倒序），
 *   避免超长列表把对话区挤没；
 * - 行内展示标题 / 短 id / 时间 / 消息数；完整 id 放在 footer，便于需要时 `/resume fork <id>`；
 * - 可打印字符会关闭面板并交回编辑器，用户可以直接开始输入下一条内容。
 */
import { paint } from "./theme.js";

/** 选择器条目：只依赖展示所需字段，避免 TuiApp 耦合 session-store 类型。 */
export interface SessionPickerItem {
  /** 会话 id（完整 UUID）。 */
  id: string;
  /** 会话标题。 */
  title: string;
  /** 最后更新时间（Unix 毫秒）。 */
  updatedAt: number;
  /** 消息条数。 */
  messageCount: number;
}

/** 选择器最多展示的会话数。 */
export const MAX_SESSION_PICKER_ITEMS = 10;

/** 标题列最大字符数（超出以省略号收尾；最终仍由 TuiApp 按终端宽度裁剪）。 */
const TITLE_MAX_CHARS = 28;

/** 选择器头部提示。 */
const PICKER_HEADER = "选择会话（↑↓ 选择 · Enter 切换 · Esc 取消）";

/** 键盘处理结果：consumed=false 时调用方继续把按键交给编辑器。 */
export interface SessionPickerKeyResult {
  /** 是否已被选择器消费。 */
  consumed: boolean;
  /** Enter 选中的会话 id（仅选中时存在）。 */
  selectedId?: string;
  /** 是否因 Esc / 输入而关闭（供调用方决定是否重绘）。 */
  closed?: boolean;
}

/**
 * 会话选择器控制器：维护候选 / 选中下标 / 开关，并渲染为输入框下方的面板行。
 */
export class SessionPicker {
  /** 候选会话（已截断到展示上限）。 */
  private items: SessionPickerItem[] = [];
  /** 当前选中下标（始终夹紧在候选范围内）。 */
  private selected = 0;
  /** 面板是否打开。 */
  private open = false;

  /**
   * 打开选择器并载入候选。
   *
   * @param items 最近会话（调用方已按更新时间倒序）。
   */
  openWith(items: readonly SessionPickerItem[]): void {
    this.items = items.slice(0, MAX_SESSION_PICKER_ITEMS);
    this.selected = 0;
    this.open = this.items.length > 0;
  }

  /** 关闭选择器并清空候选（避免下次打开残留旧列表）。 */
  close(): void {
    this.open = false;
    this.items = [];
    this.selected = 0;
  }

  /**
   * 选择器是否打开。
   *
   * @returns true 表示正在展示候选。
   */
  isOpen(): boolean {
    return this.open;
  }

  /**
   * 渲染选择器面板：头部提示 + 候选行 + footer（选中项完整 id）。
   *
   * 选中行用 reverse video（与 `/` 命令面板一致）；行内容不在此处按终端宽度裁剪，
   * 由 TuiApp 的整屏兜底统一处理。
   *
   * @returns 面板行；未打开时返回空数组。
   */
  buildLines(): string[] {
    if (!this.open || this.items.length === 0) return [];
    const lines = [paint(PICKER_HEADER, "dim")];
    this.items.forEach((item, index) => {
      const label = `  ${truncateTitle(item.title)}  ${item.id.slice(0, 8)}  ${formatTime(item.updatedAt)}  ${item.messageCount} 条`;
      lines.push(index === this.selected ? `\x1b[7m${label}\x1b[27m` : label);
    });
    const current = this.items[this.selected];
    if (current) lines.push(paint(`ID: ${current.id}`, "dim"));
    return lines;
  }

  /**
   * 处理选择器打开时的按键。
   *
   * 键序：↑/↓ 移动选中；Enter 选中并返回 id；Esc / Ctrl-C 关闭；可打印字符关闭后交回
   * 编辑器（用户开始输入新内容）；其它转义序列（Home/End 等）忽略，避免误关。
   *
   * @param data 原始 stdin 输入（单键或一小段 chunk）。
   * @returns 是否消费 / 选中的 id / 是否关闭。
   */
  handleKey(data: string): SessionPickerKeyResult {
    if (!this.open) return { consumed: false };

    switch (data) {
      case "\x1b[A":
        this.selected = Math.max(0, this.selected - 1);
        return { consumed: true };
      case "\x1b[B":
        this.selected = Math.min(this.items.length - 1, this.selected + 1);
        return { consumed: true };
      case "\r":
      case "\n": {
        const current = this.items[this.selected];
        if (!current) return { consumed: true };
        const id = current.id;
        this.close();
        return { consumed: true, selectedId: id };
      }
      case "\x1b":
      case "\x03":
        this.close();
        return { consumed: true, closed: true };
      default:
        break;
    }

    // 其它转义序列（Home/End/PageUp 等）直接吞掉：面板打开时不应把方向键当历史浏览。
    if (data.startsWith("\x1b")) return { consumed: true };

    // 可打印字符 / 粘贴：关闭面板，交回编辑器继续输入。
    this.close();
    return { consumed: false, closed: true };
  }
}

/**
 * 截断标题，超长以省略号收尾。
 *
 * @param title 原始标题。
 * @returns 不超过 {@link TITLE_MAX_CHARS} 个字符的标题。
 */
function truncateTitle(title: string): string {
  return title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS)}…` : title;
}

/**
 * 紧凑时间格式：`MM-DD HH:mm`，比 `toLocaleString()` 更稳定、更省列宽。
 *
 * @param timestamp Unix 毫秒。
 * @returns 紧凑时间文本。
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
