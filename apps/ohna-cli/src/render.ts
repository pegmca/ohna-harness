/**
 * 终端渲染层：把 agent loop 产出的 AgentEvent 转成可读的命令行输出。
 * 该模块只负责「事件 → stdout」，不持有任何运行态；多轮状态（history / abort）由 harness 维护。
 *
 * M3 新增：
 * - write/edit 的 `tool_execution_start` 在确认闸门询问**之前**打印 unified diff
 *   （内核 tool-execution 的 prepare 先于 beforeToolCall，事件顺序天然满足）；
 * - `tool_execution_end` 的结果文本超阈值时只显示头尾 + 省略提示（输出折叠）。
 *
 * M6（CLI 主题）：
 * - 符号无条件替换（⏺ / ⎿ / ✗）；颜色由 theme.ts 的 `paint` 门控，仅 TTY 生效；
 * - spinner 单写者协议：正文写入前 `clearSpinner`、agent_start 启动、agent_end 停帧；
 * - 数字骨架（累计 token / 成本 $X）与 diff 行内容**不进 ANSI**（§2 红线）。
 *
 * B1（F-3）：
 * - verbose 开关 + 最近折叠块全文缓存；ctrl+o / `/verbose` 重打全文；
 * - thinking 增量按 verbose 分派（spinner 文案 / 灰色斜体块）。
 * 会话级用量累计（UsageTracker / formatCostLine）已移到 usage.ts，本文件只保留 re-export。
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { AgentEvent } from "@aiagent/agent";
import { formatUnifiedDiff } from "./diff.js";
import { clearSpinner, isSpinnerEnabled, setVerb, startSpinner, stopSpinner } from "./spinner.js";
import { CROSS, DOT, ELLIPSIS, HOOK, paint, SPIN } from "./theme.js";
import type { UsageTracker } from "./usage.js";

// 用量的累计 / 展示已拆到 usage.ts（会话级状态与事件渲染的职责分离）；
// 这里保留 re-export，使既有调用方（repl / harness / web-entry / session-flow）零修改。
export { createUsageTracker, formatCostLine } from "./usage.js";
export type { UsageSnapshot, UsageTracker } from "./usage.js";

/**
 * 输出 sink：所有 render 层写入都经 {@link write} 转发，便于 TTY 整屏模式注入。
 *
 * 默认直写 `process.stdout`（非 TTY / 旧 readline 路径行为完全不变）；
 * TTY 整屏模式由 repl 调用 `setOutputSink(s => tui.append(s))` 把输出接入 TuiApp
 * 对话模型，退出前 `setOutputSink(undefined)` 复位。
 */
let outputSink: (s: string) => void = (s) => process.stdout.write(s);

/**
 * 设置输出 sink（注入式）。
 *
 * 传 `undefined` 复位为直写 `process.stdout`。TTY 整屏模式下用 `s => tui.append(s)`
 * 把 welcome / 事件渲染等输出导入对话模型，避免直接向真实终端写而破坏整屏。
 *
 * @param fn 新的 sink；`undefined` 表示复位默认。
 */
export function setOutputSink(fn: ((s: string) => void) | undefined): void {
  outputSink = fn ?? ((s) => process.stdout.write(s));
}

/**
 * 统一输出出口：render 层所有写入经此函数，默认直写 stdout，可被 sink 注入接管。
 *
 * @param text 待输出文本。
 */
export function write(text: string): void {
  outputSink(text);
}

/**
 * 设置 verbose 模式开关（F-3）。
 *
 * @param value true 开启、false 关闭。
 */
export function setVerbose(value: boolean): void {
  // 思考流进行中关闭 verbose：先补换行收尾，避免后续工具/正文行拼到灰色思考块末尾。
  if (verbose && !value && thinkingBlockOpen) {
    write("\n");
    thinkingBlockOpen = false;
  }
  verbose = value;
}

/**
 * 读取当前 verbose 开关状态。
 *
 * @returns verbose 是否开启。
 */
export function isVerbose(): boolean {
  return verbose;
}

/**
 * 切换 verbose 并返回切换后的状态（TUI ctrl+o 与 /verbose 共用）。
 *
 * @returns 切换后是否开启。
 */
export function toggleVerbose(): boolean {
  setVerbose(!verbose);
  return verbose;
}

/**
 * 清空折叠块全文缓存（/clear、/resume 切换会话时调用）。
 *
 * 缓存是模块级会话状态：不清理会让 ctrl+o 把上一个会话的工具输出重打到新会话里，
 * 既误导用户，也可能泄露已切走会话的内容。
 */
