/**
 * F-6 `@` 文件引用：workspace 文件列举、输入片段识别与提交时展开。
 *
 * 为什么要独立成模块：
 * - TUI 的 `@` 候选面板需要「文件清单 + 过滤」纯逻辑，非 TTY 的 REPL 只需要「提交时展开」；
 *   两者共用同一套路径策略，避免补全面板能选中而展开却被拒绝（或反之）。
 * - 所有读写都经 `@aiagent/coding` 的 `assertPathWithinRoot` / `isDeniedPath` 校验，
 *   与 read 工具使用同一信任边界；失败只降级为说明块 / 警告，绝不抛异常打断会话。
 *
 * 展开结果是 `UserMessage["content"]`：无引用时保持原字符串（零行为变化），
 * 有引用时把文件内容作为独立 TextContent 块追加，模型能明确区分「用户问题」与「文件素材」。
 */
import { promises as fs, type Dirent } from "node:fs";
import * as path from "node:path";
import type { UserMessage } from "@aiagent/ai";
import { assertPathWithinRoot, isDeniedPath } from "@aiagent/coding";

/** 文件列举时跳过的目录：依赖 / 版本库 / 构建产物 / 本工具私有状态。 */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "tmp",
  ".ohna",
]);

/** 递归深度上限：防止异常深的目录树拖慢启动。 */
const MAX_SCAN_DEPTH = 12;

/** 默认文件数量上限：大仓库只取前 N 个，面板仍可用（可按前缀继续过滤）。 */
const DEFAULT_FILE_LIMIT = 2_000;

/** 单次最多展开的文件数。 */
export const MAX_FILE_REFERENCES = 5;

/** 单个文件最大字节数（100KB）。 */
export const MAX_FILE_REFERENCE_BYTES = 100 * 1024;

/** 输入末尾的 `@fragment`：只认行首或空白后的 `@`，避免把邮箱等误判为引用。 */
const TRAILING_FRAGMENT_PATTERN = /(^|\s)@([^\s]*)$/;

/** 正文中的引用 token（保留行首 / 空白前缀，供 start 下标计算）。 */
const REFERENCE_TOKEN_PATTERN = /(^|\s)@([^\s]+)/g;

/**
 * 路径尾随标点：中文句子里的 `@a.ts，` / `@a.ts。` / `(见 @a.ts)` 不应把标点算进路径。
 *
 * 只剥离末尾连续标点，路径内部的 `.` `_` `-` `/` 等合法字符不受影响。
 */
const TRAILING_PUNCTUATION = /[，。、；：,.;:!?）)】\]}>]+$/;

/**
 * 去掉路径末尾的句子标点。
 *
 * @param value 原始 `@` 后文本。
 * @returns 去掉尾随标点后的路径片段。
 */
function stripTrailingPunctuation(value: string): string {
  return value.replace(TRAILING_PUNCTUATION, "");
}

/**
 * 输入末尾的 `@` 片段（供 TUI 打开文件候选面板）。
 *
 * `start` 指向 `@` 本身而不是其后的文本：补全时直接把 `[start, value.length)` 替换成
 * `@<相对路径> `，不会误删 `@` 前面的空格或正文。
 */
export interface FileReferenceFragment {
  /** `@` 之后的查询文本（已剥离尾随标点；可能为空串，如输入恰好是 `@`）。 */
  fragment: string;
  /** `@` 在输入中的字符下标。 */
  start: number;
  /** 路径片段的结束下标（不含被剥离的尾随标点），补全时用于保留标点。 */
  end: number;
}

/**
 * 识别输入末尾的 `@fragment`。
 *
 * @param value 当前输入框内容。
 * @returns 片段信息；输入末尾不是 `@` 引用时返回 null。
 */
export function findFileReferenceFragment(value: string): FileReferenceFragment | null {
  const match = TRAILING_FRAGMENT_PATTERN.exec(value);
  if (!match) return null;
  const raw = match[2] ?? "";
  const start = match.index + (match[1]?.length ?? 0);
  const fragment = stripTrailingPunctuation(raw);
  return {
    fragment,
    start,
    // 结束下标停在路径片段末尾：之后的尾随标点由补全逻辑原样保留。
    end: start + 1 + fragment.length,
  };
}

/**
 * 递归列出工作区文件（workspace 相对路径、`/` 分隔）。
 *
 * 设计取舍：
 * - 只列举普通文件，跟随目录但不跟随符号链接（软链接可能指向工作区外）；
 * - 跳过依赖 / 版本库 / 构建目录，并用 `isDeniedPath` 过滤 `.env`、密钥等敏感文件；
 * - 深度与数量双上限，避免超大仓库把首次 `@` 补全拖成秒级卡顿。
 *
 * @param cwd 工作区根目录。
 * @param limit 文件数量上限（缺省 2000）。
 * @returns 排序后的相对路径列表；目录不可读时返回已收集部分。
 */
export async function listWorkspaceFiles(cwd: string, limit = DEFAULT_FILE_LIMIT): Promise<string[]> {
  const root = path.resolve(cwd);
  const files: string[] = [];

  /**
   * 深度优先遍历一个目录。
   *
   * @param dir 当前绝对目录。
   * @param depth 当前深度（根为 0）。
   */
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || files.length >= limit) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 目录项按名称排序，保证面板候选稳定（不受文件系统 readdir 顺序影响）。
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= limit) return;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name) || isDeniedPath(absolute)) continue;
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile() || isDeniedPath(absolute)) continue;
      files.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  };

  await walk(root, 0);
  return files;
}

