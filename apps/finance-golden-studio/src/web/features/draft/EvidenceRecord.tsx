import { Trash2 } from "lucide-react";
import type {
  GoldenEvidence,
  GoldenReportType,
  GoldenSourceKind,
  ValidationIssue
} from "../../../core/types.ts";

/** 支持的财报类型。 */
const REPORT_TYPES: readonly GoldenReportType[] = [
  "annual",
  "interim",
  "q1",
  "q2",
  "q3",
  "prospectus",
  "announcement",
  "esg"
];

/** 支持的证据介质。 */
const SOURCE_KINDS: readonly GoldenSourceKind[] = ["text", "table", "image"];

/**
 * 编辑一条 evidence 的来源、页码、原文与介质类型。
 *
 * @param props 当前 evidence 与字段错误。
 * @returns 作者证据记录。
 */
export function EvidenceRecord({
  evidence,
  index,
  errors,
  onChange,
  onRemove,
  onSelectPage
}: {
  evidence: GoldenEvidence;
  index: number;
  errors: readonly ValidationIssue[];
  onChange: (next: GoldenEvidence) => void;
  onRemove: () => void;
  onSelectPage: (page: number) => void;
}) {
  const prefix = `evidence[${index}]`;
  const update = <TKey extends keyof GoldenEvidence>(
    key: TKey,
    value: GoldenEvidence[TKey]
  ): void => onChange({ ...evidence, [key]: value });
  return (
    <details className="evidence-record" open={index === 0}>
      <summary>
        <span>
          来源 {index + 1} · {evidence.ticker || "无代码"} ·{" "}
          {evidence.period || "无期间"}
        </span>
        <button
          aria-label={`删除证据 ${index + 1}`}
          className="icon-button"
          onClick={(event) => {
            event.preventDefault();
            onRemove();
          }}
          type="button"
        >
          <Trash2 aria-hidden="true" size={15} />
        </button>
      </summary>
      <div className="evidence-record-fields">
        <div className="field-grid field-grid-compact">
          <label className="field">
            <span className="field-label">代码</span>
            <input
              className="field-control"
              onChange={(event) => update("ticker", event.target.value)}
              value={evidence.ticker}
            />
          </label>
          <label className="field">
            <span className="field-label">报告</span>
            <select
              className="field-control"
              onChange={(event) =>
                update("report_type", event.target.value as GoldenReportType)
              }
              value={evidence.report_type}
            >
              {REPORT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">期间</span>
            <input
              className="field-control"
              onChange={(event) => update("period", event.target.value)}
              value={evidence.period}
            />
          </label>
          <label className="field">
            <span className="field-label">页码</span>
            <input
              aria-label={`证据 ${index + 1} 页码`}
              className="field-control"
              min={0}
              onChange={(event) =>
                update("page", Math.max(0, Number(event.target.value) || 0))
              }
              onFocus={() => onSelectPage(evidence.page)}
              type="number"
              value={evidence.page}
            />
          </label>
        </div>
        <label className="field">
          <span className="field-label">章节</span>
          <input
            aria-label={`证据 ${index + 1} 章节`}
            className="field-control"
            onChange={(event) => update("section", event.target.value)}
            value={evidence.section}
          />
        </label>
        <label className="field">
          <span className="field-label">原文</span>
          <textarea
            aria-label={`证据 ${index + 1} 原文`}
            className="field-control"
            onChange={(event) => update("quote", event.target.value)}
            rows={4}
            value={evidence.quote}
          />
        </label>
        <label className="field">
          <span className="field-label">来源类型</span>
          <select
            className="field-control"
            onChange={(event) =>
              update("source_kind", event.target.value as GoldenSourceKind)
            }
            value={evidence.source_kind}
          >
            {SOURCE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        {errors
          .filter((error) => error.field?.startsWith(prefix))
          .map((error, issueIndex) => (
            <p
              className="field-error"
              key={`${error.code}-${issueIndex}`}
              role="alert"
            >
              {error.message}
            </p>
          ))}
      </div>
    </details>
  );
}
