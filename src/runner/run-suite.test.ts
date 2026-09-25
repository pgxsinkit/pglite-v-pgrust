import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { findConfiguration } from "../configurations";
import type { Configuration, EngineRunner, Measurement } from "../engines/contract";
import { configurationDialect } from "../engines/contract";
import type { EngineStats } from "../engines/protocol";
import type { ConcurrentScenario, ScenarioReport } from "../engines/scenario";
import { buildConcurrencyBenchmarks, CONCURRENCY_CLIENTS, concurrencySetupFor } from "../suites/concurrency";
import type { PreparedBenchmarkId } from "../suites/prepared/benchmarks";
import {
  PREPARED_BENCHMARK_IDS,
  preparedSetupTexts,
  preparedSqlFileName,
  preparedTeardownTexts,
} from "../suites/prepared/benchmarks";
import { buildPreparedSuite } from "../suites/prepared/suite";
import { RTT_SUITE } from "../suites/rtt";
import { RTT_INITIAL_SETUP_POSTGRES, RTT_STATEMENTS, rttInitialSetupFor } from "../suites/rtt/statements";
import { SPEEDTEST_BENCHMARK_IDS, speedtestSqlFileName } from "../suites/speedtest/benchmarks";
import type { Benchmark, StatementBenchmark, Suite } from "../suites/types";
import { benchmarkSql, isScenarioBenchmark } from "../suites/types";
import { WARMUP_LABEL, WARMUP_SCRIPT_NAME } from "../suites/warmup";
import type { BenchmarkResult, WarmupResult } from "./run-suite";
import { planRun, runSuite } from "./run-suite";

function configuration(id: string): Configuration {
  const found = findConfiguration(id);
  if (found === undefined) {
    throw new Error(`unknown Configuration "${id}"`);
  }
  return found;
}

/** Exactly what a Run does: the Suite's setup in the Engine's dialect, through the plan. */
function planFor(suite: Suite, id: string): ReturnType<typeof planRun> {
  const config = configuration(id);
  return planRun(suite, config, suite.initialSetupFor(configurationDialect(config)));
}

const UNLOGGED_CONFIGURATION_IDS: readonly string[] = ["pglite-memory-unlogged", "pgrust-memory-unlogged"];

describe("planRun, the RTT Suite", () => {
  for (const id of UNLOGGED_CONFIGURATION_IDS) {
    test(`${id}: creates both tables UNLOGGED in the untimed setup`, () => {
      const plan = planFor(RTT_SUITE, id);
      expect(plan.setupSql).toContain("CREATE UNLOGGED TABLE t1 (id SERIAL PRIMARY KEY NOT NULL, a INTEGER);");
      expect(plan.setupSql).toContain("CREATE UNLOGGED TABLE t2 (id SERIAL PRIMARY KEY NOT NULL, a TEXT);");
      // The whole point of the column: not one table is left logged.
      expect(plan.setupSql.match(/CREATE UNLOGGED TABLE/g)).toHaveLength(2);
      expect(plan.setupSql).not.toMatch(/(?<!UNLOGGED )CREATE TABLE/);
    });

    test(`${id}: leaves the twelve timed statements exactly as the Baseline runs them`, () => {
      // The rewrite is DDL-only: rewriting a Benchmark would make the column measure different SQL.
      expect(planFor(RTT_SUITE, id).benchmarks.map(benchmarkSql)).toEqual([...RTT_STATEMENTS]);
    });
  }

  test("leaves the setup alone for a Configuration without a rewrite", () => {
    for (const id of ["pglite-memory", "pgrust-memory"]) {
      expect(planFor(RTT_SUITE, id).setupSql).toBe(RTT_INITIAL_SETUP_POSTGRES);
    }
  });

  test("hands wa-sqlite its own dialect's setup, unrewritten in both Configurations", () => {
    for (const id of ["wasqlite-memory", "wasqlite-memory-journal-off"]) {
      const plan = planFor(RTT_SUITE, id);
      expect(plan.setupSql).toBe(RTT_SUITE.initialSetupFor("sqlite"));
      expect(plan.setupSql).not.toContain("UNLOGGED");
      expect(plan.benchmarks.map(benchmarkSql)).toEqual([...RTT_STATEMENTS]);
    }
  });

  test("keeps every Benchmark's id and label, whatever the rewrite does to its SQL", () => {
    const plan = planFor(RTT_SUITE, "pglite-memory-unlogged");
    expect(plan.benchmarks.map((benchmark) => benchmark.id)).toEqual(
      RTT_SUITE.benchmarks.map((benchmark) => benchmark.id),
    );
    expect(plan.benchmarks.map((benchmark) => benchmark.label)).toEqual(
      RTT_SUITE.benchmarks.map((benchmark) => benchmark.label),
    );
  });
});

