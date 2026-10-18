/**
 * 终端宽度工具：零依赖手写实现，不引入 string-width / chalk。
 *
 * 极简子集目标：box 组件与调用方都需要「按可见列宽（而非 JS 字符串长度）」排版，
 * 因此只要能正确剥离 ANSI 转义并估算 CJK/全角字符宽度为 2 即可，不做断行/分词。
 */

/**
 * 剥离 ANSI 转义序列（SGR / CSI / OSC / 字符集切换），只保留可见文本。
 *
 * 为什么手写而非引入库：本包零外部依赖。终端里只有少数几种逃逸格式需要剔除，
 * 用一组正则可覆盖 paint() 产出的 `\x1b[38;2;r;g;bm…\x1b[0m` 以及常规光标/清屏序列。
 *
 * @param s 可能含 ANSI 转义的原始字符串。
 * @returns 去掉所有转义序列后的纯文本。
 */
export function stripAnsi(s: string): string {
  // SGR/CSI：ESC [ ... 结尾字母（如 m/G/K/H/J）
  // OSC：ESC ] ... BEL 或 ESC \ 结束（如超链接、标题）
  // 字符集切换：ESC ( / ESC ) 后跟单个字母
  return s.replace(/\x1b\[[0-9;?]*[0-9A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB0-2]/g, "");
}

/**
 * 判断码点是否为「宽字符」（在等宽终端里占 2 列）。
 *
 * 覆盖中日韩统一表意文字、平假名/片假名、Hangul、全角 ASCII 及常见符号/表情。
 * 这是一个足够 box 排版使用的近似集合，不追求与 Unicode 标准 100% 一致。
 *
 * @param cp Unicode 码点。
 * @returns 占 2 列时返回 true。
 */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首 / 康熙字典
    (cp >= 0x3041 && cp <= 0x33ff) || // 平假名 / 片假名 / 带圈数字
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本区
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x1f300 && cp <= 0x1faff) || // 符号与象形表情
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+（补充平面）
  );
}

/**
 * 估算单个码点在终端占用的列数：控制字符 0 列，宽字符 2 列，其余 1 列。
 *
 * @param cp Unicode 码点。
 * @returns 列宽（0 / 1 / 2）。
 */
function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 0x20) return 0; // C0 控制字符
  if (cp === 0x7f) return 0; // DEL
  if (cp >= 0x80 && cp < 0xa0) return 0; // C1 控制字符
  return isWide(cp) ? 2 : 1;
}

/**
 * 计算字符串在终端占用的可见列宽。
 *
 * 先剥离 ANSI 转义（转义本身不占列），再按码点累加宽度；CJK/全角算 2，
 * 控制字符算 0。供 box 等排版组件使用，避免把转义序列或中文当成 1 列。
 *
 * @param str 原始字符串（可能含 ANSI 转义）。
 * @returns 可见列宽。
 */
export function visibleWidth(str: string): number {
  if (str.length === 0) return 0;
  const clean = stripAnsi(str);
  let width = 0;
  for (const ch of clean) {
    width += charWidth(ch.codePointAt(0)!);
  }
  return width;
}
