import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { parsePdfBlocks } from "@aiagent/parsing";
import type { ParsedBlock } from "@aiagent/parsing";
import { GoldenStudioError } from "./errors.js";
import { readManifest } from "./manifest.js";
import type {
  PdfEvidenceBlock,
  PdfEvidenceDocument,
  PdfEvidenceMetadata
} from "./types.js";
import type { WorkspaceConfig } from "./workspace.js";
import { assertContainedPath } from "./workspace.js";

/** 从解析包 block 契约推导的证据元数据，避免两边字段漂移。 */
export type { PdfEvidenceBlock, PdfEvidenceDocument, PdfEvidenceMetadata };

/**
 * 把解析器 block 投影为证据块，并汇总得到有序页码。
 *
 * 该函数不读取文件系统，供读取边界与后续测试复用。metadata 逐块浅拷贝，
 * 防止上层编辑器改动证据 JSON 时反向污染解析结果。
 *
 * @param filePath 返回给调用方的语料相对路径。
 * @param blocks 解析器产出的原始 block。
 * @returns 可序列化的证据文档。
 */
export function projectPdfEvidence(
  filePath: string,
  blocks: readonly ParsedBlock[]
): PdfEvidenceDocument {
  const projectedBlocks = blocks.map((block) => ({
    pageNumber: block.pageNumber ?? 0,
    lineStart: block.lineStart,
    lineEnd: block.lineEnd,
    text: block.text,
    metadata: { ...(block.metadata ?? {}) }
  }));

  return {
    filePath,
    pages: [...new Set(projectedBlocks.map((block) => block.pageNumber))].sort(
      (left, right) => left - right
    ),
    blocks: projectedBlocks
  };
}

/**
 * 读取并解析语料根内的 PDF，生成带原文位置的证据投影。
 *
 * 路径先经工作区边界校验，软链逃逸也按 path_outside_root 拒绝；
 * 文件读取与解析失败分别收敛为稳定的证据错误码。
 *
 * @param config 当前工作区配置。
 * @param relativeFilePath 语料根内的 PDF 相对路径。
 * @returns 带页码、block 与表格元数据的证据文档。
 * @throws {WorkspaceError} 路径越界时抛出。
 * @throws {GoldenStudioError} 文件不存在或 PDF 解析失败时抛出。
 */
export async function readPdfEvidence(
  config: WorkspaceConfig,
  relativeFilePath: string
): Promise<PdfEvidenceDocument> {
  const { absolutePath, normalizedFilePath } = resolveContainedPdfPath(
    config,
    relativeFilePath
  );

  let content: Buffer;
  try {
    content = await readFile(absolutePath);
  } catch (error) {
    if (isNotFound(error)) {
      throw new GoldenStudioError(
        "evidence_not_found",
        `PDF evidence not found: ${normalizedFilePath}.`,
        { filePath: normalizedFilePath, absolutePath },
        error
      );
    }
    throw new GoldenStudioError(
      "evidence_parse_failed",
      `PDF evidence cannot be read: ${normalizedFilePath}.`,
      { filePath: normalizedFilePath, absolutePath },
      error
    );
  }

  try {
    return projectPdfEvidence(
      normalizedFilePath,
      parsePdfBlocks(new Uint8Array(content))
    );
  } catch (error) {
    throw new GoldenStudioError(
      "evidence_parse_failed",
      `PDF evidence cannot be parsed: ${normalizedFilePath}.`,
      { filePath: normalizedFilePath, absolutePath },
      error
    );
  }
}

/**
 * 解析 manifest 明确声明的 corpus PDF 绝对路径。
 *
 * manifest 记录是 PDF 流的白名单；路径还必须经过 corpus 根包含检查，
 * 从而同时拒绝未知文件、绝对路径和软链逃逸。解析与字节流共享此策略。
 *
 * @param config 当前工作区配置。
 * @param relativeFilePath 语料根内的 PDF 相对路径。
 * @returns 规范化路径与绝对路径。
 * @throws {WorkspaceError} 路径越界时抛出。
 * @throws {GoldenStudioError} 路径为绝对地址或 manifest 无此 PDF 时抛出。
 */
export async function resolvePdfPath(
  config: WorkspaceConfig,
  relativeFilePath: string
): Promise<{ normalizedFilePath: string; absolutePath: string }> {
  const resolved = resolveContainedPdfPath(config, relativeFilePath);
  const manifest = await readManifest(config);
  const allowed = manifest.records.some(
    (record) => record.file_path.replaceAll("\\", "/") === resolved.normalizedFilePath
  );
  if (!allowed) {
    throw new GoldenStudioError(
      "evidence_not_found",
      `PDF evidence is not declared by the corpus manifest: ${resolved.normalizedFilePath}.`,
      { filePath: resolved.normalizedFilePath }
    );
  }
  return resolved;
}

/**
 * 在 corpus 根内解析相对 PDF 路径，不检查 manifest 白名单。
 *
 * @param config 当前工作区配置。
 * @param relativeFilePath 语料根内的 PDF 相对路径。
 * @returns 规范化路径与绝对路径。
 * @throws {GoldenStudioError} 路径为绝对地址时抛出。
 * @throws {WorkspaceError} 路径越界时抛出。
 */
function resolveContainedPdfPath(
  config: WorkspaceConfig,
  relativeFilePath: string
): { normalizedFilePath: string; absolutePath: string } {
  if (isAbsolute(relativeFilePath)) {
    throw new GoldenStudioError(
      "evidence_not_found",
      `PDF evidence path must be relative to the corpus root: ${relativeFilePath}.`,
      { filePath: relativeFilePath }
    );
  }

  const absolutePath = resolve(config.corpusRoot, relativeFilePath);
  assertContainedPath(config.corpusRoot, absolutePath);
  const normalizedFilePath =
    relative(config.corpusRoot, absolutePath).replaceAll("\\", "/") || ".";
  return { normalizedFilePath, absolutePath };
}

/**
 * 识别文件不存在错误，区分证据缺失与解析失败。
 *
 * @param error 文件系统异常。
 * @returns 是否为 ENOENT。
 */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
