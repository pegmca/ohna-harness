/**
 * 事件归约器（Phase C1 · D3「单一事件归约器 + 双 presenter」）。
 *
 * 职责：把与旧 `render.ts` 同源的 `AgentEvent` 流归约成**语义条目序列**，并在每次
 * 产出 / 修补后通过 `onChange` 回调广播变更；打印 presenter（非 TTY / readline 降级）
 * 与将来的 TUI 投影 presenter 都订阅同一份变更，逻辑只写一份。
 *
 * 吸收的时序状态（D5）：
 * - 旧 `assistantDotPrinted` → 「当前 assistant 条目是否在流式中」（`status === "streaming"`）；
 * - 旧 `thinkingBlockOpen` → reasoning 条目的存在与其 text 累积；
 * - 旧 `recentFolded` → 折叠改为组模型查询（C1b），本层不再缓存全文；
 * - 旧 `verbose` → 移入 presenter 的 verbosity（D6），归约层不做展示判断。
 *
 * 归约层不产 ANSI、不读终端宽度、不写 stdout——它是纯数据转换。
 */
import type { AgentEvent } from "@aiagent/agent";
import type { UsageTracker } from "../../session/usage.js";
import type { TuiEntry, TuiEntryKind, TuiEntryMeta, TuiEntryStatus } from "./entries.js";

/**
 * 归约变更：presenter 订阅的最小通知单元。
 *
 * - `run-start` / `run-end`：run 生命周期边界（spinner 启停、收尾）；
 * - `entry-added`：新条目诞生（也可能是兜底终态条目，见 {@link StreamReducer.apply}）；
 * - `entry-patched`：已存在条目被改写；`textDelta` 仅在流式增量补丁时携带，
 *   让打印 presenter 能「只输出新增的那一段」而不重复输出累积全文。
 */
export type StreamChange =
  | { type: "run-start" }
  | { type: "run-end" }
  | { type: "reset" }
  | { type: "entry-added"; entry: TuiEntry }
  | { type: "entry-patched"; entry: TuiEntry; textDelta?: string };

/** {@link StreamReducer} 的构造选项。 */
export interface StreamReducerOptions {
  /** 变更回调（TUI / 打印 presenter 订阅入口）。 */
  onChange?: (change: StreamChange) => void;
}

/** {@link StreamReducer.pushEntry} 的入参（不含自动生成的 id）。 */
interface NewEntryInput {
  kind: TuiEntryKind;
  status: TuiEntryStatus;
  text: string;
  meta?: TuiEntry["meta"];
}

/**
 * 事件 → entry 的单一归约器。
 *
 * 用法：`reducer.setOnChange(handleChange)` 后，把每个 `AgentEvent` 交给 {@link apply}；
 * 打印 presenter 在回调里同步消费，TUI 在回调里只标脏并请求重绘。
 */
export class StreamReducer {
  /** 条目序列（追加式；已存在条目就地修补，不重排）。 */
  private readonly list: TuiEntry[] = [];
  /** 单调递增序号：保证 id 稳定唯一（`${kind}-${序号}`）；`reset()` 不归零（见其注释）。 */
  private seq = 0;
  /** 当前流式中的 assistant 条目（message_start 建立，message_end 收尾）。 */
  private currentAssistant?: TuiEntry;
  /** 当前流式中的 reasoning 条目（thinking_start 建立，下一条 thinking_start 或正文打断）。 */
  private currentReasoning?: TuiEntry;
  /** 运行中的工具条目：toolCallId → entry（tool_execution_end 按 id 回填）。 */
  private readonly runningTools = new Map<string, TuiEntry>();
  /** 变更回调。 */
  private onChange?: (change: StreamChange) => void;

  /**
   * 构造归约器。
   *
   * @param options 可选变更回调。
   */
  constructor(options?: StreamReducerOptions) {
    this.onChange = options?.onChange;
  }

  /**
   * 注册 / 替换变更回调（便于 presenter 与 reducer 分离装配，避免构造顺序耦合）。
   *
   * @param fn 变更回调；undefined 表示取消订阅。
   */
  setOnChange(fn: ((change: StreamChange) => void) | undefined): void {
    this.onChange = fn;
  }

  /** 当前条目序列（只读视图，条目本身为实时引用）。 */
  entries(): readonly TuiEntry[] {
    return this.list;
  }

