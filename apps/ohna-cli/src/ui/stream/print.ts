/**
 * 打印 presenter（Phase C1 · D3 非 TTY / readline 降级路径的唯一写者）。
 *
 * 行为零变化：逐事件复刻改造前 `ui/render.ts` 的打印逻辑，非 TTY 输出逐字节等价。
 * 状态收编（D5）：旧 `render.ts` / `spinner.ts` 的模块级变量全部收编为实例字段。
 * 单一归约器（D3）：`StreamReducer` 归约 entry，`onChange` 驱动打印；布局状态留在
 * 本类，语义状态（工具在跑、消息失败）留在归约器。C3 起 TUI 下模型失败改送 Toast。
 */
import type { AgentEvent } from "@aiagent/agent";
import type { UsageTracker } from "../../session/usage.js";
import { DEFAULT_SPINNER_VERB, FIRST_FRAME_DELAY_MS, FRAME_INTERVAL_MS, spinnerFrame } from "../spinner.js";
import { DOT, ELLIPSIS, paint, SPIN, supportsAnsi } from "../theme.js";
import type { RenderOptions } from "./print-format.js";
// 行格式化 / diff 纯函数集中在 print-format.ts；打印侧只负责清 spinner 与写 sink。
import {
  formatAssistantFailureLine, formatRunErrorLine, formatToolHeaderLine, formatToolResultLine, renderToolDiff,
} from "./print-format.js";
import type { TuiEntry, TuiEntryMeta, TuiVerbosity } from "./entries.js";
import type { StreamChange } from "./reducer.js";
import { StreamReducer } from "./reducer.js";

/**
 * 非 TTY / readline 打印 presenter：一个实例即一份「打印侧会话状态」。
 * 模块级 `printPresenter` 是默认实例，经 `ui/render.ts` 暴露给既有调用方。
 */
export class PrintPresenter {
  /** 输出 sink：默认直写 stdout，可被 `setOutputSink` 接管（TTY 整屏模式接 TuiApp）。 */
  private sink: (s: string) => void;
  /** 当前 verbosity（D6 三档；打印路径 high=旧 verbose 开，low/medium=旧 verbose 关）。 */
  private verbosity: TuiVerbosity = "low";
  /** 当前事件的渲染选项（tool start 打印 diff 时读取）。 */
  private options: RenderOptions = {};

  /** 当前 assistant 行是否已打过 `⏺` 且尚未收行（旧 assistantDotPrinted）。 */
  private assistantLineOpen = false;
  /** verbose 思考灰块是否已开启（旧 thinkingBlockOpen）。 */
  private thinkingBlockOpen = false;
  /** 当前 assistant 消息是否已打过 `✻ 思考中…` 占位行（旧 thinkingHintPrinted）。 */
  private thinkingHintPrinted = false;

  /** spinner 是否启用（TTY 整屏模式由 repl 关闭，避免 `\r\x1b[K` 污染对话模型）。 */
  private spinnerEnabled = true;
  /** spinner 当前动词文案（旧模块级 verb）。 */
  private spinnerVerb = DEFAULT_SPINNER_VERB;
  /** spinner 本轮开始时刻（旧 startedAt）。 */
  private spinnerStartedAt = 0;
  /** spinner 是否已有可见帧（旧 visible）。 */
  private spinnerVisible = false;
  /** 最近一次正文写入时刻，用于撕裂防护空闲窗（旧 lastWriteAt）。 */
  private spinnerLastWriteAt = 0;
  /** spinner 定时器句柄；非 TTY 恒为 null（旧 timer）。 */
  private spinnerTimer: NodeJS.Timeout | null = null;
  /** spinner 是否被 confirm 挂起（旧 suspended）。 */
  private spinnerSuspended = false;

  /**
   * 事件打印开关（C1b TUI 模式）。
   * TUI 模式下 presenter 仍负责归约事件与广播变更，但**不再写 stdout**——
   * 否则事件行会与整屏投影重复。`write()` 原始输出通道不受影响（宿主 notice
   * 走 `appendNotice`，仍会进入同一归约流）。
   */
  private eventRenderingEnabled = true;

