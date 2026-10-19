/**
 * 输入序列拼装器（Phase C2 补丁 · 跨 chunk 序列完整性）。
 *
 * 问题：raw mode 下一次 stdin `data` 事件不保证落在转义序列边界。终端可能把方向键
 * `\x1b[A` 拆成 `"\x1b"` + `"[A"` 两次送达，bracketed paste 起止标记
 * `\x1b[200~` / `\x1b[201~` 也可能被切开。改造前 `TuiApp.handleInput` 直接把这半截
 * 序列交给 `InputRouter`：`"\x1b"` 被 `isEscapeKey` 当成 Esc（误中断 run / 关面板），
 * 紧随的 `"[A"` 又被 editor 当普通字符插入；权限卡同样会把 `[A` 之类当输入。
 *
 * 修复：在路由**最上游**做唯一入口的不完整序列缓冲。把每个 chunk 与残留 `pending`
 * 拼接后切出完整序列（CSI / SS3 / bracketed paste / 两字节 Alt+键 / 普通文本），只把
 * 完整片段交给下游；尾部未闭合的 `\x1b...` 暂存，并在 {@link DEFAULT_TIMEOUT_MS} 毫秒
 * 后**原样**分发。单个 `\x1b` 只是「可能是 Esc，也可能是 CSI 前缀」，超时放行即 Esc
 * 手势——由此保证 Esc 永不失效，只引入可感知的极小延迟。
 *
 * 设计取舍：
 * - 纯字符串处理、不读终端，可脱离真实 TTY 单测；
 * - `feed` 同步返回本次可立即分发的完整序列数组（确定、易断言）；超时兜底走异步
 *   `onFlush` 回调（setTimeout 无法用返回值表达）；
 * - `dispose()` 清理定时器，避免 TuiApp.stop 后仍有悬挂分发写向已交还的终端。
 */

/** 未闭合序列的兜底等待时长（约 25–50ms 区间取中）：足够让同一次按键的后续字节到达。 */
export const DEFAULT_TIMEOUT_MS = 30;

/**
 * 从 `start` 处测量一个完整转义序列的长度。
 *
 * 识别形态：
 * - CSI：`ESC [ 参数 中间字节 最终字节`（最终字节 `@`~`~`，因此 `\x1b[A` / `\x1b[200~` 均在此列）；
 * - SS3：`ESC O <char>`（如 F1 `\x1bOP`）；
 * - 两字节 Alt+键：`ESC <char>`（char 非 `[` / `O`）；
 * - `ESC ESC`：首个 ESC 后无其它可辨字节，判定为独立 Esc，立即返回长度 1。
 *
 * 序列被 chunk 边界截断时返回 -1，由调用方缓冲到下一 chunk / 超时兜底。
 *
 * @param input 输入串。
 * @param start ESC 所在下标。
 * @returns 序列长度；不完整时返回 -1。
 */
function readSequenceLength(input: string, start: number): number {
  const next = input[start + 1];
  if (next === undefined) return -1; // 只剩一个 ESC：可能是 Esc，也可能是 CSI/SS3 前缀
  if (next === "[") {
    let i = start + 2;
    // 参数字节（0-9 ; : < = > ?）与中间字节（空格 ~ `/`）后紧跟最终字节（@ ~ ~）。
    while (i < input.length && /[0-9;:<=>?]/.test(input[i])) i += 1;
    while (i < input.length && input[i] >= " " && input[i] <= "/") i += 1;
    if (i >= input.length) return -1; // 未读到最终字节：不完整
    return i + 1 - start;
  }
  if (next === "O") return input[start + 2] === undefined ? -1 : 3; // SS3：ESC O <char>
  if (next === "\x1b") return 1; // ESC 后紧跟 ESC：首个必为独立 Esc，立即可分发
  return 2; // 两字节 Alt+键
}

/** {@link InputAssembler} 的构造选项。 */
export interface InputAssemblerOptions {
  /**
   * 超时兜底分发回调：`pending` 只可能是「开头一个未闭合的 `\x1b` 序列」，
   * 超时后原样交给下游（单个 `\x1b` 即一次 Esc 手势）。
   *
   * @param data 未闭合序列原文。
   */
  onFlush: (data: string) => void;
  /** 兜底等待毫秒（缺省 {@link DEFAULT_TIMEOUT_MS}）。 */
  timeoutMs?: number;
}

/**
 * 跨 chunk 输入序列拼装器：唯一入口的缓冲 + 超时兜底。
 *
 * 用法：`TuiApp.handleInput` 把每个 raw chunk 交给 {@link feed}，并同步分发其返回值
 * （已完整）；异步尾字节由 `onFlush` 补齐。
 */
export class InputAssembler {
  /** 未闭合序列缓冲（总是以 `\x1b` 开头；为空表示无待拼装内容）。 */
  private pending = "";
  /** 兜底定时器句柄；`pending` 非空时存在。 */
  private timer?: ReturnType<typeof setTimeout>;
  /** 超时兜底回调。 */
  private readonly onFlush: (data: string) => void;
  /** 兜底等待毫秒。 */
  private readonly timeoutMs: number;

  /**
   * @param options 超时回调与可选等待时长。
   */
  constructor(options: InputAssemblerOptions) {
    this.onFlush = options.onFlush;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * 送入一段原始 stdin 数据，返回其中**可立即分发**的完整序列。
   *
   * 不完整尾部保存在 {@link pending} 并排程超时兜底；下次 `feed` 会先拼接该尾部再解析，
   * 因此一个序列无论被拆成几次到达都能还原。
   *
   * @param chunk 本次 stdin 原始字节（UTF-8 字符串）。
   * @returns 本次可立即分发的片段（完整转义序列或连续普通文本）。
   */
  feed(chunk: string): string[] {
    this.clearTimer();
    const input = this.pending + chunk;
    this.pending = "";
    const ready: string[] = [];
    let i = 0;
    while (i < input.length) {
      if (input[i] !== "\x1b") {
        // 连续非 ESC 字节合并为一个片段：保持「一段可打印文本一次分发」的既有语义。
        let j = i + 1;
        while (j < input.length && input[j] !== "\x1b") j += 1;
        ready.push(input.slice(i, j));
        i = j;
        continue;
      }
      const length = readSequenceLength(input, i);
      if (length < 0) {
        // 未闭合序列：保留从该 ESC 起的尾部，等待下一 chunk 或超时。
        this.pending = input.slice(i);
        break;
      }
      ready.push(input.slice(i, i + length));
      i += length;
    }
    if (this.pending.length > 0) this.schedule();
    return ready;
  }

  /** 清空缓冲与定时器（`TuiApp.stop` 调用），避免悬挂分发。 */
  dispose(): void {
    this.clearTimer();
    this.pending = "";
  }

  /** 排程一次超时兜底：把当前 `pending` 原样分发。 */
  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const pending = this.pending;
      this.pending = "";
      if (pending.length > 0) this.onFlush(pending);
    }, this.timeoutMs);
  }

  /** 清除已排程的兜底定时器（若有）。 */
  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
