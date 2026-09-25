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

  test("carries the Configuration selection under the environment when it is given one", () => {
    const lines = toMarkdown(GRID, {
      ...OPTIONS,
      selectionLine: "Configurations (3 of 14): a, b, c | Baseline: b",
    }).split("\n");
    expect(lines[2]).toBe(OPTIONS.environmentLine);
    expect(lines[4]).toBe("Configurations (3 of 14): a, b, c | Baseline: b");
    expect(lines[6]?.startsWith("| Benchmark |")).toBe(true);
  });

  test("carries the Suite's own header line under the environment when it has one", () => {
    const lines = toMarkdown(GRID, { ...OPTIONS, suiteLine: "Concurrency clients: 4" }).split("\n");
    expect(lines[2]).toBe(OPTIONS.environmentLine);
    expect(lines[4]).toBe("Concurrency clients: 4");
    expect(lines[6]?.startsWith("| Benchmark |")).toBe(true);
  });
});

describe("toMarkdown, a grid with a Warm-up line", () => {
  const WARMUP_LINE = "Warm-up: warmup.sql, timed once per Run";
  const withWarmup: ResultsGrid = {
    ...GRID,
    warmup: {
      label: "Warm-up",
      cells: { "pglite-memory": 40, "pglite-memory-unlogged": 30 },
    },
  };
  const markdown = toMarkdown(withWarmup, { ...OPTIONS, warmupLine: WARMUP_LINE });
  const lines = markdown.split("\n");

  test("says which Warm-up the Run had, above the table", () => {
    expect(lines[2]).toBe(OPTIONS.environmentLine);
    expect(lines[4]).toBe(WARMUP_LINE);
    expect(lines[6]?.startsWith("| Benchmark |")).toBe(true);
  });

  test("puts the Warm-up first, with a ratio against the Baseline like any row", () => {
    expect(lines[8]).toBe("| Warm-up | 40.000 | 30.000 | 0.75× | skipped | – |");
    expect(lines[9]).toBe("| Test 1: 1000 INSERTs | 16.000 | 8.000 | 0.50× | skipped | – |");
  });

  // Every Suite total this repo takes from a pasted table is a sum over its `| Test` rows.
  test("stays out of a total taken over the Benchmark rows", () => {
    const total = (text: string): number =>
      text
        .split("\n")
        .filter((line) => line.startsWith("| Test"))
        .reduce((sum, line) => sum + Number(line.split("|")[2]), 0);
    expect(lines[8]?.startsWith("| Test")).toBe(false);
    expect(total(markdown)).toBe(16 + 292);
    expect(total(markdown)).toBe(total(toMarkdown(GRID, OPTIONS)));
  });

  test("leaves every Benchmark row byte-identical to the same grid without a Warm-up", () => {
    const benchmarkRows = (text: string): readonly string[] =>
      text.split("\n").filter((line) => line.startsWith("| Test"));
    expect(benchmarkRows(markdown)).toEqual(benchmarkRows(toMarkdown(GRID, OPTIONS)));
  });

  test("reports a failed column's Warm-up as failed, not as a number it never took", () => {
    const failed = toMarkdown(
      {
        ...withWarmup,
        columns: withWarmup.columns.map((column) =>
          column.id === "pgrust-memory"
            ? { ...column, available: false, unavailableReason: "boom", failed: true }
            : column,
        ),
      },
      OPTIONS,
    );
    expect(failed.split("\n")[6]).toBe("| Warm-up | 40.000 | 30.000 | 0.75× | failed | – |");
  });

  test("shows the placeholder until a column has run its Warm-up", () => {
    const pending = toMarkdown({ ...withWarmup, warmup: { label: "Warm-up", cells: {} } }, OPTIONS);
    expect(pending.split("\n")[6]).toBe("| Warm-up | – | – | – | skipped | – |");
  });

  test("writes no Warm-up row for a grid that has none", () => {
    expect(toMarkdown(GRID, OPTIONS)).not.toContain("| Warm-up |");
  });
});

describe("toMarkdown, a column the Suite does not run on", () => {
  // The Prepared Suite's wa-sqlite columns: skipped in every Run, in every browser, with the reason
  // in the header the export carries rather than in a cell.
  const PREPARED_LINE = "| Test 9: 25000 UPDATEs with an index (prepared) |";
  const refused: ResultsGrid = {
    rows: [{ id: "9", label: "Test 9: 25000 UPDATEs with an index (prepared)" }],
    columns: [
      { id: "pglite-memory", label: "PGlite Memory", available: true },
      {
        id: "wasqlite-memory",
        label: "wa-sqlite Memory",
        available: false,
        unavailableReason: "The Prepared Suite times PREPARE and EXECUTE statements, which SQLite does not have",
        note: "not run: SQLite has no PREPARE or EXECUTE",
      },
    ],
    baselineColumnId: "pglite-memory",
    cells: { [cellKey("pglite-memory", "9")]: 805 },
    warmup: { label: "Warm-up", cells: { "pglite-memory": 60 } },
  };
  const lines = toMarkdown(refused, { ...OPTIONS, title: "Prepared Suite" }).split("\n");

  test("names why in the column's header", () => {
    expect(lines[4]).toBe(
      "| Benchmark | PGlite Memory (ms) | wa-sqlite Memory — not run: SQLite has no PREPARE or EXECUTE (ms) | vs PGlite Memory |",
    );
  });

  test("reports every row of it skipped, the Warm-up included, and never a ratio", () => {
    expect(lines[6]).toBe("| Warm-up | 60.000 | skipped | – |");
    expect(lines[7]).toBe(`${PREPARED_LINE} 805.000 | skipped | – |`);
  });
});
