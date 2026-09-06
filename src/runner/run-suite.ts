/**
 * A Run: one Suite against one Configuration, on a freshly opened Engine.
 *
 * The worker is created here and terminated here, which is also how a Memory Configuration's state is
 * cleared between Runs — the data directory lives in the worker heap and dies with it.
 */

import type { Configuration, Measurement } from "../engines/contract";
import { applyModSql } from "../engines/contract";
import { createEngineRunner } from "../engines/registry";
import { mapScenarioSql } from "../engines/scenario";
import { aggregateRun } from "../results/aggregate";
import type { Benchmark, Suite } from "../suites/types";
import { isScenarioBenchmark, suiteSessions } from "../suites/types";

/** Every SQL string one Run will execute, with the Configuration's rewrite already applied. */
export interface RunPlan {
  /** The untimed setup or preamble, as the Engine will see it. */
  readonly setupSql: string;
  /** The Suite's Benchmarks, each carrying the SQL this Configuration will actually be handed. */
  readonly benchmarks: readonly Benchmark[];
  /** How many Sessions the Engine is opened with: as many as the Suite's Scenarios need. */
  readonly sessions: number;
}

/**
 * Resolve a Run's SQL: the single place a Configuration's `modSql` is applied.
 *
 * The rewrite has to reach the untimed setup as well as the Benchmarks. The RTT Suite creates its
 * two tables in the setup and nowhere else, so an unlogged Configuration whose setup was left alone
 * would run against LOGGED tables and merely duplicate the column it is meant to contrast with. A
 * Scenario is no different: every statement of every Client is rewritten too, which is why it
 * travels as data rather than as a closure. All of it happens here, on the main thread, before the
 * worker is asked for anything.
 */
export function planRun(suite: Suite, configuration: Configuration, setupSql: string): RunPlan {
  const rewrite = (sql: string): string => applyModSql(configuration, sql);
  return {
    setupSql: rewrite(setupSql),
    benchmarks: suite.benchmarks.map((benchmark) =>
      isScenarioBenchmark(benchmark)
        ? { ...benchmark, scenario: mapScenarioSql(benchmark.scenario, rewrite) }
        : { ...benchmark, sql: rewrite(benchmark.sql) },
    ),
    sessions: suiteSessions(suite),
  };
}

export interface BenchmarkResult {
  readonly configurationId: string;
  readonly benchmarkId: string;
  /** The aggregated Measurement for this cell, in milliseconds. */
  readonly elapsedMs: number;
  /** The Measurement's supporting numbers, where the Benchmark produced any. */
  readonly detail?: Measurement["detail"];
}

export interface RunOptions {
  readonly suite: Suite;
  readonly configuration: Configuration;
  /** The preamble (Speedtest) or initial setup (RTT, Concurrency) run untimed before the first Benchmark. */
  readonly setupSql: string;
  /** Called as each Benchmark completes, so the table fills in progressively. */
  readonly onResult: (result: BenchmarkResult) => void;
  readonly signal?: AbortSignal;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("Run cancelled");
  }
}

export async function runSuite(options: RunOptions): Promise<void> {
  const { suite, configuration, setupSql, onResult, signal } = options;
  const plan = planRun(suite, configuration, setupSql);
  const runner = createEngineRunner(configuration.engine);
  try {
    await runner.open(configuration, plan.setupSql, plan.sessions);
    for (const benchmark of plan.benchmarks) {
      assertNotAborted(signal);
      const measurements: Measurement[] = [];
      for (let iteration = 0; iteration < suite.iterations; iteration += 1) {
        assertNotAborted(signal);
        // One Scenario is one Measurement here exactly as one statement is: the Engine runs every
        // Client of it at once, inside the worker, and the Suite says which number the cell carries.
        measurements.push(
          isScenarioBenchmark(benchmark)
            ? benchmark.summarize(await runner.concurrent(benchmark.scenario))
            : await runner.measure(benchmark.sql),
        );
      }
      const aggregated = aggregateRun(measurements, suite.aggregation);
      onResult({
        configurationId: configuration.id,
        benchmarkId: benchmark.id,
        elapsedMs: aggregated.elapsedMs,
        ...(aggregated.detail === undefined ? {} : { detail: aggregated.detail }),
      });
    }
  } finally {
    await runner.close();
  }
}
