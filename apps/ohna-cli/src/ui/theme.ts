/**
 * 终端主题层：Claude Code 风格复刻的 ANSI 色板与符号（零依赖手写）。
 *
 * 与 diff.ts 的零依赖哲学一致，不引入 chalk / picocolors。本模块只提供两件事：
 * 1. 惰性的 ANSI 能力探测（`supportsAnsi`）+ 显式覆盖（`configure` / `resetForTest`）；
 * 2. Amberwood 语义映射 + `paint` / `paintBg` / `surface` 安全包装 + 一套无条件替换的符号常量。
 *
 * 为什么探测必须惰性：ESM import 链（index → harness → turn → render → theme）会在
 * `parseArgs` 之前求值模块级常量。若在模块顶层读 `process.stdout.isTTY`，则
 * 颜色开关已固化，环境变化（重定向 / NO_COLOR 注入）后无法覆盖。
 * 裁决：不提供 CLI `--no-color` 参数，色彩关闭依赖自动降级（非 TTY / NO_COLOR / TERM=dumb）；
 * `configure` / `resetForTest` 仅作测试注入入口（见 `test/theme.test.mjs`）。
 */

/** 主题语义色角色：对应 Amberwood 设计稿的「语义块 → 颜色」映射。 */
export type ThemeRole =
  | "foreground"
  | "accent"
  | "user"
  | "string"
  | "property"
  | "success"
  | "error"
  | "warn"
  | "info"
  | "dim"
  | "note"
  | "selected"
  | "selectedText"
  | "focused";

/** 样式修饰：bold / italic，不占独立色位。 */
export type ThemeStyle = "bold" | "italic";

/** Amberwood 色板：语义角色 → 24-bit RGB 三元组。 */
const PALETTE: Record<ThemeRole, readonly [number, number, number]> = {
  foreground: [0xe8, 0xdc, 0xcb], // 助手正文 / 标题
  accent: [0xe8, 0x62, 0x3c], // ⏺ 工具名
  user: [0xe0, 0x7b, 0x39], // ❯ 用户标签
  string: [0xd9, 0xa4, 0x41], // 命令 / 工具参数
  property: [0xc9, 0x8a, 0x5e], // 文件路径 / 属性
  success: [0x8f, 0xb3, 0x6b], // ✓ / diff +
  error: [0xe2, 0x55, 0x3d], // ✗ / diff -
  warn: [0xf2, 0xa6, 0x5a], // plan 模式 / ⚠
  info: [0x6f, 0xa8, 0xc7], // 链接 / 行号引用
  dim: [0x8c, 0x7a, 0x68], // 次要文本 / 系统行
  note: [0xb5, 0xa3, 0x92], // 提示说明
  selected: [0x3a, 0x2a, 0x20], // 选中行背景（面板 / picker / palette）
  selectedText: [0xfc, 0xe9, 0xd4], // 选中行前景（保证深色背景上的对比度）
  focused: [0xff, 0x9f, 0x45], // 确认态边框 / accent（比 warn 更亮、更偏橙）
};

/**
 * 背景分层（Amberwood 设计稿）：画布 / 会话面板 / 工具卡片 / 描边。
 *
 * 由 {@link surface} 解析成 24-bit 背景 SGR，供整屏 TUI 的输入框、palette、
 * session picker 与权限卡消费（C5）。`stroke` 用作边框行底色，形成「面板 / 边框」
 * 两层视觉分层；色值仍是代码内常量，主题 JSON 与 16 色检测为远期。
 */
export const BACKGROUND = {
  /** 画布底色。 */
  canvas: "#180F0D",
  /** 会话面板底色。 */
  panel: "#1B1310",
  /** 工具卡片底色。 */
  toolCard: "#241A14",
  /** 描边色（边框行底色）。 */
  stroke: "#38291F",
} as const;

/** 可解析的背景表面名（与 {@link BACKGROUND} 的键一一对应）。 */
export type SurfaceName = keyof typeof BACKGROUND;