/** The stand-in a missing index falls back to, so a failing assertion names the index rather than it. */
const EMPTY_BENCHMARK: Benchmark = { id: "missing", label: "missing", sql: "" };

/**
 * A stand-in for the Speedtest Suite: the real one imports its scripts with `?raw`, which is a
 * bundler feature and cannot be loaded under `bun test`. What matters here is the shape it shares
 * with the Speedtest Suite — an editable preamble supplied by the caller, and DDL in the
 * Benchmarks — not the scripts themselves.
 */
const EDITABLE_SETUP_SUITE: Suite = {
  id: "speedtest",
  title: "Editable-preamble Suite",
  description: "A Suite whose untimed setup comes from the textarea rather than from the Suite.",
  benchmarks: [{ id: "1", label: "creates a table", sql: "CREATE TABLE t (a int);\nINSERT INTO t VALUES (1);" }],
  initialSetupFor: () => "-- Pre-run setup\n",
  editableSetup: true,
  iterations: 1,
  aggregation: "mean",
};

describe("planRun, an editable preamble", () => {
  test("rewrites the preamble the textarea holds, not just the Benchmarks", () => {
    const plan = planRun(EDITABLE_SETUP_SUITE, configuration("pglite-memory-unlogged"), "CREATE TABLE warmup (a int);");
    expect(plan.setupSql).toBe("CREATE UNLOGGED TABLE warmup (a int);");
    expect(benchmarkSql(plan.benchmarks[0] ?? EMPTY_BENCHMARK)).toBe(
      "CREATE UNLOGGED TABLE t (a int);\nINSERT INTO t VALUES (1);",
    );
  });

  test("leaves an unrewritten Configuration's preamble byte-identical", () => {
    const plan = planRun(EDITABLE_SETUP_SUITE, configuration("pglite-memory"), "CREATE TABLE warmup (a int);");
    expect(plan.setupSql).toBe("CREATE TABLE warmup (a int);");
  });
});

/**
 * A stand-in for the Concurrency Suite: one Scenario Benchmark with DDL in it.
 *
 * The real Suite builds 100 000 rows and four Clients; what matters here is the one property a
 * Scenario shares with a Benchmark's SQL — a Configuration's rewrite has to reach every statement in
 * it, or an unlogged column would run the logged column's tables under another name.
 */
const SCENARIO_SUITE: Suite = {
  id: "concurrency",
  title: "Scenario Suite",
  description: "A Suite whose Benchmark is a Scenario rather than a statement.",
  benchmarks: [
    {
      id: "1",
      label: "two clients",
      scenario: {
        id: "two-clients",
        setup: ["SET lock_timeout = '2s'"],
        clients: [
          { steps: [{ transaction: ["CREATE TABLE tx_t (a int)"] }, { signal: "made" }] },
          { steps: [{ untilSignal: "made", sql: "CREATE TABLE reader_t (a int)" }] },
          { session: 1, steps: [{ sql: "SELECT 1" }] },
        ],
      },
      summarize: (report) => ({ elapsedMs: report.totalMs }),
    },
  ],
  initialSetupFor: () => "CREATE TABLE setup_t (a int);",
  editableSetup: false,
  iterations: 1,
  aggregation: "mean",
};

