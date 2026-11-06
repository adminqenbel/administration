import type { ReactNode } from "react";
import { cx } from "../cx.ts";

export interface Column<T> {
  key: string;
  header: string;
  /** Right-align and use tabular numerals: money, counts, times. */
  numeric?: boolean;
  render: (row: T) => ReactNode;
}

export interface TableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T) => string;
  /** Accessible name for the table. Shown unless captionHidden. */
  caption: string;
  captionHidden?: boolean;
  /** Shown inside the table when there are no rows (for example an EmptyState). */
  empty?: ReactNode;
}

export function Table<T>({ columns, rows, rowKey, caption, captionHidden = true, empty }: TableProps<T>) {
  return (
    // The scrollable region must be reachable by keyboard.
    <div className="qb-table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className="qb-table">
        <caption className={cx(captionHidden && "qb-sr-only")}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx(c.numeric && "qb-table__num")}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && empty ? (
            <tr className="qb-table__emptyrow">
              <td className="qb-table__empty" colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((c) => (
                  <td key={c.key} className={cx(c.numeric && "qb-table__num")}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
