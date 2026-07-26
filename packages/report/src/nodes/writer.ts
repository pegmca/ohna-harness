import type { ReportPlanDto } from "@aiagent/types";
import type { WorkflowNodeDefinition } from "@aiagent/workflow";
import {
  reportWriterInputSchema,
  reportWriterOutputSchema,
  type ReportWriterInput,
  type ReportWriterOutput
} from "../schemas.js";
import type { ReportWorkflowState } from "../workflow-types.js";

/**
 * Report Writer 节点：生成 Markdown/HTML 草稿。
 * 当 Citation Verifier 判定证据不足时，必须保留“不足以判断”表达，不编造结论。
 *
 * @returns workflow node definition。
 */
export function createReportWriterNode(): WorkflowNodeDefinition<ReportWriterInput, ReportWriterOutput, ReportWorkflowState> {
  return {
    nodeId: "report_writer",
    type: "report.writer",
    title: "Report Writer",
    inputSchema: reportWriterInputSchema,
    outputSchema: reportWriterOutputSchema,
    buildInput: (state) => ({
      plan: state.plan,
      analysis: state.analysis,
      risks: state.risks,
      citations: state.citations
    }),
    execute: (input) => {
      const subject = input.plan.subject ?? "待确认研究对象";
      const title = `${subject} ${formatReportType(input.plan.reportType)}`;
      const citationLines = input.citations.citations.map(
        (citation, index) => `[^${index + 1}]: ${citation.source} - ${citation.quote}`
      );
      const insufficientEvidence = input.citations.decision === "fail" || input.citations.missingClaims.length > 0;
      const lines: string[] = [
        `# ${title}`,
        "",
        "## 核心结论",
        input.analysis.thesis
      ];

      if (insufficientEvidence) {
        lines.push(
          "",
          "> 资料不足说明：当前检索未能为以下关键结论找到足够引用支撑，报告保留“不足以判断”的表达，不编造结论。"
        );
        lines.push(...input.citations.missingClaims.map((claim) => `- ${claim}`));

        if (input.citations.missingMetrics.length > 0) {
          lines.push("", "## 缺失财务指标", ...input.citations.missingMetrics.map((metric) => `- ${metric}`));
        }
      }

      lines.push(
        "",
        "## 关键发现",
        ...input.analysis.findings.map((finding, index) =>
          `- ${finding}${citationLines.length > 0 ? ` [^${Math.min(index + 1, citationLines.length)}]` : ""}`
        ),
        "",
        "## 风险提示",
        ...input.risks.riskItems.map((risk) => `- ${risk}`),
        "",
        "## 引用",
        ...citationLines
      );

      const markdown = lines.join("\n");

      return {
        title,
        markdown,
        html: markdownToMinimalHtml(markdown),
        sectionCount: insufficientEvidence ? 5 : 4,
        citationCount: input.citations.citations.length
      };
    },
    applyOutput: (state, output) => ({
      ...state,
      draft: output
    }),
    summarizeOutput: (output) => ({
      title: output.title,
      sectionCount: output.sectionCount,
      citationCount: output.citationCount,
      markdownLength: output.markdown.length
    })
  };
}

/**
 * 格式化报告类型，供 mock writer 生成可读标题。
 *
 * @param reportType planner 报告类型。
 * @returns 中文标题片段。
 */
function formatReportType(reportType: ReportPlanDto["reportType"]): string {
  switch (reportType) {
    case "company_brief":
      return "公司研究简报";
    case "earnings_review":
      return "业绩回顾";
    case "risk_review":
      return "风险审查";
    case "custom":
      return "自定义研究报告";
  }
}

/**
 * 将 Markdown 草稿转成最小 HTML 预览，避免本阶段引入 Markdown 渲染依赖。
 *
 * @param markdown Markdown 文本。
 * @returns 最小 HTML。
 */
function markdownToMinimalHtml(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("# ")) {
        return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      }

      if (line.startsWith("## ")) {
        return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      }

      if (line.startsWith("- ")) {
        return `<p>${escapeHtml(line)}</p>`;
      }

      return line ? `<p>${escapeHtml(line)}</p>` : "";
    })
    .join("\n");
}

/**
 * 转义 HTML 特殊字符，防止报告草稿预览直接拼接未处理文本。
 *
 * @param value 原始文本。
 * @returns 转义后的文本。
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