export function resetFoldCache(): void {
  recentFolded.length = 0;
}

/**
 * 重打最近被折叠的工具输出全文（F-3：verbose 打开时经 write 输出）。
 *
 * append-only TUI 的取舍：ctrl+o 只能「把缓存全文追加重打」而非「改写已打印行」，
 * 因此这里把 {@link recentFolded} 里每个块全文重新输出一遍；无缓存时给出明确提示。
 * 开头先写 `\n`：若上一段正文/工具输出尚未以换行收尾，可避免重打内容黏在流式行尾。
 */
export function reprintRecentFolded(): void {
  // 只有 verbose 打开时才重打：关闭态下调用应是无副作用的（避免把全文混进普通会话）。
  if (!isVerbose()) return;
  if (recentFolded.length === 0) {
    write("（本会话还没有折叠过工具输出，无可重打内容）\n");
    return;
  }
  write(`\n--- 重打最近 ${recentFolded.length} 个折叠块全文 ---\n`);
  for (const full of recentFolded) {
    write(`${full}\n`);
  }
  write("--- 折叠块全文结束 ---\n");
}

/** 渲染选项：控制工具调用的展示细节与来源标注。 */
export interface RenderOptions {
  /** 工作区根目录（diff 与路径展示基准）；缺省 process.cwd()。 */
  workspaceRoot?: string;
  /** MCP 发现的工具名：/tools 与欢迎头据此标注「(MCP)」来源。 */
  mcpToolNames?: ReadonlySet<string>;
}

/** 输出折叠阈值：结果文本超过任一阈值即折叠（字符数 / 行数）。 */
const FOLD_MAX_CHARS = 1_200;
const FOLD_MAX_LINES = 40;
/** 折叠时头部与尾部各保留的行数。 */
const FOLD_HEAD_LINES = 15;
const FOLD_TAIL_LINES = 10;
/** 错误结果完整保留的字符上限。 */
const ERROR_RESULT_MAX_CHARS = 400;
/** diff 展示行数上限，超过即折叠中段。 */
const DIFF_MAX_LINES = 400;
/** diff 折叠时头部 / 尾部各保留的行数。 */
const DIFF_HEAD_LINES = 200;
const DIFF_TAIL_LINES = 120;

/**
 * 当前 assistant 消息是否已打 ⏺ 点（懒打点：首个 text_delta 到达才打）。
 *
 * 为什么用模块级状态而不是塞进 tracker：tracker 只关心 token/成本，职责单一；
 * renderEvent 本身是同步事件处理器，事件按序到达，message_start 是新消息的天然复位点。
 */
let assistantDotPrinted = false;

/**
 * F-3 verbose 模式开关：打开后思考过程以灰色斜体展示、折叠块可重打全文。
 *
 * 为什么是模块级状态：renderEvent 是无状态同步事件处理器，事件按序到达；verbose 是
 * 「全局渲染偏好」而非单条消息状态，用模块级开关最贴合（TUI ctrl+o 与 /verbose 都改它）。
 */
let verbose = false;

/** verbose 思考块是否已开启（流式期间跟踪，保证思考与正文之间有换行分隔、收尾干净）。 */
let thinkingBlockOpen = false;

/**
 * 非 verbose + spinner 禁用（TTY 整屏）时，当前 assistant 消息是否已打过
 * `✻ 思考中…` 占位行。每条 assistant 消息只打一次，由 message_start 复位。
 */
let thinkingHintPrinted = false;

/** 折叠块全文缓存上限：ctrl+o / /verbose 重打「最近 N 个被折叠的工具输出」。 */
const FOLD_CACHE_SIZE = 8;

/** 最近被折叠的工具输出原文（FIFO，最多 {@link FOLD_CACHE_SIZE} 个）。 */
const recentFolded: string[] = [];

/**
 * 把单个 AgentEvent 渲染到终端。
 * 文本增量用 process.stdout.write 实时打印；工具调用与结果各占一行，保持简洁不刷屏；
 * assistant 消息结束时补换行并累计 usage；agent_end 打印小结（含异常）。
 *
 * @param event 来自 agentLoop 的事件。
 * @param tracker 当前 run 的用量累计器（message_end 时吸收 usage，agent_end 时输出小结）。
 * @param options 渲染选项（模式）。
 */
