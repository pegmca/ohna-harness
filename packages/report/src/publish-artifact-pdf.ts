import type { ApiError, ReportArtifactDto } from "@aiagent/types";
import type {
  ArtifactRecord,
  ArtifactRepository,
  ArtifactStorage,
  ArtifactStorageWriteResult
} from "./persistence.js";

export type PdfPublishFailurePhase =
  | "render"
  | "storage_write"
  | "metadata_commit"
  | "metadata_commit_and_compensation";

export type PdfPublishResult =
  | { ok: true; artifact: ReportArtifactDto; reused: boolean }
  | { ok: false; phase: PdfPublishFailurePhase; failureStatePersisted: boolean };

/**
 * 以补偿式 saga 发布 PDF（pi 化阶段 5 从 apps/finance-api 下沉到 report 包，
 * 供 generate_report 工具与 HTTP 路由共用同一条发布路径）。
 *
 * 文件原子发布成功但 metadata 提交失败时，必须删除本次随机 key；已有 `pdf_ready`
 * 直接幂等返回，避免重复生成覆盖旧 key。
 *
 * @param record 当前 Artifact record。
 * @param repository Artifact repository。
 * @param storage PDF storage。
 * @param render 纯 PDF renderer。
 * @param now 当前时间工厂。
 * @returns 发布结果，不向调用方泄漏底层异常。
 */
export async function publishArtifactPdf(
  record: ArtifactRecord,
  repository: ArtifactRepository,
  storage: ArtifactStorage,
  render: () => Uint8Array,
  now: () => Date = () => new Date()
): Promise<PdfPublishResult> {
  if (record.artifact.status === "pdf_ready" && record.storageKey) {
    return { ok: true, artifact: record.artifact, reused: true };
  }

  let bytes: Uint8Array;
  try {
    bytes = render();
  } catch {
    return persistFailure(record, repository, "render", now);
  }

  let stored: ArtifactStorageWriteResult;
  try {
    stored = await storage.writePdf(bytes);
  } catch {
    return persistFailure(record, repository, "storage_write", now);
  }

  const generatedAt = now().toISOString();
  const readyArtifact: ReportArtifactDto = {
    ...record.artifact,
    status: "pdf_ready",
    pdfExport: {
      status: "ready",
      fileName: record.artifact.pdfExport.fileName ?? `${record.artifact.artifactId}.pdf`,
      message: "真实 PDF 已生成并通过 artifact ID 提供下载。",
      generatedAt,
      downloadUrl: `/api/report-artifacts/${encodeURIComponent(record.artifact.artifactId)}/download`
    }
  };
  try {
    await repository.save(toReadyRecord(record, readyArtifact, stored, generatedAt));
    return { ok: true, artifact: readyArtifact, reused: false };
  } catch {
    try {
      await storage.deletePdf(stored.key);
    } catch {
      const persisted = await persistFailure(
        { ...record, storageProvider: stored.provider, storageKey: stored.key, sizeBytes: stored.sizeBytes, checksumSha256: stored.checksumSha256 },
        repository,
        "metadata_commit_and_compensation",
        now,
        { cleanupRequired: true }
      );
      return persisted;
    }
    return persistFailure(record, repository, "metadata_commit", now);
  }
}

/**
 * 持久化结构化 PDF 失败；失败状态写入也失败时显式返回，不静默吞错。
 *
 * @param record 当前 record。
 * @param repository Artifact repository。
 * @param phase 失败阶段。
 * @param now 当前时间工厂。
 * @param metadata 需要维护任务处理的补偿证据。
 * @returns 失败结果。
 */
async function persistFailure(
  record: ArtifactRecord,
  repository: ArtifactRepository,
  phase: PdfPublishFailurePhase,
  now: () => Date,
  metadata: Record<string, unknown> = {}
): Promise<PdfPublishResult> {
  const updatedAt = now().toISOString();
  const error: ApiError = {
    code: "internal_error",
    message: "PDF 生成失败，可安全重试。",
    details: { failurePhase: phase }
  };
  const failedArtifact: ReportArtifactDto = {
    ...record.artifact,
    status: "pdf_failed",
    pdfExport: {
      status: "failed",
      fileName: record.artifact.pdfExport.fileName,
      message: error.message,
      error
    }
  };
  try {
    await repository.save({
      ...record,
      artifact: failedArtifact,
      metadata: { ...record.metadata, ...metadata, pdfFailurePhase: phase },
      updatedAt
    });
    return { ok: false, phase, failureStatePersisted: true };
  } catch {
    return { ok: false, phase, failureStatePersisted: false };
  }
}

/** @returns 可提交的 pdf_ready record。 */
function toReadyRecord(
  record: ArtifactRecord,
  artifact: ReportArtifactDto,
  stored: ArtifactStorageWriteResult,
  updatedAt: string
): ArtifactRecord {
  return {
    ...record,
    artifact,
    mediaType: "application/pdf",
    sizeBytes: stored.sizeBytes,
    checksumSha256: stored.checksumSha256,
    storageProvider: stored.provider,
    storageKey: stored.key,
    metadata: { ...record.metadata, cleanupRequired: false },
    updatedAt
  };
}
