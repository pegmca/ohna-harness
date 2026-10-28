import type { ValidationReport } from "../../shared/api/types.ts";

/**
 * 展示作者集关键词的稳定汇总与逐项失败，不推断缺失的 evidence 归属。
 *
 * @param props 作者集校验报告。
 * @returns 关键词统计和不可达明细。
 */
export function KeywordDiagnostics({ report }: { report: ValidationReport }) {
  const summary = report.keywordSummary;
  if (!summary || summary.total === 0) return null;
  const failures = report.keywordResults.filter((result) => !result.reachable);
  return (
    <section aria-label="Keyword diagnostics" className="keyword-diagnostics">
      <dl className="keyword-summary">
        <div>
          <dt>Keywords</dt>
          <dd>{summary.total}</dd>
        </div>
        <div>
          <dt>Reachable</dt>
          <dd>{summary.reachable}</dd>
        </div>
        <div>
          <dt>Unreachable</dt>
          <dd>{summary.unreachable}</dd>
        </div>
      </dl>
      {failures.length > 0 ? (
        <div className="issue-summary">
          <h3>
            {failures.length} unreachable keyword{failures.length === 1 ? "" : "s"}
          </h3>
          <ul>
            {failures.map((keyword) => (
              <li key={`${keyword.caseId}:${keyword.keywordIndex}`}>
                <code>
                  {keyword.caseId} · {keyword.caseType} · keyword{" "}
                  {keyword.keywordIndex + 1}
                </code>
                <span className="keyword-text">{keyword.keyword}</span>
                {keyword.evidence.length > 0 ? (
                  <span className="keyword-evidence">
                    {keyword.evidence
                      .map(
                        (evidence) =>
                          `${evidence.documentFilePath ?? "unresolved document"} · ${
                            evidence.reachable ? "matched" : "no match"
                          }`
                      )
                      .join("\n")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
