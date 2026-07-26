import { z } from "zod";

const reportPlanSchema = z.object({
  planId: z.string(),
  status: z.enum(["ready", "needs_clarification", "partial"]),
  triggerSource: z.enum(["toggle", "button", "natural_language"]),
  reportType: z.enum(["company_brief", "earnings_review", "risk_review", "custom"]),
  subject: z.string().optional(),
  timeRange: z.string().optional(),
  requiredData: z.array(z.string()),
  assumptions: z.array(z.string()),
  clarificationQuestions: z.array(z.string()),
  steps: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      description: z.string(),
      requiredData: z.array(z.string()),
      optional: z.boolean()
    })
  )
});

const citationVerifierDecisionSchema = z.enum(["pass", "needs_more_evidence", "needs_metric", "retry_tool", "fail"]);

const reportEvidenceItemSchema = z.object({
  id: z.string(),
  source: z.string(),
  quote: z.string(),
  retrievalResult: z.any().optional(),
  citation: z.any().optional(),
  query: z.string().optional()
});

const reportMetricRequirementSchema = z.object({
  name: z.string(),
  required: z.boolean(),
  found: z.boolean(),
  sourceEvidenceId: z.string().optional()
});

const reportClaimSchema = z.object({
  id: z.string(),
  text: z.string(),
  evidenceIds: z.array(z.string()),
  citationIds: z.array(z.string())
});

export const reportDataCollectorInputSchema = z.object({
  plan: reportPlanSchema,
  followUpQueries: z.array(z.string()).optional()
});

export const reportDataCollectorOutputSchema = z.object({
  subject: z.string(),
  timeRange: z.string(),
  filings: z.array(z.string()),
  financialMetrics: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      period: z.string(),
      sourceEvidenceId: z.string().optional()
    })
  ),
  evidence: z.array(reportEvidenceItemSchema),
  retrievalTraces: z.array(z.any()).optional()
  , partial: z.boolean().default(false)
  , sourceErrors: z.array(z.object({ query: z.string(), code: z.string(), message: z.string() })).default([])
});

export const reportAnalyzerInputSchema = z.object({
  plan: reportPlanSchema,
  collectedData: reportDataCollectorOutputSchema
});

export const reportAnalyzerOutputSchema = z.object({
  thesis: z.string(),
  findings: z.array(z.string()),
  claims: z.array(reportClaimSchema),
  metricRequirements: z.array(reportMetricRequirementSchema),
  evidenceIds: z.array(z.string())
});

export const reportRiskCheckerInputSchema = z.object({
  plan: reportPlanSchema,
  analysis: reportAnalyzerOutputSchema,
  collectedData: reportDataCollectorOutputSchema
});

export const reportRiskCheckerOutputSchema = z.object({
  riskLevel: z.enum(["low", "medium", "high"]),
  riskItems: z.array(z.string()),
  passed: z.boolean(),
  needsMoreEvidence: z.boolean(),
  followUpQueries: z.array(z.string())
});

export const reportCitationVerifierInputSchema = z.object({
  analysis: reportAnalyzerOutputSchema,
  collectedData: reportDataCollectorOutputSchema,
  risks: reportRiskCheckerOutputSchema
});

export const reportCitationVerifierOutputSchema = z.object({
  decision: citationVerifierDecisionSchema,
  verified: z.boolean(),
  citations: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      quote: z.string(),
      supportsFinding: z.string(),
      claimId: z.string().optional(),
      documentId: z.string().optional(),
      chunkId: z.string().optional(),
      chunkIndex: z.number().optional(),
      heading: z.string().optional()
    })
  ),
  missingCitationFindings: z.array(z.string()),
  missingClaims: z.array(z.string()),
  missingMetrics: z.array(z.string()),
  followUpQueries: z.array(z.string()),
  retryCount: z.number(),
  maxRetries: z.number()
});

export const reportWriterInputSchema = z.object({
  plan: reportPlanSchema,
  analysis: reportAnalyzerOutputSchema,
  risks: reportRiskCheckerOutputSchema,
  citations: reportCitationVerifierOutputSchema
});

export const reportWriterOutputSchema = z.object({
  title: z.string(),
  markdown: z.string(),
  html: z.string(),
  sectionCount: z.number().int().nonnegative(),
  citationCount: z.number().int().nonnegative()
});

export const reportPdfExporterInputSchema = z.object({
  draft: reportWriterOutputSchema
});

export const reportPdfExporterOutputSchema = z.object({
  status: z.literal("completed"),
  fileName: z.string(),
  mimeType: z.literal("application/pdf"),
  message: z.string()
});

export type CitationVerifierDecision = z.infer<typeof citationVerifierDecisionSchema>;
export type ReportEvidenceItem = z.infer<typeof reportEvidenceItemSchema>;
export type ReportMetricRequirement = z.infer<typeof reportMetricRequirementSchema>;
export type ReportClaim = z.infer<typeof reportClaimSchema>;
export type ReportDataCollectorInput = z.infer<typeof reportDataCollectorInputSchema>;
export type ReportDataCollectorOutput = z.infer<typeof reportDataCollectorOutputSchema>;
export type ReportAnalyzerInput = z.infer<typeof reportAnalyzerInputSchema>;
export type ReportAnalyzerOutput = z.infer<typeof reportAnalyzerOutputSchema>;
export type ReportRiskCheckerInput = z.infer<typeof reportRiskCheckerInputSchema>;
export type ReportRiskCheckerOutput = z.infer<typeof reportRiskCheckerOutputSchema>;
export type ReportCitationVerifierInput = z.infer<typeof reportCitationVerifierInputSchema>;
export type ReportCitationVerifierOutput = z.infer<typeof reportCitationVerifierOutputSchema>;
export type ReportWriterInput = z.infer<typeof reportWriterInputSchema>;
export type ReportWriterOutput = z.infer<typeof reportWriterOutputSchema>;
export type ReportPdfExporterInput = z.infer<typeof reportPdfExporterInputSchema>;
export type ReportPdfExporterOutput = z.infer<typeof reportPdfExporterOutputSchema>;
