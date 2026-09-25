/**
 * GFM export of a results grid: the same rows and columns the UI shows, preceded by the environment
 * line so a pasted table is self-describing.
 */

import { EMPTY_CELL, formatDetail, formatMs, formatRatio } from "./format";
import type { GridColumn, ResultsGrid } from "./grid";
import { hasRatioColumn, readCell, readWarmup, rowDetails, unmeasuredCellText } from "./grid";

export interface MarkdownExportOptions {
  readonly title: string;
  readonly environmentLine: string;
  /**
   * Which Configurations this table compares, and which of them the ratios are taken against.
   *
   * Part of the environment block rather than a footnote: a table of three columns out of fourteen
   * is a different result from a table of fourteen, and a pasted one has to say which it is.
   */
  readonly selectionLine?: string;
  readonly baselineLabel: string;
  /**
   * A line the Suite itself contributes under the environment — how many Clients ran, for the
   * Concurrency Suite. Absent for a Suite with nothing to add.
   */
  readonly suiteLine?: string;
  /**
   * The line that says this Run had a Warm-up, and which script it was, above the table whose first
   * row is that Warm-up's. An export without it is from before the Warm-up existed, when every
   * Suite's first Benchmark paid the Engine's first-use costs itself.
   */
  readonly warmupLine?: string;
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/**
 * One column's header cell: its label, the note the Suite gave it, and the unit.
 *
 * The note travels in the header so a pasted table stays self-describing. A Concurrency table whose
 * columns did not say which kind of concurrency each of them had would be five rows of numbers
 * answering two different questions with no way to tell which.
 */
export function markdownColumnHeader(column: GridColumn): string {
  return column.note === undefined ? `${column.label} (ms)` : `${column.label} — ${column.note} (ms)`;
}

/** Header cells, in order, including the ratio column that follows each non-baseline column. */
export function markdownHeaderCells(grid: ResultsGrid, baselineLabel: string): readonly string[] {
  const cells: string[] = ["Benchmark"];
  for (const column of grid.columns) {
    cells.push(markdownColumnHeader(column));
    if (hasRatioColumn(grid, column.id)) {
      cells.push(`vs ${baselineLabel}`);
    }
  }
  return cells;
}

/**
 * One body row: its label, then every column's number (or why it has none) and, after every column
 * but the Baseline, the ratio. A Benchmark's row and the Warm-up line are the same shape; only where
 * their numbers are read from differs, which is what `read` says.
 */
function bodyRowCells(
  grid: ResultsGrid,
  rowLabel: string,
  read: (columnId: string) => number | undefined,
): readonly string[] {
  const cells: string[] = [escapeCell(rowLabel)];
  for (const column of grid.columns) {
    const value = read(column.id);
    if (!column.available && value === undefined) {
      cells.push(unmeasuredCellText(column));
      if (hasRatioColumn(grid, column.id)) {
        cells.push(EMPTY_CELL);
      }
      continue;
    }
    cells.push(formatMs(value));
    if (hasRatioColumn(grid, column.id)) {
      cells.push(formatRatio(value, read(grid.baselineColumnId)));
    }
  }
  return cells;
}

/**
 * The Detail block: one line per Configuration per Benchmark, under the table.
 *
 * Under it and not in it, because a cell is one number and a Detail is a handful of them. A row with
 * nothing to add contributes nothing, so the two Suites that report a single time per Benchmark
 * export exactly what they always did.
 */
function detailLines(grid: ResultsGrid): readonly string[] {
  const lines: string[] = [];
  for (const gridRow of grid.rows) {
    for (const { column, detail } of rowDetails(grid, gridRow.id)) {
      lines.push(`- **${gridRow.label}** — ${column.label}: ${formatDetail(detail)}`);
    }
  }
  return lines;
}

export function toMarkdown(grid: ResultsGrid, options: MarkdownExportOptions): string {
  const header = markdownHeaderCells(grid, options.baselineLabel);
  const lines: string[] = [`### ${options.title}`, "", options.environmentLine, ""];
  if (options.selectionLine !== undefined) {
    lines.push(options.selectionLine, "");
  }
  if (options.suiteLine !== undefined) {
    lines.push(options.suiteLine, "");
  }
  if (options.warmupLine !== undefined) {
    lines.push(options.warmupLine, "");
  }
  lines.push(row(header), row(header.map(() => "---")));
  // The Warm-up is the table's first row and never one of its Benchmarks: its label does not start
  // with `Test`, which is what every total taken from a pasted table sums over.
  const warmup = grid.warmup;
  if (warmup !== undefined) {
    lines.push(row(bodyRowCells(grid, warmup.label, (columnId) => readWarmup(grid, columnId))));
  }
  for (const gridRow of grid.rows) {
    lines.push(row(bodyRowCells(grid, gridRow.label, (columnId) => readCell(grid.cells, columnId, gridRow.id))));
  }
  const details = detailLines(grid);
  if (details.length > 0) {
    lines.push("", "#### Detail", "", ...details);
  }
  return `${lines.join("\n")}\n`;
}
