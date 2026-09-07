/**
 * The results table as data: rows are Benchmarks, columns are Configurations, cells are the
 * aggregated Measurement in milliseconds. The UI and the Markdown export read the same structure.
 *
 * A cell may also carry a **Detail**: the supporting numbers of a Measurement whose one figure
 * cannot say what happened (a Concurrency row's per-Client spread, its statement counts, its
 * SQLSTATEs). Details are kept beside the cells rather than in them, because they belong under the
 * table and under the row — never inside a cell that is supposed to be one number.
 */

import type { MeasurementDetail } from "../engines/contract";

export interface GridRow {
  readonly id: string;
  readonly label: string;
}

export interface GridColumn {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
  /** True when this column's Run failed, as opposed to never having been attempted. */
  readonly failed?: boolean;
  /**
   * What the Suite has to say about this column beside its label — the Concurrency Suite's mode.
   *
   * Part of the header rather than a footnote, because the cells under it cannot be read without
   * it: `interleaved on one session` and `one backend per Client` are two different questions.
   */
  readonly note?: string;
}

/** Cell values keyed by `cellKey(columnId, rowId)`; a missing key means "not measured yet". */
export type GridCells = Readonly<Record<string, number>>;

/** Cell Details, keyed exactly as the cells are; most cells have none. */
export type GridDetails = Readonly<Record<string, MeasurementDetail>>;

export interface ResultsGrid {
  readonly rows: readonly GridRow[];
  readonly columns: readonly GridColumn[];
  readonly baselineColumnId: string;
  readonly cells: GridCells;
  readonly details?: GridDetails;
}

export function cellKey(columnId: string, rowId: string): string {
  return `${columnId}::${rowId}`;
}

export function readCell(cells: GridCells, columnId: string, rowId: string): number | undefined {
  return cells[cellKey(columnId, rowId)];
}

export function readDetail(grid: ResultsGrid, columnId: string, rowId: string): MeasurementDetail | undefined {
  return grid.details?.[cellKey(columnId, rowId)];
}

/** Every Detail of one row, in column order, so the export and the page list them the same way. */
export function rowDetails(
  grid: ResultsGrid,
  rowId: string,
): readonly { readonly column: GridColumn; readonly detail: MeasurementDetail }[] {
  const found: { column: GridColumn; detail: MeasurementDetail }[] = [];
  for (const column of grid.columns) {
    const detail = readDetail(grid, column.id, rowId);
    if (detail !== undefined) {
      found.push({ column, detail });
    }
  }
  return found;
}

/** How wide one body row is: the label, every column, and the ratio that follows all but the Baseline. */
export function gridColumnSpan(grid: ResultsGrid): number {
  return 1 + grid.columns.length + grid.columns.filter((column) => hasRatioColumn(grid, column.id)).length;
}

/** What an unmeasured cell of an unavailable column says: a failed Run is not a skipped one. */
export function unmeasuredCellText(column: GridColumn): string {
  return column.failed === true ? "failed" : "skipped";
}

/** Whether a column gets a ratio column after it (every column except the baseline). */
export function hasRatioColumn(grid: ResultsGrid, columnId: string): boolean {
  return columnId !== grid.baselineColumnId;
}
