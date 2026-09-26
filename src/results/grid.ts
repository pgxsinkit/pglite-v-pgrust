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
import type { StoreStats } from "./store-stats";

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

/**
 * The store work behind the cells, keyed exactly as the cells are, on a Run with `?brokerStats=1`
 * (`src/broker-switches.ts`); the Warm-up's is keyed by column id alone, as its cells are.
 */
export type GridStoreStats = Readonly<Record<string, StoreStats>>;

/**
 * The **Warm-up** line: one Measurement per column, shown above the Benchmarks with a ratio like any
 * row, and never one of them.
 *
 * Its cells are keyed by column id alone and kept apart from `cells`, so nothing that walks the
 * Benchmarks' rows — a row count, a Suite total — can pick the Warm-up up by accident. Its label
 * never starts with `Test`, for the same reason one step further on: every table this repo's notes
 * total is totalled over its `| Test` rows.
 */
export interface GridWarmup {
  readonly label: string;
  /** The Warm-up's Measurement per column, keyed by column id; a missing key means "not measured yet". */
  readonly cells: GridCells;
  /** The Warm-up's store work per column, keyed by column id, on a Run that counts it. */
  readonly storeStats?: GridStoreStats;
}

export interface ResultsGrid {
  readonly rows: readonly GridRow[];
  readonly columns: readonly GridColumn[];
  readonly baselineColumnId: string;
  readonly cells: GridCells;
  readonly details?: GridDetails;
  /** Present, and exported as tables of their own, only on a Run that counts store work. */
  readonly storeStats?: GridStoreStats;
  /** Absent for a grid that has no Warm-up line; every Suite Run has one. */
  readonly warmup?: GridWarmup;
}

export function cellKey(columnId: string, rowId: string): string {
  return `${columnId}::${rowId}`;
}

export function readCell(cells: GridCells, columnId: string, rowId: string): number | undefined {
  return cells[cellKey(columnId, rowId)];
}

/** One column's Warm-up Measurement, if the grid has a Warm-up line and that column has run it. */
export function readWarmup(grid: ResultsGrid, columnId: string): number | undefined {
  return grid.warmup?.cells[columnId];
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