  /** 重置归约状态：清空条目与配对表（/clear、/resume、fork 切换会话时调用）。 */
  reset(): void {
    this.list.length = 0;
    // 注意（M2）：序号**不归零**。id 形如 `${kind}-${seq}`，若 reset 后从 0 重新计数，
    // 新会话的第一个 `tool-0` 会与旧会话同 id 冲突——TuiState.expanded 等以组 ID
    // （首叶子 id + kind）为 key 的视图状态会误命中新会话条目。序号单调递增即可保证
    // 全进程内 id 不复用。
    this.currentAssistant = undefined;
    this.currentReasoning = undefined;
    this.runningTools.clear();
    // 广播 reset：TUI 订阅者据此刷新条目引用（数组已就地清空，需要一次重绘）。
    this.emit({ type: "reset" });
  }

  /**
   * 追加一条用户输入回显为 `user` 条目（整屏 TUI 对话流）。
   *
   * 非 TTY 的输入回显由 repl 直接写入（`❯ …` 行），这里只服务整屏投影：让「用户输入」
   * 以语义条目进入对话流，与 assistant / tool 条目共享分组与滚动模型。
   *
   * @param text 用户输入原文（未上色；多行由投影层按行缩进渲染）。
   * @returns 新建 user 条目的实时引用。
   */
  appendUser(text: string): TuiEntry {
    return this.pushEntry({ kind: "user", status: "done", text });
  }

  /**
   * 追加一条宿主 notice（欢迎头 / slash 输出）。
   *
   * 与事件归约共用同一序列，保证 notice 与工具条目严格按时间顺序排列，也让
   * `reset()` 能一次性清空两者；`rawAnsi` 由投影层决定是否原样透传。
   *
   * @param text 未上色或已带 ANSI 的宿主文本（单行；多行由调用方拆分）。
   * @param meta 可选元数据（TUI 宿主透传 ANSI 时带 `rawAnsi: true`）。
   * @returns 新建 notice 条目的实时引用。
   */
  appendNotice(text: string, meta?: TuiEntryMeta): TuiEntry {
    return this.pushEntry({ kind: "notice", status: "done", text, ...(meta ? { meta } : {}) });
  }

  /**
   * 消费一个 AgentEvent 并产出 / 修补条目。
   *
   * 事件覆盖范围与旧 `renderEvent` 一致：agent_start / message_start /
   * message_update（text / thinking）/ tool_execution_start / tool_execution_end /
   * message_end / agent_end；turn_* 与 tool_execution_update 等无展示语义的事件被忽略。
   *
   * @param event 来自 agentLoop 的事件。
   * @param tracker 会话级用量累计器（message_end 吸收 usage、agent_end 产出小结）。
   */
  apply(event: AgentEvent, tracker: UsageTracker): void {
    switch (event.type) {
      case "agent_start": {
        // 运行态标记：presenter 据此启动 spinner / 计时；不产生对话条目。
        this.emit({ type: "run-start" });
        return;
      }

      case "message_start": {
        // 仅 assistant 消息进入对话流（user / toolResult 不在此渲染）。
        if (event.message.role !== "assistant") return;
        // 兜底：新消息开始前收尾上一段可能仍在流式中的思考。
        this.finalizeReasoning();
        this.currentAssistant = this.pushEntry({ kind: "assistant", status: "streaming", text: "" });
        return;
      }

      case "message_update": {
        const inner = event.assistantMessageEvent;
        if (inner.type === "text_delta") {
          // 正文开始即思考结束：先收尾当前 reasoning 段，再 patch 当前 assistant 条目
          // （绝不新建 assistant 条目，避免每 delta 一行）。
          this.finalizeReasoning();
          const entry = this.ensureAssistant();
          entry.text += inner.delta;
          this.emit({ type: "entry-patched", entry, textDelta: inner.delta });
          return;
        }
        if (inner.type === "thinking_start") {
          // 每段思考开一个新 reasoning 条目；开新段前先收尾上一段（同一消息内可多段）。
          this.finalizeReasoning();
          this.currentReasoning = this.pushEntry({ kind: "reasoning", status: "streaming", text: "" });
          return;
        }
        if (inner.type === "thinking_delta") {
          const entry = this.currentReasoning;
          if (!entry) return; // 未见 thinking_start 的孤立增量：无锚点可挂，忽略。
          entry.text += inner.delta;
          this.emit({ type: "entry-patched", entry, textDelta: inner.delta });
          return;
        }
        return;
      }

      case "tool_execution_start": {
        // 思考被工具调用打断：工具开始前收尾当前 reasoning 段。
        this.finalizeReasoning();
        const entry = this.pushEntry({
          kind: "tool",
          status: "running",
          text: "",
          meta: { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
        });
        this.runningTools.set(event.toolCallId, entry);
        return;
      }

      case "tool_execution_end": {
        const entry = this.runningTools.get(event.toolCallId);
        if (entry) {
          this.runningTools.delete(event.toolCallId);
          entry.status = event.isError ? "error" : "done";
          entry.meta = { ...entry.meta, result: event.result, isError: event.isError };
          this.emit({ type: "entry-patched", entry });
          return;
        }
        // 兜底：未见 start 的 end（异常事件序 / 直通伪事件）。直接落一个终态条目，
        // 打印 presenter 只输出结果行（不产 header），与旧行为等价。
        this.pushEntry({
          kind: "tool",
          status: event.isError ? "error" : "done",
          text: "",
          meta: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
          },
        });
        return;
      }

      case "message_end": {
        const message = event.message;
        // 仅 assistant 消息携带 usage；user 的 prompt 与 toolResult 不计入模型用量。
        if (message.role !== "assistant") return;
        // 兜底：消息结束收尾仍在流式中的 reasoning 段（思考后无正文的纯思考消息）。
        this.finalizeReasoning();
        tracker.add(message.usage);
        const entry = this.ensureAssistant();
        entry.status = message.stopReason === "error" ? "error" : "done";
        entry.meta = {
          ...entry.meta,
          stopReason: message.stopReason,
          ...(message.stopReason === "error" ? { errorMessage: message.errorMessage } : {}),
        };
        this.emit({ type: "entry-patched", entry });
        return;
      }

      case "agent_end": {
        // 兜底：run 边界前收尾仍在流式中的 reasoning 段（异常事件序）。
        this.finalizeReasoning();
        // run 边界：先通知 presenter 停帧，再产出用量小结（顺序与旧输出一致）。
        this.emit({ type: "run-end" });
        const summary = tracker.line();
        if (summary) this.pushEntry({ kind: "notice", status: "done", text: summary });
        if (event.error) {
          // provider 错误不走这里（编码在 assistant 消息里）；agent_end.error 是钩子/兜底收尾。
          this.pushEntry({
            kind: "error",
            status: "error",
            text: event.error.message,
            meta: { code: event.error.code, errorMessage: event.error.message },
          });
        }
        return;
      }

      default:
        // turn_start / turn_end / tool_execution_update 等在 CLI 中无需独立展示，避免噪声。
        return;
    }
  }

