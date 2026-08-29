/**
 * The results table as data: rows are Benchmarks, columns are Configurations, cells are the
 * aggregated Measurement in milliseconds. The UI and the Markdown export read the same structure.
 */

export interface GridRow {
  readonly id: string;
  readonly label: string;
}

export interface GridColumn {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

/** Cell values keyed by `cellKey(columnId, rowId)`; a missing key means "not measured yet". */
export type GridCells = Readonly<Record<string, number>>;

export interface ResultsGrid {
  readonly rows: readonly GridRow[];
  readonly columns: readonly GridColumn[];
  readonly baselineColumnId: string;
  readonly cells: GridCells;
}

export function cellKey(columnId: string, rowId: string): string {
  return `${columnId}::${rowId}`;
}

export function readCell(cells: GridCells, columnId: string, rowId: string): number | undefined {
  return cells[cellKey(columnId, rowId)];
}

/** Whether a column gets a ratio column after it (every column except the baseline). */
export function hasRatioColumn(grid: ResultsGrid, columnId: string): boolean {
  return columnId !== grid.baselineColumnId;
}
