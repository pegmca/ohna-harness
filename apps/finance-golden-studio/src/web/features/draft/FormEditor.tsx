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
        <h2 id="form-editor-heading">表单答案</h2>
        <span className="section-meta">{value.items.length} 项</span>
      </div>
      <div className="form-group">
        <div className="section-heading section-heading-small">
          <h3>分组</h3>
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
            添加分组
          </button>
        </div>
        {(value.groups ?? []).map((group, index) => (
          <div className="form-row" key={index}>
            <label className="sr-only" htmlFor={`form-group-${index}`}>
              分组 {index + 1}
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
              placeholder="分组"
              value={group}
            />
            <button
              aria-label={`删除分组 ${index + 1}`}
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
          <h3>条目</h3>
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
            添加表单项
          </button>
        </div>
        {value.items.map((item, index) => (
          <div className="form-row form-item-row" key={index}>
            <label className="sr-only" htmlFor={`form-key-${index}`}>
              条目 {index + 1} 键
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
              placeholder="键"
              value={item.key}
            />
            <label className="sr-only" htmlFor={`form-value-${index}`}>
              条目 {index + 1} 值
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
              placeholder="值"
              value={item.value}
            />
            <button
              aria-label={`删除表单项 ${index + 1}`}
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
          <p className="muted-text">暂无表单项。</p>
        ) : null}
      </div>
    </section>
  );
}
