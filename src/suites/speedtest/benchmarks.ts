// Based on wa-sqlite's benchmarks.
// Copyright 2021 Roy T. Hashimoto. All Rights Reserved.
// Modified by the PGLite authors.
// Ported by pglite-v-pgrust.

/**
 * The Speedtest Suite's Benchmark ids and labels, kept free of the `?raw` SQL imports so the shape of
 * the Suite is unit-testable outside a bundler.
 */

/** The 16 SQL scripts, in the order PGlite runs them. */
export const SPEEDTEST_BENCHMARK_IDS = [
  "1",
  "2",
  "2.1",
  "3",
  "3.1",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
] as const;

export type SpeedtestBenchmarkId = (typeof SPEEDTEST_BENCHMARK_IDS)[number];

/** The human-readable descriptions PGlite's benchmark page uses for each script. */
export const SPEEDTEST_BENCHMARK_LABELS: Readonly<Record<SpeedtestBenchmarkId, string>> = {
  "1": "Test 1: 1000 INSERTs",
  "2": "Test 2: 25000 INSERTs in a transaction",
  "2.1": "Test 2.1: 25000 INSERTs in single statement",
  "3": "Test 3: 25000 INSERTs into an indexed table",
  "3.1": "Test 3.1: 25000 INSERTs into an indexed table in single statement",
  "4": "Test 4: 100 SELECTs without an index",
  "5": "Test 5: 100 SELECTs on a string comparison",
  "6": "Test 6: Creating an index",
  "7": "Test 7: 5000 SELECTs with an index",
  "8": "Test 8: 1000 UPDATEs without an index",
  "9": "Test 9: 25000 UPDATEs with an index",
  "10": "Test 10: 25000 text UPDATEs with an index",
  "11": "Test 11: INSERTs from a SELECT",
  "12": "Test 12: DELETE without an index",
  "13": "Test 13: DELETE with an index",
  "14": "Test 14: A big INSERT after a big DELETE",
  "15": "Test 15: A big DELETE followed by many small INSERTs",
  "16": "Test 16: DROP TABLE",
};

/** The default preamble offered in the UI, matching PGlite's benchmark page. */
export const SPEEDTEST_DEFAULT_PREAMBLE = "-- Pre-run setup\n";

/** The file each Benchmark's SQL is read from, relative to this directory. */
export function speedtestSqlFileName(id: SpeedtestBenchmarkId): string {
  return `benchmark${id}.sql`;
}