/**
 * 强制开关（测试注入）：用闭包持有，避免模块级 `let` 可变全局（v1.4 D5 状态收编）。
 *
 * `configure` 注入后优先于惰性探测；`resetForTest` 复位为 undefined，回到惰性探测。
 * 闭包外的模块只通过 get/set 访问，行为与改造前完全一致。
 */
const ansiOverride = (() => {
  let forced: boolean | undefined;
  return {
    /** 读取当前强制值；undefined 表示未覆盖。 */
    get: (): boolean | undefined => forced,
    /** 写入强制值；undefined 表示清除覆盖。 */
    set: (value: boolean | undefined): void => {
      forced = value;
    },
  };
})();

/**
 * 判断当前环境是否支持 ANSI 颜色输出。
 *
 * 每次调用现查环境（惰性求值），门控条件：stdout 为 TTY 且未设 NO_COLOR 且
 * TERM 不是 dumb，且未被 `configure` 显式覆盖。
 *
 * @returns 支持颜色输出时返回 true。
 */
export function supportsAnsi(): boolean {
  const forced = ansiOverride.get();
  if (forced !== undefined) return forced;
  return (
    !!process.stdout.isTTY &&
    !process.env.NO_COLOR &&
    process.env.TERM !== "dumb"
  );
}

/**
 * 显式覆盖 ANSI 开关。
 *
 * 当前仅测试注入使用（`configure({ forced: true })` 后 `supportsAnsi()` 恒返回该值），
 * 生产路径色彩开关完全由惰性探测决定（非 TTY / NO_COLOR / TERM=dumb 自动降级）。
 *
 * @param options forced 为 true / false；此后 supportsAnsi 恒返回该值。
 */
export function configure(options: { forced: boolean }): void {
  ansiOverride.set(options.forced);
}

/**
 * 复位 forced 覆盖，回到惰性探测。
 *
 * 测试注入覆盖后若不复位，会让后续「非 TTY 无 `\x1b`」断言假绿（颜色被强制打开）。
 * 每个注入用例的 afterEach 都应调用本函数。
 */
export function resetForTest(): void {
  ansiOverride.set(undefined);
}

/**
 * 用主题色包装一段文本；环境不支持 ANSI 时原样返回（降级）。
 *
 * 这是所有「带色输出」的唯一出口：非 TTY / NO_COLOR / dumb 终端
 * 下不产生任何 `\x1b` 转义序列，保证管道输出可被逐字节消费。
 *
 * @param text 原始文本。
 * @param role 语义色角色。
 * @param style 可选样式修饰（bold / italic）。
 * @returns 带色文本（支持 ANSI）或原文（降级）。
 */
export function paint(text: string, role: ThemeRole, style?: ThemeStyle): string {
  if (!supportsAnsi()) return text;
  const [r, g, b] = PALETTE[role];
  const modifier = style === "bold" ? ";1" : style === "italic" ? ";3" : "";
  return `\x1b[38;2;${r};${g};${b}${modifier}m${text}\x1b[0m`;
}

/**
 * 把十六进制色值解析成 24-bit RGB 三元组。
 *
 * 只支持 `#RRGGBB`（{@link BACKGROUND} 的既定格式），避免把颜色解析做成
 * 主题 DSL；非法输入回退为透明黑，保证渲染路径不抛异常。
 *
 * @param hex 形如 `#1B1310` 的色值。
 * @returns `[r, g, b]`，每项 0-255。
 */
