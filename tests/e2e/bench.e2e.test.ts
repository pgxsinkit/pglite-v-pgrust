/**
 * The headless lane, end to end: build, serve, drive Chromium, and check the Markdown the page
 * exports is a real results table.
 *
 * This proves the lane, not the Engines: it asserts the shape of every cell (a millisecond figure,
 * a ratio, or an explicit `skipped`/`failed`) and never a threshold, because a benchmark number is
 * not a pass/fail. All four Suites run, the Prepared Suite on the twelve Postgres columns (wa-sqlite
 * has no PREPARE, and its two columns say so). The RTT Suite runs at a deliberately non-standard three iterations so the whole
 * lane stays inside a sane wall time; the environment line must say so.
 *
 * Run with `bun run test:e2e`; it is not part of `bun run test`, `check` or `validate`.
 */

import { describe, expect, test } from "bun:test";

import type { BenchReport } from "../../scripts/bench";
import { runBench, WEBKIT_SKIP_MESSAGE } from "../../scripts/bench";
import { CONFIGURATIONS } from "../../src/configurations";
import { EMPTY_CELL } from "../../src/results/format";
import { markdownColumnHeader } from "../../src/results/markdown";
import { describeRttIterations } from "../../src/rtt-iterations";
import { SUITES } from "../../src/suites";
import { CONCURRENCY_CLIENTS, CONCURRENCY_SUITE, INTERLEAVED_ON_ONE_SESSION } from "../../src/suites/concurrency";
import {
  PREPARED_BENCHMARK_IDS,
  PREPARED_BENCHMARK_LABELS,
  PREPARED_SQLITE_NOTE,
} from "../../src/suites/prepared/benchmarks";
import { RTT_STATEMENTS } from "../../src/suites/rtt/statements";
import { SPEEDTEST_BENCHMARK_IDS } from "../../src/suites/speedtest/benchmarks";
import type { Suite, SuiteId } from "../../src/suites/types";
import { WARMUP_EXPORT_LINE, WARMUP_LABEL } from "../../src/suites/warmup";

/**
 * Build plus four Suites against fourteen Configurations; generous, because it is a real browser.
 *
 * The five Storage Configurations are the slow ones — each seeds a whole data directory into a cold
 * store before its Run and writes every byte the Suite produces to OPFS — and the Concurrency Suite
 * builds a 100 000-row table before every one of its Runs. This is a wall clock for a lane, not a
 * threshold anything is measured against.
 */
const LANE_TIMEOUT_MS = 3_600_000;

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
  pgliteOpfsRelaxed: 4,
  pgliteOpfsRelaxedRatio: 5,
  pgliteOpfsStrict: 6,
  pgliteOpfsStrictRatio: 7,
  pgrust: 8,
  pgrustRatio: 9,
  pgrustUnlogged: 10,
  pgrustUnloggedRatio: 11,
  pgrustThreads: 12,
  pgrustThreadsRatio: 13,
  pgrustThreadsBroker: 14,
  pgrustThreadsBrokerRatio: 15,
  pgrustThreadsOpfsRelaxed: 16,
  pgrustThreadsOpfsRelaxedRatio: 17,
  pgrustThreadsOpfsStrict: 18,
  pgrustThreadsOpfsStrictRatio: 19,
  pgrustPostmasterBroker: 20,
  pgrustPostmasterBrokerRatio: 21,
  pgrustPostmasterOpfsRelaxed: 22,
  pgrustPostmasterOpfsRelaxedRatio: 23,
  wasqlite: 24,
  wasqliteRatio: 25,
  wasqliteJournalOff: 26,
  wasqliteJournalOffRatio: 27,
} as const;

/** Benchmark label, fourteen Configurations, and a ratio for each of the thirteen non-Baseline ones. */
const EXPECTED_CELLS_PER_ROW = 28;

interface ColumnPair {
  readonly label: string;
  readonly value: number;
  readonly ratio: number;
}