describe("planRun, a Suite of Scenarios", () => {
  test("rewrites every statement of every Client, and the Scenario's setup with them", () => {
    const plan = planRun(SCENARIO_SUITE, configuration("pglite-memory-unlogged"), "");
    const benchmark = plan.benchmarks[0];
    if (benchmark === undefined || !isScenarioBenchmark(benchmark)) {
      throw new Error("the planned Suite lost its Scenario Benchmark");
    }
    expect(benchmark.scenario.clients[0]?.steps[0]).toEqual({ transaction: ["CREATE UNLOGGED TABLE tx_t (a int)"] });
    expect(benchmark.scenario.clients[1]?.steps[0]).toEqual({
      untilSignal: "made",
      sql: "CREATE UNLOGGED TABLE reader_t (a int)",
    });
    expect(benchmark.scenario.setup).toEqual(["SET lock_timeout = '2s'"]);
  });

  test("rewrites the untimed setup of a Suite of Scenarios exactly as it rewrites any other", () => {
    expect(planFor(SCENARIO_SUITE, "pglite-memory-unlogged").setupSql).toBe("CREATE UNLOGGED TABLE setup_t (a int);");
    expect(planFor(SCENARIO_SUITE, "pglite-memory").setupSql).toBe("CREATE TABLE setup_t (a int);");
  });

  // The Engine is opened with as many Sessions as the Scenario's Clients need, and the two
  // single-statement Suites keep asking for the one every Engine has.
  test("opens as many Sessions as the Scenario needs, and one for a Suite of statements", () => {
    expect(planRun(SCENARIO_SUITE, configuration("pgrust-postmaster-memory-broker"), "").sessions).toBe(2);
    expect(planRun(RTT_SUITE, configuration("pgrust-postmaster-memory-broker"), "").sessions).toBe(1);
  });
});

/** The Warm-up as the bundle imports it, read from disk because `?raw` is a bundler feature. */
const WARMUP_SQL = readFileSync(join(import.meta.dir, "../suites", WARMUP_SCRIPT_NAME), "utf8");

/** Every statement of the Warm-up, one per line, comments dropped. */
const WARMUP_STATEMENTS = WARMUP_SQL.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("--"));

/** The Prepared Suite's timed texts, read from disk because `?raw` is a bundler feature. */
const PREPARED_SQL_FROM_DISK = Object.fromEntries(
  PREPARED_BENCHMARK_IDS.map((id) => [
    id,
    readFileSync(join(import.meta.dir, "../suites/prepared", preparedSqlFileName(id)), "utf8"),
  ]),
) as Record<PreparedBenchmarkId, string>;

/** The Prepared Suite as the page runs it, built from those texts. */
const PREPARED_SUITE = buildPreparedSuite(PREPARED_SQL_FROM_DISK);

/** Every SQL string any Suite runs, in both dialects: its setup, its Benchmarks, its Scenarios. */
function everySuiteSql(): string {
  const speedtest = SPEEDTEST_BENCHMARK_IDS.map((id) =>
    readFileSync(join(import.meta.dir, "../suites/speedtest", speedtestSqlFileName(id)), "utf8"),
  );
  const rtt = [rttInitialSetupFor("postgres"), rttInitialSetupFor("sqlite"), ...RTT_STATEMENTS];
  const concurrency = [
    concurrencySetupFor("postgres"),
    concurrencySetupFor("sqlite"),
    JSON.stringify(buildConcurrencyBenchmarks(CONCURRENCY_CLIENTS, "postgres").map((entry) => entry.scenario)),
    JSON.stringify(buildConcurrencyBenchmarks(CONCURRENCY_CLIENTS, "sqlite").map((entry) => entry.scenario)),
  ];
  const prepared = PREPARED_BENCHMARK_IDS.flatMap((id) => [
    ...preparedSetupTexts(id),
    PREPARED_SQL_FROM_DISK[id],
    ...preparedTeardownTexts(id),
  ]);
  return [...speedtest, ...rtt, ...concurrency, ...prepared].join("\n");
}

