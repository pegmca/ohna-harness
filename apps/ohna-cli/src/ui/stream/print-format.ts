/**
 * 打印 presenter 的纯格式化工具（Phase C1 从 `ui/render.ts` 原样迁移）。
 *
 * 这里只放**无状态纯函数**与常量：折叠阈值、工具入参一行摘要、工具结果文本提取、
 * 打印行格式化（工具头行 / 结果行 / 失败提示）与写前 unified diff。它们被
 * `stream/print.ts`（非 TTY 打印）复用，也被 `ui/tui/rows.ts`（整屏投影）复用；
 * 不持有任何会话状态（D5：模块级可变全局清零）。
 *
 * 注意：行格式化函数会产出 ANSI（颜色由主题决定），但仍是纯函数——同样的输入得到
 * 同样的输出，不读时钟、不读终端；「是否写 sink / 何时清 spinner」的副作用留在
 * `PrintPresenter` 内部收口。
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { formatUnifiedDiff } from "../diff.js";
import { CROSS, DOT, ELLIPSIS, HOOK, paint } from "../theme.js";
import type { TuiEntry } from "./entries.js";

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
export const ERROR_RESULT_MAX_CHARS = 400;
/** diff 展示行数上限，超过即折叠中段。 */
const DIFF_MAX_LINES = 400;
/** diff 折叠时头部 / 尾部各保留的行数。 */
const DIFF_HEAD_LINES = 200;
const DIFF_TAIL_LINES = 120;

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
export function formatToolArgs(toolName: string, args: unknown): string {
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
export function extractResultText(result: unknown): string {
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
 * 折叠超长的工具输出：超过阈值时只保留头尾，中间以 `… +N 行` + 可执行提示替代。
 *
 * 注意（C1 / D4）：这里**不再缓存折叠全文**。旧实现的 `recentFolded` FIFO 是为 append-only
 * TUI 的「ctrl+o 重打全文」服务的；C1b 起折叠改为组模型查询（entry 自带全文），
 * 因此缓存被删除。
 *
 * 提示文案（M3）由调用方传入：非 TTY 打印路径与 TUI 投影路径的「查看完整输出」入口不同
 * （`/export` vs `ctrl+o 展开分组 + /export`），折叠逻辑只写一份，文案各自提供。
 *
 * @param text 工具结果文本。
 * @param omittedHint 中段省略提示的后缀（含括号）；缺省指向 `/export`。
 * @returns 原文（未超阈值）或「头 + … +N 行 + 提示 + 尾」。
 */
export function foldOutput(text: string, omittedHint = "（完整输出见 /export）"): string {
  const lines = text.split("\n");
  if (lines.length <= FOLD_MAX_LINES && text.length <= FOLD_MAX_CHARS) return text;

  const head = lines.slice(0, FOLD_HEAD_LINES);
  const tail = lines.length > FOLD_HEAD_LINES ? lines.slice(-FOLD_TAIL_LINES) : [];
  const omitted = lines.length - head.length - tail.length;
  const omittedNote = omitted > 0 ? `${ELLIPSIS} +${omitted} 行${omittedHint}` : "";
  return [...head, omittedNote, ...tail].filter(Boolean).join("\n");
}

/**
 * 按**可用行数预算**折叠行序列（头尾保留 + 中段省略），Phase C3 权限卡 diff 预览复用。
 *
 * 与 {@link foldOutput} 的区别：`foldOutput` 的阈值是固定常量（40 行 / 1200 字符），
 * 本函数由调用方传入预算——权限卡的高度受输入区分配约束，需要"恰好塞进 N 行"。
 * 折叠策略保持一致：优先保留头部，再保留尾部，中间以 `… +N 行` 标记替代。
 *
 * @param lines 原始行。
 * @param maxLines 预算行数（<=0 表示不显示任何行）。
 * @returns 不超过 maxLines 的行序列（含省略标记行）。
 */
export function foldLinesToBudget(lines: readonly string[], maxLines: number): string[] {
  if (maxLines <= 0) return [];
  const list = [...lines];
  if (list.length <= maxLines) return list;
  // 只有 1 行预算时只放省略标记（头尾都放不下）。
  if (maxLines === 1) return [`${ELLIPSIS} +${list.length} 行`];
  const markerLines = 1;
  const headCount = Math.ceil((maxLines - markerLines) / 2);
  const tailCount = maxLines - markerLines - headCount;
  const omitted = list.length - headCount - tailCount;
  // 注意 `slice(-0)` 等价于 `slice(0)`（会取整段），预算为 2 时 tailCount=0 必须显式判空。
  const tail = tailCount > 0 ? list.slice(-tailCount) : [];
  return [...list.slice(0, headCount), `${ELLIPSIS} +${omitted} 行`, ...tail];
}

/**
 * 工具调用头行：`⏺ 工具名(入参摘要)`（⏺ accent、名字 accent+bold、入参 dim，M6 主题）。
 *
 * @param entry 处于 running 的工具条目。
 * @returns 头行文本（含尾换行）。
 */
export function formatToolHeaderLine(entry: TuiEntry): string {
  const name = entry.meta?.toolName ?? "";
  const args = formatToolArgs(name, entry.meta?.args);
  return `${paint(DOT, "accent")} ${paint(name, "accent", "bold")}(${paint(args, "dim")})\n`;
}

/**
 * 工具结果行：错误保留前 {@link ERROR_RESULT_MAX_CHARS} 字符，成功走头尾折叠。
 *
 * 抽到纯函数层的原因：打印 presenter 只负责「清 spinner + 写 sink」这一副作用的收口，
 * 文案 / 截断 / 折叠策略集中一份，便于单测与将来其它 presenter 复用。
 *
 * @param entry 已置 done/error 的工具条目。
 * @returns 最终行文本（含尾换行）。
 */
export function formatToolResultLine(entry: TuiEntry): string {
  const resultText = extractResultText(entry.meta?.result);
  if (entry.status === "error") {
    // 错误信息是用户排障的唯一线索：保留完整前 400 字符，不参与头尾折叠。
    return `  ${paint(`${HOOK} ${CROSS}`, "error")} ${resultText.slice(0, ERROR_RESULT_MAX_CHARS)}\n`;
  }
  return `  ${paint(`${HOOK}`, "dim")} ${resultText ? foldOutput(resultText) : ""}\n`;
}

/**
 * provider 失败提示行（assistant 条目 `status=error`）。
 *
 * @param message 错误消息；调用方负责在缺省时补「provider 返回未知错误」。
 * @returns 已着色的提示文本（不含尾换行）。
 */
export function formatAssistantFailureLine(message: string): string {
  return paint(`${CROSS} 模型调用失败：${message}`, "error");
}

/**
 * 运行级错误行（`agent_end.error`）：与 provider 错误（assistant 条目）区分文案。
 *
 * @param entry error 条目。
 * @returns 最终行文本（前置空行 + 尾换行，等价旧 `\n${text}\n` 的留白）。
 */
export function formatRunErrorLine(entry: TuiEntry): string {
  const message = entry.meta?.errorMessage ?? entry.text;
  return paint(`\n${CROSS} 运行异常终止（${entry.meta?.code ?? "unknown"}）：${message}`, "error") + "\n";
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
 * 为什么用同步 IO：事件归约与打印是同步链路，diff 必须在确认闸门询问前
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