/**
 * The two PGlite OPFS columns, held to the same rule as pgrust: they need a capability this browser
 * may not grant (a synchronous access handle in a dedicated worker), so `skipped` is a legitimate
 * cell.
 */
const OPFS_COLUMNS: readonly ColumnPair[] = [
  {
    label: "PGlite OPFS repacked (relaxed)",
    value: COLUMNS.pgliteOpfsRelaxed,
    ratio: COLUMNS.pgliteOpfsRelaxedRatio,
  },
  { label: "PGlite OPFS repacked (strict)", value: COLUMNS.pgliteOpfsStrict, ratio: COLUMNS.pgliteOpfsStrictRatio },
];

/**
 * The four pgrust columns, held to the same rule: a number with a ratio, or an honest non-number.
 *
 * The two single-session ones need JSPI; the two Threads ones need cross-origin isolation and the
 * second wasm module instead, and the broker one also needs the pre-release store bundle. Every one
 * of those can be absent in a legitimate environment, so `skipped` and `failed` are honest cells.
 */
const PGRUST_COLUMNS: readonly ColumnPair[] = [
  { label: "pgrust Memory", value: COLUMNS.pgrust, ratio: COLUMNS.pgrustRatio },
  { label: "pgrust Memory (unlogged)", value: COLUMNS.pgrustUnlogged, ratio: COLUMNS.pgrustUnloggedRatio },
  { label: "pgrust Threads Memory", value: COLUMNS.pgrustThreads, ratio: COLUMNS.pgrustThreadsRatio },
  {
    label: "pgrust Threads Memory (broker, pre-release store)",
    value: COLUMNS.pgrustThreadsBroker,
    ratio: COLUMNS.pgrustThreadsBrokerRatio,
  },
];

/**
 * The two threads columns whose store is on OPFS: the same store as the two above, reached through
 * the broker's coordinator worker instead of through PGlite. They need everything the two threads
 * Memory columns need AND a synchronous access handle, so they have the most ways to be `skipped`
 * of any column here.
 */
const PGRUST_THREADS_OPFS_COLUMNS: readonly ColumnPair[] = [
  {
    label: "pgrust Threads OPFS repacked (relaxed, pre-release store)",
    value: COLUMNS.pgrustThreadsOpfsRelaxed,
    ratio: COLUMNS.pgrustThreadsOpfsRelaxedRatio,
  },
  {
    label: "pgrust Threads OPFS repacked (strict, pre-release store)",
    value: COLUMNS.pgrustThreadsOpfsStrict,
    ratio: COLUMNS.pgrustThreadsOpfsStrictRatio,
  },
];

/**
 * The two postmaster columns: the same wasm module as the threads columns, booted as a real server.
 *
 * They need cross-origin isolation, the threads wasm module and the pre-release store bundle, and
 * the OPFS one needs a synchronous access handle as well — so, like every pgrust column, an honest
 * non-number is a legitimate cell here.
 */
