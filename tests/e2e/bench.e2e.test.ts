/**
 * The headless lane, end to end: build, serve, drive Chromium, and check the Markdown the page
 * exports is a real results table.
 *
 * This proves the lane, not the Engines: it asserts the shape of every cell (a millisecond figure,
 * a ratio, or an explicit `skipped`/`failed`) and never a threshold, because a benchmark number is
 * not a pass/fail. The RTT Suite runs at a deliberately non-standard three iterations so the whole
 * lane stays inside a sane wall time; the environment line must say so.
 *
 * Run with `bun run test:e2e`; it is not part of `bun run test`, `check` or `validate`.
 */

import { describe, expect, test } from "bun:test";

import type { BenchReport } from "../../scripts/bench";
import { runBench, WEBKIT_SKIP_MESSAGE } from "../../scripts/bench";
import { EMPTY_CELL } from "../../src/results/format";
import { describeRttIterations } from "../../src/rtt-iterations";
import { RTT_STATEMENTS } from "../../src/suites/rtt/statements";
import { SPEEDTEST_BENCHMARK_IDS } from "../../src/suites/speedtest/benchmarks";
import type { SuiteId } from "../../src/suites/types";

/** Build plus two Suites against six Configurations; generous, because it is a real browser. */
const LANE_TIMEOUT_MS = 900_000;

const RTT_ITERATIONS = 3;

/** `formatMs`: three decimal places, always. */
const MS_PATTERN = /^\d+\.\d{3}$/;
/** `formatRatio`: two decimal places and the multiplication sign. */
const RATIO_PATTERN = /^\d+\.\d{2}×$/;

/** How a column that never produced a Measurement reports itself. */
const NON_NUMERIC_CELLS: readonly string[] = ["skipped", "failed"];

/**
 * Cell positions in a body row: the Baseline has no ratio column, every other Configuration does.
 * Written out because an off-by-one here would silently assert about the wrong column.
 */
const COLUMNS = {
  baseline: 1,
  pgliteUnlogged: 2,
  pgliteUnloggedRatio: 3,
  pgrust: 4,
  pgrustRatio: 5,
  pgrustUnlogged: 6,
  pgrustUnloggedRatio: 7,
  wasqlite: 8,
  wasqliteRatio: 9,
  wasqliteJournalOff: 10,
  wasqliteJournalOffRatio: 11,
} as const;

/** Benchmark label, six Configurations, and a ratio for each of the five non-Baseline ones. */
const EXPECTED_CELLS_PER_ROW = 12;

interface ColumnPair {
  readonly label: string;
  readonly value: number;
  readonly ratio: number;
}

/** The two pgrust columns, held to the same rule: a number with a ratio, or an honest non-number. */
const PGRUST_COLUMNS: readonly ColumnPair[] = [
  { label: "pgrust Memory", value: COLUMNS.pgrust, ratio: COLUMNS.pgrustRatio },
  { label: "pgrust Memory (unlogged)", value: COLUMNS.pgrustUnlogged, ratio: COLUMNS.pgrustUnloggedRatio },
];

/** The two wa-sqlite columns, held to the stricter rule below. */
const WASQLITE_COLUMNS: readonly ColumnPair[] = [
  { label: "wa-sqlite Memory", value: COLUMNS.wasqlite, ratio: COLUMNS.wasqliteRatio },
  {
    label: "wa-sqlite Memory (journal off)",
    value: COLUMNS.wasqliteJournalOff,
    ratio: COLUMNS.wasqliteJournalOffRatio,
  },
];

/** Taken from the Suite definitions rather than written down, so a new Benchmark cannot slip past. */
const EXPECTED_ROW_COUNTS: Readonly<Record<SuiteId, number>> = {
  speedtest: SPEEDTEST_BENCHMARK_IDS.length,
  rtt: RTT_STATEMENTS.length,
};

const SUITE_IDS: readonly SuiteId[] = ["speedtest", "rtt"];

/** The body rows of the single GFM table in a Suite's export, split into trimmed cells. */
function tableRows(markdown: string): readonly (readonly string[])[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
}

function rowsFor(suiteId: SuiteId): readonly (readonly string[])[] {
  const suite = report.suites.find((candidate) => candidate.suiteId === suiteId);
  if (suite === undefined) {
    throw new Error(`The bench report has no ${suiteId} Suite`);
  }
  return tableRows(suite.markdown);
}

