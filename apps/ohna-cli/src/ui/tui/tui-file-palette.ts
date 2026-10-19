/**
 * TUI `@` 文件候选面板：懒加载 + 过滤 + 键盘选择 / 补全。
 *
 * 从 tui-app.ts 抽出的原因：文件面板有独立状态（文件缓存、选中项、Esc 关闭记忆），
 * 与 `/` 命令面板的纯「过滤 + 渲染」不同；独立类让 TuiApp 只保留几行接线，
 * 也便于在没有真实终端的情况下单测键盘语义。
 *
 * 加载策略：首次出现 `@fragment` 时才扫描工作区，扫描完成后经 `onUpdate` 触发一次重绘；
 * 文件列表在整个会话内缓存，后续输入不再重复 walk。
 */
import { truncateToWidth, visibleWidth } from "@aiagent/term";
import { paintBg, paintOnSurface } from "../theme.js";
import {
  filterWorkspaceFiles,
  findFileReferenceFragment,
  listWorkspaceFiles,
  type FileReferenceFragment,
} from "../../workspace/file-reference.js";

/** 文件面板最多展示的候选数（与 `/` 面板的 9 条保持一致）。 */
export const MAX_FILE_PALETTE_ITEMS = 9;

/** 键盘处理结果：consumed=false 时调用方继续把按键交给编辑器。 */
export interface FilePaletteKeyResult {
  /** 是否已被面板消费。 */
  consumed: boolean;
  /** 补全后的新输入值（仅 Tab / Enter 命中候选时存在）。 */
  value?: string;
}

/** 文件面板构造选项。 */
export interface FileReferencePaletteOptions {
  /** 工作区根目录。 */
  cwd: string;
  /** 扫描完成后的重绘回调（异步加载完通知 TuiApp）。 */
  onUpdate: () => void;
  /** 文件数量上限（透传 listWorkspaceFiles）。 */
  limit?: number;
}

/**
 * `@` 文件候选面板控制器。
 */
export class FileReferencePalette {
  private readonly options: FileReferencePaletteOptions;
  /** 工作区文件缓存；null 表示尚未加载，加载中由 loading 标记。 */
  private files: string[] | null = null;
  private loading = false;
  /** 当前选中下标。 */
  private selected = 0;
  /**
   * 被 Esc 关闭时的输入值：只有输入发生变化才重新打开，避免按 Esc 后下一帧又弹出。
   */
  private dismissedValue: string | null = null;

  /**
   * @param options 工作目录与重绘回调。
   */
  constructor(options: FileReferencePaletteOptions) {
    this.options = options;
  }

  /**
   * 当前输入末尾的 `@` 片段；面板被 Esc 关闭且输入未变时返回 null。
   *
   * 副作用：首次命中片段时触发一次异步文件扫描（不阻塞输入）。
   *
   * @param value 输入框内容。
   * @returns 片段信息或 null。
   */
  fragment(value: string): FileReferenceFragment | null {
    if (this.dismissedValue !== null) {
      if (value === this.dismissedValue) return null;
      this.dismissedValue = null;
    }
    const fragment = findFileReferenceFragment(value);
    if (!fragment) return null;
    this.ensureLoaded();
    return fragment;
  }

  /**
   * 渲染候选行（面板关闭或无候选时为空数组）。
   *
   * 选中行使用 `selected` / `selectedText` 颜色块；`width > 0` 时裁剪并补齐，
   * 让 panel 背景铺满整行。
   *
   * @param value 输入框内容。
   * @param width 面板目标可见宽；0 表示不补齐。
   * @returns 最多 {@link MAX_FILE_PALETTE_ITEMS} 行文本（选中行颜色块）。
   */
  buildLines(value: string, width: number = 0): string[] {
    const candidates = this.candidates(value);
    if (candidates.length === 0) return [];
    const selected = resolveIndex(this.selected, candidates.length);
    const nameWidth = Math.max(...candidates.map((file) => file.length));
    return candidates.map((file, index) => {
      const fitted = fitToWidth(`  @${file.padEnd(nameWidth)}`, width);
      return index === selected ? paintBg(fitted, "selected", "selectedText") : paintOnSurface(fitted, "panel");
    });
  }

  /**
   * 处理面板键：Up/Down 选择，Tab/Enter 补全，Esc 关闭。
   *
   * 无候选时不消费按键（让 Up/Down 回到编辑器历史、Enter 正常提交输入），
   * 但 Esc 仍消费并记住关闭状态，避免用户无法摆脱空面板。
   *
   * @param data 原始 stdin 输入。
   * @param value 输入框内容。
   * @returns 消费结果与可能的补全值。
   */
  handleKey(data: string, value: string): FilePaletteKeyResult {
    const fragment = this.fragment(value);
    if (!fragment) return { consumed: false };

    if (data === "\x1b") {
      this.dismissedValue = value;
      return { consumed: true };
    }

    const candidates = this.candidates(value);
    if (candidates.length === 0) return { consumed: false };
    switch (data) {
      case "\x1b[A":
        this.selected = resolveIndex(this.selected - 1, candidates.length);
        return { consumed: true };
      case "\x1b[B":
        this.selected = resolveIndex(this.selected + 1, candidates.length);
        return { consumed: true };
      case "\t":
      case "\r":
      case "\n": {
        const chosen = candidates[resolveIndex(this.selected, candidates.length)];
        // 保留 `@` 前缀与尾随标点：`@a.ts，` 补全为 `@alpha.ts，`，提交时标点不参与路径。
        // 没有尾随时补一个空格，用户可继续输入；提交时再由展开逻辑读取内容。
        const suffix = value.slice(fragment.end);
        const next = `${value.slice(0, fragment.start)}@${chosen}${suffix || " "}`;
        this.selected = 0;
        return { consumed: true, value: next };
      }
      default:
        return { consumed: false };
    }
  }

  /**
   * 当前候选（懒加载未完成时为空数组）。
   *
   * @param value 输入框内容。
   * @returns 最多 9 个相对路径。
   */
  private candidates(value: string): string[] {
    const fragment = this.fragment(value);
    if (!fragment || this.files === null) return [];
    return filterWorkspaceFiles(this.files, fragment.fragment, MAX_FILE_PALETTE_ITEMS);
  }

  /**
   * 首次需要候选时异步扫描工作区；扫描失败按空列表处理（不阻断输入）。
   */
  private ensureLoaded(): void {
    if (this.files !== null || this.loading) return;
    this.loading = true;
    listWorkspaceFiles(this.options.cwd, this.options.limit)
      .then((files) => {
        this.files = files;
      })
      .catch(() => {
        this.files = [];
      })
      .finally(() => {
        this.loading = false;
        this.options.onUpdate();
      });
  }
}

/**
 * 按目标可见宽裁剪并补空格（供背景铺满整行）。
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
 * 把选中下标夹紧到 `[0, length - 1]`。
 *
 * @param index 当前下标。
 * @param length 候选数。
 * @returns 夹紧后的下标；空列表返回 0。
 */
function resolveIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}