  /** 归约变更订阅者（TUI 投影订阅入口；与事件打印开关解耦）。 */
  private readonly listeners = new Set<() => void>();

  /** 宿主瞬时提示通道（C3）：TUI 下「模型调用失败」送 Toast，详情仍留在对话流 entry。 */
  private notifier?: (text: string) => void;

  /** 单一事件归约器：entry 序列的唯一事实源（C1b 的 TUI 投影也订阅它）。 */
  private readonly reducer: StreamReducer;

  /**
   * @param options 可选输出 sink（缺省直写 `process.stdout`，测试可注入捕获函数）。
   */
  constructor(options?: { sink?: (s: string) => void }) {
    this.sink = options?.sink ?? ((s) => process.stdout.write(s));
    this.reducer = new StreamReducer({ onChange: (change) => this.handleChange(change) });
  }

  /**
   * 消费一个 AgentEvent：先归约成 entry，再由变更回调同步打印。
   * @param event 来自 agentLoop 的事件。
   * @param tracker 会话级用量累计器。
   * @param options 渲染选项（工作区根目录等）。
   */
  renderEvent(event: AgentEvent, tracker: UsageTracker, options?: RenderOptions): void {
    // 同步事件链：options 在 apply 期间对 tool start 的 diff 预览可见。
    this.options = options ?? {};
    this.reducer.apply(event, tracker);
  }

  /**
   * 设置输出 sink（注入式）；传 undefined 复位为直写 stdout。
   * @param fn 新 sink 或 undefined。
   */
  setOutputSink(fn: ((s: string) => void) | undefined): void {
    this.sink = fn ?? ((s) => process.stdout.write(s));
  }

  /**
   * 设置 verbosity 三档（D6）：打印路径 `high` 等价旧 verbose 开，其余档等价旧 verbose 关。
   * 从 high 降到其它档时，若思考灰块尚未收尾，先补换行（与旧 `setVerbose(false)` 一致）。
   * @param level 目标档位。
   */
  setVerbosity(level: TuiVerbosity): void {
    if (this.verbosity === "high" && level !== "high" && this.thinkingBlockOpen) {
      this.write("\n");
      this.thinkingBlockOpen = false;
    }
    this.verbosity = level;
  }

  /** 读取当前 verbosity。 */
  getVerbosity(): TuiVerbosity {
    return this.verbosity;
  }

  /** @returns 条目序列（实时引用）。 */
  entries(): readonly TuiEntry[] {
    return this.reducer.entries();
  }

  /**
   * 订阅归约变更（TUI 投影入口，与事件打印开关解耦）。
   * @param fn 变更回调。
   * @returns 取消订阅函数。
   */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * 启用 / 禁用事件打印（TTY 整屏模式禁用，避免与投影重复；`write()` 不受影响）。
   * @param value true 启用打印（默认）、false 仅归约。
   */
  setEventRenderingEnabled(value: boolean): void {
    this.eventRenderingEnabled = value;
  }

  /**
   * 设置宿主瞬时提示通道（C3）：TUI 接 Toast；undefined 关闭。
   * @param fn 提示回调。
   */
  setNotifier(fn: ((text: string) => void) | undefined): void {
    this.notifier = fn;
  }

  /**
   * 追加宿主文本为 notice 条目（欢迎头 / slash 输出的 TUI 通道）。
   * 按 `\n` 拆成单行 notice，`rawAnsi` 时保留原 ANSI 由投影层原样透传。
   * @param text 待追加文本（可多行、可含 ANSI）。
   * @param options `rawAnsi=true` 表示原样透传 ANSI。
   */
  appendNotice(text: string, options?: { rawAnsi?: boolean }): void {
    if (text.length === 0) return;
    const lines = text.split("\n");
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const meta: TuiEntryMeta | undefined = options?.rawAnsi ? { rawAnsi: true } : undefined;
    for (const line of lines) this.reducer.appendNotice(line, meta);
  }