export function renderEvent(event: AgentEvent, tracker: UsageTracker, options?: RenderOptions): void {
  switch (event.type) {
    case "agent_start": {
      // spinner 单写者协议：run 开始即启动「思考中」帧，首个文本增量到达时被抑制。
      startSpinner("思考中");
      return;
    }

    case "message_start": {
      // 新 assistant 消息复位懒打点标志；纯 tool-call 消息（无文本）不产生悬空 ⏺ 行。
      if (event.message.role === "assistant") {
        assistantDotPrinted = false;
        thinkingBlockOpen = false; // 新消息复位 verbose 思考块状态
        thinkingHintPrinted = false; // 新消息允许再打一次「思考中」占位行
      }
      return;
    }

    case "message_update": {
      // 正文 / 思考增量按 verbose 分派：默认思考进 spinner 文案，verbose 下灰色斜体展示。
      const inner = event.assistantMessageEvent;
      if (inner.type === "text_delta") {
        // verbose 思考块未闭合时先补换行，保证正文另起一行、不与思考内容拼接。
        if (isVerbose() && thinkingBlockOpen) {
          write("\n");
          thinkingBlockOpen = false;
        }
        // 每个 delta 都清帧并标记一次正文写入，抑制 spinner 在流式期间重启帧（撕裂防护）。
        clearSpinner();
        if (!assistantDotPrinted) {
          // 懒打点：首个 text_delta 才打 ⏺；纯 tool-call 消息不产生悬空 ⏺ 行。
          write(paint(`${DOT} `, "accent"));
          assistantDotPrinted = true;
        }
        write(paint(inner.delta, "foreground"));
      } else if (inner.type === "thinking_start") {
        if (isVerbose()) {
          // verbose：等第一个 thinking_delta 再开灰色斜体块（无增量时不留空块）。
          return;
        }
        if (isSpinnerEnabled()) {
          // 非 TTY：spinner 是唯一写者，把动词切回「思考中」（tool 执行会改成「执行 X」）。
          // 只在 start 切一次，避免每增量重置已耗时。
          setVerb("思考中");
        } else if (!thinkingHintPrinted) {
          // TTY 整屏禁用了 spinner（避免 \r\x1b[K 污染对话模型）：退化为追加一行
          // `✻ 思考中…`，让用户至少能感知思考阶段。每条 assistant 消息只打一次，
          // 避免多段 thinking 刷屏；与 verbose 灰色斜体块互斥。若正文已开始流式
          // （非典型顺序），先换行，避免提示黏在正文行尾。
          if (assistantDotPrinted) write("\n");
          write(paint(`${SPIN} 思考中${ELLIPSIS}`, "dim") + "\n");
          thinkingHintPrinted = true;
        }
      } else if (inner.type === "thinking_delta") {
        if (isVerbose()) {
          // verbose：灰色斜体块；首段前打 ✻ 标记，与正文的 ⏺ 区分。
          clearSpinner();
          if (!thinkingBlockOpen) {
            write(paint(`${SPIN} `, "dim"));
            thinkingBlockOpen = true;
          }
          write(paint(inner.delta, "dim", "italic"));
        }
        // 非 verbose：thinking 内容不落正文，spinner 已在 agent_start / thinking_start 显示「思考中」。
      }
      return;
    }

    case "tool_execution_start": {
      setVerb(`执行 ${event.toolName}`);
      clearSpinner();
      // ⏺ Tool(args)：⏺ accent、工具名 accent+bold、入参 dim（M6 主题：替换旧三角形调用标记）。
      write(
        `${paint(DOT, "accent")} ${paint(event.toolName, "accent", "bold")}(${paint(formatToolArgs(event.toolName, event.args), "dim")})\n`,
      );
      // 写前 diff 预览：必须在确认闸门询问之前展示，用户才能据此决定 allow / deny。
      // 红线（§2）：diff 行内容（+/- 行与 @@ 头）不进 ANSI，此处原样打印。
      const diffText = renderToolDiff(event.toolName, event.args, options);
      if (diffText) write(diffText + "\n");
      return;
    }

    case "tool_execution_end": {
      const resultText = extractResultText(event.result);
      clearSpinner();
      if (event.isError) {
        // 错误信息是用户排障的唯一线索：保留完整前 400 字符，不参与头尾折叠。
        write(
          `  ${paint(`${HOOK} ${CROSS}`, "error")} ${resultText.slice(0, ERROR_RESULT_MAX_CHARS)}\n`,
        );
      } else {
        write(`  ${paint(`${HOOK}`, "dim")} ${resultText ? foldOutput(resultText) : ""}\n`);
      }
      return;
    }

    case "message_end": {
      // 仅 assistant 消息携带 usage；user 的 prompt 消息与 toolResult 不计入模型用量。
      const message = event.message;
      if (message.role === "assistant") {
        tracker.add(message.usage);
        // 收行只在「确实流式输出过正文」时补换行；纯 tool-call 消息不留悬空空行。
        if (assistantDotPrinted) {
          write("\n");
          assistantDotPrinted = false;
        }
        // verbose 思考块若未闭合（如思考后直接跟 toolcall、或流异常），补换行收尾。
        if (isVerbose() && thinkingBlockOpen) {
          write("\n");
          thinkingBlockOpen = false;
        }
        // provider 错误不会进入 agent_end.error（loop 把失败编码在 assistant 消息里）；
        // 这里必须显式提示，否则用户只看到空白 + 退出码 0。
        if (message.stopReason === "error") {
          clearSpinner();
          write(
            paint(`${CROSS} 模型调用失败：${message.errorMessage || "provider 返回未知错误"}`, "error") + "\n",
          );
        }
      }
      return;
    }

    case "agent_end": {
      stopSpinner();
      const summary = tracker.line();
      // 数字骨架（累计 token / 成本 $X）保持纯文本（§2 红线），不套色。
      if (summary) write(`\n${summary}\n`);
      if (event.error) {
        write(
          paint(`\n${CROSS} 运行异常终止（${event.error.code}）：${event.error.message}`, "error") + "\n",
        );
      }
      return;
    }

    default:
      // turn_start / turn_end / tool_execution_update 等在 CLI 中无需独立展示，避免噪声。
      return;
  }
}