describe("the Warm-up script", () => {
  test("builds one scratch table, works it, and drops it again", () => {
    const creates = WARMUP_STATEMENTS.filter((statement) => statement.startsWith("CREATE TABLE"));
    expect(creates).toEqual(["CREATE TABLE warmup_scratch(k INTEGER PRIMARY KEY, v INTEGER, t VARCHAR(100));"]);
    expect(WARMUP_STATEMENTS[0]).toBe(creates[0]);
    expect(WARMUP_STATEMENTS.at(-1)).toBe("DROP TABLE warmup_scratch;");
    expect(WARMUP_STATEMENTS.filter((statement) => statement.startsWith("CREATE INDEX"))).toEqual([
      "CREATE INDEX warmup_scratch_v ON warmup_scratch(v);",
    ]);
  });

  test("inserts a few hundred rows one statement at a time, then a few dozen of each indexed kind", () => {
    const count = (prefix: string): number =>
      WARMUP_STATEMENTS.filter((statement) => statement.startsWith(prefix)).length;
    expect(count("INSERT INTO warmup_scratch VALUES(")).toBe(500);
    expect(count("SELECT ")).toBe(36);
    expect(count("UPDATE ")).toBe(36);
    // Thirty-six by key, and the one big DELETE.
    expect(count("DELETE FROM warmup_scratch WHERE k = ")).toBe(36);
    expect(count("DELETE ")).toBe(37);
  });

  // It runs before the setup and beside every Suite, so its table must be one no Suite ever names.
  test("names a table no Suite touches, in either dialect", () => {
    expect(everySuiteSql()).not.toContain("warmup_scratch");
  });

  test("is labelled so that no total over the `| Test` rows can count it", () => {
    expect(WARMUP_LABEL).toBe("Warm-up");
    expect(WARMUP_LABEL.startsWith("Test")).toBe(false);
  });
});

describe("planRun, the Warm-up", () => {
  test("hands every Configuration the same script, through its own rewrite", () => {
    for (const id of ["pglite-memory", "pgrust-postmaster-opfs-repacked-relaxed", "wasqlite-memory"]) {
      expect(planRun(RTT_SUITE, configuration(id), "", WARMUP_SQL).warmupSql).toBe(WARMUP_SQL);
    }
    const unlogged = planRun(RTT_SUITE, configuration("pglite-memory-unlogged"), "", WARMUP_SQL).warmupSql ?? "";
    expect(unlogged).toContain("CREATE UNLOGGED TABLE warmup_scratch(");
    expect(unlogged).not.toMatch(/(?<!UNLOGGED )CREATE TABLE/);
  });

  test("keeps the Warm-up out of the Benchmarks it plans", () => {
    const plan = planRun(RTT_SUITE, configuration("pglite-memory"), "", WARMUP_SQL);
    expect(plan.benchmarks.map(benchmarkSql)).toEqual([...RTT_STATEMENTS]);
  });

  test("plans no Warm-up for a caller that gave none", () => {
    expect(planFor(RTT_SUITE, "pglite-memory").warmupSql).toBeNull();
  });
});

/** An Engine that runs nothing and writes down, in order, everything it was asked. */
class RecordingRunner implements EngineRunner {
  readonly calls: string[] = [];
  #elapsed = 0;

  async open(config: Configuration, preamble: string, sessions = 1): Promise<void> {
    this.calls.push(`open ${config.id} preamble=${JSON.stringify(preamble)} sessions=${sessions}`);
  }

  async exec(sql: string): Promise<void> {
    this.calls.push(`exec ${sql}`);
  }