  /**
   * 追加一条用户输入回显为 `user` 条目（整屏 TUI 通道）。
   *
   * 非 TTY 分支的输入回显由 repl 直接 `write`，不经过 presenter；此入口只在
   * TuiState 接入本 presenter 时被调用，让用户输入以语义条目进入整屏投影。
   *
   * @param text 用户输入原文（未上色）。
   */
  appendUser(text: string): void {
    if (text.length === 0) return;
    this.reducer.appendUser(text);
  }

  /**
   * 会话级重置（/clear、/resume、fork）：清空条目与打印布局状态，**不重置** sink /
   * verbosity / spinner 开关（属用户偏好与宿主装配，不随会话切换变化）。
   */
  resetPresentation(): void {
    this.reducer.reset();
    this.assistantLineOpen = false;
    this.thinkingBlockOpen = false;
    this.thinkingHintPrinted = false;
    this.options = {};
  }

  /**
   * 同步收尾：停止动画帧（打印链路全同步、无内部缓冲，无需额外 flush）。
   */
  flush(): void {
    this.stopSpinner();
  }

  /**
   * 统一输出出口（正文与 spinner 帧共用同一 sink，保证单写者）。
   * @param text 待输出文本。
   */
  write(text: string): void {
    this.sink(text);
  }

  /**
   * @param value true 启用、false 禁用（禁用时立即清掉可见帧）。
   */
  setSpinnerEnabled(value: boolean): void {
    if (value) {
      this.spinnerEnabled = true;
      return;
    }
    this.stopSpinner();
    this.spinnerEnabled = false;
  }

  /** 读取 spinner 是否启用（render 侧决定思考提示行的降级方式）。 */
  isSpinnerEnabled(): boolean {
    return this.spinnerEnabled;
  }

  /**
   * 启动 spinner（agent_start / resume 挂接点）。
   * @param initialVerb 初始动词文案（缺省「思考中」）。
   */
  startSpinner(initialVerb = DEFAULT_SPINNER_VERB): void {
    if (!supportsAnsi()) return;
    if (!this.spinnerEnabled) return;
    this.stopSpinner();
    this.spinnerVerb = initialVerb;
    const now = Date.now();
    this.spinnerStartedAt = now;
    this.spinnerLastWriteAt = now;
    this.spinnerTimer = setInterval(() => {
      if (supportsAnsi()) this.drawSpinner();
    }, FRAME_INTERVAL_MS);
  }

  /**
   * 切换 spinner 动词文案（tool_execution_start 挂接点，如「执行 bash」）。
   * @param nextVerb 新的动词文案。
   */
  setVerb(nextVerb: string): void {
    if (!this.spinnerEnabled) return;
    this.spinnerVerb = nextVerb;
    const now = Date.now();
    this.spinnerStartedAt = now;
    this.spinnerLastWriteAt = now;
  }

  /**
   * 清除可见帧并标记最近一次正文写入（正文写入前的撕裂防护）。
   */
  clearSpinner(): void {
    if (!this.spinnerEnabled) return;
    if (this.spinnerVisible) {
      this.write("\r\x1b[K");
      this.spinnerVisible = false;
    }
    this.spinnerLastWriteAt = Date.now();
  }

  /** 停止 spinner（agent_end / abort / error 路径的收尾挂接点）。 */
  stopSpinner(): void {
    if (!this.spinnerEnabled) return;
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (this.spinnerVisible) {
      this.write("\r\x1b[K");
      this.spinnerVisible = false;
    }
  }

  /** 挂起 spinner：confirm 询问前调用，避免帧覆盖提示。 */
  suspendSpinner(): void {
    if (!this.spinnerEnabled) return;
    this.spinnerSuspended = this.spinnerTimer !== null;
    this.stopSpinner();
  }

  /** 恢复 spinner：confirm resolve 后按原动词重启（仅当此前确实在跑）。 */
  resumeSpinner(): void {
    if (!this.spinnerEnabled) return;
    if (!this.spinnerSuspended) return;
    this.spinnerSuspended = false;
    this.startSpinner(this.spinnerVerb);
  }

