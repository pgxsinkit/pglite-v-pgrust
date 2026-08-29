// Based on wa-sqlite's benchmarks.
// Copyright 2021 Roy T. Hashimoto. All Rights Reserved.
// Modified by the PGLite authors.
// Ported by pglite-v-pgrust.

import type { Benchmark, Suite } from "../types";
import { RTT_BENCHMARK_LABELS, RTT_INITIAL_SETUP, RTT_ITERATIONS, RTT_STATEMENTS } from "./statements";

export function buildRttBenchmarks(): readonly Benchmark[] {
  return RTT_STATEMENTS.map((sql, index) => ({
    id: String(index + 1),
    label: RTT_BENCHMARK_LABELS[index] ?? `Test ${index + 1}`,
    sql,
  }));
}

/** Twelve single-statement CRUD queries, each executed many times; reports the mean per statement. */
export const RTT_SUITE: Suite = {
  id: "rtt",
  title: "RTT Suite",
  description: `Twelve single-statement CRUD queries, ${RTT_ITERATIONS} iterations each, top and bottom 10% of Measurements discarded, mean of the rest.`,
  benchmarks: buildRttBenchmarks(),
  defaultSetupSql: RTT_INITIAL_SETUP,
  editableSetup: false,
  iterations: RTT_ITERATIONS,
  aggregation: "trimmed-mean",
};
