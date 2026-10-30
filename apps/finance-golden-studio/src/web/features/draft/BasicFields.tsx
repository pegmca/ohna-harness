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

/** 草稿题型的中文展示文案。 */
const TYPE_LABELS: Record<GoldenDraftType, string> = {
  numeric_fact: "数值事实",
  definitional: "定义类",
  comparison: "对比类",
  multi_doc: "多文档",
  table: "表格",
  unit_trap: "单位陷阱",
  negative: "负例题"
};

/** 难度的中文展示文案。 */
const DIFFICULTY_LABELS: Record<GoldenDifficulty, string> = {
  easy: "简单",
  medium: "中等",
  hard: "困难"
};

/** 答案形态的中文展示文案。 */
const ANSWER_TYPE_LABELS: Record<GoldenAnswerType, string> = {
  number: "数值",
  list: "列表",
  table: "表格",
  form: "表单",
  text: "文本"
};

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
        <h2 id="basic-fields-heading">问题</h2>
        <span className="section-meta">{draft.id}</span>
      </div>
      <div className="field-stack">
        <FieldError errors={errors} field="query" />
        <label className="field-label" htmlFor="draft-query">
          问句
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
          标准答案
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
            <span className="field-label">题型</span>
            <select
              className="field-control"
              onChange={(event) =>
                update("type", event.target.value as GoldenDraftType)
              }
              value={draft.type}
            >
              {TYPE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {TYPE_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">难度</span>
            <select
              className="field-control"
              onChange={(event) =>
                update("difficulty", event.target.value as GoldenDifficulty)
              }
              value={draft.difficulty}
            >
              {DIFFICULTY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {DIFFICULTY_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">答案形态</span>
            <select
              className="field-control"
              onChange={(event) =>
                update("answer_type", event.target.value as GoldenAnswerType)
              }
              value={draft.answer_type}
            >
              {ANSWER_TYPE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {ANSWER_TYPE_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">单位</span>
            <input
              className="field-control"
              onChange={(event) => update("answer_unit", event.target.value)}
              value={draft.answer_unit}
            />
          </label>
        </div>

        <label className="field-label" htmlFor="draft-note">
          标注备注
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
            需要多份文档
          </label>
          <label className="check-label">
            <input
              checked={draft.is_negative}
              onChange={(event) => update("is_negative", event.target.checked)}
              type="checkbox"
            />
            负例题
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