const PGRUST_POSTMASTER_COLUMNS: readonly ColumnPair[] = [
  {
    label: "pgrust Postmaster Memory (broker, pre-release store)",
    value: COLUMNS.pgrustPostmasterBroker,
    ratio: COLUMNS.pgrustPostmasterBrokerRatio,
  },
  {
    label: "pgrust Postmaster OPFS repacked (relaxed, pre-release store)",
    value: COLUMNS.pgrustPostmasterOpfsRelaxed,
    ratio: COLUMNS.pgrustPostmasterOpfsRelaxedRatio,
  },
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

/**
 * Taken from the Suite definitions rather than written down, so a new Benchmark cannot slip past;
 * one more for the Warm-up line every table leads with.
 */
const EXPECTED_ROW_COUNTS: Readonly<Record<SuiteId, number>> = {
  speedtest: 1 + SPEEDTEST_BENCHMARK_IDS.length,
  rtt: 1 + RTT_STATEMENTS.length,
  concurrency: 1 + CONCURRENCY_SUITE.benchmarks.length,
  prepared: 1 + PREPARED_BENCHMARK_IDS.length,
};

const SUITE_IDS: readonly SuiteId[] = ["speedtest", "rtt", "concurrency", "prepared"];

/** The Suite that does not run on the Reference Engine, and whose wa-sqlite columns say so. */
const PREPARED_SUITE_ID: SuiteId = "prepared";

/** Whether this Suite runs on SQLite at all; the one that does not skips both wa-sqlite columns. */
function runsOnSqlite(suiteId: SuiteId): boolean {
  return suiteFor(suiteId).unsupportedReasonFor?.("sqlite") === undefined;
}

/** The Suite whose cells are not all times, and whose Engines are not all able to run it. */
const CONCURRENCY_SUITE_ID: SuiteId = "concurrency";

/**
 * The columns that used to be refused the Concurrency Suite and now run it.
 *
 * They have one Session each, which is a mode rather than an excuse: their Clients interleave per
 * statement on it, exactly as PGlite's do, and their headers say so. A `skipped` cell in any of them
 * would be this repo having quietly re-introduced the refusal.
 */
const CONCURRENCY_SINGLE_SESSION_COLUMNS: readonly ColumnPair[] = [
  { label: "pgrust Memory", value: COLUMNS.pgrust, ratio: COLUMNS.pgrustRatio },
  { label: "pgrust Threads Memory", value: COLUMNS.pgrustThreads, ratio: COLUMNS.pgrustThreadsRatio },
  WASQLITE_COLUMNS[0] ?? { label: "wa-sqlite Memory", value: COLUMNS.wasqlite, ratio: COLUMNS.wasqliteRatio },
];

function suiteFor(suiteId: SuiteId): Suite {
  const found = SUITES.find((candidate) => candidate.id === suiteId);
  if (found === undefined) {
    throw new Error(`no Suite with id "${suiteId}"`);
  }
  return found;
}

/**
 * The header cell a column should carry in this Suite: its label, the Suite's note on it, the unit.
 *
 * Built from the Suite rather than written down, so the Concurrency Suite's mode cannot go missing
 * from the export without this failing.
 */
function expectedColumnHeader(suiteId: SuiteId, label: string): string {
  const configuration = CONFIGURATIONS.find((candidate) => candidate.label === label);
  if (configuration === undefined) {
    throw new Error(`no Configuration labelled "${label}"`);
  }
  const note = suiteFor(suiteId).columnNoteFor?.(configuration.engine);
  return markdownColumnHeader({
    id: configuration.id,
    label,
    available: true,
    ...(note === undefined ? {} : { note }),
  });
}

/** The Baseline's own label, which every ratio header names. */
const BASELINE_LABEL = "PGlite Memory";

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

/** The header row of that same table, split the same way. */
function tableHeader(markdown: string): readonly string[] {
  const header = markdown.split("\n").filter((line) => line.startsWith("|"))[0] ?? "";
  return header
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function headerFor(suiteId: SuiteId): readonly string[] {
  const suite = report.suites.find((candidate) => candidate.suiteId === suiteId);
  if (suite === undefined) {
    throw new Error(`The bench report has no ${suiteId} Suite`);
  }
  return tableHeader(suite.markdown);
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
    // Not merely "present": the lane's own static server sends COOP + COEP, so a run that reported
    // `no` here would be a lane serving the page without isolation — and the two pgrust Threads
    // columns would be skipped for a reason that has nothing to do with the browser.
    expect(report.environmentLine).toContain("cross-origin isolated yes");
    expect(report.environmentLine).toContain("OPFS sync access");
    expect(report.environmentLine).toContain(describeRttIterations(RTT_ITERATIONS));
  });

  test("returns every Suite in the order they were requested", () => {
    expect(report.suites.map((suite) => suite.suiteId)).toEqual([...SUITE_IDS]);
  });

  test("writes a results file containing the environment line and both tables", async () => {
    expect(report.outputPath).not.toBeNull();
    const written = await Bun.file(report.outputPath ?? "").text();
    expect(written).toContain(report.environmentLine);
    expect(written).toContain("### Speedtest Suite");
    expect(written).toContain("### RTT Suite");
    expect(written).toContain("### Concurrency Suite");
    expect(written).toContain("### Prepared Suite");
  });

  for (const suiteId of SUITE_IDS) {
    test(`${suiteId}: has one row per Benchmark and one cell per Configuration and ratio`, () => {
      const rows = rowsFor(suiteId);
      expect(rows).toHaveLength(EXPECTED_ROW_COUNTS[suiteId]);
      const offenders = rows.filter((row) => row.length !== EXPECTED_CELLS_PER_ROW).map(describeRow);
      expect(offenders).toEqual([]);
    });

    // The Warm-up leads the table and is never one of its Benchmarks: every other row is a `Test`.
    test(`${suiteId}: leads with the Warm-up line, says which script it was, and labels every other row a Test`, () => {
      const rows = rowsFor(suiteId);
      expect(rows[0]?.[0]).toBe(WARMUP_LABEL);
      expect(
        rows
          .slice(1)
          .filter((row) => !(row[0] ?? "").startsWith("Test "))
          .map(describeRow),
      ).toEqual([]);
      const suite = report.suites.find((candidate) => candidate.suiteId === suiteId);
      expect(suite?.markdown).toContain(WARMUP_EXPORT_LINE);
    });

    // Every assertion below indexes cells by position, so the positions have to be pinned to the
    // labels they are supposed to name: a Configuration inserted in the middle would otherwise move
    // every column after it and the tests would quietly assert about the wrong one.
    test(`${suiteId}: names its columns in Configuration order, so the cell positions mean what they say`, () => {
      const header = headerFor(suiteId);
      for (const column of [
        ...OPFS_COLUMNS,
        ...PGRUST_COLUMNS,
        ...PGRUST_THREADS_OPFS_COLUMNS,
        ...PGRUST_POSTMASTER_COLUMNS,
        ...WASQLITE_COLUMNS,
      ]) {
        expect(header[column.value]).toBe(expectedColumnHeader(suiteId, column.label));
        expect(header[column.ratio]).toBe(`vs ${BASELINE_LABEL}`);
      }
      expect(header[COLUMNS.baseline]).toBe(expectedColumnHeader(suiteId, BASELINE_LABEL));
      expect(header).toHaveLength(EXPECTED_CELLS_PER_ROW);
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

    // Both pgrust columns need JSPI and the synced wasm assets, and both OPFS columns need a
    // synchronous access handle, so any of them can legitimately be `skipped` or `failed` here;
    // what the lane checks is that the cell says so honestly.
    for (const column of [
      ...OPFS_COLUMNS,
      ...PGRUST_COLUMNS,
      ...PGRUST_THREADS_OPFS_COLUMNS,
      ...PGRUST_POSTMASTER_COLUMNS,
    ]) {
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
    // Every Suite, this one included: wa-sqlite runs the Concurrency Suite on its one connection,
    // interleaving per statement, which is the mode its header states.
    //
    // The one exception is a Suite that does not run on SQLite at all — the Prepared Suite, since SQLite
    // has no PREPARE — and there both columns must be `skipped` in every row, never `failed` and never
    // a number: the page must not have tried.
    if (runsOnSqlite(suiteId)) {
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
    } else {
      test(`${suiteId}: both wa-sqlite Reference columns are skipped in every row, and say why`, () => {
        const rows = rowsFor(suiteId);
        const offenders = rows
          .filter((row) =>
            WASQLITE_COLUMNS.some((column) => row[column.value] !== "skipped" || row[column.ratio] !== EMPTY_CELL),
          )
          .map(describeRow);
        expect(offenders).toEqual([]);
        const header = headerFor(suiteId);
        for (const column of WASQLITE_COLUMNS) {
          expect(header[column.value]).toContain(PREPARED_SQLITE_NOTE);
        }
      });
    }
  }
});

describe("the Concurrency Suite", () => {
  test("records how many Clients ran, in the Suite's own header line", () => {
    const suite = report.suites.find((candidate) => candidate.suiteId === CONCURRENCY_SUITE_ID);
    expect(suite?.markdown).toContain(`Concurrency clients: ${CONCURRENCY_CLIENTS}`);
  });

  // Every Concurrency row reports one headline number and its supporting numbers under the table:
  // a p95 with no statement count behind it is not something a reader can check.
  test("exports a Detail block under the table, naming Benchmarks and Configurations", () => {
    const suite = report.suites.find((candidate) => candidate.suiteId === CONCURRENCY_SUITE_ID);
    const markdown = suite?.markdown ?? "";
    expect(markdown).toContain("#### Detail");
    expect(markdown).toContain("PGlite Memory: ");
    expect(markdown).toMatch(/- \*\*Test 1: Read fan-out/);
  });

  test("runs on the single-session Engines too, rather than refusing them", () => {
    const rows = rowsFor(CONCURRENCY_SUITE_ID);
    for (const column of CONCURRENCY_SINGLE_SESSION_COLUMNS) {
      const offenders = rows
        .filter((row) => !MS_PATTERN.test(row[column.value] ?? "") || !RATIO_PATTERN.test(row[column.ratio] ?? ""))
        .map(describeRow);
      expect(offenders).toEqual([]);
    }
  });

  test("states each column's concurrency mode in the header the export carries", () => {
    const header = headerFor(CONCURRENCY_SUITE_ID);
    const suite = report.suites.find((candidate) => candidate.suiteId === CONCURRENCY_SUITE_ID);
    expect(suite?.failures).toBe("");
    for (const column of CONCURRENCY_SINGLE_SESSION_COLUMNS) {
      expect(header[column.value]).toContain(INTERLEAVED_ON_ONE_SESSION);
    }
    // The one Engine that answers the other way, and the whole reason the note has to be there.
    for (const column of PGRUST_POSTMASTER_COLUMNS) {
      expect(header[column.value]).toContain("one backend per Client");
    }
  });

  test("runs on both PGlite and both postmaster columns", () => {
    const rows = rowsFor(CONCURRENCY_SUITE_ID);
    const offenders = rows
      .filter(
        (row) =>
          !MS_PATTERN.test(row[COLUMNS.baseline] ?? "") ||
          PGRUST_POSTMASTER_COLUMNS.some((column) => !MS_PATTERN.test(row[column.value] ?? "")),
      )
      .map(describeRow);
    expect(offenders).toEqual([]);
  });
});

describe("the Prepared Suite", () => {
  test("runs every Postgres column without a failure", () => {
    const suite = report.suites.find((candidate) => candidate.suiteId === PREPARED_SUITE_ID);
    expect(suite?.failures).toBe("");
  });

  test("labels its rows as the Speedtest's statement-heavy rows, prepared", () => {
    expect(rowsFor(PREPARED_SUITE_ID).map((row) => row[0])).toEqual([
      WARMUP_LABEL,
      ...PREPARED_BENCHMARK_IDS.map((id) => PREPARED_BENCHMARK_LABELS[id]),
    ]);
  });

  test("has a number in every row on both PGlite Memory columns and the pgrust Postmaster OPFS one", () => {
    const rows = rowsFor(PREPARED_SUITE_ID);
    const offenders = rows
      .filter(
        (row) =>
          !MS_PATTERN.test(row[COLUMNS.baseline] ?? "") ||
          !MS_PATTERN.test(row[COLUMNS.pgliteUnlogged] ?? "") ||
          !MS_PATTERN.test(row[COLUMNS.pgrustPostmasterOpfsRelaxed] ?? ""),
      )
      .map(describeRow);
    expect(offenders).toEqual([]);
  });
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