  /**
   * 绘制一帧：`✻ 动词… (Ns)`，覆盖上一次帧。
   * 空闲窗未到直接返回（撕裂防护）；帧内容 dim 着色后再写入。
   */
  private drawSpinner(): void {
    if (!this.spinnerEnabled) return;
    if (Date.now() - this.spinnerLastWriteAt < FIRST_FRAME_DELAY_MS) return;
    const elapsed = (Date.now() - this.spinnerStartedAt) / 1000;
    this.write(`\r\x1b[K${paint(spinnerFrame(this.spinnerVerb, elapsed), "dim")}`);
    this.spinnerVisible = true;
  }

  /** 归约变更分发：先广播（TUI 订阅者），再决定打印或送 Toast。 @param change 归约变更。 */
  private handleChange(change: StreamChange): void {
    // 先广播（TUI 订阅者需要知道条目变化），再决定是否打印。
    for (const listener of this.listeners) listener();
    if (!this.eventRenderingEnabled) {
      // C3：TUI 不打印事件行；`message_end stopReason=error` 改送 Toast
      //（详情仍是 assistant 条目的 error 行，对话流保留完整信息）。
      const failed = change.type === "entry-patched" ? change.entry : undefined;
      if (this.notifier && failed?.kind === "assistant" && failed.status === "error") {
        const message = failed.meta?.errorMessage || "provider 返回未知错误";
        this.notifier(formatAssistantFailureLine(message));
      }
      return;
    }
    switch (change.type) {
      case "run-start":
        // spinner 单写者协议：run 开始即启动「思考中」帧，首个文本增量到达时被抑制。
        this.startSpinner(DEFAULT_SPINNER_VERB);
        return;
      case "run-end":
        this.stopSpinner();
        return;
      case "reset":
        // 会话重置：不产生输出（条目已清空）。
        return;
      case "entry-added":
        this.handleEntryAdded(change.entry);
        return;
      case "entry-patched":
        this.handleEntryPatched(change.entry, change.textDelta);
        return;
    }
  }

  /**
   * 新条目：按 kind 打印对应的「起始」行。
   * @param entry 新条目。
   */
  private handleEntryAdded(entry: TuiEntry): void {
    switch (entry.kind) {
      case "assistant":
        // 新 assistant 消息复位懒打点 / 思考块 / 占位行状态（等价旧 message_start 分支）。
        this.assistantLineOpen = false;
        this.thinkingBlockOpen = false;
        this.thinkingHintPrinted = false;
        return;

      case "reasoning":
        // 默认（low/medium）思考不进正文：有 spinner 交给 spinner，否则追加一次占位行。
        if (this.verbosity === "high") return;
        if (this.spinnerEnabled) {
          this.setVerb(DEFAULT_SPINNER_VERB);
          return;
        }
        if (!this.thinkingHintPrinted) {
          if (this.assistantLineOpen) this.write("\n");
          this.write(paint(`${SPIN} 思考中${ELLIPSIS}`, "dim") + "\n");
          this.thinkingHintPrinted = true;
        }
        return;

      case "tool":
        // 兜底终态条目（未见 start 的 end）：只打印结果行，不产 header。
        if (entry.status !== "running") {
          this.printToolResult(entry);
          return;
        }
        this.setVerb(`执行 ${entry.meta?.toolName ?? ""}`);
        this.clearSpinner();
        // ⏺ Tool(args)：⏺ accent、工具名 accent+bold、入参 dim（M6 主题）。
        this.write(formatToolHeaderLine(entry));
        // 写前 diff 预览：必须在确认闸门询问之前展示，用户才能据此决定 allow / deny。
        // 红线（§2）：diff 行内容（+/- 行与 @@ 头）不进 ANSI，此处原样打印。
        {
          const diffText = renderToolDiff(entry.meta?.toolName ?? "", entry.meta?.args, this.options);
          if (diffText) this.write(diffText + "\n");
        }
        return;

      case "notice":
        // 用量小结：数字骨架保持纯文本（§2 红线），前后各留一个空行（等价旧 `\n${summary}\n`）。
        this.write(`\n${entry.text}\n`);
        return;

      case "error":
        // 运行级错误（agent_end.error）：与 provider 错误（assistant 条目 error）区分文案。
        this.write(formatRunErrorLine(entry));
        return;

      case "user":
        // 用户输入回显由上层（repl）负责；打印 presenter 不重复输出。
        return;
    }
  }

