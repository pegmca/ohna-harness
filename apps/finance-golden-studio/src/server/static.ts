import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { ServerResponse } from "node:http";
import { assertContainedPath } from "../core/workspace.js";
import { HttpError } from "./errors.js";

/** 常见前端资产的内容类型。 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};

/** 静态资源读取结果。 */
export interface StaticAsset {
  body: Buffer | null;
  filePath: string;
  contentType: string;
}

/**
 * 读取构建后的 Web 资产；SPA 路由回退到 index.html。
 *
 * 只读取 staticDir 内已存在的普通文件，禁止目录穿越和软链逃逸。
 * 未找到静态目录时明确抛出 503，避免 serve 声称已启动却没有 UI。
 *
 * @param staticDir 构建产物目录。
 * @param pathname 浏览器请求路径。
 * @returns 文件内容、路径与内容类型。
 * @throws {HttpError} 静态目录缺失或路径非法时抛出。
 */
export async function readStaticAsset(
  staticDir: string,
  pathname: string
): Promise<StaticAsset> {
  const root = resolve(staticDir);
  const rootInfo = await safeStat(root);
  if (!rootInfo?.isDirectory()) {
    throw new HttpError(
      503,
      "invalid_request",
      "Golden Studio Web build is missing. Run pnpm --filter @aiagent/finance-golden-studio build.",
      { staticDir: root }
    );
  }

  const decoded = safeDecodePath(pathname);
  const candidate = resolve(root, `.${decoded}`);
  assertContainedPath(root, candidate);
  const info = await safeStat(candidate);
  if (info?.isFile()) {
    return {
      body: await readFile(candidate),
      filePath: candidate,
      contentType: contentTypeFor(candidate)
    };
  }

  const fallback = join(root, "index.html");
  assertContainedPath(root, fallback);
  try {
    return {
      body: await readFile(fallback),
      filePath: fallback,
      contentType: "text/html; charset=utf-8"
    };
  } catch (error) {
    throw new HttpError(
      503,
      "invalid_request",
      "Golden Studio Web entry is missing. Run pnpm --filter @aiagent/finance-golden-studio build.",
      { staticDir: root },
      error
    );
  }
}

/**
 * 把已读取的静态资产写入响应。
 *
 * @param response Node 响应。
 * @param asset 静态资产。
 */
export function writeStaticAsset(
  response: ServerResponse,
  asset: StaticAsset
): void {
  response.statusCode = 200;
  response.setHeader("content-type", asset.contentType);
  response.setHeader("cache-control", "no-cache");
  if (asset.body) {
    response.end(asset.body);
    return;
  }
  createReadStream(asset.filePath).pipe(response);
}

/**
 * 解码 URL 路径；非法编码映射为统一 400。
 *
 * @param pathname URL 路径。
 * @returns 解码后的路径。
 * @throws {HttpError} 百分号编码非法时抛出。
 */
function safeDecodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "invalid_request", "Request path contains invalid encoding.");
  }
}

/**
 * 探测文件并区分不存在；其他 IO 错误向上抛出。
 *
 * @param path 文件路径。
 * @returns 文件元信息或 undefined。
 */
async function safeStat(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * 由扩展名选择稳定内容类型。
 *
 * @param filePath 文件路径。
 * @returns MIME 类型。
 */
function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
