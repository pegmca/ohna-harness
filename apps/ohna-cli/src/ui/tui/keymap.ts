/**
 * 全局键位单一表（Phase C2 · D9 前置）。
 *
 * 改造前同一批按键散落在三处：`tui-editor.ts` 的 switch、`tui-app.ts` 的 Esc 手势、
 * picker / palette 各自的 handleKey；帮助、palette footer、welcome 又各自硬编码提示文本。
 * 这里把「键序列 + 展示标签 + 说明 + 生效域」收敛为 {@link KEYMAP}，其它展示位
 * （/help、palette footer、欢迎头）全部从本表生成——**改一处即全局一致**。
 *
 * 范围取舍（D9）：本期只做「定义 + 生成」，用户自定义键位（YAML）与 leader 前缀
 * （ctrl+x + 后继键的定时前缀序）列为远期，不在此实现。
 */

/** 键位生效域：always 恒生效；running / confirm 为语义标记（供展示与后续门控）。 */
export type KeyScope = "always" | "running" | "confirm";

/** 一条键位定义。 */
export interface KeyBinding {
  /** 稳定 id（如 `assistant.toggle-group`）。 */
  id: string;
  /** 规范化键名（`ctrl+o` / `shift+tab` / `esc esc` / `up/down` …），展示与匹配都读它。 */
  keys: string;
  /** 一句话说明（帮助 / footer 共用）。 */
  description: string;
  /** 生效域；缺省 always。 */
  when?: KeyScope;
}

/**
 * 键名 → raw 键序列（raw mode 下终端发来的原始字节）。
 *
 * 复合键名（`up/down`、`esc esc`）在 {@link matchesKey} 里按 `/` 拆开逐一比对；
 * `esc esc` 作为整体登记，便于展示「双击 Esc」而无需在调用方拼字符串。
 */
const KEY_SEQUENCES: Readonly<Record<string, readonly string[]>> = {
  "ctrl+o": ["\x0f"],
  "shift+tab": ["\x1b[Z"],
  esc: ["\x1b"],
  "esc esc": ["\x1b\x1b"],
  "ctrl+c": ["\x03"],
  tab: ["\t"],
  enter: ["\r", "\n"],
  up: ["\x1b[A"],
  down: ["\x1b[B"],
  pageup: ["\x1b[5~"],
  pagedown: ["\x1b[6~"],
  "ctrl+end": ["\x1b[1;5F"],
};

/** 单个键名的展示标签。 */
const KEY_LABELS: Readonly<Record<string, string>> = {
  "ctrl+o": "Ctrl+O",
  "shift+tab": "Shift+Tab",
  esc: "Esc",
  "ctrl+c": "Ctrl+C",
  tab: "Tab",
  enter: "Enter",
  up: "↑",
  down: "↓",
  pageup: "PageUp",
  pagedown: "PageDown",
  "ctrl+end": "Ctrl+End",
};

/**
 * 全局键位表：`/help`、palette footer、欢迎头提示的唯一来源。
 *
 * 顺序即帮助行的展示顺序；`palette.*` 条目只服务 palette footer，不在 /help 重复列出。
 */
export const KEYMAP: readonly KeyBinding[] = [
  {
    id: "assistant.toggle-group",
    keys: "ctrl+o",
    description: "展开 / 收起最近一个分组",
    when: "always",
  },
  {
    id: "permission.cycle-mode",
    keys: "shift+tab",
    description: "循环权限模式 default → acceptEdits → plan",
    when: "always",
  },
  {
    id: "session.interrupt",
    keys: "esc",
    description: "中断当前回答（空闲时无操作）",
    when: "always",
  },
  {
    id: "session.rewind-hint",
    keys: "esc esc",
    description: "回退编辑（checkpoint / rewind 落地后启用）",
    when: "always",
  },
  {
    id: "session.interrupt-ctrl-c",
    keys: "ctrl+c",
    description: "中断当前回答；空闲时退出会话",
    when: "always",
  },
  {
    id: "editor.history",
    keys: "up/down",
    description: "浏览输入历史",
    when: "always",
  },
  {
    id: "session.scroll",
    keys: "pageup/pagedown",
    description: "向上回填 / 向下回收历史（C4）",
    when: "always",
  },
  {
    id: "session.toBottom",
    keys: "ctrl+end",
    description: "回到对话底部",
    when: "always",
  },
  // palette footer 专用条目：与上面共享键序列，但说明更短，适合单行 footer。
  { id: "palette.move", keys: "up/down", description: "选择", when: "always" },
  { id: "palette.complete", keys: "tab", description: "补全", when: "always" },
  { id: "palette.submit", keys: "enter", description: "执行", when: "always" },
  { id: "palette.close", keys: "esc", description: "关闭", when: "always" },
];

