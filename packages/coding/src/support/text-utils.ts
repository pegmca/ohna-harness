/**
 * 纯文本渲染工具（ported from pi (badlogic/packages/coding-agent)，MIT，Copyright (c) 2025 Mario Zechner）。
 *
 * pi 的 render-utils.ts 混杂了 pi-tui 的 hyperlink / 终端图像回退 / ANSI 处理。
 * aiagent 的工具只回纯文本，渲染统一由组合根负责，因此这里只保留四个与终端无关的工具函数。
 */
import { homedir } from "node:os";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";

/** 文本块形态（工具 content 数组的成员）。 */
export interface TextBlockLike {
  type?: string;
  text?: string;
}

/**
 * 把未知值收敛成字符串：非字符串类型返回 null，让调用方自行决定是否报错。
 *
 * @param value 任意入参。
 * @returns 字符串值；null 表示入参不是字符串。
 */
export function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return null;
}

/**
 * 抽取工具结果中的纯文本内容，忽略 image 等非文本块。
 * 同时兼容「content 数组」与「包裹对象」两种入参形态，方便不同工具实现直接调用。
 *
 * @param content content 数组或含 content 字段的工具结果。
 * @returns 拼接后的纯文本（多个文本块以换行分隔）。
 */
export function getTextOutput(content: TextBlockLike[] | { content?: TextBlockLike[] } | undefined | null): string {
  const blocks = Array.isArray(content) ? content : content?.content;
  if (!blocks || blocks.length === 0) return "";

  return blocks
    .filter((block): block is TextBlockLike & { text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.replace(/\r/g, ""))
    .join("\n");
}

/**
 * 把制表符替换为 3 个空格，保证行号对齐不会因为 tab 宽度错乱。
 *
 * @param text 原始文本。
 * @returns 替换后的文本。
 */
export function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

/**
 * 把绝对路径压缩成人读的短路径：优先相对 cwd，其次用 ~ 代指 home，过长时保留尾部并加省略号。
 *
 * @param path 目标路径。
 * @param cwd 当前工作目录，用于生成相对路径。
 * @param max 长度上限，默认 60。
 * @returns 展示用短路径。
 */
export function shortenPath(path: string, cwd: string, max: number = 60): string {
  if (typeof path !== "string" || path.length === 0) return "";

  let shortened = path;
  const home = homedir();
  const resolvedPath = resolvePath(path);
  const relativeToCwd = relative(resolvePath(cwd), resolvedPath);
  const isOutside = relativeToCwd === ".." || relativeToCwd.startsWith("../") || isAbsolute(relativeToCwd);
  const insideCwd = !isOutside;

  if (insideCwd) {
    shortened = relativeToCwd === "" ? "." : relativeToCwd;
  } else if (resolvedPath === home || resolvedPath.startsWith(home + "/")) {
    shortened = `~${resolvedPath.slice(home.length)}`;
  } else {
    shortened = resolvedPath;
  }

  if (shortened.length <= max) {
    return shortened;
  }
  return `…${shortened.slice(-(max - 1))}`;
}
