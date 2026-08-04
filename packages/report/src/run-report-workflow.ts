import { createDataSourceRuntime } from "@aiagent/rag";
import type { ReportPlanDto, WorkflowErrorDto } from "@aiagent/types";
import { runSequentialWorkflow } from "@aiagent/workflow";
import { createReportWorkflowNodes } from "./nodes/index.js";
import type {
  ReportPackageSummary,
  ReportWorkflowResult,
  ReportWorkflowState,
  RunReportWorkflowOptions
} from "./workflow-types.js";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_STEPS = 16;

/**
 * 创建 report package 摘要，说明本阶段已实现带 Critic/Verifier 的 Agentic RAG Workflow。
 *
 * @returns report package 当前能力摘要。
 */
export function createReportPackageSummary(): ReportPackageSummary {
  return {
    packageName: "@aiagent/report",
    boundary: "report_workflow_nodes_writer_export_adapter",
    runtimeState: "agentic_rag_ready"
  };
}

/**
 * 从 Report Planner 输出执行 Agentic RAG Report Workflow：
 * Data Collector 调用 RAG runtime 检索证据，Analyzer 生成带引用的 claims，
 * Risk Checker 检查风险披露，Citation Verifier 判断证据充分性并在不足时触发补充检索，
 * 最后由 Report Writer 生成草稿、PDF Exporter 占位导出。
 *
 * @param plan Report Planner 输出。
 * @param options max steps、max retries、节点事件 sink、可选 demo documents。
 * @returns 结构化 workflow 结果。
 */
export async function runReportWorkflow(
  plan: ReportPlanDto,
  options: RunReportWorkflowOptions = {}
): Promise<ReportWorkflowResult> {
  const readyError = validateExecutablePlan(plan);
  const initialState: ReportWorkflowState = {
    plan,
    documents: options.documents ?? [],
    dataSourceRuntime: options.dataSourceRuntime ?? createDataSourceRuntime(),
    followUpQueries: [],
    verifierRetryCount: 0
  };

  if (readyError) {
    const now = new Date().toISOString();
    return {
      ok: false,
      state: initialState,
      error: readyError,
      run: {
        runId: options.runId ?? createReportWorkflowRunId(plan.planId),
        workflowName: "report_workflow",
        status: "failed",
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
        executedSteps: 0,
        nodes: createReportWorkflowNodes(options.maxRetries ?? DEFAULT_MAX_RETRIES).map((node) => ({
          nodeId: node.nodeId,
          type: node.type,
          title: node.title,
          status: "pending",
          durationMs: 0
        })),
        edges: createReportWorkflowEdges(),
        events: [
          {
            id: `report_workflow_event_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            type: "workflow_failed",
            createdAt: now,
            error: readyError
          }
        ],
        error: readyError
      }
    };
  }

  const result = await runSequentialWorkflow<ReportWorkflowState>({
    workflowName: "report_workflow",
    runId: options.runId ?? createReportWorkflowRunId(plan.planId),
    initialState,
    nodes: createReportWorkflowNodes(options.maxRetries ?? DEFAULT_MAX_RETRIES),
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    sink: options.sink
    , deadlineMs: options.deadlineMs
    , signal: options.signal
  });

  if (!result.ok) {
    return {
      ok: false,
      run: result.run,
      state: result.state,
      error: result.error
    };
  }

  if (!result.state.draft || !result.state.export) {
    const error: WorkflowErrorDto = {
      code: "node_execution_failed",
      message: "Report workflow completed without draft or export state."
    };
    return {
      ok: false,
      run: {
        ...result.run,
        status: "failed",
        error
      },
      state: result.state,
      error
    };
  }

  return {
    ok: true,
    run: result.state.collectedData?.partial ? { ...result.run, partial: true, recovery: [...(result.run.recovery ?? []), { nodeId: "data_collector", action: "partial", attempts: 1, reason: "One or more non-critical data sources failed." }] } : result.run,
    state: result.state,
    draft: result.state.draft,
    export: result.state.export
  };
}

/**
 * 创建固定顺序的 report workflow edges，并补充 Citation Verifier → Data Collector 的循环边。
 *
 * @returns edge DTO。
 */
function createReportWorkflowEdges(): { from: string; to: string }[] {
  const nodes = createReportWorkflowNodes(DEFAULT_MAX_RETRIES);
  const sequentialEdges = nodes.slice(0, -1).map((node, index) => ({
    from: node.nodeId,
    to: nodes[index + 1].nodeId
  }));

  return [
    ...sequentialEdges,
    {
      from: "citation_verifier",
      to: "data_collector"
    }
  ];
}

/**
 * 校验 plan 是否足以执行 workflow，避免缺少研究对象时进入数据收集节点。
 *
 * @param plan Report Planner 输出。
 * @returns 不可执行时的结构化错误。
 */
function validateExecutablePlan(plan: ReportPlanDto): WorkflowErrorDto | undefined {
  if (!plan.subject) {
    return {
      code: "invalid_workflow",
      message: "Report workflow requires plan.subject. Please clarify the research subject before execution.",
      details: {
        planId: plan.planId,
        status: plan.status,
        clarificationQuestions: plan.clarificationQuestions
      }
    };
  }

  if (plan.status === "needs_clarification") {
    return {
      code: "invalid_workflow",
      message: "Report workflow cannot execute while plan needs clarification.",
      details: {
        planId: plan.planId,
        clarificationQuestions: plan.clarificationQuestions
      }
    };
  }

  return undefined;
}

/**
 * 生成 report workflow run id。
 *
 * @param planId planner 输出 id。
 * @returns workflow run id。
 */
function createReportWorkflowRunId(planId: string): string {
  return `report_wf_${planId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
