import type { JSX } from "react";
import { Fragment } from "react";

import type { MeasurementDetail } from "../engines/contract";
import { formatDetail, formatMs, formatRatio } from "../results/format";
import type { GridColumn, ResultsGrid } from "../results/grid";
import { gridColumnSpan, hasRatioColumn, readCell, rowDetails, unmeasuredCellText } from "../results/grid";

export interface ResultsTableProps {
  readonly grid: ResultsGrid;
  readonly baselineLabel: string;
  /** The Configuration currently being run, highlighted while its column fills in. */
  readonly activeColumnId: string | null;
}

export function ResultsTable({ grid, baselineLabel, activeColumnId }: ResultsTableProps): JSX.Element {
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Benchmark</th>
          {grid.columns.map((column) => (
            <ColumnHeaders
              key={column.id}
              columnId={column.id}
              label={column.label}
              available={column.available}
              unavailableReason={column.unavailableReason}
              showRatio={hasRatioColumn(grid, column.id)}
              baselineLabel={baselineLabel}
              active={column.id === activeColumnId}
            />
          ))}
        </tr>
      </thead>
      <tbody>
        {grid.rows.map((row) => (
          <Fragment key={row.id}>
            <tr>
              <td>{row.label}</td>
              {grid.columns.map((column) => {
                const value = readCell(grid.cells, column.id, row.id);
                const baseline = readCell(grid.cells, grid.baselineColumnId, row.id);
                const className = column.available ? undefined : "unavailable";
                return (
                  <ValueCells
                    key={column.id}
                    className={className}
                    text={column.available || value !== undefined ? formatMs(value) : unmeasuredCellText(column)}
                    ratio={hasRatioColumn(grid, column.id) ? formatRatio(value, baseline) : null}
                  />
                );
              })}
            </tr>
            <DetailRow grid={grid} rowId={row.id} rowLabel={row.label} />
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

interface DetailRowProps {
  readonly grid: ResultsGrid;
  readonly rowId: string;
  readonly rowLabel: string;
}

/**
 * The Detail of one Benchmark, folded away under its row.
 *
 * A cell stays one number; everything that number was computed from — per-Client percentiles,
 * statement counts, SQLSTATEs — is one click away, and is the same text the Markdown export writes
 * under the table. A row whose Benchmarks report no Detail renders nothing at all.
 */
function DetailRow({ grid, rowId, rowLabel }: DetailRowProps): JSX.Element | null {
  const details = rowDetails(grid, rowId);
  if (details.length === 0) {
    return null;
  }
  return (
    <tr className="detail">
      <td colSpan={gridColumnSpan(grid)}>
        <details>
          <summary>{rowLabel}: detail</summary>
          <ul>
            {details.map((entry: { column: GridColumn; detail: MeasurementDetail }) => (
              <li key={entry.column.id}>
                <strong>{entry.column.label}</strong>: {formatDetail(entry.detail)}
              </li>
            ))}
          </ul>
        </details>
      </td>
    </tr>
  );
}

interface ColumnHeadersProps {
  readonly columnId: string;
  readonly label: string;
  readonly available: boolean;
  readonly unavailableReason: string | undefined;
  readonly showRatio: boolean;
  readonly baselineLabel: string;
  readonly active: boolean;
}

function ColumnHeaders(props: ColumnHeadersProps): JSX.Element {
  const classNames = [props.available ? "" : "unavailable", props.active ? "active" : ""].filter(Boolean).join(" ");
  return (
    <>
      <th scope="col" className={classNames === "" ? undefined : classNames} title={props.unavailableReason}>
        {props.label} <span className="unit">(ms)</span>
        {props.available ? null : <div className="reason">{props.unavailableReason}</div>}
      </th>
      {props.showRatio ? (
        <th scope="col" className="ratio">
          vs {props.baselineLabel}
        </th>
      ) : null}
    </>
  );
}

interface ValueCellsProps {
  readonly className: string | undefined;
  readonly text: string;
  readonly ratio: string | null;
}

function ValueCells(props: ValueCellsProps): JSX.Element {
  return (
    <>
      <td className={props.className}>{props.text}</td>
      {props.ratio === null ? null : <td className="ratio">{props.ratio}</td>}
    </>
  );
}
