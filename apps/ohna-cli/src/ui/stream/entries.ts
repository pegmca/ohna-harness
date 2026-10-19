/**
 * 语义条目模型（Phase C1 的**唯一契约**，勿在别处重复定义）。
 *
 * 动机（v1.4 计划 D3/D5）：改造前 ohna 的对话模型是「事件 → 预合成 ANSI 字符串数组」，
 * 时序状态（是否已打点、思考块是否开启）散落在 `render.ts` / `spinner.ts` 的模块级变量里。
 * 这里把「事件流的语义结果」抽象成稳定的 entry 序列：
 *
 * - **文本字段只存未上色原文**：上色 / 折叠 / 截断是投影层（`stream/print.ts` /
 *   将来 `ui/tui/rows.ts`）的职责，归约层绝不产出 ANSI——这样同一份 entry 既能给
 *   非 TTY 打印 presenter，也能给整屏 TUI 投影 presenter 复用（D3 双 presenter）。
 * - **id 稳定唯一**：`${kind}-${序号}`，同一条目在生命周期内 id 不变（只补丁 status/text），
 *   为 C1b 的组折叠锚点、以及将来的 checkpoint/rewind 定位预留 key。
 * - **status 显式**：streaming（流式中）/ running（工具执行中）/ done / error，
 *   让「消息是否结束」「工具是否失败」从隐式的模块级布尔量变成可查询的条目字段。
 */

/** 语义条目类别：user / assistant / reasoning / tool / error / notice。 */
export type TuiEntryKind = "user" | "assistant" | "reasoning" | "tool" | "error" | "notice";

/** 条目生命周期状态：streaming / running / done / error。 */
export type TuiEntryStatus = "streaming" | "running" | "done" | "error";

/**
 * verbosity 三档（D6）：分类/投影期旋钮，不在投影层写条件分支。
 *
 * - `low`：所有非文本条目统一折进 activity（对齐旧 `verbose=false`）；
 * - `medium`：reasoning/exploration 分组但折叠，activity 逐条；
 * - `high`：同 medium 且默认展开（对齐旧 `verbose=true` 的思考灰块展示）。
 *
 * C1a 阶段打印 presenter 只区分 high（=旧 verbose 开）与 low/medium（=旧 verbose 关）；
 * 三档分组语义已在 C1b 的 `classifier` / `rows` 落地：low 全部折进 activity 组、
 * medium reasoning/exploration 分组折叠、high 默认展开。
 */
export type TuiVerbosity = "low" | "medium" | "high";

/**
 * 条目附带的原始元数据（**未上色、未格式化**）。
 *
 * 各字段都指向上游事件的原始值：打印 presenter 自行决定如何折叠 / 着色 / 截断，
 * 归约层只做搬运与配对，避免把展示细节写进契约。
 */
export interface TuiEntryMeta {
  /** 工具调用 id（tool_execution_start/end 的配对键）。 */
  toolCallId?: string;
  /** 工具名（如 bash / write / edit）。 */
  toolName?: string;
  /** 工具入参原文（形状不固定，展示前由 presenter 格式化）。 */
  args?: unknown;
  /** 工具执行结果原文（tool_execution_end）。 */
  result?: unknown;
  /** 工具结果是否为错误（tool_execution_end.isError）。 */
  isError?: boolean;
  /** 模型/运行错误消息（message_end.stopReason=error 或 agent_end.error）。 */
  errorMessage?: string;
  /** assistant 消息的停止原因（原生 stopReason，便于诊断）。 */
  stopReason?: string;
  /** 运行级错误的稳定错误码（agent_end.error.code）。 */
  code?: string;
  /**
   * notice 条目是否原样透传 ANSI（C1b TUI 宿主注入的欢迎头 / slash 输出）。
   *
   * 语义条目契约本身仍然「不产 ANSI」：该标记只说明 `text` 来自宿主的已着色文本，
   * 由投影层决定原样输出；归约器自身产出的 notice / error 永远不带此标记。
   */
  rawAnsi?: boolean;
}

/**
 * 语义条目：对话流的最小稳定单元。
 *
 * 不可变约定之外的补充：`text` / `status` / `meta` 会被同一 id 的补丁就地改写
 * （流式 delta 只 patch `text`，不新建条目），因此订阅方读到的是**实时引用**，
 * 应在回调内同步消费，不长期持有。
 */
export interface TuiEntry {
  /** 稳定唯一 id（`${kind}-${序号}`），折叠锚点 / rewind 定位的 key。 */
  id: string;
  /** 条目类别。 */
  kind: TuiEntryKind;
  /** 生命周期状态。 */
  status: TuiEntryStatus;
  /** 未上色原文（assistant/reasoning 为累积增量；tool 为空，展示串由 presenter 生成）。 */
  text: string;
  /** 可选原始元数据（工具入参/结果、错误信息等）。 */
  meta?: TuiEntryMeta;
}
