import { readFile } from "node:fs/promises";
import {
  readPdfEvidence,
  resolvePdfPath
} from "../../core/evidence.js";
import { HttpError } from "../errors.js";
import { readEvidencePath } from "../paths.js";
import type { RequestContext, RouteResult } from "../types.js";

/**
 * 处理证据解析投影与受控 PDF 字节流。
 *
 * @param context 请求上下文。
 * @param segments API 路径段。
 * @returns 路由响应；未匹配时为 undefined。
 */
export async function handleEvidence(
  context: RequestContext,
  segments: readonly string[]
): Promise<RouteResult> {
  if (
    !(segments.length === 1 && segments[0] === "evidence") &&
    !(
      segments.length === 2 &&
      segments[0] === "evidence" &&
      segments[1] === "content"
    )
  ) {
    return undefined;
  }
  if (context.request.method !== "GET") {
    throw new HttpError(405, "method_not_allowed", "Use GET for this route.", {
      allowed: "GET"
    });
  }
  const filePath = readEvidencePath(context.url);
  if (segments.length === 1) {
    return {
      kind: "json",
      status: 200,
      body: { ok: true, data: await readPdfEvidence(context.config, filePath) }
    };
  }
  const { absolutePath, normalizedFilePath } = await resolvePdfPath(
    context.config,
    filePath
  );
  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch {
    throw new HttpError(
      404,
      "not_found",
      `PDF evidence not found: ${normalizedFilePath}.`,
      { filePath: normalizedFilePath }
    );
  }
  const range = parseRange(context.request.headers.range, bytes.byteLength);
  if (range !== null) {
    return {
      kind: "buffer",
      status: 206,
      body: bytes.subarray(range.start, range.end + 1),
      headers: {
        "content-type": "application/pdf",
        "accept-ranges": "bytes",
        "content-range": `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
        "content-length": String(range.end - range.start + 1)
      }
    };
  }
  return {
    kind: "buffer",
    status: 200,
    body: bytes,
    headers: {
      "content-type": "application/pdf",
      "accept-ranges": "bytes",
      "content-length": String(bytes.byteLength)
    }
  };
}

/**
 * 解析单段 byte range；未提供时返回 undefined。
 *
 * @param header Range 请求头。
 * @param size 文件总字节数。
 * @returns 闭区间范围；没有 Range 时为 undefined。
 * @throws {HttpError} Range 不合法或不可满足时抛出。
 */
function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match) throw rangeError(size);
  const left = match[1];
  const right = match[2];
  if (!left && !right) throw rangeError(size);
  let start: number;
  let end: number;
  if (!left) {
    const suffix = Number(right);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw rangeError(size);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(left);
    end = right ? Number(right) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw rangeError(size);
    }
    end = Math.min(end, size - 1);
  }
  if (start < 0 || start > end || start >= size) throw rangeError(size);
  return { start, end };
}

/**
 * 构造 416 范围错误。
 *
 * @param size 文件总字节数。
 * @returns 范围不可满足错误。
 */
function rangeError(size: number): HttpError {
  return new HttpError(416, "range_not_satisfiable", "Requested byte range is not satisfiable.", {
    size
  });
}
