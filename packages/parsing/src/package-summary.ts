import type { ParsingPackageSummary } from "./types.js";

/**
 * 创建 parsing package 的边界摘要，用于测试和 README 中说明 package 职责。
 *
 * @returns parsing package 的稳定职责、来源类型和当前可识别文件类型。
 */
export function createParsingPackageSummary(): ParsingPackageSummary {
  return {
    packageName: "@aiagent/parsing",
    boundary: "document_parsing_and_raw_text",
    supportedSourceKinds: ["local_file", "remote_url", "mock_text"],
    supportedFileTypes: ["markdown", "txt", "pdf"]
  };
}
