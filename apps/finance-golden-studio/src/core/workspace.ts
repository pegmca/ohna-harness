import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Golden Studio 的稳定配置错误码。 */
export type WorkspaceErrorCode =
  | "workspace_config_missing"
  | "invalid_root_path"
  | "manifest_not_found"
  | "path_outside_root"
  | "invalid_batch_name"
  | "invalid_draft_id";

/** 工作区、源语料与 golden 数据路径的只读配置。 */
export interface WorkspaceConfig {
  repoRoot: string;
  workspaceRoot: string;
  corpusRoot: string;
  manifestPath: string;
  draftRoot: string;
  goldenPath: string;
  generatedPath: string;
  backupRoot: string;
}

/** 可覆盖工作区位置的显式输入。 */
export interface WorkspaceInput {
  workspaceRoot?: string;
  corpusRoot?: string;
}

/** 供 CLI 与 HTTP 边界统一映射的结构化配置错误。 */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  /**
   * @param code 稳定错误码。
   * @param message 可安全展示的错误说明。
   * @param cause 仅供内部诊断的原始异常。
   */
  constructor(code: WorkspaceErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "WorkspaceError";
    this.code = code;
  }
}

/** 应用源码所在目录由当前模块位置推导，避免依赖进程启动目录。 */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** 语料 manifest 的固定相对布局。 */
const MANIFEST_RELATIVE_PATH = join("manifest", "manifest.jsonl");
/** 作者集在工作区内的固定相对布局。 */
const GOLDEN_RELATIVE_PATH = join("datasets", "finance", "rag-golden");

/**
 * 解析 Golden Studio 的工作区、语料与全部派生数据路径。
 *
 * 优先级为显式参数、环境变量、仓库内约定；当 manifest 不在约定的语料位置时，
 * 必须提供 corpusRoot 或 FINANCE_CORPUS_ROOT，绝不回退到开发者私有绝对路径。
 *
 * @param input 可选的工作区与语料根覆盖值。
 * @returns 已规范化且经过 manifest 校验的工作区配置。
 * @throws {WorkspaceError} 配置缺失或 manifest 不存在时抛出稳定错误。
 */
export function resolveWorkspaceConfig(input: WorkspaceInput = {}): WorkspaceConfig {
  /** 仓库根只由应用位置推导，并在使用时走统一的结构化根目录校验。 */
  const repoRoot = canonicalizeRoot(resolve(APP_ROOT, "../.."));
  const workspaceRoot = canonicalizeRoot(
    input.workspaceRoot ?? process.env.GOLDEN_WORKSPACE_ROOT ?? repoRoot
  );
  const explicitCorpus = input.corpusRoot ?? process.env.FINANCE_CORPUS_ROOT;
  const inferredCorpus = resolve(repoRoot, "datasets", "finance");
  const inferredManifest = resolve(inferredCorpus, MANIFEST_RELATIVE_PATH);

  if (!explicitCorpus && !existsSync(inferredManifest)) {
    throw new WorkspaceError(
      "workspace_config_missing",
      "FINANCE_CORPUS_ROOT or corpusRoot is required when the repository corpus manifest is absent."
    );
  }

  const corpusRoot = canonicalizeRoot(explicitCorpus ?? inferredCorpus);
  const manifestPath = canonicalizePathWithinRoot(corpusRoot, join(corpusRoot, MANIFEST_RELATIVE_PATH));
  if (!existsSync(manifestPath)) {
    throw new WorkspaceError(
      "manifest_not_found",
      `Corpus manifest not found at ${join(corpusRoot, MANIFEST_RELATIVE_PATH)}.`
    );
  }

  const goldenRoot = resolve(workspaceRoot, GOLDEN_RELATIVE_PATH);
  return {
    repoRoot,
    workspaceRoot,
    corpusRoot,
    manifestPath,
    draftRoot: join(goldenRoot, "_drafts"),
    goldenPath: join(goldenRoot, "golden.jsonl"),
    generatedPath: resolve(workspaceRoot, "datasets", "finance", "rag-golden-v1.json"),
    backupRoot: join(goldenRoot, "_backups")
  };
}

