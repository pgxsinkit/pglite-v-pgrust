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
   * SQL run untimed on a freshly opened Engine, before the first Benchmark.
   *
   * The Benchmarks themselves are dialect-neutral and are run byte-identically against every
   * Engine; only this setup has to be spelled differently for a SQLite Engine, so it is the one
   * place a dialect is asked for.
   */
  initialSetupFor(dialect: SqlDialect): string;
  /** Whether the UI offers the setup SQL as an editable preamble. */
  readonly editableSetup: boolean;
  /** How many times each Benchmark is executed per Run. */
  readonly iterations: number;
  readonly aggregation: AggregationStrategy;
  /**
   * Engines that cannot run this Suite at all, and the reason their cells carry.
   *
   * Not a browser capability and not a Configuration's storage: a property of what the Engine *is*.
   * The Concurrency Suite names the Engines with one place to run SQL, because the only way they
   * could produce a number for it would be to serialise the Clients and call the result concurrency.
   */
  readonly unsupportedEngines?: Readonly<Partial<Record<EngineId, string>>>;
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
