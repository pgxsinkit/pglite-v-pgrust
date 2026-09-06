import { describe, expect, test } from "bun:test";

import type { ResultsGrid } from "./grid";
import { cellKey } from "./grid";
import { markdownHeaderCells, toMarkdown } from "./markdown";

const GRID: ResultsGrid = {
  rows: [
    { id: "1", label: "Test 1: 1000 INSERTs" },
    { id: "2", label: "Test 2: 25000 INSERTs in a transaction" },
  ],
  columns: [
    { id: "pglite-memory", label: "PGlite Memory", available: true },
    { id: "pglite-memory-unlogged", label: "PGlite Memory (unlogged)", available: true },
    { id: "pgrust-memory", label: "pgrust Memory", available: false, unavailableReason: "pgrust requires JSPI" },
  ],
  baselineColumnId: "pglite-memory",
  cells: {
    [cellKey("pglite-memory", "1")]: 16,
    [cellKey("pglite-memory", "2")]: 292,
    [cellKey("pglite-memory-unlogged", "1")]: 8,
    [cellKey("pglite-memory-unlogged", "2")]: 292,
  },
};

const OPTIONS = {
  title: "Speedtest Suite",
  environmentLine: "@pgxsinkit/pglite 0.5.5-pgx.2 | pgrust not synced | JSPI available | TestAgent/1.0",
  baselineLabel: "PGlite Memory",
};

describe("markdownHeaderCells", () => {
  test("adds a ratio column after every non-baseline Configuration", () => {
    expect(markdownHeaderCells(GRID, "PGlite Memory")).toEqual([
      "Benchmark",
      "PGlite Memory (ms)",
      "PGlite Memory (unlogged) (ms)",
      "vs PGlite Memory",
      "pgrust Memory (ms)",
      "vs PGlite Memory",
    ]);
  });
});

describe("toMarkdown", () => {
  const markdown = toMarkdown(GRID, OPTIONS);
  const lines = markdown.split("\n");

  test("leads with the title and the environment line", () => {
    expect(lines[0]).toBe("### Speedtest Suite");
    expect(lines[2]).toBe(OPTIONS.environmentLine);
  });

  test("emits a GFM header and separator of matching width", () => {
    expect(lines[4]).toBe(
      "| Benchmark | PGlite Memory (ms) | PGlite Memory (unlogged) (ms) | vs PGlite Memory | pgrust Memory (ms) | vs PGlite Memory |",
    );
    expect(lines[5]).toBe("| --- | --- | --- | --- | --- | --- |");
  });

  test("emits one row per Benchmark with ratios against the baseline", () => {
    expect(lines[6]).toBe("| Test 1: 1000 INSERTs | 16.000 | 8.000 | 0.50× | skipped | – |");
    expect(lines[7]).toBe("| Test 2: 25000 INSERTs in a transaction | 292.000 | 292.000 | 1.00× | skipped | – |");
  });

  test("ends with a trailing newline", () => {
    expect(markdown.endsWith("\n")).toBe(true);
  });

  test("renders unmeasured cells of an available Configuration as the placeholder", () => {
    const partial = toMarkdown({ ...GRID, cells: {} }, OPTIONS);
    expect(partial.split("\n")[6]).toBe("| Test 1: 1000 INSERTs | – | – | – | skipped | – |");
  });

  test("distinguishes a failed Run from a skipped Configuration", () => {
    const failed = toMarkdown(
      {
        ...GRID,
        columns: GRID.columns.map((column) =>
          column.id === "pgrust-memory"
            ? { ...column, available: false, unavailableReason: "boom", failed: true }
            : column,
        ),
      },
      OPTIONS,
    );
    expect(failed.split("\n")[6]).toBe("| Test 1: 1000 INSERTs | 16.000 | 8.000 | 0.50× | failed | – |");
  });

  test("escapes pipes in row labels", () => {
    const piped = toMarkdown({ ...GRID, rows: [{ id: "1", label: "a | b" }], cells: {} }, OPTIONS);
    expect(piped.split("\n")[6]).toBe("| a \\| b | – | – | – | skipped | – |");
  });
});

describe("toMarkdown, a Suite that reports more than one number per cell", () => {
  const withDetail: ResultsGrid = {
    ...GRID,
    details: {
      [cellKey("pglite-memory", "1")]: { "writer total ms": 663.355, "reader statements": 3 },
      [cellKey("pglite-memory-unlogged", "1")]: { "writer total ms": 641.2, "reader statements": 4 },
    },
  };

  test("writes the Detail under the table, one line per Configuration per Benchmark", () => {
    const markdown = toMarkdown(withDetail, OPTIONS);
    expect(markdown).toContain("#### Detail");
    expect(markdown).toContain(
      "- **Test 1: 1000 INSERTs** — PGlite Memory: writer total ms = 663.355; reader statements = 3",
    );
    expect(markdown).toContain(
      "- **Test 1: 1000 INSERTs** — PGlite Memory (unlogged): writer total ms = 641.200; reader statements = 4",
    );
  });

  // The cell stays one number: a Detail belongs under the table, never inside a column.
  test("leaves the table itself byte-identical to the same grid without a Detail", () => {
    const table = (markdown: string): string => markdown.split("#### Detail")[0] ?? "";
    expect(table(toMarkdown(withDetail, OPTIONS)).trimEnd()).toBe(toMarkdown(GRID, OPTIONS).trimEnd());
  });

  test("writes no Detail block for a grid that has none", () => {
    expect(toMarkdown(GRID, OPTIONS)).not.toContain("#### Detail");
  });

  test("carries the Suite's own header line under the environment when it has one", () => {
    const lines = toMarkdown(GRID, { ...OPTIONS, suiteLine: "Concurrency clients: 4" }).split("\n");
    expect(lines[2]).toBe(OPTIONS.environmentLine);
    expect(lines[4]).toBe("Concurrency clients: 4");
    expect(lines[6]?.startsWith("| Benchmark |")).toBe(true);
  });
});