  /**
   * 条目补丁：流式增量或状态终态。
   * @param entry 被修补后的条目（实时引用）。
   * @param textDelta 流式增量（仅 text_delta / thinking_delta 携带）。
   */
  private handleEntryPatched(entry: TuiEntry, textDelta?: string): void {
    switch (entry.kind) {
      case "assistant":
        if (textDelta !== undefined) {
          this.printAssistantDelta(textDelta);
          return;
        }
        this.closeAssistantMessage(entry);
        return;

      case "reasoning":
        if (textDelta !== undefined) this.printReasoningDelta(textDelta);
        return;

      case "tool":
        this.printToolResult(entry);
        return;

      case "notice":
      case "error":
      case "user":
        return;
    }
  }

  /**
   * 打印正文增量：收思考块 → 清 spinner → 懒打 ⏺ → 输出 delta。
   * @param delta 文本增量。
   */
  private printAssistantDelta(delta: string): void {
    // verbose 思考块未闭合时先补换行，保证正文另起一行、不与思考内容拼接。
    if (this.verbosity === "high" && this.thinkingBlockOpen) {
      this.write("\n");
      this.thinkingBlockOpen = false;
    }
    // 每个 delta 都清帧并标记一次正文写入，抑制 spinner 在流式期间重启帧（撕裂防护）。
    this.clearSpinner();
    if (!this.assistantLineOpen) {
      // 懒打点：首个 text_delta 才打 ⏺；纯 tool-call 消息不产生悬空 ⏺ 行。
      this.write(paint(`${DOT} `, "accent"));
      this.assistantLineOpen = true;
    }
    this.write(paint(delta, "foreground"));
  }

  /**
   * 打印思考增量（仅 high 档）：灰色斜体块，首段前打 ✻ 标记。
   * @param delta 思考增量。
   */
  private printReasoningDelta(delta: string): void {
    if (this.verbosity !== "high") return;
    this.clearSpinner();
    if (!this.thinkingBlockOpen) {
      this.write(paint(`${SPIN} `, "dim"));
      this.thinkingBlockOpen = true;
    }
    this.write(paint(delta, "dim", "italic"));
  }

  /** assistant 消息收尾（message_end）：收行 / 收思考块 / provider 错误显式提示。 @param entry 已置 done/error 的条目。 */
  private closeAssistantMessage(entry: TuiEntry): void {
    // 收行只在「确实流式输出过正文」时补换行；纯 tool-call 消息不留悬空空行。
    if (this.assistantLineOpen) {
      this.write("\n");
      this.assistantLineOpen = false;
    }
    // verbose 思考块若未闭合（如思考后直接跟 toolcall、或流异常），补换行收尾。
    if (this.verbosity === "high" && this.thinkingBlockOpen) {
      this.write("\n");
      this.thinkingBlockOpen = false;
    }
    // provider 错误不会进入 agent_end.error（loop 把失败编码在 assistant 消息里）；
    // 这里必须显式提示，否则用户只看到空白 + 退出码 0。
    if (entry.status === "error") {
      this.clearSpinner();
      this.write(formatAssistantFailureLine(entry.meta?.errorMessage || "provider 返回未知错误") + "\n");
    }
  }

  /** 打印工具结果行：错误保留前 400 字符，成功走头尾折叠（文案见 {@link formatToolResultLine}）。 @param entry 已置 done/error 的工具条目。 */
  private printToolResult(entry: TuiEntry): void {
    this.clearSpinner();
    this.write(formatToolResultLine(entry));
  }
}

/**
 * 模块级默认 presenter：非 TTY / readline 路径与 web-entry 共用同一实例。
 *
 * 这是唯一允许存在的模块级**实例**（const，不可重新赋值）；所有可变状态都在实例字段里。
 * 对外函数（renderEvent / write / setOutputSink / …）在 `ui/render.ts` 里做薄委托，
 * 保证既有调用方的公共入口与签名不变。
 */
export const printPresenter = new PrintPresenter();

