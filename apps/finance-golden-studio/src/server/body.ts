import type { IncomingMessage } from "node:http";
import { HttpError } from "./errors.js";

/**
 * 读取并限制 JSON 请求体大小。
 *
 * @param request Node HTTP 请求。
 * @param maxBodyBytes 允许的最大字节数。
 * @returns 解析后的普通对象。
 * @throws {HttpError} 请求体超限、为空、非法 JSON 或不是对象时抛出。
 */
export async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new HttpError(413, "request_too_large", "Request body is too large.", {
      maxBodyBytes
    });
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBodyBytes) {
      throw new HttpError(413, "request_too_large", "Request body is too large.", {
        maxBodyBytes
      });
    }
    chunks.push(bytes);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object.");
  }
  return parsed;
}

/**
 * 判断值是否为普通对象。
 *
 * @param value 待判断值。
 * @returns 非数组且非 null 的对象时为 true。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
