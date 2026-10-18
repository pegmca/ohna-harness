/**
 * PDF 发布 saga 已下沉到 packages/report（pi 化阶段 5：generate_report 工具与 HTTP 路由共用）。
 * 本文件仅保留 re-export 壳，保持既有 import 路径（含测试）零修改。
 */
export {
  publishArtifactPdf,
  type PdfPublishFailurePhase,
  type PdfPublishResult
} from "@aiagent/report";