  async measure(sql: string): Promise<Measurement> {
    this.calls.push(`measure ${sql}`);
    this.#elapsed += 1;
    return { elapsedMs: this.#elapsed };
  }

  async scalar(sql: string): Promise<{ readonly elapsedMs: number; readonly value: string | null }> {
    this.calls.push(`scalar ${sql}`);
    return { elapsedMs: 0, value: null };
  }

  async concurrent(scenario: ConcurrentScenario): Promise<ScenarioReport> {
    this.calls.push(`concurrent ${scenario.id}`);
    return { totalMs: 0, clients: [] };
  }

  async stats(): Promise<EngineStats> {
    this.calls.push("stats");
    return { wasmMemories: [] };
  }

  async close(): Promise<void> {
    this.calls.push("close");
  }
}

describe("runSuite, the Warm-up", () => {
  const TWO_STATEMENTS: Suite = {
    ...EDITABLE_SETUP_SUITE,
    benchmarks: [
      { id: "1", label: "Test 1: one", sql: "SELECT 1;" },
      { id: "2", label: "Test 2: two", sql: "SELECT 2;" },
    ],
  };

  async function run(setupSql: string): Promise<{
    readonly calls: readonly string[];
    readonly warmups: readonly WarmupResult[];
    readonly results: readonly BenchmarkResult[];
  }> {
    const runner = new RecordingRunner();
    const warmups: WarmupResult[] = [];
    const results: BenchmarkResult[] = [];
    await runSuite({
      suite: TWO_STATEMENTS,
      configuration: configuration("pglite-memory"),
      setupSql,
      warmupSql: "-- the warm-up\nSELECT 0;",
      onWarmup: (result) => warmups.push(result),
      onResult: (result) => results.push(result),
      createRunner: () => runner,
    });
    return { calls: runner.calls, warmups, results };
  }

  test("boots the Engine bare, times the Warm-up, then runs the setup untimed, then the Benchmarks", async () => {
    const { calls } = await run("CREATE TABLE t (a int);");
    expect(calls).toEqual([
      'open pglite-memory preamble="" sessions=1',
      "measure -- the warm-up\nSELECT 0;",
      "exec CREATE TABLE t (a int);",
      "measure SELECT 1;",
      "measure SELECT 2;",
      "close",
    ]);
  });

  test("reports the Warm-up once, on its own callback, and never as a Benchmark's result", async () => {
    const { warmups, results } = await run("CREATE TABLE t (a int);");
    expect(warmups).toEqual([{ configurationId: "pglite-memory", elapsedMs: 1 }]);
    expect(results.map((result) => [result.benchmarkId, result.elapsedMs])).toEqual([
      ["1", 2],
      ["2", 3],
    ]);
  });

  test("skips an empty setup, as opening with an empty preamble always did", async () => {
    const { calls } = await run("  \n");
    expect(calls.some((call) => call.startsWith("exec"))).toBe(false);
  });
});

/** A planned Benchmark that the plan must have kept a statement Benchmark. */
function statementBenchmark(benchmark: Benchmark | undefined): StatementBenchmark {
  if (benchmark === undefined || isScenarioBenchmark(benchmark)) {
    throw new Error("expected a statement Benchmark");
  }
  return benchmark;
}

describe("planRun, the Prepared Suite", () => {
  for (const id of UNLOGGED_CONFIGURATION_IDS) {
    test(`${id}: creates every row's tables UNLOGGED in the row's own untimed setup`, () => {
      const plan = planFor(PREPARED_SUITE, id);
      const setups = plan.benchmarks.flatMap((benchmark) => statementBenchmark(benchmark).setup ?? []);
      const creates = setups.join("").match(/CREATE (UNLOGGED )?TABLE/g) ?? [];
      expect(creates).toEqual(["CREATE UNLOGGED TABLE", "CREATE UNLOGGED TABLE", "CREATE UNLOGGED TABLE"]);
      expect(statementBenchmark(plan.benchmarks[0]).setup?.[0]).toBe(
        "CREATE UNLOGGED TABLE t1(a INTEGER, b INTEGER, c VARCHAR(100));\n",
      );
    });

    test(`${id}: leaves the PREPAREs, the EXECUTEs and the DEALLOCATEs exactly as the Baseline runs them`, () => {
      const plan = planFor(PREPARED_SUITE, id);
      const baseline = planFor(PREPARED_SUITE, "pglite-memory");
      plan.benchmarks.forEach((benchmark, index) => {
        const ours = statementBenchmark(benchmark);
        const theirs = statementBenchmark(baseline.benchmarks[index]);
        expect(ours.sql).toBe(theirs.sql);
        expect(ours.setup?.at(-1)).toBe(theirs.setup?.at(-1));
        expect(ours.teardown).toEqual(theirs.teardown);
      });
    });
  }

  test("hands every Postgres Configuration without a rewrite the Suite's own bytes", () => {
    for (const id of ["pglite-memory", "pglite-opfs-repacked-relaxed", "pgrust-postmaster-opfs-repacked-relaxed"]) {
      const plan = planFor(PREPARED_SUITE, id);
      expect(plan.benchmarks).toEqual(PREPARED_SUITE.benchmarks);
      expect(plan.setupSql).toBe("");
      expect(plan.sessions).toBe(1);
    }
  });
});

describe("runSuite, a Benchmark with its own untimed setup and teardown", () => {
  const SETUP_SUITE: Suite = {
    ...EDITABLE_SETUP_SUITE,
    benchmarks: [
      {
        id: "1",
        label: "Test 1: prepared",
        sql: "EXECUTE p(1);",
        setup: ["CREATE TABLE t (a int);", "PREPARE p(int) AS INSERT INTO t VALUES ($1);"],
        teardown: ["DEALLOCATE p;"],
      },
      { id: "2", label: "Test 2: plain", sql: "SELECT 2;" },
    ],
  };

  async function run(configurationId: string): Promise<{
    readonly calls: readonly string[];
    readonly results: readonly BenchmarkResult[];
  }> {
    const runner = new RecordingRunner();
    const results: BenchmarkResult[] = [];
    await runSuite({
      suite: SETUP_SUITE,
      configuration: configuration(configurationId),
      setupSql: "-- setup",
      warmupSql: "SELECT 0;",
      onWarmup: () => undefined,
      onResult: (result) => results.push(result),
      createRunner: () => runner,
    });
    return { calls: runner.calls, results };
  }

  test("sends each setup text untimed and alone just before the Benchmark, and its teardown just after", async () => {
    const { calls } = await run("pglite-memory");
    expect(calls).toEqual([
      'open pglite-memory preamble="" sessions=1',
      "measure SELECT 0;",
      "exec -- setup",
      "exec CREATE TABLE t (a int);",
      "exec PREPARE p(int) AS INSERT INTO t VALUES ($1);",
      "measure EXECUTE p(1);",
      "exec DEALLOCATE p;",
      "measure SELECT 2;",
      "close",
    ]);
  });

  test("times only the Benchmark's own text", async () => {
    const { results } = await run("pglite-memory");
    expect(results.map((result) => [result.benchmarkId, result.elapsedMs])).toEqual([
      ["1", 2],
      ["2", 3],
    ]);
  });

  test("rewrites a row's setup for an unlogged Configuration, as it rewrites everything else", async () => {
    const { calls } = await run("pgrust-memory-unlogged");
    expect(calls).toContain("exec CREATE UNLOGGED TABLE t (a int);");
  });
});

describe("runSuite, a Suite that does not run on an Engine", () => {
  test("refuses the Prepared Suite on wa-sqlite before it opens anything, and says why", async () => {
    const runner = new RecordingRunner();
    let refusal: unknown = null;
    try {
      await runSuite({
        suite: PREPARED_SUITE,
        configuration: configuration("wasqlite-memory"),
        setupSql: "",
        warmupSql: "SELECT 0;",
        onWarmup: () => undefined,
        onResult: () => undefined,
        createRunner: () => runner,
      });
    } catch (thrown) {
      refusal = thrown;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect(String(refusal)).toContain("Prepared Suite does not run on wa-sqlite Memory");
    expect(runner.calls).toEqual([]);
  });
});
