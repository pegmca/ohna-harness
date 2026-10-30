import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileSearch,
  Filter,
  Plus,
  Trash2
} from "lucide-react";
import type {
  GoldenDocumentRef,
  GoldenDraft,
  GoldenEvidence,
  PdfEvidenceBlock,
  PdfEvidenceDocument,
  ValidationIssue
} from "../../../core/types.ts";
import {
  resolveDraftSourcePath,
  type DraftSourceOption
} from "./evidencing.ts";
import { EvidenceBlock } from "./EvidenceBlock.tsx";
import { EvidenceRecord } from "./EvidenceRecord.tsx";

/** 证据面板属性。 */
interface EvidencePaneProps {
  draft: GoldenDraft;
  documents: readonly PdfEvidenceDocument[];
  sources: readonly DraftSourceOption[];
  errors: readonly ValidationIssue[];
  evidenceContentUrl: (filePath: string) => string;
  onDraftChange: (next: GoldenDraft) => void;
  onQuoted: (index: number, value: string) => void;
}

/** 证据列表过滤模式。 */
type EvidenceFilter = "all" | "text" | "tables";

/**
 * 将 PDF、证据块与作者证据记录合并在一个可独立滚动的证据面板中。
 *
 * @param props 当前草稿、已加载文档与选区回调。
 * @returns PDF/证据工作区。
 */
