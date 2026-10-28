import type { PdfEvidenceBlock } from "../../../core/types.ts";
import { createEvidenceQuote } from "./evidencing.ts";

/**
 * 支持用鼠标或键盘选择证据原文并回填 quote。
 *
 * @param props 证据块、目标证据索引与选区回调。
 * @returns 可选择文本的证据块。
 */
export function EvidenceBlock({
  block,
  evidenceIndex,
  onQuoted
}: {
  block: PdfEvidenceBlock;
  evidenceIndex: number | undefined;
  onQuoted: (index: number, value: string) => void;
}) {
  const captureSelection = (): void => {
    if (evidenceIndex === undefined) return;
    const selected = window.getSelection()?.toString() ?? "";
    const quote = createEvidenceQuote(block.text, selected);
    if (quote) onQuoted(evidenceIndex, quote);
  };
  return (
    <article
      className={
        block.metadata.isTableRow
          ? "evidence-block evidence-block-table"
          : "evidence-block"
      }
      onKeyUp={captureSelection}
      onMouseUp={captureSelection}
    >
      <div className="block-meta">
        <span>
          Page {block.pageNumber} · L{block.lineStart}–{block.lineEnd}
        </span>
        {block.metadata.isTableRow ? (
          <span className="badge badge-neutral">
            Table · {String(block.metadata.tableColumnCount ?? "?")} columns
          </span>
        ) : null}
        {entryMetadata(block).sourceLayer ? (
          <span className="section-meta">{entryMetadata(block).sourceLayer}</span>
        ) : null}
      </div>
      <div
        className={
          block.metadata.isTableRow
            ? "block-text block-text-table"
            : "block-text"
        }
        tabIndex={0}
      >
        {block.text}
      </div>
    </article>
  );
}

/**
 * 读取证据块可展示的元数据。
 *
 * @param block 证据块。
 * @returns 来源层视图。
 */
function entryMetadata(block: PdfEvidenceBlock): { sourceLayer?: string } {
  const sourceLayer = block.metadata.sourceLayer;
  return typeof sourceLayer === "string" ? { sourceLayer } : {};
}
