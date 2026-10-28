import type { GoldenDraft } from "../core/types.js";
import {
  validateBatchName,
  validateDraftId
} from "../core/workspace.js";
import { HttpError } from "./errors.js";
import { isRecord } from "./body.js";

/**
 * 从路径段中校验批次名。
 *
 * @param raw 原始路径段。
 * @returns 合法批次名。
 * @throws {WorkspaceError} 路径段非法时抛出。
 */
export function readBatchSegment(raw: string): string {
  const value = decodeSegment(raw);
  validateBatchName(value);
  return value;
}

/**
 * 从路径段中校验草稿 ID。
 *
 * @param raw 原始路径段。
 * @returns 合法草稿 ID。
 * @throws {WorkspaceError} 路径段非法时抛出。
 */
export function readDraftSegment(raw: string): string {
  const value = decodeSegment(raw);
  validateDraftId(value);
  return value;
}

/**
 * 读取查询参数中的证据路径。
 *
 * @param url 请求 URL。
 * @returns 原始相对路径。
 * @throws {HttpError} path 缺失或为空时抛出。
 */
export function readEvidencePath(url: URL): string {
  const value = url.searchParams.get("path");
  if (!value || value.trim().length === 0) {
    throw new HttpError(400, "invalid_request", "Query parameter path is required.", {
      parameter: "path"
    });
  }
  return value;
}

/**
 * 校验并提取完整草稿对象。
 *
 * @param body 已解析请求体。
 * @returns 草稿对象。
 * @throws {HttpError} draft 不是对象时抛出。
 */
export function readDraftBody(body: Record<string, unknown>): GoldenDraft {
  if (!isRecord(body.draft)) {
    throw new HttpError(400, "invalid_request", "Request body must contain draft.", {
      field: "draft"
    });
  }
  return body.draft as unknown as GoldenDraft;
}

/**
 * 校验显式确认和可选批次字段。
 *
 * @param body 已解析请求体。
 * @returns 强类型的动作输入。
 * @throws {HttpError} 确认缺失或批次字段不是字符串时抛出。
 */
export function readActionBody(body: Record<string, unknown>): {
  confirm: true;
  scope?: "batch" | "draft" | "golden";
  batch?: string;
  id?: string;
} {
  if (body.confirm !== true) {
    throw new HttpError(
      400,
      "confirmation_required",
      "This action requires an explicit confirm:true payload.",
      { field: "confirm" }
    );
  }
  if (body.batch !== undefined && typeof body.batch !== "string") {
    throw new HttpError(400, "invalid_request", "batch must be a string.", {
      field: "batch"
    });
  }
  if (
    body.scope !== undefined &&
    body.scope !== "batch" &&
    body.scope !== "draft" &&
    body.scope !== "golden"
  ) {
    throw new HttpError(400, "invalid_request", "scope must be batch, draft, or golden.", {
      field: "scope"
    });
  }
  if (body.scope === "golden" && body.batch !== undefined) {
    throw new HttpError(
      400,
      "invalid_request",
      "scope golden cannot include batch.",
      { fields: ["scope", "batch"] }
    );
  }
  if (body.id !== undefined && typeof body.id !== "string") {
    throw new HttpError(400, "invalid_request", "id must be a string.", {
      field: "id"
    });
  }
  if (body.scope === "draft" && body.id === undefined) {
    throw new HttpError(
      400,
      "invalid_request",
      "id is required when scope is draft.",
      { field: "id" }
    );
  }
  if (body.scope === "draft" && body.batch === undefined) {
    throw new HttpError(
      400,
      "invalid_request",
      "batch is required when scope is draft.",
      { field: "batch" }
    );
  }
  return {
    confirm: true,
    ...(body.scope === undefined ? {} : { scope: body.scope }),
    ...(body.batch === undefined ? {} : { batch: body.batch }),
    ...(body.id === undefined ? {} : { id: body.id })
  };
}

/**
 * 解码路径段并拒绝不能表示的 URI 段。
 *
 * @param raw 原始路径段。
 * @returns 解码后的段。
 * @throws {HttpError} 百分号编码非法时抛出。
 */
function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "invalid_request", "Route contains invalid encoding.");
  }
}
