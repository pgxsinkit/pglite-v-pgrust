/**
 * The bench lane's command line, without a browser: which Suites it will run, and what it refuses.
 *
 * Cheap to assert and worth asserting: `--suite` is how a run is narrowed, and a Suite the parser
 * does not know about is a Suite nobody can ask for.
 */

import { describe, expect, test } from "bun:test";

import { CONFIGURATION_IDS } from "../src/configurations";
import { cellKey } from "../src/results/grid";
import { toMarkdown } from "../src/results/markdown";
import { SUITES } from "../src/suites";
import { WARMUP_EXPORT_LINE, WARMUP_LABEL } from "../src/suites/warmup";
import type { BenchReport } from "./bench";
import { DEFAULT_BENCH_OPTIONS, parseBenchArguments, renderResultsFile } from "./bench";

describe("parseBenchArguments", () => {
  test("runs all four Suites by default, in page order", () => {
    expect(DEFAULT_BENCH_OPTIONS.suites).toEqual(["speedtest", "rtt", "concurrency", "prepared"]);
    expect(DEFAULT_BENCH_OPTIONS.suites).toEqual(SUITES.map((suite) => suite.id));
    expect(parseBenchArguments([]).options.suites).toBeUndefined();
  });

  test("accepts --suite prepared, on its own and beside the Speedtest", () => {
    expect(parseBenchArguments(["--suite", "prepared"]).options.suites).toEqual(["prepared"]);
    expect(parseBenchArguments(["--suite=speedtest", "--suite", "prepared"]).options.suites).toEqual([
      "speedtest",
      "prepared",
    ]);
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
    expect(() => parseBenchArguments(["--suite", "prepare"])).toThrow("prepared");
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

  test("passes an alternate pgrust threads module through, and refuses an id that cannot be one", () => {
    expect(DEFAULT_BENCH_OPTIONS.pgrustModule).toBeNull();
    expect(parseBenchArguments([]).options.pgrustModule).toBeUndefined();
    expect(parseBenchArguments(["--pgrust-module", "3624f82c"]).options.pgrustModule).toBe("3624f82c");
    expect(parseBenchArguments(["--pgrust-module=3624F82C"]).options.pgrustModule).toBe("3624f82c");
    expect(() => parseBenchArguments(["--pgrust-module", "pgrust-assets/3624f82c"])).toThrow("pgrust-assets/3624f82c");
    expect(() => parseBenchArguments(["--pgrust-module", "latest"])).toThrow("--pgrust-module");
    expect(() => parseBenchArguments(["--pgrust-module"])).toThrow("--pgrust-module needs a value");
  });

  test("passes the two store-seam switches through, both off by default", () => {
    expect(DEFAULT_BENCH_OPTIONS.brokerStats).toBe(false);
    expect(DEFAULT_BENCH_OPTIONS.brokerGather).toBe(false);
    expect(parseBenchArguments([]).options.brokerStats).toBeUndefined();
    expect(parseBenchArguments([]).options.brokerGather).toBeUndefined();
    expect(parseBenchArguments(["--broker-stats"]).options.brokerStats).toBe(true);
    expect(parseBenchArguments(["--broker-gather"]).options.brokerGather).toBe(true);
    const both = parseBenchArguments(["--broker-stats", "--broker-gather"]).options;
    expect([both.brokerStats, both.brokerGather]).toEqual([true, true]);
  });

  test("passes a broker spin and the store levers through, neither on the URL by default", () => {
    expect(DEFAULT_BENCH_OPTIONS.brokerSpinUs).toBeNull();
    expect(DEFAULT_BENCH_OPTIONS.storeLevers).toEqual([]);
    expect(parseBenchArguments([]).options.brokerSpinUs).toBeUndefined();
    expect(parseBenchArguments([]).options.storeLevers).toBeUndefined();
    for (const spinUs of [0, 50, 200, 1000]) {
      expect(parseBenchArguments(["--broker-spin", String(spinUs)]).options.brokerSpinUs).toBe(spinUs);
    }
    expect(parseBenchArguments(["--broker-spin=50"]).options.brokerSpinUs).toBe(50);
    for (const bad of ["-5", "1001", "fast", "50.5"]) {
      expect(() => parseBenchArguments(["--broker-spin", bad])).toThrow("--broker-spin expects a whole number");
    }
    expect(() => parseBenchArguments(["--broker-spin"])).toThrow("--broker-spin needs a value");
    expect(parseBenchArguments(["--store-levers", "coalesce,grow"]).options.storeLevers).toEqual(["grow", "coalesce"]);
    expect(parseBenchArguments(["--store-levers", "grow"]).options.storeLevers).toEqual(["grow"]);
    for (const bad of ["zeroskip", "grow,metacoalesce", ","]) {
      expect(() => parseBenchArguments(["--store-levers", bad])).toThrow("--store-levers expects");
    }
  });

  // Since 2026-09-24 the lane's OPFS is on disk; the off-the-record lane every older OPFS number was
  // taken in is only ever asked for by name.
  test("runs in a persistent context by default, and the ephemeral one only by name", () => {
    expect(DEFAULT_BENCH_OPTIONS.contextKind).toBe("persistent");
    expect(DEFAULT_BENCH_OPTIONS.keepProfile).toBe(false);
    expect(parseBenchArguments([]).options.contextKind).toBeUndefined();
    expect(parseBenchArguments(["--ephemeral-context"]).options.contextKind).toBe("ephemeral");
    expect(parseBenchArguments(["--keep-profile"]).options.keepProfile).toBe(true);
    expect(() => parseBenchArguments(["--ephemeral-context", "--keep-profile"])).toThrow("--keep-profile");
  });

  // The default has to cover the run the default flags ask for: four Suites against fourteen
  // Configurations, five of which seed a whole data directory into a cold store first.
  test("allows the whole default run inside the default deadline", () => {
    expect(DEFAULT_BENCH_OPTIONS.timeoutMs).toBeGreaterThanOrEqual(2_400_000);
    expect(parseBenchArguments(["--timeout", "900000"]).options.timeoutMs).toBe(900_000);
  });
});

describe("renderResultsFile", () => {
  // The page's export, as the lane reads it off the page: a Warm-up line above the table and the
  // Warm-up as its first row.
  const markdown = toMarkdown(
    {
      rows: [{ id: "1", label: "Test 1: 1000 INSERTs" }],
      columns: [{ id: "pglite-memory", label: "PGlite Memory", available: true }],
      baselineColumnId: "pglite-memory",
      cells: { [cellKey("pglite-memory", "1")]: 60 },
      warmup: { label: WARMUP_LABEL, cells: { "pglite-memory": 45 } },
    },
    {
      title: "Speedtest Suite",
      environmentLine: "environment",
      baselineLabel: "PGlite Memory",
      warmupLine: WARMUP_EXPORT_LINE,
    },
  );
  const report: BenchReport = {
    browser: "chromium",
    contextKind: "persistent",
    keptProfileDir: null,
    skipped: false,
    reason: null,
    environmentLine: "environment",
    suites: [{ suiteId: "speedtest", markdown, failures: "" }],
    outputPath: null,
    consoleErrors: [],
  };

  test("carries each Suite's Warm-up line and row, and keeps it out of the `| Test` rows", () => {
    const written = renderResultsFile(report, "2026-09-25T00:00:00.000Z");
    expect(written).toContain(WARMUP_EXPORT_LINE);
    expect(written).toContain("| Warm-up | 45.000 |");
    expect(written.split("\n").filter((line) => line.startsWith("| Test"))).toEqual([
      "| Test 1: 1000 INSERTs | 60.000 |",
    ]);
  });
});
