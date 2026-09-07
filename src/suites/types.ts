/** Suite, Benchmark and aggregation vocabulary (see CONTEXT.md). */

import type { EngineId, Measurement, SqlDialect } from "../engines/contract";
import type { ConcurrentScenario, ScenarioReport } from "../engines/scenario";
import { scenarioSessions } from "../engines/scenario";

/** How the per-iteration Measurements of one Benchmark collapse to the number in the cell. */
export type AggregationStrategy = "mean" | "trimmed-mean";

/** One timed unit within a Suite: a Speedtest script, or one RTT statement. One row of the table. */
export interface StatementBenchmark {
  readonly id: string;
  readonly label: string;
  readonly sql: string;
}

/**
 * A Benchmark whose unit is a whole scripted Scenario rather than one statement.
 *
 * The Engine runs every Client of the Scenario at once and reports what each of them did; `summarize`
 * is what turns that into the one number in the cell and the Detail beneath it. The reduction is
 * arithmetic on numbers the worker already measured, so it belongs to the Suite — which is the only
 * thing that knows whether this row's headline is a percentile, a rate or a wall time.
 */
export interface ScenarioBenchmark {
  readonly id: string;
  readonly label: string;
  readonly scenario: ConcurrentScenario;
  readonly summarize: (report: ScenarioReport) => Measurement;
}

export type Benchmark = StatementBenchmark | ScenarioBenchmark;

export function isScenarioBenchmark(benchmark: Benchmark): benchmark is ScenarioBenchmark {
  return "scenario" in benchmark;
}

/**
 * The SQL of a Benchmark that has one.
 *
 * For the callers that know they are looking at a statement Benchmark and want to say so: a Scenario
 * Benchmark has no single statement, and asking it for one is a mistake worth a message.
 */
export function benchmarkSql(benchmark: Benchmark): string {
  if (isScenarioBenchmark(benchmark)) {
    throw new Error(`Benchmark "${benchmark.id}" runs a Scenario, not one statement`);
  }
  return benchmark.sql;
}

export type SuiteId = "speedtest" | "rtt" | "concurrency";

/** A named, fixed list of Benchmarks run in order against one Engine. */
export interface Suite {
  readonly id: SuiteId;
  readonly title: string;
  readonly description: string;
  readonly benchmarks: readonly Benchmark[];
  /**
   * The Benchmarks as a given dialect must spell them; absent where one spelling serves everybody.
   *
   * The Speedtest and RTT Benchmarks are dialect-neutral and are run byte-identically against every
   * Engine. The Concurrency Suite's are not: a Scenario sets a per-Session lock wait and runs one
   * deliberately long query, and neither `SET lock_timeout` nor a `~` operator exists in SQLite. The
   * ids and the labels are the same list either way — the table has one row per Benchmark, whatever
   * the column — and only the SQL inside differs.
   */
  benchmarksFor?(dialect: SqlDialect): readonly Benchmark[];
  /**
   * SQL run untimed on a freshly opened Engine, before the first Benchmark.
   *
   * The one place every Suite has to answer a dialect, because every Suite builds its own dataset.
   */
  initialSetupFor(dialect: SqlDialect): string;
  /** Whether the UI offers the setup SQL as an editable preamble. */
  readonly editableSetup: boolean;
  /** How many times each Benchmark is executed per Run. */
  readonly iterations: number;
  readonly aggregation: AggregationStrategy;
  /**
   * What this Suite has to say about one Engine's column, beside its label.
   *
   * The Concurrency Suite's columns are not comparable without it: `one backend per Client` and
   * `interleaved on one session` are two different questions being answered, and a table pasted
   * somewhere else has to carry which one each column answered. It rides in the header cell rather
   * than in a footnote for exactly that reason. Absent for a Suite whose columns need no such note.
   */
  columnNoteFor?(engine: EngineId): string | undefined;
  /** A line the Markdown export carries under the environment, e.g. how many Clients ran. */
  readonly headerLine?: string;
}

/**
 * How many Sessions a Run of this Suite has to open: as many as its greediest Scenario needs.
 *
 * Derived rather than declared, so a Suite cannot ask for a Client it never opens a Session for.
 */
export function suiteSessions(suite: Suite): number {
  let sessions = 1;
  for (const benchmark of suite.benchmarks) {
    if (isScenarioBenchmark(benchmark)) {
      sessions = Math.max(sessions, scenarioSessions(benchmark.scenario));
    }
  }
  return sessions;
}
