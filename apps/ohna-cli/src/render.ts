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
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { AgentEvent } from "@aiagent/agent";
import type { Usage } from "@aiagent/ai";
import { formatUnifiedDiff } from "./diff.js";
import { clearSpinner, setVerb, startSpinner, stopSpinner } from "./spinner.js";
import { CROSS, DOT, ELLIPSIS, HOOK, paint } from "./theme.js";

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

/** 会话累计用量的可持久化快照（与 session-store 的 SessionUsageTotals 同形）。 */
export interface UsageSnapshot {
  /** 累计输入 token。 */
  input: number;
  /** 累计输出 token。 */
  output: number;
  /** 累计 token 总数。 */
  total: number;
  /** 累计成本（美元）。 */
  cost: number;
}

/**
 * 会话级 token / 成本累计器：逐条吸收 assistant 消息的 usage。
 *
 * 与 M1 的「单轮累计」不同，同一实例跨 run 复用，因此 /cost 与 --max-cost 看到的是
 * 整个会话（含 --resume 恢复）的真实累计，而不是最后一轮的局部数字。
 */
export interface UsageTracker {
  /** 累加一条 assistant 消息的用量。 */
  add(usage: Usage): void;
  /** 生成累计小结文案；无任何用量时返回 null（例如被中断的空 run）。 */
  line(): string | null;
  /** 读取当前累计快照（用于 --max-cost 判定与落盘）。 */
  snapshot(): UsageSnapshot;
  /** 从落盘快照恢复（--resume）；覆盖当前累计值。 */
  restore(snapshot: UsageSnapshot): void;
}

/**
 * 创建会话级用量累计器。
 *
 * @returns 可累加、快照、恢复的 UsageTracker。
 */
export function createUsageTracker(): UsageTracker {
  let input = 0;
  let output = 0;
  let total = 0;
  let cost = 0;

  return {
    add(usage: Usage): void {
      input += usage.input;
      output += usage.output;
      total += usage.totalTokens;
      cost += usage.cost.total;
    },
    line(): string | null {
      if (total === 0) return null;
      return `累计 token: ${total}（输入 ${input} / 输出 ${output}），成本 $${cost.toFixed(6)}`;
    },
    snapshot(): UsageSnapshot {
      return { input, output, total, cost };
    },
    restore(snapshot: UsageSnapshot): void {
      input = snapshot.input;
      output = snapshot.output;
      total = snapshot.total;
      cost = snapshot.cost;
    },
  };
}

/**
 * 生成 `/cost` 的展示文案：始终有输出（无用量时明确说明，而不是空行）。
 *
 * 注意：本行数字骨架（累计 token N / 成本 $X）必须保持纯文本，不进 ANSI（§2 红线），
 * 否则 verify 脚本的两个数字捕获组会被转义序列打断。
 *
 * @param tracker 会话级累计器。
 * @returns 单行中文用量文案。
 */
export function formatCostLine(tracker: UsageTracker): string {
  const snapshot = tracker.snapshot();
  if (snapshot.total === 0) {
    return "累计用量：暂无（本会话尚未产生模型调用）";
  }
  return `累计用量：token ${snapshot.total}（输入 ${snapshot.input} / 输出 ${snapshot.output}），成本 $${snapshot.cost.toFixed(6)}`;
}

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
      if (event.message.role === "assistant") assistantDotPrinted = false;
      return;
    }

    case "message_update": {
      // 仅转发文本增量；thinking / toolcall 增量不在 CLI 主输出中渲染，避免打断正文流。
      const inner = event.assistantMessageEvent;
      if (inner.type === "text_delta") {
        // 每个 delta 都清帧并标记一次正文写入，抑制 spinner 在流式期间重启帧（撕裂防护）。
        clearSpinner();
        if (!assistantDotPrinted) {
          // 懒打点：首个 text_delta 才打 ⏺；纯 tool-call 消息不产生悬空 ⏺ 行。
          write(paint(`${DOT} `, "accent"));
          assistantDotPrinted = true;
        }
        write(paint(inner.delta, "foreground"));
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

  const head = lines.slice(0, FOLD_HEAD_LINES);
  const tail = lines.length > FOLD_HEAD_LINES ? lines.slice(-FOLD_TAIL_LINES) : [];
  const omitted = lines.length - head.length - tail.length;
  const omittedNote = omitted > 0 ? `${ELLIPSIS} +${omitted} 行` : "";
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
