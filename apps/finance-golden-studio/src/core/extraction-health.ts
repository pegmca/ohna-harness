import type { ParsedBlock } from "@aiagent/parsing";

/** PDF 抽取健康度判定结果。 */
export type ExtractionHealth =
  | {
      ok: true;
      reason: "ok";
      cjkChars: number;
      spacedCjkPairs: number;
      blocksPerPage: number;
    }
  | {
      ok: false;
      reason: "text_too_short" | "cjk_spacing";
      cjkChars: number;
      spacedCjkPairs: number;
      blocksPerPage: number;
    };

/**
 * 判定 PDF 文本是否具备可人工标注的抽取质量。
 *
 * 少于 200 个非空白字符直接拒绝；每页不足 1.5 个 block 且 CJK
 * 字符间距超过 15% 时，视为字符级抽取缺陷。
 *
 * @param blocks 解析器产出的 block。
 * @returns 健康度计数与拒绝原因。
 */
export function assessExtractionHealth(
  blocks: readonly ParsedBlock[]
): ExtractionHealth {
  const text = blocks.map((block) => block.text).join("\n");
  const nonWhitespace = text.replace(/\s+/gu, "").length;
  const cjkChars = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const spacedCjkPairs = (
    text.match(/\p{Script=Han}[ \t]+(?=\p{Script=Han})/gu) ?? []
  ).length;
  const pages = new Set(blocks.map((block) => block.pageNumber ?? 0)).size || 1;
  const blocksPerPage = blocks.length / pages;
  if (nonWhitespace < 200) {
    return {
      ok: false,
      reason: "text_too_short",
      cjkChars,
      spacedCjkPairs,
      blocksPerPage
    };
  }
  if (
    blocksPerPage < 1.5 &&
    cjkChars > 200 &&
    spacedCjkPairs / cjkChars > 0.15
  ) {
    return {
      ok: false,
      reason: "cjk_spacing",
      cjkChars,
      spacedCjkPairs,
      blocksPerPage
    };
  }
  return {
    ok: true,
    reason: "ok",
    cjkChars,
    spacedCjkPairs,
    blocksPerPage
  };
}