function hexToRgb(hex: string): readonly [number, number, number] {
  const value = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return [0, 0, 0];
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

/**
 * 解析一个背景表面，返回 24-bit 背景色 SGR 前缀；不支持 ANSI 时返回空串。
 *
 * 之所以只返回前缀而不是完整包裹：调用方常需要把背景铺满整行（先补空格再上色），
 * 完整包裹由 {@link paintOnSurface} 承担。非 TTY / NO_COLOR / TERM=dumb 下返回空串，
 * 因此调用点不会泄漏任何 `\x1b`。
 *
 * @param name 表面名（与 {@link BACKGROUND} 键一致）。
 * @returns 背景色前缀（如 `\x1b[48;2;27;19;16m`）或空串。
 */
export function surface(name: SurfaceName): string {
  if (!supportsAnsi()) return "";
  const [r, g, b] = hexToRgb(BACKGROUND[name]);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * 用背景表面包裹一段文本，并在结尾恢复默认背景。
 *
 * 关键细节：文本内部的 `paint()` 以 `\x1b[0m` 复位**全部** SGR（含背景），
 * 若直接首尾包裹，颜色段之后的空格会掉回默认背景。这里在每个内部复位后重放
 * 背景前缀，保证整行表面连续；结尾用 `\x1b[49m` 只复位背景，不误伤调用方的前景样式。
 *
 * @param text 文本（可含既有 ANSI 颜色）。
 * @param name 表面名。
 * @returns 带连续背景的文本；不支持 ANSI 时原样返回。
 */
export function paintOnSurface(text: string, name: SurfaceName): string {
  const bg = surface(name);
  if (!bg) return text;
  const restored = text.includes("\x1b[0m") ? text.split("\x1b[0m").join(`\x1b[0m${bg}`) : text;
  return `${bg}${restored}\x1b[49m`;
}

/**
 * 用语义角色的颜色作为背景包裹文本（选中行 / 高亮块）。
 *
 * 与 {@link paintOnSurface} 的分工：后者消费 {@link BACKGROUND} 的结构性表面，
 * 本函数消费 {@link PALETTE} 的状态色。前景默认取 `foreground`，选中行通常传
 * `selectedText` 以保证深背景上的可读性。内部无嵌套颜色，结尾用 `\x1b[0m` 完整复位。
 *
 * @param text 原始文本（期望不含未闭合 ANSI）。
 * @param role 背景色角色。
 * @param foreground 前景色角色（缺省 foreground）。
 * @returns 反色块文本；不支持 ANSI 时原样返回。
 */
export function paintBg(text: string, role: ThemeRole, foreground: ThemeRole = "foreground"): string {
  if (!supportsAnsi()) return text;
  const [br, bg, bb] = PALETTE[role];
  const [fr, fg, fb] = PALETTE[foreground];
  return `\x1b[48;2;${br};${bg};${bb};38;2;${fr};${fg};${fb}m${text}\x1b[0m`;
}

/** 工具调用 / 助手正文标记（⏺ U+23FA）。 */
export const DOT = "⏺";

/** 工具结果标记（⎿ U+23BF）。 */
export const HOOK = "⎿";

/** 停止标记（⏹ U+23F9）。 */
export const STOP = "⏹";

/** spinner / 欢迎标记（✻ U+273B）。 */
export const SPIN = "✻";

/** 错误标记（✗ U+2717）。 */
export const CROSS = "✗";

/** 省略号（… U+2026）。 */
export const ELLIPSIS = "…";

/**
 * 输入区顶线：`╭─ ohna ─…─╮`，宽度取当时终端列数。
 *
 * 只作为普通内容打印（TTY 门控由调用方 `supportsAnsi` 决定），随后由 readline
 * 打印单行 prompt `│ > `。readline 的 `_refreshLine` 会把 prompt + line 当一个
 * 逻辑行做列折算，因此顶线不能塞进 setPrompt（多行 prompt 会导致行编辑错位）。
 *
 * @param columns 终端列数（缺省 80）。
 * @returns 一行顶线文本（含换行）。
 */
export function inputTopBar(columns: number): string {
  const width = Math.max(columns, 16);
  return "╭─ ohna " + "─".repeat(Math.max(width - 9, 0)) + "╮\n";
}

/**
 * 输入区下边框：`╰─…─╯`，宽度与 inputTopBar 对齐（外宽 = max(columns,16)）。
 *
 * 顶线在每次 prompt 前打印、下边框在「提交输入时」打印，从而把每条已提交输入
 * 在滚动历史里闭合为一个完整边框盒子（readline 无法在光标活动行下方持续作画，
 * 故下边框采用「提交即闭合」而非常驻，见 06-cli-theme.md §3.4 修订）。
 *
 * @param columns 终端列数（缺省 80）。
 * @returns 一行下边框文本（含换行）。
 */
export function inputBottomBar(columns: number): string {
  const width = Math.max(columns, 16);
  return "╰" + "─".repeat(Math.max(width - 2, 0)) + "╯\n";
}
