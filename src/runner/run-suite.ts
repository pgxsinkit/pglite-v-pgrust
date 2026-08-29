/**
 * A Run: one Suite against one Configuration, on a freshly opened Engine.
 *
 * The worker is created here and terminated here, which is also how a Memory Configuration's state is
 * cleared between Runs — the data directory lives in the worker heap and dies with it.
 */

import type { Configuration, Measurement } from "../engines/contract";
import { applyModSql } from "../engines/contract";
import { createEngineRunner } from "../engines/registry";
import { aggregateMeasurements } from "../results/aggregate";
import type { Benchmark, Suite } from "../suites/types";

/** Every SQL string one Run will execute, with the Configuration's rewrite already applied. */
export interface RunPlan {
  /** The untimed setup or preamble, as the Engine will see it. */
  readonly setupSql: string;
  /** The Suite's Benchmarks, each carrying the SQL this Configuration will actually be handed. */
  readonly benchmarks: readonly Benchmark[];
}

/**
 * Resolve a Run's SQL: the single place a Configuration's `modSql` is applied.
 *
 * The rewrite has to reach the untimed setup as well as the Benchmarks. The RTT Suite creates its
 * two tables in the setup and nowhere else, so an unlogged Configuration whose setup was left alone
 * would run against LOGGED tables and merely duplicate the column it is meant to contrast with.
 * Both rewrites happen here, on the main thread, before the worker is asked for anything.
 */
export function planRun(suite: Suite, configuration: Configuration, setupSql: string): RunPlan {
  return {
    setupSql: applyModSql(configuration, setupSql),
    benchmarks: suite.benchmarks.map((benchmark) => ({
      ...benchmark,
      sql: applyModSql(configuration, benchmark.sql),
    })),
  };
}

export interface BenchmarkResult {
  readonly configurationId: string;
  readonly benchmarkId: string;
  /** The aggregated Measurement for this cell, in milliseconds. */
  readonly elapsedMs: number;
}

export interface RunOptions {
  readonly suite: Suite;
  readonly configuration: Configuration;
  /** The preamble (Speedtest) or initial setup (RTT) run untimed before the first Benchmark. */
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
    await runner.open(configuration, plan.setupSql);
    for (const benchmark of plan.benchmarks) {
      assertNotAborted(signal);
      const measurements: Measurement[] = [];
      for (let iteration = 0; iteration < suite.iterations; iteration += 1) {
        assertNotAborted(signal);
        measurements.push(await runner.measure(benchmark.sql));
      }
      onResult({
        configurationId: configuration.id,
        benchmarkId: benchmark.id,
        elapsedMs: aggregateMeasurements(measurements, suite.aggregation),
      });
    }
  } finally {
    await runner.close();
  }
}
