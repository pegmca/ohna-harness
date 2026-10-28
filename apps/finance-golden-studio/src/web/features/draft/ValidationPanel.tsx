import type {
  ValidationIssue,
  ValidationReport
} from "../../../core/types.ts";

/** 校验面板属性。 */
interface ValidationPanelProps {
  report: ValidationReport | undefined;
  dirty: boolean;
  validationError?: string;
  onIssueSelect?: (issue: ValidationIssue) => void;
}

/**
 * 展示服务端校验结论、问题路径与关键词结果。
 *
 * @param props 最近一次校验报告和状态。
 * @returns 校验面板。
 */
export function ValidationPanel({
  report,
  dirty,
  validationError,
  onIssueSelect
}: ValidationPanelProps) {
  return (
    <section aria-labelledby="validation-heading" className="editor-section">
      <div className="section-heading">
        <h2 id="validation-heading">Validation</h2>
        <StatusBadge report={report} dirty={dirty} />
      </div>
      {validationError ? (
        <p className="field-error" role="alert">
          {validationError}
        </p>
      ) : null}
      {!report ? (
        <p className="muted-text">Not validated.</p>
      ) : (
        <>
          {report.errors.length === 0 ? (
            <p className="status-text status-text-ok">
              No blocking issues found.
            </p>
          ) : (
            <IssueList
              issues={report.errors}
              kind="error"
              onIssueSelect={onIssueSelect}
            />
          )}
          {report.warnings.length > 0 ? (
            <IssueList
              issues={report.warnings}
              kind="warning"
              onIssueSelect={onIssueSelect}
            />
          ) : null}
          {report.keywordResults.length > 0 ? (
            <div className="validation-keywords">
              <h3>Keyword scan</h3>
              <ul>
                {report.keywordResults.map((keyword) => (
                  <li key={keyword.keyword}>
                    <span className="keyword-text">{keyword.keyword}</span>
                    <span
                      className={
                        keyword.reachable
                          ? "status-text status-text-ok"
                          : "status-text status-text-warn"
                      }
                    >
                      {keyword.reachable
                        ? `Reachable in ${keyword.evidenceIndexes.length} source${
                            keyword.evidenceIndexes.length === 1 ? "" : "s"
                          }`
                        : "Not found in evidence"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * 展示可点击定位的问题列表。
 *
 * @param props 问题列表、类别与定位回调。
 * @returns 问题列表。
 */
function IssueList({
  issues,
  kind,
  onIssueSelect
}: {
  issues: readonly ValidationIssue[];
  kind: "error" | "warning";
  onIssueSelect?: (issue: ValidationIssue) => void;
}) {
  return (
    <ul
      aria-label={`${kind}s`}
      className={`issue-list issue-list-${kind}`}
      role="list"
    >
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${issue.field ?? "all"}-${index}`}>
          <button
            className="issue-button"
            onClick={() => onIssueSelect?.(issue)}
            type="button"
          >
            <span className="issue-label">
              {kind === "error" ? "Error" : "Warning"} · {issue.code}
            </span>
            <span>{issue.message}</span>
            {issue.field ? <code>{issue.field}</code> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * 显示校验通过、待重验、失败等稳定状态。
 *
 * @param props 最近报告与 dirty 状态。
 * @returns 状态徽标。
 */
function StatusBadge({
  report,
  dirty
}: {
  report: ValidationReport | undefined;
  dirty: boolean;
}) {
  const label = !report
    ? "Unvalidated"
    : dirty
      ? "Needs revalidation"
      : report.ok
        ? "Validated"
        : "Needs fixes";
  const className = !report
    ? "badge badge-neutral"
    : dirty
      ? "badge badge-warning"
      : report.ok
        ? "badge badge-success"
        : "badge badge-danger";
  return <span className={className}>{label}</span>;
}