export function EvidencePane({
  draft,
  documents,
  sources,
  errors,
  evidenceContentUrl,
  onDraftChange,
  onQuoted
}: EvidencePaneProps) {
  const [activeSourcePath, setActiveSourcePath] = useState(
    sources[0]?.filePath ?? resolveDraftSourcePath(draft) ?? ""
  );
  const fallbackSourcePath = resolveDraftSourcePath(draft) ?? "";
  const effectiveSourcePath = activeSourcePath || fallbackSourcePath;
  const activeDocument =
    documents.find((document) => document.filePath === effectiveSourcePath) ??
    documents[0];
  const pages = activeDocument?.pages.length
    ? activeDocument.pages
    : uniquePages(draft.evidence);
  const [pageIndex, setPageIndex] = useState(0);
  const [filter, setFilter] = useState<EvidenceFilter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    setActiveSourcePath(sources[0]?.filePath ?? resolveDraftSourcePath(draft) ?? "");
  }, [draft.id, sources]);

  useEffect(() => {
    setPageIndex(0);
  }, [effectiveSourcePath]);

  const pageNumber = pages[Math.min(pageIndex, Math.max(0, pages.length - 1))];
  const blocks = useMemo(() => {
    const allBlocks = activeDocument?.blocks ?? [];
    const pageBlocks =
      pageNumber === undefined
        ? allBlocks
        : allBlocks.filter((block) => block.pageNumber === pageNumber);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return pageBlocks.filter((block) => {
      const tableMatch =
        filter === "all" ||
        (filter === "tables" && block.metadata.isTableRow === true) ||
        (filter === "text" && block.metadata.isTableRow !== true);
      const textMatch =
        normalizedQuery.length === 0 ||
        block.text.toLocaleLowerCase().includes(normalizedQuery);
      return tableMatch && textMatch;
    });
  }, [activeDocument, filter, pageNumber, query]);

  const setEvidence = (index: number, next: GoldenEvidence): void => {
    onDraftChange({
      ...draft,
      evidence: draft.evidence.map((evidence, current) =>
        current === index ? next : evidence
      )
    });
  };
  const addEvidence = (): void => {
    const base = draft.evidence[0];
    onDraftChange({
      ...draft,
      evidence: [
        ...draft.evidence,
        {
          ticker: base?.ticker ?? "",
          report_type: base?.report_type ?? "annual",
          period: base?.period ?? "",
          section: "",
          page: pageNumber ?? 0,
          quote: "",
          source_kind: "text"
        }
      ]
    });
  };
  const removeEvidence = (index: number): void => {
    onDraftChange({
      ...draft,
      evidence: draft.evidence.filter((_, current) => current !== index)
    });
  };
  const addDistractor = (): void => {
    onDraftChange({
      ...draft,
      distractors: [
        ...draft.distractors,
        {
          ticker: "",
          report_type: "annual",
          period: ""
        }
      ]
    });
  };
  const updateDistractor = (
    index: number,
    next: GoldenDocumentRef
  ): void => {
    onDraftChange({
      ...draft,
      distractors: draft.distractors.map((item, current) =>
        current === index ? next : item
      )
    });
  };

  return (
    <section aria-labelledby="evidence-heading" className="evidence-section">
      <div className="section-heading evidence-heading">
        <div>
          <h2 id="evidence-heading">证据</h2>
          <span className="section-meta">
            {activeDocument?.filePath ?? "无来源 PDF"}
          </span>
        </div>
        {effectiveSourcePath && activeDocument ? (
          <a
            aria-label="打开 PDF"
            className="icon-button"
            href={evidenceContentUrl(effectiveSourcePath)}
            rel="noreferrer"
            target="_blank"
            title="打开 PDF"
          >
            <ExternalLink aria-hidden="true" size={16} />
          </a>
        ) : null}
      </div>

      {sources.length > 1 ? (
        <label className="field evidence-source-select">
          <span className="field-label">来源文档</span>
          <select
            className="field-control"
            onChange={(event) => setActiveSourcePath(event.target.value)}
            value={effectiveSourcePath}
          >
            {sources.map((source) => (
              <option key={source.filePath} value={source.filePath}>
                {source.label} · {source.filePath}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="pdf-panel">
        {effectiveSourcePath && activeDocument ? (
          <iframe
            aria-label="PDF 页面预览"
            className="pdf-preview"
            src={`${evidenceContentUrl(effectiveSourcePath)}#page=${pageNumber ?? 1}`}
            title={`PDF 第 ${pageNumber ?? 1} 页`}
          />
        ) : (
          <div className="empty-pane">
            <FileSearch aria-hidden="true" size={18} />
            <p>{draft.is_negative ? "此负例题没有来源 PDF。" : "请选择证据来源。"}</p>
          </div>
        )}
        <div className="pdf-controls" aria-label="PDF 翻页控制">
          <button
            aria-label="上一页"
            className="icon-button"
            disabled={pageIndex <= 0}
            onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
            type="button"
          >
            <ChevronLeft aria-hidden="true" size={16} />
          </button>
          <span className="pdf-page-label">
            第 {pageNumber ?? 0} / {pages.at(-1) ?? 0} 页
          </span>
          <button
            aria-label="下一页"
            className="icon-button"
            disabled={pageIndex >= pages.length - 1}
            onClick={() =>
              setPageIndex((current) => Math.min(pages.length - 1, current + 1))
            }
            type="button"
          >
            <ChevronRight aria-hidden="true" size={16} />
          </button>
        </div>
      </div>

      <div className="evidence-tools">
        <label className="filter-control" htmlFor="evidence-filter">
          <Filter aria-hidden="true" size={14} />
          <span className="sr-only">筛选证据</span>
          <input
            className="field-control"
            id="evidence-filter"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选区块"
            value={query}
          />
        </label>
        <div aria-label="证据类型" className="segmented-control" role="group">
          {(["all", "text", "tables"] as const).map((option) => (
            <button
              aria-pressed={filter === option}
              className="segment"
              key={option}
              onClick={() => setFilter(option)}
              type="button"
            >
              {option === "all" ? "全部" : option === "text" ? "文本" : "表格"}
            </button>
          ))}
        </div>
      </div>

      <div className="block-list" aria-label="证据区块">
        {blocks.length === 0 ? (
          <p className="empty-pane">本页没有匹配的区块。</p>
        ) : (
          blocks.map((block, index) => (
            <EvidenceBlock
              block={block}
              evidenceIndex={findEvidenceIndex(draft, block, effectiveSourcePath)}
              key={`${block.pageNumber}-${block.lineStart}-${index}`}
              onQuoted={onQuoted}
            />
          ))
        )}
      </div>

      <div className="evidence-records">
        <div className="section-heading section-heading-small">
          <h3>来源记录</h3>
          <button
            className="button button-ghost"
            onClick={addEvidence}
            type="button"
          >
            <Plus aria-hidden="true" size={14} />
            添加来源
          </button>
        </div>
        {draft.evidence.map((evidence, index) => (
          <EvidenceRecord
            errors={errors}
            evidence={evidence}
            index={index}
            key={index}
            onChange={(next) => setEvidence(index, next)}
            onRemove={() => removeEvidence(index)}
            onSelectPage={(page) => {
              const nextIndex = pages.indexOf(page);
              if (nextIndex >= 0) setPageIndex(nextIndex);
            }}
          />
        ))}
        {draft.evidence.length === 0 ? (
          <p className="muted-text">暂无证据记录。</p>
        ) : null}
      </div>

      <div className="distractor-editor">
        <div className="section-heading section-heading-small">
          <h3>干扰项</h3>
          <button
            className="button button-ghost"
            onClick={addDistractor}
            type="button"
          >
            <Plus aria-hidden="true" size={14} />
            添加干扰项
          </button>
        </div>
        {draft.distractors.map((distractor, index) => (
          <div className="distractor-row" key={index}>
            <label className="sr-only" htmlFor={`distractor-ticker-${index}`}>
              干扰项 {index + 1} 代码
            </label>
            <input
              className="field-control"
              id={`distractor-ticker-${index}`}
              onChange={(event) =>
                updateDistractor(index, {
                  ...distractor,
                  ticker: event.target.value
                })
              }
              placeholder="代码"
              value={distractor.ticker}
            />
            <label className="sr-only" htmlFor={`distractor-period-${index}`}>
              干扰项 {index + 1} 期间
            </label>
            <input
              className="field-control"
              id={`distractor-period-${index}`}
              onChange={(event) =>
                updateDistractor(index, {
                  ...distractor,
                  period: event.target.value
                })
              }
              placeholder="期间"
              value={distractor.period}
            />
            <label className="sr-only" htmlFor={`distractor-report-${index}`}>
              干扰项 {index + 1} 报告类型
            </label>
            <select
              className="field-control"
              id={`distractor-report-${index}`}
              onChange={(event) =>
                updateDistractor(index, {
                  ...distractor,
                  report_type: event.target.value as GoldenDocumentRef["report_type"]
                })
              }
              value={distractor.report_type}
            >
              {["annual", "interim", "q1", "q2", "q3", "prospectus", "announcement", "esg"].map(
                (reportType) => (
                  <option key={reportType} value={reportType}>
                    {reportType}
                  </option>
                )
              )}
            </select>
            <button
              aria-label={`删除干扰项 ${index + 1}`}
              className="icon-button"
              onClick={() =>
                onDraftChange({
                  ...draft,
                  distractors: draft.distractors.filter(
                    (_, current) => current !== index
                  )
                })
              }
              type="button"
            >
              <Trash2 aria-hidden="true" size={15} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * 查找证据块对应的人工 evidence 下标。
 *
 * @param draft 当前草稿。
 * @param block 证据块。
 * @param sourcePath 当前来源路径。
 * @returns 匹配证据下标；没有匹配时回退到首条来源。
 */
function findEvidenceIndex(
  draft: GoldenDraft,
  block: PdfEvidenceBlock,
  sourcePath: string
): number | undefined {
  const exact = draft.evidence.findIndex(
    (evidence) =>
      (evidence.page === block.pageNumber ||
        evidence.page_image_ref?.includes(sourcePath)) &&
      evidence.source_kind === (block.metadata.isTableRow ? "table" : "text")
  );
  if (exact >= 0) return exact;
  return draft.evidence.length === 1 ? 0 : undefined;
}

/**
 * 收集 evidence 中出现的有序页码。
 *
 * @param evidence 作者证据。
 * @returns 去重页码。
 */
function uniquePages(evidence: readonly GoldenEvidence[]): number[] {
  return [...new Set(evidence.map((item) => item.page).filter((page) => page > 0))].sort(
    (left, right) => left - right
  );
}
