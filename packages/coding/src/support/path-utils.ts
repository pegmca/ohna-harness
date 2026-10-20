/**
 * 路径解析工具（参考自 pi (badlogic/packages/coding-agent)，MIT，Copyright (c) 2025 Mario Zechner）。
 *
 * 相对 paths.ts 的定位：paths.ts 只做纯字符串归一化，本模块负责「带文件系统探测」的容错解析。
 * 保留了 pi 的 macOS 变体回退：截图 AM/PM 空格、NFD 分解、弯引号——用户粘贴路径时最常踩的坑。
 */
import { existsSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { normalizePath, resolvePath } from "./paths.js";

/** macOS 截图文件名在 AM/PM 前用的是窄不换行空格（U+202F）。 */
const NARROW_NO_BREAK_SPACE = "\u202F";

/**
 * 生成 macOS 文件名变体候选：截图 AM/PM 空格、NFD 分解、弯引号，以及「NFD + 弯引号」组合。
 *
 * @param resolved 已解析的路径。
 * @returns 与入参不同的变体路径列表。
 */
function collectMacOSVariants(resolved: string): string[] {
  const nfdVariant = resolved.normalize("NFD");
  const variants: string[] = [
    resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
    nfdVariant,
    resolved.replace(/'/g, "\u2019"),
    nfdVariant.replace(/'/g, "\u2019"),
  ];
  return variants.filter((variant) => variant !== resolved);
}

/**
 * 异步判断路径是否存在。
 *
 * @param filePath 绝对路径。
 * @returns 存在为 true。
 */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 仅做输入层的路径展开（去 @ 前缀、Unicode 空格归一、~ 展开），不解析相对路径。
 *
 * @param filePath 原始输入。
 * @returns 展开后的路径。
 */
export function expandPath(filePath: string): string {
  return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * 把路径解析到给定 cwd 下的绝对路径（含 ~ 展开与 @ 剥离）。
 *
 * @param filePath 原始输入路径。
 * @param cwd 当前工作目录。
 * @returns 绝对路径。
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * 同步容错路径解析：路径直接存在就返回，否则依次尝试 macOS 变体，最后回退到原解析值。
 *
 * @param filePath 原始输入路径。
 * @param cwd 当前工作目录。
 * @returns 实际存在（或最接近）的绝对路径。
 */
export function resolveReadPath(filePath: string, cwd: string): string {
  const resolved = resolveToCwd(filePath, cwd);
  if (existsSync(resolved)) {
    return resolved;
  }
  for (const variant of collectMacOSVariants(resolved)) {
    if (existsSync(variant)) {
      return variant;
    }
  }
  return resolved;
}

/**
 * 异步版容错路径解析，语义同 resolveReadPath，适合已经全异步的工具实现。
 *
 * @param filePath 原始输入路径。
 * @param cwd 当前工作目录。
 * @returns 实际存在（或最接近）的绝对路径。
 */
export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
  const resolved = resolveToCwd(filePath, cwd);
  if (await pathExists(resolved)) {
    return resolved;
  }
  for (const variant of collectMacOSVariants(resolved)) {
    if (await pathExists(variant)) {
      return variant;
    }
  }
  return resolved;
}
