import { useState } from "react";
import type { ValidationIssue } from "../../../core/types.ts";
import type { KeywordReachabilityView } from "./evidencing.ts";

/** 关键词编辑器属性。 */
interface KeywordEditorProps {
  keywords: readonly string[];
  reachability: readonly KeywordReachabilityView[];
  errors: readonly ValidationIssue[];
  onChange: (keywords: string[]) => void;
}

/**
 * 编辑 expected_keywords，并在每次变更后显示来源可达性。
 *
 * @param props 当前关键词、即时可达性与更新回调。
 * @returns 关键词编辑分区。
 */
export function KeywordEditor({
  keywords,
  reachability,
  errors,
  onChange
}: KeywordEditorProps) {
  const [draftKeyword, setDraftKeyword] = useState("");
  const addKeyword = (): void => {
    const next = draftKeyword.trim();
    if (!next) return;
    onChange([...keywords, next]);
    setDraftKeyword("");
  };

  return (
    <section aria-labelledby="keyword-heading" className="editor-section">
      <div className="section-heading">
        <h2 id="keyword-heading">Expected keywords</h2>
        <span className="section-meta">{keywords.length}</span>
      </div>
      <div className="keyword-add">
        <label className="sr-only" htmlFor="new-keyword">
          New expected keyword
        </label>
        <input
          className="field-control"
          id="new-keyword"
          onChange={(event) => setDraftKeyword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addKeyword();
            }
          }}
          placeholder="Add keyword"
          value={draftKeyword}
        />
        <button className="button button-secondary" onClick={addKeyword} type="button">
          Add keyword
        </button>
      </div>
      {keywords.length === 0 ? (
        <p className="muted-text">No expected keywords yet.</p>
      ) : (
        <ul className="keyword-list" aria-label="Expected keyword list">
          {keywords.map((keyword, index) => {
            const status = reachability[index];
            return (
              <li className="keyword-row" key={`${keyword}-${index}`}>
                <div className="keyword-main">
                  <span className="keyword-text">{keyword}</span>
                  <span
                    className={
                      status?.reachable
                        ? "status-text status-text-ok"
                        : "status-text status-text-warn"
                    }
                  >
                    {status?.reachable
                      ? `Reachable in ${status.evidenceIndexes.length} source${
                          status.evidenceIndexes.length === 1 ? "" : "s"
                        }`
                      : "Not found in evidence"}
                  </span>
                </div>
                <button
                  aria-label={`Remove keyword ${keyword}`}
                  className="icon-button"
                  onClick={() =>
                    onChange(keywords.filter((_, current) => current !== index))
                  }
                  type="button"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {errorsFor(errors, "expected_keywords").map((error) => (
        <p className="field-error" key={`${error.code}-${error.message}`} role="alert">
          {error.message}
        </p>
      ))}
    </section>
  );
}

/**
 * 查找关键词相关错误。
 *
 * @param errors 服务端校验错误。
 * @param field 字段路径。
 * @returns 匹配的问题。
 */
function errorsFor(
  errors: readonly ValidationIssue[],
  field: string
): ValidationIssue[] {
  return errors.filter((error) => error.field?.startsWith(field));
}
