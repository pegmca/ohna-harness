import type { GoldenAnswerTable } from "../../../core/types.ts";
import {
  appendTableColumn,
  appendTableRow,
  removeTableColumn,
  removeTableRow,
  updateTableColumn,
  updateTableRow
} from "./evidencing.ts";

/** 表格答案编辑器属性。 */
interface TableEditorProps {
  table: GoldenAnswerTable | undefined;
  onChange: (table: GoldenAnswerTable) => void;
}

/**
 * 在可滚动网格中编辑宽表格与长单元格。
 *
 * @param props 当前表格与更新回调。
 * @returns 表格答案编辑分区。
 */
export function TableEditor({ table, onChange }: TableEditorProps) {
  const value = normalizeTable(table);
  return (
    <section aria-labelledby="table-editor-heading" className="editor-section">
      <div className="section-heading">
        <h2 id="table-editor-heading">表格答案</h2>
        <span className="section-meta">
          {value.rows.length} × {value.columns.length}
        </span>
      </div>
      <div
        aria-label="表格答案"
        className="table-scroll"
        role="region"
        tabIndex={0}
      >
        <div
          className="table-canvas"
          style={{ width: `${Math.max(440, value.columns.length * 170 + 130)}px` }}
        >
          <table className="answer-table">
            <thead>
              <tr>
                <th aria-label="行号" className="row-index">
                  #
                </th>
                {value.columns.map((column, columnIndex) => (
                  <th key={`${column}-${columnIndex}`}>
                    <div className="table-column-head">
                      <label className="sr-only" htmlFor={`column-${columnIndex}`}>
                        列 {columnIndex + 1}
                      </label>
                      <input
                        className="table-input table-column-name"
                        id={`column-${columnIndex}`}
                        onChange={(event) =>
                          onChange(
                            updateTableColumn(value, columnIndex, event.target.value)
                          )
                        }
                        value={column}
                      />
                      <label className="sr-only" htmlFor={`unit-${columnIndex}`}>
                        第 {columnIndex + 1} 列单位
                      </label>
                      <input
                        aria-label={`第 ${columnIndex + 1} 列单位`}
                        className="table-input table-unit"
                        onChange={(event) =>
                          onChange({
                            ...value,
                            units: {
                              ...(value.units ?? {}),
                              [column]: event.target.value
                            }
                          })
                        }
                        placeholder="单位"
                        value={value.units?.[column] ?? ""}
                      />
                      <button
                        aria-label={`删除第 ${columnIndex + 1} 列`}
                        className="icon-button table-action"
                        onClick={() =>
                          onChange(removeTableColumn(value, columnIndex))
                        }
                        type="button"
                      >
                        ×
                      </button>
                    </div>
                  </th>
                ))}
                <th className="row-actions-head">
                  <button
                    className="icon-button"
                    onClick={() => onChange(appendTableColumn(value))}
                    type="button"
                  >
                    + 列
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {value.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <th className="row-index">{rowIndex + 1}</th>
                  {value.columns.map((column, columnIndex) => (
                    <td key={`${column}-${columnIndex}`}>
                      <label className="sr-only" htmlFor={`cell-${rowIndex}-${columnIndex}`}>
                        第 {rowIndex + 1} 行，{column}
                      </label>
                      <textarea
                        className="table-input table-cell"
                        id={`cell-${rowIndex}-${columnIndex}`}
                        onChange={(event) =>
                          onChange(
                            updateTableRow(
                              value,
                              rowIndex,
                              columnIndex,
                              event.target.value
                            )
                          )
                        }
                        rows={2}
                        value={row[columnIndex] ?? ""}
                      />
                    </td>
                  ))}
                  <td className="row-actions">
                    <button
                      aria-label={`删除第 ${rowIndex + 1} 行`}
                      className="icon-button"
                      onClick={() => onChange(removeTableRow(value, rowIndex))}
                      type="button"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
              {value.rows.length === 0 ? (
                <tr>
                  <td className="table-empty" colSpan={value.columns.length + 2}>
                    添加一行以录入表格数值。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
      <div className="section-actions">
        <button
          className="button button-secondary"
          onClick={() => onChange(appendTableRow(value))}
          type="button"
        >
          添加行
        </button>
      </div>
    </section>
  );
}

/**
 * 为缺失的表格结构提供可编辑初始值。
 *
 * @param table 可选表格。
 * @returns 合法表格。
 */
function normalizeTable(table: GoldenAnswerTable | undefined): GoldenAnswerTable {
  return table ?? { columns: ["列 1"], units: {}, rows: [] };
}
