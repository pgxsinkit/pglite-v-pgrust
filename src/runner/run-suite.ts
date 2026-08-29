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
import type { Suite } from "../suites/types";

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
  const runner = createEngineRunner(configuration.engine);
  try {
    await runner.open(configuration, setupSql);
    for (const benchmark of suite.benchmarks) {
      assertNotAborted(signal);
      const sql = applyModSql(configuration, benchmark.sql);
      const measurements: Measurement[] = [];
      for (let iteration = 0; iteration < suite.iterations; iteration += 1) {
        assertNotAborted(signal);
        measurements.push(await runner.measure(sql));
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