/**
 * 按查询串过滤文件候选（大小写不敏感），并给出稳定排序。
 *
 * 排序优先级：文件名前缀命中 → 路径前缀命中 → 路径包含查询；同分时短路径优先。
 * 面板最多展示 9 条，因此这里直接截断，避免上层重复排序。
 *
 * @param files 全量相对路径。
 * @param query `@` 之后的查询文本。
 * @param limit 返回上限（缺省 9）。
 * @returns 命中文件列表。
 */
export function filterWorkspaceFiles(
  files: readonly string[],
  query: string,
  limit = 9,
): string[] {
  const q = query.trim().toLowerCase();
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    if (!q) {
      scored.push({ file, score: 0 });
      continue;
    }
    const lower = file.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    if (base.startsWith(q)) scored.push({ file, score: 0 });
    else if (lower.startsWith(q)) scored.push({ file, score: 1 });
    else if (lower.includes(q)) scored.push({ file, score: 2 });
  }
  scored.sort((a, b) => a.score - b.score || a.file.length - b.file.length || (a.file < b.file ? -1 : 1));
  return scored.slice(0, limit).map((item) => item.file);
}

/** `@` 展开结果：内容块与给用户看的警告（警告同时以说明块进入 content）。 */
export interface FileReferenceExpansion {
  /** 可直接作为 user message 的 content。 */
  content: UserMessage["content"];
  /** 失败原因（供 REPL / TUI 用 write() 提示；成功时为空数组）。 */
  warnings: string[];
}

/**
 * 把输入中的 `@path` 展开为「原文本 + 每个文件一个文本块」。
 *
 * 无引用时原样返回字符串（不改变既有会话行为）；有引用时即使全部失败也返回数组，
 * 失败原因作为独立说明块保留在 content 中，同时收集到 `warnings`。
 *
 * @param text 用户原始输入。
 * @param cwd 工作区根目录（路径解析与边界校验基准）。
 * @returns 展开后的 content 与警告。
 */
export async function expandFileReferencesDetailed(
  text: string,
  cwd: string,
): Promise<FileReferenceExpansion> {
  const tokens: Array<{ raw: string; relative: string }> = [];
  for (const match of text.matchAll(REFERENCE_TOKEN_PATTERN)) {
    const raw = match[2];
    const relative = stripTrailingPunctuation(raw);
    // 只有标点（如 `@，`）不构成引用。
    if (relative) tokens.push({ raw, relative });
  }
  if (tokens.length === 0) return { content: text, warnings: [] };

  const root = path.resolve(cwd);
  const blocks: Array<{ type: "text"; text: string }> = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const absolute = path.resolve(root, token.relative);

    // 去重：同一文件多次 @ 只注入一次，避免上下文被重复内容撑大。
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    if (seen.size > MAX_FILE_REFERENCES) {
      const warning = `最多引用 ${MAX_FILE_REFERENCES} 个文件，已忽略 @${token.raw}`;
      warnings.push(warning);
      blocks.push({ type: "text", text: `[文件引用失败] ${warning}` });
      continue;
    }

    const failure = await readReferenceFile(root, absolute);
    if (typeof failure === "string") {
      const warning = `@${token.raw}：${failure}`;
      warnings.push(warning);
      // 保留原文本中的 @path，同时把原因作为说明块交给模型（不读取、不抛异常）。
      blocks.push({ type: "text", text: `[文件引用失败] ${warning}` });
      continue;
    }
    blocks.push({
      type: "text",
      text: `文件 ${path.relative(root, absolute).split(path.sep).join("/")}：\n${failure.content}`,
    });
  }

  // 原文本始终是第一个块：模型先看到用户问题，再看到文件素材。
  return { content: [{ type: "text", text }, ...blocks], warnings };
}

/**
 * 仅返回展开后的 content（调用方不需要逐条警告时使用）。
 *
 * @param text 用户原始输入。
 * @param cwd 工作区根目录。
 * @returns 字符串（无引用）或内容块数组。
 */
export async function expandFileReferences(
  text: string,
  cwd: string,
): Promise<FileReferenceExpansion["content"]> {
  return (await expandFileReferencesDetailed(text, cwd)).content;
}

/**
 * 读取单个被引用文件；任何失败都返回中文原因而不是抛异常。
 *
 * @param root 工作区根目录。
 * @param absolute 已解析的绝对路径。
 * @returns 成功时为文件内容，失败时为原因字符串。
 */
async function readReferenceFile(
  root: string,
  absolute: string,
): Promise<{ content: string } | string> {
  const boundary = assertPathWithinRoot(absolute, root);
  if (!boundary.ok) return `路径越界（仅允许工作区内文件）`;
  if (isDeniedPath(absolute)) return `敏感路径（.env / 密钥 / 依赖目录等不可引用）`;

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(absolute);
  } catch {
    return "文件不存在";
  }
  if (!stat.isFile()) return "不是普通文件";
  if (stat.size > MAX_FILE_REFERENCE_BYTES) {
    return `文件超过 ${Math.floor(MAX_FILE_REFERENCE_BYTES / 1024)}KB 上限（${stat.size} 字节）`;
  }

  let content: string;
  try {
    content = await fs.readFile(absolute, "utf8");
  } catch (error) {
    return `读取失败（${error instanceof Error ? error.message : String(error)}）`;
  }
  // NUL 字节是二进制文件的可靠信号：避免把图片 / 可执行文件塞进对话上下文。
  if (content.includes("\u0000")) return "疑似二进制文件，已跳过";
  return { content };
}