/**
 * 断言目标路径最终解析后仍位于指定根目录内。
 *
 * 不存在的目标会沿最近的已存在祖先解析软链，因此新文件写入也无法借软链逃逸。
 * 相对目标以 root 为基准解析，所有调用方无需依赖进程当前工作目录。
 *
 * @param root 允许访问的根目录。
 * @param target 待校验的绝对或相对路径。
 * @throws {WorkspaceError} target 最终落在 root 外时抛出 path_outside_root。
 */
export function assertContainedPath(root: string, target: string): void {
  const configuredRoot = canonicalizeRoot(root);
  const rootPath = canonicalizePath(configuredRoot);
  const targetPath = resolve(configuredRoot, target);
  if (targetPath === configuredRoot || targetPath === rootPath) return;

  const relativeTarget = relative(configuredRoot, targetPath);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
    throw outsideRootError(configuredRoot, targetPath);
  }

  const canonicalTarget = canonicalizePath(targetPath);
  const canonicalRelative = relative(rootPath, canonicalTarget);
  if (
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(canonicalRelative)
  ) {
    throw outsideRootError(rootPath, canonicalTarget);
  }
}

/**
 * 校验批次名，确保它只能成为 `_drafts/` 下的单级目录。
 *
 * @param name 待校验的批次名。
 * @throws {WorkspaceError} 名称为空、绝对路径、包含分隔符或为点目录时抛出。
 */
export function validateBatchName(name: string): void {
  validateSinglePathSegment(name, "invalid_batch_name", "batch name");
}

/**
 * 校验草稿 ID，确保它只能成为批次目录下的单级文件名。
 *
 * @param id 待校验的草稿 ID。
 * @throws {WorkspaceError} ID 为空、绝对路径、包含分隔符或为点目录时抛出。
 */
export function validateDraftId(id: string): void {
  validateSinglePathSegment(id, "invalid_draft_id", "draft id");
}

/**
 * 将根目录转为真实绝对路径；不存在、非目录或无法解析时统一返回结构化错误。
 *
 * @param root 根目录。
 * @returns realpath 规范化后的绝对根路径。
 */
function canonicalizeRoot(root: string): string {
  try {
    const absoluteRoot = resolve(root);
    if (!statSync(absoluteRoot).isDirectory()) {
      throw new WorkspaceError("invalid_root_path", `Configured root is not a directory: ${absoluteRoot}`);
    }
    return realpathSync(absoluteRoot);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("invalid_root_path", `Configured root is not an existing directory: ${root}`, error);
  }
}

/**
 * 解析目标路径，并从最近的存在祖先开始补回不存在尾段。
 *
 * @param target 目标路径。
 * @returns 结合 realpath 祖先与剩余路径的绝对路径。
 */
function canonicalizePath(target: string): string {
  const absoluteTarget = resolve(target);
  const missingSegments: string[] = [];
  let cursor = absoluteTarget;

  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return absoluteTarget;
    missingSegments.unshift(cursor.slice(parent.length).replace(/^[/\\]/, ""));
    cursor = parent;
  }

  return resolve(realpathSync(cursor), ...missingSegments);
}

/**
 * 计算并校验由根派生的固定路径，作为后续读取 manifest 的最后一道边界。
 *
 * @param root 允许访问的根目录。
 * @param target 已派生的目标路径。
 * @returns 规范化且已确认位于 root 内的路径。
 */
function canonicalizePathWithinRoot(root: string, target: string): string {
  assertContainedPath(root, target);
  return canonicalizePath(target);
}

/**
 * 校验名称是仅含一个路径段的合法目录或文件名。
 *
 * @param value 待校验值。
 * @param code 校验失败时使用的稳定错误码。
 * @param label 错误消息中的字段名称。
 */
function validateSinglePathSegment(
  value: string,
  code: "invalid_batch_name" | "invalid_draft_id",
  label: string
): void {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new WorkspaceError(code, `Invalid ${label}: a single non-dot path segment is required.`);
  }
}

/**
 * 构造统一的路径越界错误。
 *
 * @param root 允许访问的根目录。
 * @param target 实际解析到的目标路径。
 * @returns 带 path_outside_root 错误码的 WorkspaceError。
 */
function outsideRootError(root: string, target: string): WorkspaceError {
  return new WorkspaceError(
    "path_outside_root",
    `Resolved path is outside the allowed root (${target} is not under ${root}).`
  );
}
