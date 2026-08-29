/**
 * GFM export of a results grid: the same rows and columns the UI shows, preceded by the environment
 * line so a pasted table is self-describing.
 */

import { EMPTY_CELL, formatMs, formatRatio } from "./format";
import type { ResultsGrid } from "./grid";
import { hasRatioColumn, readCell, unmeasuredCellText } from "./grid";

export interface MarkdownExportOptions {
  readonly title: string;
  readonly environmentLine: string;
  readonly baselineLabel: string;
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/** Header cells, in order, including the ratio column that follows each non-baseline column. */
export function markdownHeaderCells(grid: ResultsGrid, baselineLabel: string): readonly string[] {
  const cells: string[] = ["Benchmark"];
  for (const column of grid.columns) {
    cells.push(`${column.label} (ms)`);
    if (hasRatioColumn(grid, column.id)) {
      cells.push(`vs ${baselineLabel}`);
    }
  }
  return cells;
}

function bodyRowCells(grid: ResultsGrid, rowId: string, rowLabel: string): readonly string[] {
  const cells: string[] = [escapeCell(rowLabel)];
  for (const column of grid.columns) {
    const value = readCell(grid.cells, column.id, rowId);
    if (!column.available && value === undefined) {
      cells.push(unmeasuredCellText(column));
      if (hasRatioColumn(grid, column.id)) {
        cells.push(EMPTY_CELL);
      }
      continue;
    }
    cells.push(formatMs(value));
    if (hasRatioColumn(grid, column.id)) {
      cells.push(formatRatio(value, readCell(grid.cells, grid.baselineColumnId, rowId)));
    }
  }
  return cells;
}

export function toMarkdown(grid: ResultsGrid, options: MarkdownExportOptions): string {
  const header = markdownHeaderCells(grid, options.baselineLabel);
  const lines: string[] = [
    `### ${options.title}`,
    "",
    options.environmentLine,
    "",
    row(header),
    row(header.map(() => "---")),
  ];
  for (const gridRow of grid.rows) {
    lines.push(row(bodyRowCells(grid, gridRow.id, gridRow.label)));
  }
  return `${lines.join("\n")}\n`;
}
