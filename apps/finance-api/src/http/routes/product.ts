import type { ApiResult, ProductArchitectureDto, ProductEvalReportDto } from "@aiagent/types";
import type { FastifyInstance } from "fastify";
import { createRequestId } from "../errors.js";

/**
 * 注册产品展示页路由（eval 报告与架构图）。
 *
 * @param app Fastify 实例。
 */
export function registerProductRoutes(app: FastifyInstance): void {
  /** Eval 产品页使用版本化 baseline 的确定性证据投影，并明确标注 demo dataset。 */
  app.get("/api/product/eval-report", async (): Promise<ApiResult<ProductEvalReportDto>> => {
    const requestId = createRequestId();
    const data: ProductEvalReportDto = {
      datasetVersion: "financial-research-v1.0.0", caseCount: 31, generatedAt: "2026-07-19T00:00:00.000Z",
      metrics: { citationCoverage: 0.935, financialAccuracy: 0.968, sourceGroundedness: 0.968, successRate: 0.903, averageLatencyMs: 22.839, p95LatencyMs: 45 },
      baseline: { citationCoverage: 0.935, financialAccuracy: 0.968, sourceGroundedness: 0.968, successRate: 0.903, averageLatencyMs: 22.839, p95LatencyMs: 45 },
      failures: [
        { caseId: "fail-001", query: "财务事实约束失败", rootCause: "数值、单位、币种、期间或来源未同时满足。", improvement: "增加结构化事实与期间校验。", traceId: "trace-fail-001", requestId: "request-fail-001" },
        { caseId: "fail-002", query: "引用 grounded 检查失败", rootCause: "引用文本无法在 retrieved chunk 中回溯。", improvement: "强化 citation verifier。", traceId: "trace-fail-002", requestId: "request-fail-002" },
        { caseId: "fail-003", query: "Report workflow 提前终止", rootCause: "workflow 在预期节点前终止。", improvement: "补齐节点重试与终止原因。", traceId: "trace-fail-003", requestId: "request-fail-003" }
      ], demoData: true
    };
    return { ok: true, data, requestId };
  });

  /** 架构产品页的关系来自当前 workspace package 边界。 */
  app.get("/api/product/architecture", async (): Promise<ApiResult<ProductArchitectureDto>> => {
    const requestId = createRequestId();
    return { ok: true, requestId, data: createProductArchitectureDto() };
  });
}

/** @returns 与仓库真实依赖方向一致的架构展示 DTO。 */
function createProductArchitectureDto(): ProductArchitectureDto {
  const nodes = [
    { id: "web", label: "apps/finance-web", responsibility: "React 产品视图，只消费 HTTP DTO" },
    { id: "api", label: "apps/finance-api", responsibility: "校验、生命周期、artifact store 与结构化错误" },
    { id: "agent", label: "packages/agent", responsibility: "intent routing、agent loop 与 report planner" },
    { id: "report", label: "packages/report", responsibility: "研报节点、writer 与 PDF renderer" },
    { id: "workflow", label: "packages/workflow", responsibility: "有限状态机、重试与审批" },
    { id: "rag", label: "packages/rag", responsibility: "ingestion、chunk、retrieval 与 citation" },
    { id: "tools", label: "packages/tools + mcp", responsibility: "工具 schema、权限和执行通道" },
    { id: "trace", label: "packages/trace", responsibility: "跨边界事件与运行指标" },
    { id: "types", label: "packages/types", responsibility: "小型稳定共享 DTO" }
  ];
  const edges = [
    { from: "web", to: "api", label: "HTTP DTO" }, { from: "api", to: "agent", label: "run" },
    { from: "api", to: "report", label: "workflow/export" }, { from: "agent", to: "tools", label: "tool calls" },
    { from: "report", to: "workflow", label: "runtime" }, { from: "report", to: "rag", label: "evidence" },
    { from: "agent", to: "trace", label: "events" }, { from: "report", to: "trace", label: "events" },
    { from: "web", to: "types", label: "contracts" }, { from: "api", to: "types", label: "contracts" }
  ];
  return { nodes, edges, demoData: false };
}