  /**
   * 新增条目并广播 `entry-added`。
   *
   * @param input 条目类别 / 状态 / 原文与元数据。
   * @returns 新建条目的实时引用。
   */
  private pushEntry(input: NewEntryInput): TuiEntry {
    const entry: TuiEntry = {
      id: `${input.kind}-${this.seq}`,
      kind: input.kind,
      status: input.status,
      text: input.text,
      ...(input.meta ? { meta: input.meta } : {}),
    };
    this.seq += 1;
    this.list.push(entry);
    this.emit({ type: "entry-added", entry });
    return entry;
  }

  /**
   * 取当前 assistant 条目；若事件序异常（无 message_start）则补建一个，保证 delta 不丢展示。
   *
   * @returns 当前 assistant 条目。
   */
  private ensureAssistant(): TuiEntry {
    if (!this.currentAssistant) {
      this.currentAssistant = this.pushEntry({ kind: "assistant", status: "streaming", text: "" });
    }
    return this.currentAssistant;
  }

  /**
   * 收尾当前 reasoning 段：把 `status` 置为 `done` 并广播 `entry-patched`（只 patch
   * 同一条目，绝不新建）。
   *
   * 触发时点：首个正文 `text_delta`（正文开始即思考结束）、`tool_execution_start`
   * （思考被工具调用打断）、下一条 `thinking_start`（新段开启前）、`message_end` /
   * `agent_end`（兜底）。缺少这一步会让思考组永久转圈、`activitySummary` 的
   * `"N thoughts"` 永不计数、`busyLabel` 对已结束思考仍显示 Thinking…。
   */
  private finalizeReasoning(): void {
    const entry = this.currentReasoning;
    if (!entry) return;
    // 先清空引用再广播，保证回调期间的重入不会重复收尾同一段。
    this.currentReasoning = undefined;
    if (entry.status !== "streaming") return;
    entry.status = "done";
    this.emit({ type: "entry-patched", entry });
  }

  /**
   * 广播一次变更。
   *
   * @param change 变更描述。
   */
  private emit(change: StreamChange): void {
    this.onChange?.(change);
  }
}
