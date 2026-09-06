/**
 * The bench lane's command line, without a browser: which Suites it will run, and what it refuses.
 *
 * Cheap to assert and worth asserting: `--suite` is how a run is narrowed, and a Suite the parser
 * does not know about is a Suite nobody can ask for.
 */

import { describe, expect, test } from "bun:test";

import { DEFAULT_BENCH_OPTIONS, parseBenchArguments } from "./bench";

describe("parseBenchArguments", () => {
  test("runs all three Suites by default, in page order", () => {
    expect(DEFAULT_BENCH_OPTIONS.suites).toEqual(["speedtest", "rtt", "concurrency"]);
    expect(parseBenchArguments([]).options.suites).toBeUndefined();
  });

  test("accepts --suite concurrency, on its own and beside the others", () => {
    expect(parseBenchArguments(["--suite", "concurrency"]).options.suites).toEqual(["concurrency"]);
    expect(parseBenchArguments(["--suite", "rtt", "--suite", "concurrency"]).options.suites).toEqual([
      "rtt",
      "concurrency",
    ]);
    expect(parseBenchArguments(["--suite=concurrency"]).options.suites).toEqual(["concurrency"]);
  });

  test("refuses a Suite that does not exist, naming the ones that do", () => {
    expect(() => parseBenchArguments(["--suite", "concurrent"])).toThrow("concurrency");
  });

  // The default has to cover the run the default flags ask for: three Suites against fourteen
  // Configurations, five of which seed a whole data directory into a cold store first.
  test("allows the whole default run inside the default deadline", () => {
    expect(DEFAULT_BENCH_OPTIONS.timeoutMs).toBeGreaterThanOrEqual(2_400_000);
    expect(parseBenchArguments(["--timeout", "900000"]).options.timeoutMs).toBe(900_000);
  });
});
