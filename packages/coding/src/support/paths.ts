/**
 * 路径归一化基元（ported from pi (badlogic/packages/coding-agent)，MIT，Copyright (c) 2025 Mario Zechner）。
 *
 * 原文件为 pi 的 utils/paths.ts，这里只保留编码工具真正需要的部分：
 * 去掉了依赖子进程的云同步标记等无关能力，保持零外部依赖（仅 node 标准库），
 * 作为 path-utils.ts 的下游基础模块。
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as nodeResolvePath, sep } from "node:path";

/** 各类 Unicode 空格变体，统一替换成普通空格后再参与路径解析。 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** 路径输入的可选开关。 */
export interface PathInputOptions {
  /** 归一化前 trim 首尾空白。 */
  trim?: boolean;
  /** 展开前导 ~ 到 home 目录，默认 true。 */
  expandTilde?: boolean;
  /** ~ 展开使用的 home 目录，默认 os.homedir()。 */
  homeDir?: string;
  /** 去掉前导 @，用于 CLI 的 @file 引用语法。 */
  stripAtPrefix?: boolean;
  /** 把 Unicode 空格变体归一成普通空格。 */
  normalizeUnicodeSpaces?: boolean;
}

/**
 * 把路径解析为其规范形态（跟随软链）。
 *
 * 路径尚不存在时（写类工具创建新文件的常见场景）不能直接退化成原串：那样会与已经经过
 * realpath 的工作区根无法做前缀比较，导致合法写入被误判越界（cwd 是软链路径时必踩）。
 * 这里向上找到**最近的已存在祖先**做 realpath，再拼回剩余片段，保证两侧前缀可比。
 *
 * @param path 待规范化路径。
 * @returns realpath 结果，失败时为入参原样。
 */
export function canonicalizePath(path: string): string {
  const resolvedPath = nodeResolvePath(path);
  try {
    return realpathSync(resolvedPath);
  } catch {
    const parent = dirname(resolvedPath);
    // 已到文件系统根仍失败，整条路径都不可用，原样返回由调用方处理
    if (parent === resolvedPath) {
      return resolvedPath;
    }
    return join(canonicalizePath(parent), basename(resolvedPath));
  }
}

/**
 * 归一化路径输入：依次处理 trim、Unicode 空格、@ 前缀、~ 展开与 file:// URL。
 * 这一层不做相对路径解析，那是 resolvePath 的职责。
 *
 * @param input 原始路径输入。
 * @param options 归一化开关。
 * @returns 归一化后的路径。
 */
export function normalizePath(input: string, options: PathInputOptions = {}): string {
  let normalized = options.trim ? input.trim() : input;
  if (options.normalizeUnicodeSpaces) {
    normalized = normalized.replace(UNICODE_SPACES, " ");
  }
  if (options.stripAtPrefix && normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }

  if (options.expandTilde ?? true) {
    const home = options.homeDir ?? homedir();
    if (normalized === "~") return home;
    if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
      return join(home, normalized.slice(2));
    }
  }

  if (/^file:\/\//.test(normalized)) {
    return fileUrlToPath(normalized);
  }

  return normalized;
}

/**
 * 把路径解析为绝对路径：先归一化，再以 baseDir 解析相对路径。
 *
 * @param input 原始路径输入。
 * @param baseDir 相对路径的基准目录，默认 process.cwd()。
 * @param options 归一化开关。
 * @returns 绝对路径。
 */
export function resolvePath(input: string, baseDir: string = process.cwd(), options: PathInputOptions = {}): string {
  const normalized = normalizePath(input, options);
  const normalizedBaseDir = normalizePath(baseDir);
  return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}

/**
 * 计算相对 cwd 的相对路径；目标不在 cwd 内时返回 undefined。
 * 工具在回喂模型的文本里展示短路径时会用到。
 *
 * @param filePath 目标路径。
 * @param cwd 当前工作目录。
 * @returns cwd 内的相对路径，越界时为 undefined。
 */
export function getCwdRelativePath(filePath: string, cwd: string): string | undefined {
  const resolvedCwd = resolvePath(cwd);
  const resolvedPath = resolvePath(filePath, resolvedCwd);
  const relativePath = relative(resolvedCwd, resolvedPath);
  const isInsideCwd =
    relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(".." + sep) && !isAbsolute(relativePath));
  return isInsideCwd ? relativePath || "." : undefined;
}

/**
 * 把 file:// URL 转成本地路径；非法转义序列时回退为去掉协议前缀的字符串。
 *
 * @param fileUrl file:// 形式的 URL。
 * @returns 本地路径。
 */
function fileUrlToPath(fileUrl: string): string {
  const withoutProtocol = fileUrl.slice("file://".length);
  try {
    return decodeURIComponent(withoutProtocol);
  } catch {
    return withoutProtocol;
  }
}
