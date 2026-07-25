import type { ReportArtifactDto, WorkflowErrorDto, WorkflowRunDto } from "@aiagent/types";

export type WorkflowPersistenceStatus = WorkflowRunDto["status"];
export type WorkflowNodePersistenceStatus = WorkflowRunDto["nodes"][number]["status"];

export interface WorkflowPersistenceContext {
  userId: string;
  conversationId: string;
  agentRunId: string;
  planId: string;
}

export interface PersistedWorkflow {
  context: WorkflowPersistenceContext;
  run: WorkflowRunDto;
}

export interface ArtifactRecord {
  artifact: ReportArtifactDto;
  userId: string;
  conversationId: string;
  agentRunId: string;
  kind: "research_report";
  mediaType: "text/html" | "application/pdf";
  sizeBytes?: number;
  checksumSha256?: string;
  storageProvider?: "local";
  storageKey?: string;
  metadata: Record<string, unknown>;
  updatedAt: string;
  deletedAt?: string;
}

export interface WorkflowRepository {
  /**
   * 保存 workflow 及其节点尝试快照；实现必须阻止终态回退。
   *
   * @param value workflow 与归属上下文。
   * @returns 保存完成。
   */
  save(value: PersistedWorkflow): Promise<void>;
  /**
   * 按用户归属读取 workflow。
   *
   * @param userId 服务端确认的用户 ID。
   * @param workflowRunId workflow run ID。
   * @returns workflow；不存在或不属于用户时返回 undefined。
   */
  findById(userId: string, workflowRunId: string): Promise<PersistedWorkflow | undefined>;
}

export interface ArtifactRepository {
  /**
   * 创建或更新 artifact metadata；实现必须校验用户归属并限制正文大小。
   *
   * @param value artifact record。
   * @returns 保存后的 record。
   */
  save(value: ArtifactRecord): Promise<ArtifactRecord>;
  /**
   * 按用户归属读取未删除 artifact。
   *
   * @param userId 服务端确认的用户 ID。
   * @param artifactId artifact ID。
   * @returns artifact；不存在、已删除或越权时返回 undefined。
   */
  findById(userId: string, artifactId: string): Promise<ArtifactRecord | undefined>;
  /**
   * 软删除 artifact metadata；物理文件由维护任务异步清理。
   *
   * @param userId 服务端确认的用户 ID。
   * @param artifactId artifact ID。
   * @param deletedAt 删除时间。
   * @returns 是否删除到一条记录。
   */
  softDelete(userId: string, artifactId: string, deletedAt: string): Promise<boolean>;
}

export interface ArtifactStorageWriteResult {
  provider: "local";
  key: string;
  sizeBytes: number;
  checksumSha256: string;
}

export interface ArtifactStorage {
  /**
   * 使用服务端随机 key 原子写入 PDF。
   *
   * @param bytes 完整 PDF bytes。
   * @returns 存储 metadata。
   */
  writePdf(bytes: Uint8Array): Promise<ArtifactStorageWriteResult>;
  /**
   * 读取服务端曾返回的 storage key。
   *
   * @param key 不透明 storage key。
   * @returns PDF bytes。
   */
  readPdf(key: string): Promise<Uint8Array>;
  /**
   * 删除本次 saga 尚未提交 metadata 的 PDF，用于失败补偿。
   *
   * @param key adapter 已生成且通过校验的 storage key。
   * @returns 删除完成；文件已不存在也视为成功。
   */
  deletePdf(key: string): Promise<void>;
}

export interface ArtifactPersistenceFailure {
  status: "pdf_failed";
  error: WorkflowErrorDto;
}

export const MAX_ARTIFACT_TEXT_LENGTH = 1_000_000;