/**
 * 工具入参的紧凑 JSON 表示，超长截断，避免一行刷屏。
 *
 * @param value 工具入参对象。
 * @returns 紧凑字符串。
 */
function shortJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (!text) return "{}";
    return truncateText(text, 200);
  } catch {
    return String(value);
  }
}

/**
 * 把路径渲染成相对当前工作目录的形式（越界则保留绝对形式，越界本身会被工具层拒绝）。
 *
 * @param target 绝对路径或相对路径。
 * @returns 便于阅读的路径文本。
 */
function toRelative(target: string): string {
  const cwd = process.cwd();
  const absolute = path.isAbsolute(target) ? target : path.resolve(cwd, target);
  const relative = path.relative(cwd, absolute);
  const shown = relative && !relative.startsWith("..") ? relative : absolute;
  return truncateText(shown, 160);
}

/**
 * 单行文本截断，超长用省略号收尾。
 *
 * @param text 原始文本。
 * @param max 最大长度。
 * @returns 截断后的文本。
 */
function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 工具入参的一行展示：bash 显示命令、读写编辑显示相对路径、grep/find 显示模式，
 * 结构意外时回退到紧凑 JSON，避免整段参数刷屏。
 *
 * ohna 恒为编码助手，因此这里的「路径 / 命令」摘要无条件生效。
 *
 * @param toolName 工具名。
 * @param args 工具入参。
 * @returns 一行入参文本。
 */
function formatToolArgs(toolName: string, args: unknown): string {
  if (typeof args !== "object" || args === null) return shortJson(args);

  const record = args as Record<string, unknown>;
  if (typeof record.command === "string") return truncateText(record.command.replace(/\s+/g, " "), 160);

  const relativePath = typeof record.path === "string" ? toRelative(record.path) : undefined;
  if (toolName === "grep" || toolName === "find") {
    const pattern = typeof record.pattern === "string" ? record.pattern : "";
    return relativePath ? `${pattern} 于 ${relativePath}` : pattern;
  }
  if (relativePath) return relativePath;
  return shortJson(args);
}

/**
 * 从工具执行结果中提取一句可读文本：优先取 content 内的 text 块，其次 message 字段。
 *
 * @param result 工具回传的结构化结果（形状不固定）。
 * @returns 可读文本。
 */
function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;

  if (result && typeof result === "object") {
    const record = result as { content?: unknown; message?: unknown };
    if (Array.isArray(record.content)) {
      const text = record.content
        .filter((block): block is { type: string; text: string } =>
          !!block && typeof block === "object" && (block as { type?: string }).type === "text",
        )
        .map((block) => block.text)
        .join("");
      if (text) return text;
    }
    if (typeof record.message === "string") return record.message;
  }

  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * 折叠超长的工具输出：超过阈值时只保留头尾，中间以 `… +N 行` 标记替代。
 *
 * @param text 工具结果文本。
 * @returns 原文（未超阈值）或「头 + … +N 行 + 尾」。
 */
