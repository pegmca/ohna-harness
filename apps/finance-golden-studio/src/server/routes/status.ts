import { readFile, stat } from "node:fs/promises";
import { classifyGeneratedFreshness } from "../../core/generated-freshness.js";
import type { GoldenStatus, WorkspaceSettings } from "../../core/types.js";
import { validateGolden } from "../../core/validate.js";
import { assertContainedPath } from "../../core/workspace.js";
import { HttpError } from "../errors.js";
import type { RequestContext, RouteResult } from "../types.js";

/**
 * 提供作者集、生成物与只读工作区配置状态。
 *
 * @param context 请求上下文。
 * @param segments API 路径段。
 * @returns 路由响应；未匹配时为 undefined。
 */
export async function handleStatus(
  context: RequestContext,
  segments: readonly string[]
): Promise<RouteResult> {
  if (context.request.method !== "GET") return undefined;
  if (segments.length === 1 && segments[0] === "golden") {
    return {
      kind: "json",
      status: 200,
      body: { ok: true, data: await readGoldenStatus(context) }
    };
  }
  if (segments.length === 1 && segments[0] === "settings") {
    return {
      kind: "json",
      status: 200,
      body: { ok: true, data: workspaceSettings(context) }
    };
  }
  return undefined;
}

/**
 * 独立读取作者集健康与生成物摘要。
 *
 * @param context 请求上下文。
 * @returns 分离的双区状态。
 */
async function readGoldenStatus(context: RequestContext): Promise<GoldenStatus> {
  const { config } = context;
  assertContainedPath(config.workspaceRoot, config.goldenPath);
  assertContainedPath(config.workspaceRoot, config.generatedPath);
  const [validation, authoredCases, goldenMetadata, generated] = await Promise.all([
    validateGolden(config),
    countJsonLines(config.goldenPath),
    readFileMetadata(config.goldenPath),
    readGeneratedStatus(config.generatedPath)
  ]);
  const generatedStatus: GoldenStatus["generated"] = generated.exists
    ? {
        ...generated.value,
        ...(goldenMetadata
          ? { sourceModifiedAt: new Date(goldenMetadata.mtimeMs).toISOString() }
          : {}),
        freshness:
          goldenMetadata
            ? (classifyGeneratedFreshness(
                goldenMetadata,
                generated.metadata
              ) as "fresh" | "stale")
            : "fresh"
      }
    : generated.value;
  return {
    authored: {
      path: config.goldenPath,
      caseCount: authoredCases,
      validation
    },
    generated: generatedStatus
  };
}

/**
 * 把工作区路径投影为只读设置。
 *
 * @param context 请求上下文。
 * @returns 浏览器可见配置。
 */
function workspaceSettings(context: RequestContext): WorkspaceSettings {
  const { config } = context;
  return {
    workspaceRoot: config.workspaceRoot,
    corpusRoot: config.corpusRoot,
    manifestPath: config.manifestPath,
    goldenPath: config.goldenPath,
    generatedPath: config.generatedPath
  };
}

/**
 * 从生成物读取真实版本和 case 数；文件缺失或损坏时明确视为不可用。
 *
 * @param path 生成物绝对路径。
 * @returns 生成物状态。
 */
async function readGeneratedStatus(path: string): Promise<
  | { exists: false; value: Extract<GoldenStatus["generated"], { exists: false }> }
  | {
      exists: true;
      value: Extract<GoldenStatus["generated"], { exists: true }>;
      metadata: { mtimeMs: number; mtimeNs?: bigint };
    }
> {
  let raw: string;
  let modifiedAt: string;
  let mtimeMs: number;
  let mtimeNs: bigint | undefined;
  try {
    const [content, metadata] = await Promise.all([
      readFile(path, "utf8"),
      stat(path, { bigint: true })
    ]);
    raw = content;
    mtimeMs = Number(metadata.mtimeMs);
    modifiedAt = new Date(mtimeMs).toISOString();
    mtimeNs = metadata.mtimeNs;
  } catch (error) {
    if (isNotFound(error)) return { exists: false, value: { path, exists: false, freshness: "missing" } };
    throw new HttpError(
      500,
      "internal_error",
      "Generated eval artifact cannot be read.",
      { path }
    );
  }
  try {
    const value = JSON.parse(raw) as {
      datasetVersion?: unknown;
      cases?: unknown;
    };
    if (
      typeof value.datasetVersion !== "string" ||
      !Array.isArray(value.cases)
    ) {
      throw new Error("Generated eval artifact does not match its dataset shape.");
    }
    return {
      exists: true,
      metadata: {
        mtimeMs,
        ...(typeof mtimeNs === "bigint" ? { mtimeNs } : {})
      },
      value: {
        path,
        exists: true,
        caseCount: value.cases.length,
        datasetVersion: value.datasetVersion,
        modifiedAt,
        freshness: "fresh"
      }
    };
  } catch (error) {
    throw new HttpError(
      409,
      "invalid_request",
      "Generated eval artifact cannot be read.",
      { path }
    );
  }
}

/**
 * 读取作者集时间戳；源文件不存在时不参与比较。
 *
 * @param path 作者集路径。
 * @returns 毫秒与可选纳秒时间戳。
 */
async function readFileMetadata(
  path: string
): Promise<{ mtimeMs: number; mtimeNs?: bigint } | undefined> {
  try {
    const metadata = await stat(path, { bigint: true });
    return {
      mtimeMs: Number(metadata.mtimeMs),
      mtimeNs: metadata.mtimeNs
    };
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * 统计 JSONL 非空行；缺失作者集返回 0。
 *
 * @param path 作者集路径。
 * @returns 非空行数。
 */
async function countJsonLines(path: string): Promise<number> {
  try {
    return (await readFile(path, "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0).length;
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
}

/**
 * 判断文件不存在。
 *
 * @param error 文件系统异常。
 * @returns ENOENT 时为 true。
 */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
