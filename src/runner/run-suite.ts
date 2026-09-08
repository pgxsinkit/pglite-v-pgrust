/**
 * A Run: one Suite against one Configuration, on a freshly opened Engine.
 *
 * The worker is created here and terminated here, which is also how a Memory Configuration's state is
 * cleared between Runs — the data directory lives in the worker heap and dies with it.
 */

import type { Configuration, Measurement } from "../engines/contract";
import { applyModSql, configurationDialect } from "../engines/contract";
import type { EngineStats } from "../engines/protocol";
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
 * Resolve a Run's SQL: the single place a Configuration's dialect and its `modSql` are applied.
 *
 * The rewrite has to reach the untimed setup as well as the Benchmarks. The RTT Suite creates its
 * two tables in the setup and nowhere else, so an unlogged Configuration whose setup was left alone
 * would run against LOGGED tables and merely duplicate the column it is meant to contrast with. A
 * Scenario is no different: every statement of every Client is rewritten too, which is why it
 * travels as data rather than as a closure. All of it happens here, on the main thread, before the
 * worker is asked for anything.
 *
 * The dialect is asked first and the rewrite applied after it, in that order: a Suite that spells
 * its Benchmarks differently for SQLite (the Concurrency Suite does) still has to be handed to a
 * Configuration's own rewrite, and a Configuration that has none gets the dialect's spelling
 * untouched.
 */
export function planRun(suite: Suite, configuration: Configuration, setupSql: string): RunPlan {
  const rewrite = (sql: string): string => applyModSql(configuration, sql);
  const benchmarks = suite.benchmarksFor?.(configurationDialect(configuration)) ?? suite.benchmarks;
  return {
    setupSql: rewrite(setupSql),
    benchmarks: benchmarks.map((benchmark) =>
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
  /**
   * Called once with what the Engine can say about the memory it holds, after the last Benchmark
   * and before the Engine is closed — the only moment the answer is the Run's peak rather than a
   * number taken off an Engine that has already let go of it. A `WebAssembly.Memory` only ever
   * grows, so its size read here IS the high-water mark of the Run.
   *
   * Optional and never fatal: an Engine whose worker has already died to an earlier failure must
   * still let the Run report the Benchmarks it did complete.
   */
  readonly onStats?: (configurationId: string, stats: EngineStats) => void;
  readonly signal?: AbortSignal;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("Run cancelled");
  }
}

export async function runSuite(options: RunOptions): Promise<void> {
  const { suite, configuration, setupSql, onResult, onStats, signal } = options;
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
    if (onStats !== undefined) {
      try {
        onStats(configuration.id, await runner.stats());
      } catch {
        // A Run that completed every Benchmark is not a failed Run because the Engine could not
        // describe its own memory afterwards.
      }
    }
  } finally {
    await runner.close();
  }
}
