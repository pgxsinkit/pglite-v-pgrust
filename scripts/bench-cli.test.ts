/**
 * The bench lane's command line, without a browser: which Suites it will run, and what it refuses.
 *
 * Cheap to assert and worth asserting: `--suite` is how a run is narrowed, and a Suite the parser
 * does not know about is a Suite nobody can ask for.
 */

import { describe, expect, test } from "bun:test";

import { CONFIGURATION_IDS } from "../src/configurations";
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

  test("narrows the Configurations and names the Baseline, defaulting to neither", () => {
    expect(DEFAULT_BENCH_OPTIONS.configurationIds).toBeNull();
    expect(DEFAULT_BENCH_OPTIONS.baselineId).toBeNull();
    expect(parseBenchArguments(["--configurations", "pglite-memory,pgrust-memory"]).options.configurationIds).toEqual([
      "pglite-memory",
      "pgrust-memory",
    ]);
    expect(parseBenchArguments(["--baseline=pgrust-memory"]).options.baselineId).toBe("pgrust-memory");
  });

  test("refuses an id that names no Configuration, and a Baseline outside the selection", () => {
    expect(() => parseBenchArguments(["--configurations", "pglite-memry"])).toThrow(CONFIGURATION_IDS.join(", "));
    expect(() => parseBenchArguments(["--configurations", "pglite-memory", "--baseline", "pgrust-memory"])).toThrow(
      "pgrust-memory",
    );
  });

  test("passes pgrust Postmaster tuning through, and refuses an entry the page would drop", () => {
    expect(DEFAULT_BENCH_OPTIONS.postmasterTuning).toBeNull();
    expect(parseBenchArguments(["--postmaster-tuning", "fsync=off, wal_buffers=4MB"]).options.postmasterTuning).toBe(
      "fsync=off,wal_buffers=4MB",
    );
    expect(parseBenchArguments(["--postmaster-tuning=pool:8,shared_buffers=64MB"]).options.postmasterTuning).toBe(
      "pool:8,shared_buffers=64MB",
    );
    expect(() => parseBenchArguments(["--postmaster-tuning", "fsync=off,Shared-Buffers=64MB"])).toThrow(
      "Shared-Buffers=64MB",
    );
    expect(() => parseBenchArguments(["--postmaster-tuning", "pool:0"])).toThrow("pool:0");
  });

  // The default has to cover the run the default flags ask for: three Suites against fourteen
  // Configurations, five of which seed a whole data directory into a cold store first.
  test("allows the whole default run inside the default deadline", () => {
    expect(DEFAULT_BENCH_OPTIONS.timeoutMs).toBeGreaterThanOrEqual(2_400_000);
    expect(parseBenchArguments(["--timeout", "900000"]).options.timeoutMs).toBe(900_000);
  });
});