export function foldOutput(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= FOLD_MAX_LINES && text.length <= FOLD_MAX_CHARS) return text;

  // F-3：折叠前缓存全文，供 ctrl+o / /verbose 重打（append-only TUI 只能「重打」不能「改写」）。
  recentFolded.push(text);
  if (recentFolded.length > FOLD_CACHE_SIZE) recentFolded.shift();

  const head = lines.slice(0, FOLD_HEAD_LINES);
  const tail = lines.length > FOLD_HEAD_LINES ? lines.slice(-FOLD_TAIL_LINES) : [];
  const omitted = lines.length - head.length - tail.length;
  const omittedNote = omitted > 0 ? `${ELLIPSIS} +${omitted} 行（ctrl+o 展开）` : "";
  return [...head, omittedNote, ...tail].filter(Boolean).join("\n");
}

/**
 * 解析 write/edit 入参中的目标路径。
 *
 * @param args 工具入参。
 * @param root 工作区根目录（相对路径的解析基准）。
 * @returns 绝对路径；形状不符返回 null。
 */
function resolveDiffTargetPath(args: unknown, root: string): string | null {
  if (typeof args !== "object" || args === null) return null;
  const target = (args as { path?: unknown }).path;
  if (typeof target !== "string" || !target) return null;
  return path.isAbsolute(target) ? target : path.resolve(root, target);
}

/**
 * 同步读取磁盘上的当前文件内容；读不到（新文件）返回 null。
 *
 * 为什么用同步 IO：renderEvent 是同步事件处理器，diff 必须在确认闸门询问前
 * 打印完成；文件读取是本机操作，微秒~毫秒级，不值得为它引入异步渲染管线。
 *
 * @param absolutePath 绝对路径。
 * @returns 文件内容；不存在 / 不可读返回 null。
 */
function readCurrentContent(absolutePath: string): string | null {
  try {
    return readFileSync(absolutePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * 为 write / edit 生成写前 unified diff 预览。
 *
 * - write：旧内容取磁盘现状（读不到视为新文件，全 `+` 行）；
 * - edit：在磁盘现状上做一次精确替换得到「编辑后内容」，找不到匹配时不出 diff
 *   （工具层会以 isError 回喂「未找到唯一匹配」，无需重复报错）。
 *
 * @param toolName 工具名（仅处理 write / edit）。
 * @param args 工具入参。
 * @param options 渲染选项（工作区基准）。
 * @returns 可直接打印的 diff 文本（含折叠）；无需展示时返回空字符串。
 */
export function renderToolDiff(toolName: string, args: unknown, options?: RenderOptions): string {
  if (toolName !== "write" && toolName !== "edit") return "";
  const root = options?.workspaceRoot ?? process.cwd();
  const record = args as Record<string, unknown>;
  const absolutePath = resolveDiffTargetPath(args, root);
  if (!absolutePath) return "";

  const relative = path.relative(root, absolutePath);
  const label = relative && !relative.startsWith("..") ? relative : absolutePath;
  const current = readCurrentContent(absolutePath);
  const oldText = current ?? "";

  let nextText: string | undefined;
  if (toolName === "write") {
    if (typeof record.content !== "string") return "";
    nextText = record.content;
  } else {
    const oldString = record.oldText;
    const newString = record.newText;
    if (typeof oldString !== "string" || typeof newString !== "string") return "";
    // 磁盘上没有该文件（或不含匹配）时不出 diff：前者工具必然报错，后者由工具报「未找到唯一匹配」。
    if (current === null || !current.includes(oldString)) return "";
    nextText = current.replace(oldString, newString);
  }

  // 新文件：磁盘无内容且不是覆盖写 → 全 `+`；读取失败同样按新文件展示。
  const isNewFile = toolName === "write" && current === null;
  const diff = formatUnifiedDiff(oldText, nextText, isNewFile ? `新文件 ${label}` : undefined);
  if (!diff) return "";

  const lines = diff.split("\n");
  let shown = lines;
  if (lines.length > DIFF_MAX_LINES) {
    const head = lines.slice(0, DIFF_HEAD_LINES);
    const tail = lines.slice(-DIFF_TAIL_LINES);
    shown = [...head, `${ELLIPSIS} [diff 已折叠，省略 ${lines.length - head.length - tail.length} 行]`, ...tail];
  }
  return [label, ...shown].join("\n");
}
