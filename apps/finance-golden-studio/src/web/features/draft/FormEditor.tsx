import type { GoldenAnswerForm } from "../../../core/types.ts";

/** 表单答案编辑器属性。 */
interface FormEditorProps {
  form: GoldenAnswerForm | undefined;
  onChange: (form: GoldenAnswerForm) => void;
}

/**
 * 编辑键值表单答案与可选分组。
 *
 * @param props 当前表单与更新回调。
 * @returns 表单答案编辑分区。
 */
export function FormEditor({ form, onChange }: FormEditorProps) {
  const value: GoldenAnswerForm = {
    groups: form?.groups ?? [],
    items: form?.items ?? []
  };

  return (
    <section aria-labelledby="form-editor-heading" className="editor-section">
      <div className="section-heading">
        <h2 id="form-editor-heading">Answer form</h2>
        <span className="section-meta">{value.items.length} items</span>
      </div>
      <div className="form-group">
        <div className="section-heading section-heading-small">
          <h3>Groups</h3>
          <button
            className="button button-ghost"
            onClick={() =>
              onChange({
                ...value,
                groups: [...(value.groups ?? []), ""]
              })
            }
            type="button"
          >
            Add group
          </button>
        </div>
        {(value.groups ?? []).map((group, index) => (
          <div className="form-row" key={index}>
            <label className="sr-only" htmlFor={`form-group-${index}`}>
              Group {index + 1}
            </label>
            <input
              className="field-control"
              id={`form-group-${index}`}
              onChange={(event) =>
                onChange({
                  ...value,
                  groups: (value.groups ?? []).map((current, currentIndex) =>
                    currentIndex === index ? event.target.value : current
                  )
                })
              }
              placeholder="Group"
              value={group}
            />
            <button
              aria-label={`Remove group ${index + 1}`}
              className="icon-button"
              onClick={() =>
                onChange({
                  ...value,
                  groups: (value.groups ?? []).filter(
                    (_, currentIndex) => currentIndex !== index
                  )
                })
              }
              type="button"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="form-group">
        <div className="section-heading section-heading-small">
          <h3>Items</h3>
          <button
            className="button button-ghost"
            onClick={() =>
              onChange({
                ...value,
                items: [...value.items, { key: "", value: "" }]
              })
            }
            type="button"
          >
            Add form item
          </button>
        </div>
        {value.items.map((item, index) => (
          <div className="form-row form-item-row" key={index}>
            <label className="sr-only" htmlFor={`form-key-${index}`}>
              Item {index + 1} key
            </label>
            <input
              className="field-control"
              id={`form-key-${index}`}
              onChange={(event) =>
                onChange({
                  ...value,
                  items: value.items.map((current, currentIndex) =>
                    currentIndex === index
                      ? { ...current, key: event.target.value }
                      : current
                  )
                })
              }
              placeholder="Key"
              value={item.key}
            />
            <label className="sr-only" htmlFor={`form-value-${index}`}>
              Item {index + 1} value
            </label>
            <input
              className="field-control"
              id={`form-value-${index}`}
              onChange={(event) =>
                onChange({
                  ...value,
                  items: value.items.map((current, currentIndex) =>
                    currentIndex === index
                      ? { ...current, value: event.target.value }
                      : current
                  )
                })
              }
              placeholder="Value"
              value={item.value}
            />
            <button
              aria-label={`Remove form item ${index + 1}`}
              className="icon-button"
              onClick={() =>
                onChange({
                  ...value,
                  items: value.items.filter(
                    (_, currentIndex) => currentIndex !== index
                  )
                })
              }
              type="button"
            >
              ×
            </button>
          </div>
        ))}
        {value.items.length === 0 ? (
          <p className="muted-text">No form items yet.</p>
        ) : null}
      </div>
    </section>
  );
}
