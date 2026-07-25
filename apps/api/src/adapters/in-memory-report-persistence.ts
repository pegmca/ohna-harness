import type { ArtifactRecord, ArtifactRepository, PersistedWorkflow, WorkflowRepository } from "@aiagent/report";

/**
 * 创建仅供测试和无数据库开发模式使用的 Report repositories。
 *
 * @returns 内存 repositories。
 */
export function createInMemoryReportRepositories(): {
  workflowRepository: WorkflowRepository;
  artifactRepository: ArtifactRepository;
} {
  const workflows = new Map<string, PersistedWorkflow>();
  const artifacts = new Map<string, ArtifactRecord>();
  return {
    workflowRepository: {
      async save(value) { workflows.set(`${value.context.userId}:${value.run.runId}`, structuredClone(value)); },
      async findById(userId, workflowRunId) { return workflows.get(`${userId}:${workflowRunId}`); }
    },
    artifactRepository: {
      async save(value) {
        artifacts.set(`${value.userId}:${value.artifact.artifactId}`, structuredClone(value));
        return value;
      },
      async findById(userId, artifactId) { return artifacts.get(`${userId}:${artifactId}`); },
      async softDelete(userId, artifactId, deletedAt) {
        const key = `${userId}:${artifactId}`;
        const value = artifacts.get(key);
        if (!value || value.deletedAt) return false;
        artifacts.set(key, { ...value, deletedAt, updatedAt: deletedAt });
        return true;
      }
    }
  };
}