/** palette footer 使用的键位 id（顺序即展示顺序）。 */
const PALETTE_HINT_IDS: readonly string[] = [
  "palette.move",
  "palette.complete",
  "palette.submit",
  "palette.close",
];

/**
 * 把规范化键名渲染为展示标签（复合键名按 `/` 逐段翻译）。
 *
 * @param keys 规范化键名（如 `up/down`、`ctrl+o`）。
 * @returns 展示标签（如 `↑/↓`、`Ctrl+O`）；未知键名原样返回。
 */
export function keyLabel(keys: string): string {
  return keys
    .split("/")
    .map((part) => KEY_LABELS[part] ?? part)
    .join("/");
}

/**
 * 判断一段 raw 输入是否命中某个键名。
 *
 * 复合键名（`up/down`）任一段命中即算命中。
 *
 * @param keys 规范化键名。
 * @param data 原始 stdin 输入。
 * @returns 命中返回 true。
 */
export function matchesKey(keys: string, data: string): boolean {
  return keys.split("/").some((part) => (KEY_SEQUENCES[part] ?? []).includes(data));
}

/**
 * 判断输入是否为「一个或多个独立 Esc」（不含方向键等 CSI 序列）。
 *
 * @param data 原始输入。
 * @returns 全部由 `\x1b` 组成时返回 true。
 */
export function isEscapeKey(data: string): boolean {
  return data.length > 0 && /^\x1b+$/.test(data);
}

/**
 * 按 id 查找键位定义。
 *
 * @param id 键位 id。
 * @returns 命中定义；未命中返回 undefined。
 */
export function findKeyBinding(id: string): KeyBinding | undefined {
  return KEYMAP.find((binding) => binding.id === id);
}

/**
 * 把若干键位 id 渲染为一行提示（`↑/↓ 选择 · Tab 补全`）。
 *
 * @param ids 键位 id 列表。
 * @param separator 条目分隔符，缺省 ` · `。
 * @returns 单行提示；未知 id 被跳过。
 */
export function formatKeyHints(ids: readonly string[], separator = " · "): string {
  return ids
    .map((id) => findKeyBinding(id))
    .filter((binding): binding is KeyBinding => binding !== undefined)
    .map((binding) => `${keyLabel(binding.keys)} ${binding.description}`)
    .join(separator);
}

/**
 * palette footer 文案（`/` 命令面板底部的键位提示）。
 *
 * @returns 单行 footer。
 */
export function paletteFooter(): string {
  return formatKeyHints(PALETTE_HINT_IDS);
}

/**
 * 生成 /help 的快捷键小节（名称与说明两列对齐）。
 *
 * 排除 `palette.*` 条目：它们只服务 palette footer，避免在通用帮助里重复。
 *
 * @returns 每个全局键位一行。
 */
export function keyHelpLines(): string[] {
  const bindings = KEYMAP.filter((binding) => !binding.id.startsWith("palette."));
  const labels = bindings.map((binding) => keyLabel(binding.keys));
  const pad = Math.max(...labels.map((label) => label.length));
  return bindings.map((binding, index) => `  ${labels[index].padEnd(pad)}  ${binding.description}`);
}