/** Offending rows rendered as text, so a failure names the Benchmark and shows its cells. */
function describeRow(row: readonly string[]): string {
  return `${row[0] ?? ""} -> ${row.slice(1).join(" | ")}`;
}

/**
 * One Run of the whole lane, shared by every assertion below: driving the browser twice would
 * double an already slow lane and prove nothing extra.
 */
const report: BenchReport = await runBench({
  browser: "chromium",
  suites: SUITE_IDS,
  rttIterations: RTT_ITERATIONS,
  timeoutMs: LANE_TIMEOUT_MS,
});

describe("bench lane", () => {
  test("reports the environment, including the non-standard RTT iteration count", () => {
    expect(report.skipped).toBe(false);
    expect(report.environmentLine).toContain("@pgxsinkit/pglite");
    expect(report.environmentLine).toContain("pgrust");
    expect(report.environmentLine).toContain("wa-sqlite");
    expect(report.environmentLine).toContain("JSPI");
    expect(report.environmentLine).toContain(describeRttIterations(RTT_ITERATIONS));
  });

  test("returns both Suites in the order they were requested", () => {
    expect(report.suites.map((suite) => suite.suiteId)).toEqual([...SUITE_IDS]);
  });

  test("writes a results file containing the environment line and both tables", async () => {
    expect(report.outputPath).not.toBeNull();
    const written = await Bun.file(report.outputPath ?? "").text();
    expect(written).toContain(report.environmentLine);
    expect(written).toContain("### Speedtest Suite");
    expect(written).toContain("### RTT Suite");
  });

  for (const suiteId of SUITE_IDS) {
    test(`${suiteId}: has one row per Benchmark and one cell per Configuration and ratio`, () => {
      const rows = rowsFor(suiteId);
      expect(rows).toHaveLength(EXPECTED_ROW_COUNTS[suiteId]);
      const offenders = rows.filter((row) => row.length !== EXPECTED_CELLS_PER_ROW).map(describeRow);
      expect(offenders).toEqual([]);
    });

    test(`${suiteId}: both PGlite Configurations report milliseconds and a ratio in every row`, () => {
      const rows = rowsFor(suiteId);
      const offenders = rows
        .filter(
          (row) =>
            !MS_PATTERN.test(row[COLUMNS.baseline] ?? "") ||
            !MS_PATTERN.test(row[COLUMNS.pgliteUnlogged] ?? "") ||
            !RATIO_PATTERN.test(row[COLUMNS.pgliteUnloggedRatio] ?? ""),
        )
        .map(describeRow);
      expect(offenders).toEqual([]);
    });

    // Both pgrust columns need JSPI and the synced wasm assets, so either can legitimately be
    // `skipped` or `failed` here; what the lane checks is that the cell says so honestly.
    for (const column of PGRUST_COLUMNS) {
      test(`${suiteId}: the ${column.label} column is milliseconds, skipped or failed in every row`, () => {
        const rows = rowsFor(suiteId);
        const offenders = rows
          .filter((row) => {
            const value = row[column.value] ?? "";
            const ratio = row[column.ratio] ?? "";
            if (MS_PATTERN.test(value)) {
              return !RATIO_PATTERN.test(ratio);
            }
            return !NON_NUMERIC_CELLS.includes(value) || ratio !== EMPTY_CELL;
          })
          .map(describeRow);
        expect(offenders).toEqual([]);
      });
    }

    // The Reference Engine is held to a stricter rule than the subjects: it needs no JSPI and no
    // asset that can be missing, so a `skipped` or `failed` cell here is a harness bug, not a
    // browser or a build state. Its whole purpose is to be the column that always has a number.
    test(`${suiteId}: both wa-sqlite Reference columns report milliseconds and a ratio in every row`, () => {
      const rows = rowsFor(suiteId);
      const offenders = rows
        .filter((row) =>
          WASQLITE_COLUMNS.some(
            (column) => !MS_PATTERN.test(row[column.value] ?? "") || !RATIO_PATTERN.test(row[column.ratio] ?? ""),
          ),
        )
        .map(describeRow);
      expect(offenders).toEqual([]);
    });
  }
});

describe("bench lane, WebKit", () => {
  test("skips with a reason instead of launching a browser", async () => {
    const skipped = await runBench({ browser: "webkit", build: false });
    expect(skipped.skipped).toBe(true);
    expect(skipped.reason).toBe(WEBKIT_SKIP_MESSAGE);
    expect(skipped.outputPath).toBeNull();
    expect(skipped.suites).toHaveLength(0);
  });
});
