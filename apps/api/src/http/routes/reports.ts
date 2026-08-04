import type { IdentitySnapshot } from "@aiagent/identity";
import { publishArtifactPdf, renderResearchReportPdf } from "@aiagent/report";
import type { ArtifactRepository, ArtifactStorage, WorkflowRepository } from "@aiagent/report";
import type { ApiResult, ReportArtifactDto, ReportWorkflowResponseDto } from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import { createRequestId, fail, toApiError } from "../errors.js";

export interface ReportRoutesDeps {
  workflowRepository: WorkflowRepository;
  artifactRepository: ArtifactRepository;
  artifactStorage: ArtifactStorage;
  identityByRequest: WeakMap<object, IdentitySnapshot>;
}

/**
 * 注册 report workflow 快照与 artifact 预览、PDF 导出、下载和软删除路由。
 *
 * @param app Fastify 实例。
 * @param deps workflow/artifact repository、artifact 存储与共享 identity 映射。
 */
export function registerReportRoutes(app: FastifyInstance, deps: ReportRoutesDeps): void {
  const { workflowRepository, artifactRepository, artifactStorage, identityByRequest } = deps;

  /** 按服务端身份读取持久化 workflow 快照。 */
  app.get<{ Params: { runId: string } }>("/api/report-workflows/:runId", async (request, reply): Promise<ApiResult<ReportWorkflowResponseDto>> => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    const value = await workflowRepository.findById(identity?.userId ?? "00000000-0000-0000-0000-000000000000", request.params.runId);
    if (!value) {
      reply.code(404);
      return fail(toApiError("not_found", "Report workflow run 不存在。", requestId), requestId);
    }
    const artifactId = `artifact_${value.run.runId}`;
    const artifact = await artifactRepository.findById(value.context.userId, artifactId);
    return { ok: true, data: { run: value.run, artifact: artifact?.artifact }, requestId };
  });

  /** 读取可预览报告 artifact，响应不暴露 report runtime 内部 state。 */
  app.get<{ Params: { artifactId: string } }>("/api/report-artifacts/:artifactId", async (request, reply): Promise<ApiResult<ReportArtifactDto>> => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    const value = await artifactRepository.findById(identity?.userId ?? "00000000-0000-0000-0000-000000000000", request.params.artifactId);
    if (!value) {
      reply.code(404);
      return fail(toApiError("not_found", "Report artifact 不存在。", requestId), requestId);
    }
    return { ok: true, data: value.artifact, requestId };
  });

  /** 重新发布真实 PDF；approval 门删除后直接执行发布 saga（幂等：已 pdf_ready 直接复用）。 */
  app.post<{ Params: { artifactId: string } }>("/api/report-artifacts/:artifactId/pdf", async (request, reply): Promise<ApiResult<ReportArtifactDto>> => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    const record = await artifactRepository.findById(identity?.userId ?? "00000000-0000-0000-0000-000000000000", request.params.artifactId);
    if (!record) {
      reply.code(404);
      return fail(toApiError("not_found", "Report artifact 不存在。", requestId), requestId);
    }
    const artifact = record.artifact;
    const published = await publishArtifactPdf(
      record,
      artifactRepository,
      artifactStorage,
      () => renderResearchReportPdf({
        title: artifact.title,
        generatedAt: artifact.createdAt,
        markdown: artifact.markdown,
        citations: artifact.citations
      })
    );
    if (published.ok) return { ok: true, data: published.artifact, requestId };
    reply.code(500);
    return fail(toApiError(
      "internal_error",
      published.failureStatePersisted
        ? "PDF 生成失败，失败状态已记录，可安全重试。"
        : "PDF 生成失败且状态暂时无法保存，请稍后查询 Artifact 状态。",
      requestId,
      { failurePhase: published.phase, failureStatePersisted: published.failureStatePersisted }
    ), requestId);
  });

  /** 下载先校验用户归属，再用数据库中的不透明 storage key 读取 PDF。 */
  app.get<{ Params: { artifactId: string } }>("/api/report-artifacts/:artifactId/download", async (request, reply) => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    const record = await artifactRepository.findById(identity?.userId ?? "00000000-0000-0000-0000-000000000000", request.params.artifactId);
    const artifact = record?.artifact;
    if (!record || !artifact || artifact.status !== "pdf_ready" || !record.storageKey) {
      reply.code(404);
      return fail(toApiError("not_found", "PDF 不存在或尚未完成。", requestId), requestId);
    }
    try {
      const bytes = await artifactStorage.readPdf(record.storageKey);
      reply.header("content-type", "application/pdf");
      reply.header("content-disposition", createDownloadContentDisposition(artifact.pdfExport.fileName ?? `${artifact.artifactId}.pdf`));
      return reply.send(Buffer.from(bytes));
    } catch {
      reply.code(500);
      return fail(toApiError("internal_error", "PDF 文件暂时无法读取，请稍后重试。", requestId), requestId);
    }
  });

  /** 软删除 Artifact metadata；物理 PDF 由后续维护任务清理。 */
  app.delete<{ Params: { artifactId: string } }>("/api/report-artifacts/:artifactId", async (request, reply) => {
    const requestId = createRequestId();
    const identity = identityByRequest.get(request);
    const deleted = await artifactRepository.softDelete(
      identity?.userId ?? "00000000-0000-0000-0000-000000000000",
      request.params.artifactId,
      new Date().toISOString()
    );
    if (!deleted) {
      reply.code(404);
      return fail(toApiError("not_found", "Report artifact 不存在。", requestId), requestId);
    }
    reply.code(204);
    return reply.send();
  });
}

/** @param fileName artifact 中的展示文件名。 @returns 不含控制字符和路径分隔符的下载名。 */
function sanitizeDownloadFileName(fileName: string): string {
  return fileName.replace(/[\\/\r\n"\x00-\x1F]/g, "_").slice(0, 120) || "immersive-report.pdf";
}

/**
 * 构造 content-disposition：HTTP header 只能放 Latin-1，中文标题需 ASCII 回退名 + RFC 5987 UTF-8 扩展名。
 *
 * @param fileName artifact 中的展示文件名（可含中文）。
 * @returns 合法的 content-disposition 值。
 */
function createDownloadContentDisposition(fileName: string): string {
  const safe = sanitizeDownloadFileName(fileName);
  const asciiFallback = safe.replace(/[^\x20-\x7E]/g, "_") || "immersive-report.pdf";
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
