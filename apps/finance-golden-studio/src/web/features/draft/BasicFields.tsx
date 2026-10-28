import type {
  GoldenAnswerType,
  GoldenDifficulty,
  GoldenDraft,
  GoldenDraftType,
  ValidationIssue
} from "../../../core/types.ts";

/** 支持编辑的草稿题型。 */
const TYPE_OPTIONS: readonly GoldenDraftType[] = [
  "numeric_fact",
  "definitional",
  "comparison",
  "multi_doc",
  "table",
  "unit_trap",
  "negative"
];

/** 支持编辑的难度。 */
const DIFFICULTY_OPTIONS: readonly GoldenDifficulty[] = ["easy", "medium", "hard"];

/** 支持编辑的答案形态。 */
const ANSWER_TYPE_OPTIONS: readonly GoldenAnswerType[] = [
  "number",
  "list",
  "table",
  "form",
  "text"
];

/** 基础字段编辑组件属性。 */
interface BasicFieldsProps {
  draft: GoldenDraft;
  errors: readonly ValidationIssue[];
  onChange: (next: GoldenDraft) => void;
}

/**
 * 编辑问句、答案摘要、题型与题目元数据。
 *
 * @param props 草稿、字段错误与更新回调。
 * @returns 基础字段分区。
 */
export function BasicFields({ draft, errors, onChange }: BasicFieldsProps) {
  const update = <TKey extends keyof GoldenDraft>(
    key: TKey,
    value: GoldenDraft[TKey]
  ): void => onChange({ ...draft, [key]: value });

  return (
    <section aria-labelledby="basic-fields-heading" className="editor-section">
      <div className="section-heading">
        <h2 id="basic-fields-heading">Question</h2>
        <span className="section-meta">{draft.id}</span>
      </div>
      <div className="field-stack">
        <FieldError errors={errors} field="query" />
        <label className="field-label" htmlFor="draft-query">
          Query
        </label>
        <textarea
          aria-describedby={hasField(errors, "query") ? "draft-query-error" : undefined}
          className={hasField(errors, "query") ? "field-control field-control-error" : "field-control"}
          id="draft-query"
          onChange={(event) => update("query", event.target.value)}
          rows={3}
          value={draft.query}
        />

        <label className="field-label" htmlFor="draft-gold-answer">
          Gold answer
        </label>
        <textarea
          className={hasField(errors, "gold_answer") ? "field-control field-control-error" : "field-control"}
          id="draft-gold-answer"
          onChange={(event) => update("gold_answer", event.target.value)}
          rows={4}
          value={draft.gold_answer}
        />
        <FieldError errors={errors} field="gold_answer" />

        <div className="field-grid">
          <label className="field">
            <span className="field-label">Type</span>
            <select
              className="field-control"
              onChange={(event) =>
                update("type", event.target.value as GoldenDraftType)
              }
              value={draft.type}
            >
              {TYPE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Difficulty</span>
            <select
              className="field-control"
              onChange={(event) =>
                update("difficulty", event.target.value as GoldenDifficulty)
              }
              value={draft.difficulty}
            >
              {DIFFICULTY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Answer form</span>
            <select
              className="field-control"
              onChange={(event) =>
                update("answer_type", event.target.value as GoldenAnswerType)
              }
              value={draft.answer_type}
            >
              {ANSWER_TYPE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Unit</span>
            <input
              className="field-control"
              onChange={(event) => update("answer_unit", event.target.value)}
              value={draft.answer_unit}
            />
          </label>
        </div>

        <label className="field-label" htmlFor="draft-note">
          Annotation note
        </label>
        <textarea
          className="field-control"
          id="draft-note"
          onChange={(event) => update("note", event.target.value)}
          rows={3}
          value={draft.note}
        />

        <div className="check-row">
          <label className="check-label">
            <input
              checked={draft.requires_multi_doc}
              onChange={(event) =>
                update("requires_multi_doc", event.target.checked)
              }
              type="checkbox"
            />
            Requires multiple documents
          </label>
          <label className="check-label">
            <input
              checked={draft.is_negative}
              onChange={(event) => update("is_negative", event.target.checked)}
              type="checkbox"
            />
            Negative case
          </label>
        </div>
      </div>
    </section>
  );
}

/**
 * 判断字段是否有服务端错误。
 *
 * @param errors 校验错误。
 * @param field 字段路径。
 * @returns 存在匹配错误时为 true。
 */
function hasField(errors: readonly ValidationIssue[], field: string): boolean {
  return errors.some(
    (error) =>
      error.field === field ||
      error.field?.startsWith(`${field}.`) ||
      error.field?.startsWith(`${field}[`)
  );
}

/**
 * 显示某字段的首个服务端校验错误。
 *
 * @param props 错误集合与字段路径。
 * @returns 错误文本；无错误时不渲染。
 */
function FieldError({
  errors,
  field
}: {
  errors: readonly ValidationIssue[];
  field: string;
}) {
  const error = errors.find(
    (candidate) =>
      candidate.field === field ||
      candidate.field?.startsWith(`${field}.`) ||
      candidate.field?.startsWith(`${field}[`)
  );
  return error ? (
    <p className="field-error" id={`${field}-error`} role="alert">
      {error.message}
    </p>
  ) : null;
}
