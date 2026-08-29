import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SPEEDTEST_BENCHMARK_IDS, SPEEDTEST_BENCHMARK_LABELS, speedtestSqlFileName } from "./benchmarks";

/**
 * PGlite's own copies, used as the byte-equality oracle. Absent on most machines, in which case the
 * provenance test skips rather than fails; override with `PGLITE_BENCHMARK_SRC` to point elsewhere.
 */
const PGLITE_BENCHMARK_SRC =
  process.env["PGLITE_BENCHMARK_SRC"] ?? "/home/anton/dev/pgxsinkit/pglite/packages/benchmark/src";

describe("Speedtest Suite definition", () => {
  test("keeps PGlite's Benchmark order, including the 2.1 and 3.1 variants", () => {
    expect([...SPEEDTEST_BENCHMARK_IDS]).toEqual([
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
    ]);
  });

  test("covers the 16 SQL scripts plus the two single-statement variants", () => {
    expect(SPEEDTEST_BENCHMARK_IDS).toHaveLength(18);
    expect(SPEEDTEST_BENCHMARK_IDS.filter((id) => id.includes("."))).toEqual(["2.1", "3.1"]);
  });

  test("labels every Benchmark with PGlite's description", () => {
    for (const id of SPEEDTEST_BENCHMARK_IDS) {
      expect(SPEEDTEST_BENCHMARK_LABELS[id]).toStartWith(`Test ${id}: `);
    }
    expect(SPEEDTEST_BENCHMARK_LABELS["1"]).toBe("Test 1: 1000 INSERTs");
    expect(SPEEDTEST_BENCHMARK_LABELS["2.1"]).toBe("Test 2.1: 25000 INSERTs in single statement");
    expect(SPEEDTEST_BENCHMARK_LABELS["16"]).toBe("Test 16: DROP TABLE");
  });

  test("ships one SQL file per Benchmark", () => {
    for (const id of SPEEDTEST_BENCHMARK_IDS) {
      expect(existsSync(join(import.meta.dir, speedtestSqlFileName(id)))).toBe(true);
    }
  });
});

describe("Speedtest Suite SQL provenance", () => {
  const oracleAvailable = existsSync(PGLITE_BENCHMARK_SRC);

  test.skipIf(!oracleAvailable)("every .sql file is byte-identical to PGlite's copy", () => {
    for (const id of SPEEDTEST_BENCHMARK_IDS) {
      const fileName = speedtestSqlFileName(id);
      const ours = readFileSync(join(import.meta.dir, fileName));
      const theirs = readFileSync(join(PGLITE_BENCHMARK_SRC, fileName));
      expect({ fileName, equal: ours.equals(theirs) }).toEqual({ fileName, equal: true });
    }
  });
});
