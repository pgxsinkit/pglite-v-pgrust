/**
 * A Run: one Suite against one Configuration, on a freshly opened Engine.
 *
 * The worker is created here and terminated here, which is also how a Memory Configuration's state is
 * cleared between Runs — the data directory lives in the worker heap and dies with it.
 *
 * In order: the Engine boots and its store opens; the **Warm-up** runs, timed; the Suite's untimed
 * setup runs; then the Benchmarks. The Warm-up comes before the setup in every Suite, so its line
 * measures the same thing in all four — the first SQL an Engine runs after boot — and so the
 * Concurrency Suite's 100 000-row setup cannot pay the first-use costs untimed and leave its Warm-up
 * line measuring an Engine that is already warm.
 *
 * A statement Benchmark may carry untimed texts of its own, sent just before its first Measurement
 * and just after its last: the Prepared Suite's tables and `PREPARE` before a row, its `DEALLOCATE`
 * after it. The other three Suites' Benchmarks carry none, and their Runs are unchanged.
 */

import type { Configuration, EngineId, EngineRunner, Measurement } from "../engines/contract";
import { applyModSql, configurationDialect } from "../engines/contract";
import type { EngineStats } from "../engines/protocol";
import { createEngineRunner } from "../engines/registry";
import { mapScenarioSql } from "../engines/scenario";
import { aggregateRun } from "../results/aggregate";
import type { Benchmark, StatementBenchmark, Suite } from "../suites/types";
import { isScenarioBenchmark, suiteSessions, suiteUnsupportedReason } from "../suites/types";

/** Every SQL string one Run will execute, with the Configuration's rewrite already applied. */
export interface RunPlan {
  /**
   * The Warm-up, as the Engine will see it; null for a plan that was not given one (the probes,
   * which reuse a Suite's setup and Benchmarks but are not Suite Runs).
   */
  readonly warmupSql: string | null;
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
 *
 * The Warm-up is rewritten too, for the same reason as the setup: an unlogged column whose Warm-up
 * created a logged table would warm a path its Benchmarks never take.
 */
export function planRun(
  suite: Suite,
  configuration: Configuration,
  setupSql: string,
  warmupSql: string | null = null,
): RunPlan {
  const rewrite = (sql: string): string => applyModSql(configuration, sql);
  const benchmarks = suite.benchmarksFor?.(configurationDialect(configuration)) ?? suite.benchmarks;
  return {
    warmupSql: warmupSql === null ? null : rewrite(warmupSql),
    setupSql: rewrite(setupSql),
    benchmarks: benchmarks.map((benchmark) =>
      isScenarioBenchmark(benchmark)
        ? { ...benchmark, scenario: mapScenarioSql(benchmark.scenario, rewrite) }
        : rewriteStatementBenchmark(benchmark, rewrite),
    ),
    sessions: suiteSessions(suite),
  };
}

/**
 * A statement Benchmark with every text it carries rewritten: its timed SQL and, where it has them,
 * its untimed setup and teardown texts. The Prepared Suite creates its tables in a row's setup, so an
 * unlogged column whose row setup was left alone would run on logged tables.
 */
function rewriteStatementBenchmark(
  benchmark: StatementBenchmark,
  rewrite: (sql: string) => string,
): StatementBenchmark {
  return {
    ...benchmark,
    sql: rewrite(benchmark.sql),
    ...(benchmark.setup === undefined ? {} : { setup: benchmark.setup.map(rewrite) }),
    ...(benchmark.teardown === undefined ? {} : { teardown: benchmark.teardown.map(rewrite) }),
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

/**
 * What one Run's Warm-up took: one Measurement, never aggregated and never a Benchmark's.
 *
 * Reported through its own callback rather than as a `BenchmarkResult` with a reserved id, so
 * nothing that collects Benchmark results — a row, a total — can collect it by accident.
 */
export interface WarmupResult {
  readonly configurationId: string;
  /** The Warm-up's wall time in milliseconds, taken inside the worker as a Benchmark's is. */
  readonly elapsedMs: number;
}

export interface RunOptions {
  readonly suite: Suite;
  readonly configuration: Configuration;
  /** The preamble (Speedtest) or initial setup (RTT, Concurrency) run untimed before the first Benchmark. */
  readonly setupSql: string;
  /**
   * The Warm-up script, run once and timed after the Engine opens and before `setupSql`, on the
   * first Session. The same text for every Suite and every Engine: `src/suites/warmup.sql`.
   */
  readonly warmupSql: string;
  /** Called once, when the Warm-up completes, before the setup and the first Benchmark. */
  readonly onWarmup: (result: WarmupResult) => void;
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
  /** Where the Engine comes from; the worker-backed registry unless a test hands in its own. */
  readonly createRunner?: (engine: EngineId) => EngineRunner;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("Run cancelled");
  }
}

/** Send each untimed text of a Benchmark's setup or teardown, in order, each as its own query text. */
async function execEach(
  runner: EngineRunner,
  texts: readonly string[] | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  for (const text of texts ?? []) {
    assertNotAborted(signal);
    await runner.exec(text);
  }
}

export async function runSuite(options: RunOptions): Promise<void> {
  const { suite, configuration, setupSql, warmupSql, onWarmup, onResult, onStats, signal } = options;
  const unsupported = suiteUnsupportedReason(suite, configurationDialect(configuration));
  if (unsupported !== undefined) {
    // The page never asks, since it skips such a column; this is for any other caller, which would
    // otherwise boot an Engine only to fail on the Suite's first statement.
    throw new Error(`${suite.title} does not run on ${configuration.label}: ${unsupported}`);
  }
  const plan = planRun(suite, configuration, setupSql, warmupSql);
  const runner = (options.createRunner ?? createEngineRunner)(configuration.engine);
  try {
    // Booted with no preamble, so the Warm-up is the first SQL the Engine runs.
    await runner.open(configuration, "", plan.sessions);
    if (plan.warmupSql !== null) {
      assertNotAborted(signal);
      const warmup = await runner.measure(plan.warmupSql);
      onWarmup({ configurationId: configuration.id, elapsedMs: warmup.elapsedMs });
    }
    if (plan.setupSql.trim() !== "") {
      assertNotAborted(signal);
      await runner.exec(plan.setupSql);
    }
    for (const benchmark of plan.benchmarks) {
      assertNotAborted(signal);
      // A Benchmark's own untimed setup, once, just before its first Measurement: the Prepared
      // Suite's tables and its PREPARE. Nothing else sits between it and the timed text.
      if (!isScenarioBenchmark(benchmark)) {
        await execEach(runner, benchmark.setup, signal);
      }
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
      if (!isScenarioBenchmark(benchmark)) {
        await execEach(runner, benchmark.teardown, signal);
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
