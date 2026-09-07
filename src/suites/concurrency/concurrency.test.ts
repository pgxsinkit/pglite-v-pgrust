import { describe, expect, test } from "bun:test";

import type { EngineId, SqlDialect } from "../../engines/contract";
import { isSignalStep, isTransactionStep, isUntilSignalStep, scenarioSessions } from "../../engines/scenario";
import { isScenarioBenchmark, suiteSessions } from "../types";
import type { Benchmark, ScenarioBenchmark } from "../types";
import {
  buildConcurrencyBenchmarks,
  buildConcurrencySuite,
  BUSY_TIMEOUT_MS,
  CONCURRENCY_CLIENTS,
  CONCURRENCY_ROWS,
  CONCURRENCY_SETUP_SQL,
  CONCURRENCY_SETUP_SQL_SQLITE,
  CONCURRENCY_SUITE,
  INTERLEAVED_ON_ONE_SESSION,
  LOCK_TIMEOUT,
  LOCK_TIMEOUT_SQLSTATE,
  ONE_BACKEND_PER_CLIENT,
  READ_FANOUT_STATEMENTS,
  SQLITE_BUSY_CODE,
  WRITE_TRANSACTIONS,
} from "./index";
import { createRandom } from "./random";

function scenarioBenchmark(benchmarks: readonly Benchmark[], id: string): ScenarioBenchmark {
  const found = benchmarks.find((candidate) => candidate.id === id);
  if (found === undefined || !isScenarioBenchmark(found)) {
    throw new Error(`the Concurrency Suite has no Scenario Benchmark "${id}"`);
  }
  return found;
}

function benchmark(id: string): ScenarioBenchmark {
  return scenarioBenchmark(CONCURRENCY_SUITE.benchmarks, id);
}

/** The same Benchmark as a SQLite Engine is handed it. */
function sqliteBenchmark(id: string): ScenarioBenchmark {
  const benchmarks = CONCURRENCY_SUITE.benchmarksFor?.("sqlite");
  if (benchmarks === undefined) {
    throw new Error("the Concurrency Suite no longer spells its Benchmarks per dialect");
  }
  return scenarioBenchmark(benchmarks, id);
}

describe("the Concurrency Suite", () => {
  test("is five Benchmarks, every one of them a Scenario", () => {
    expect(CONCURRENCY_SUITE.id).toBe("concurrency");
    expect(CONCURRENCY_SUITE.benchmarks).toHaveLength(5);
    expect(CONCURRENCY_SUITE.benchmarks.every(isScenarioBenchmark)).toBe(true);
    expect(CONCURRENCY_SUITE.iterations).toBe(1);
  });

  // The Suite opens exactly as many Sessions as its greediest Scenario needs; the postmaster creates
  // that many pipe pairs before its guest starts, so a Client without a Session could never run.
  test("needs one Session per Client, and says so through the Scenarios themselves", () => {
    expect(suiteSessions(CONCURRENCY_SUITE)).toBe(CONCURRENCY_CLIENTS);
    for (const id of ["1", "4", "5"]) {
      expect(scenarioSessions(benchmark(id).scenario)).toBe(CONCURRENCY_CLIENTS);
    }
  });

  test("builds its dataset in the untimed setup: one indexed table and one contended row", () => {
    expect(CONCURRENCY_SETUP_SQL).toContain(`CREATE TABLE concurrency_rows`);
    expect(CONCURRENCY_SETUP_SQL).toContain(`generate_series(1, ${CONCURRENCY_ROWS})`);
    expect(CONCURRENCY_SETUP_SQL).toContain("CREATE INDEX concurrency_rows_v");
    expect(CONCURRENCY_SETUP_SQL).toContain("CREATE TABLE concurrency_contended");
    // The payload is 100 bytes and differs per row, so the full scan really has to read all of it.
    expect(CONCURRENCY_SETUP_SQL).toContain("rpad(md5(g::text), 100, 'x')");
    expect(CONCURRENCY_SUITE.initialSetupFor("postgres")).toBe(CONCURRENCY_SETUP_SQL);
  });

  // The same dataset, in the only other dialect anything here speaks. Not a rewrite of the Postgres
  // spelling: `generate_series`, `md5` and `rpad` are three functions SQLite does not have.
  test("builds the same dataset for a SQLite Engine, in SQLite's own spelling", () => {
    expect(CONCURRENCY_SUITE.initialSetupFor("sqlite")).toBe(CONCURRENCY_SETUP_SQL_SQLITE);
    expect(CONCURRENCY_SETUP_SQL_SQLITE).toContain("CREATE TABLE concurrency_rows");
    expect(CONCURRENCY_SETUP_SQL_SQLITE).toContain(`WHERE x < ${CONCURRENCY_ROWS}`);
    expect(CONCURRENCY_SETUP_SQL_SQLITE).toContain("CREATE INDEX concurrency_rows_v");
    expect(CONCURRENCY_SETUP_SQL_SQLITE).toContain("CREATE TABLE concurrency_contended");
    // 100 bytes, distinct per row, and containing neither pattern anything searches for.
    expect(CONCURRENCY_SETUP_SQL_SQLITE).toContain("substr(hex(x) || '");
    expect(CONCURRENCY_SETUP_SQL_SQLITE).toContain(", 1, 100)");
    expect(CONCURRENCY_SETUP_SQL_SQLITE).not.toContain("generate_series");
    expect(CONCURRENCY_SETUP_SQL_SQLITE).not.toContain("md5");
  });

  // The Suite refuses no Engine: what differs between columns is the kind of concurrency they had,
  // and that is stated rather than used as grounds for an empty cell.
  test("names every Engine's concurrency mode instead of refusing any of them", () => {
    const modes: Readonly<Record<EngineId, string>> = {
      pglite: INTERLEAVED_ON_ONE_SESSION,
      pgrust: INTERLEAVED_ON_ONE_SESSION,
      "pgrust-threads": INTERLEAVED_ON_ONE_SESSION,
      "pgrust-postmaster": ONE_BACKEND_PER_CLIENT,
      wasqlite: INTERLEAVED_ON_ONE_SESSION,
    };
    for (const [engine, mode] of Object.entries(modes)) {
      expect(CONCURRENCY_SUITE.columnNoteFor?.(engine as EngineId)).toBe(mode);
    }
  });

  test("records the Client count in the line the export carries", () => {
    expect(CONCURRENCY_SUITE.headerLine).toBe(`Concurrency clients: ${CONCURRENCY_CLIENTS}`);
    expect(buildConcurrencySuite(6, false).headerLine).toBe("Concurrency clients: 6 (non-standard)");
    expect(buildConcurrencySuite(6, false).benchmarks).toHaveLength(5);
    expect(suiteSessions(buildConcurrencySuite(6, false))).toBe(6);
  });
});

describe("the five Scenarios", () => {
  test("read fan-out: every Client runs its own point SELECTs and nothing else", () => {
    const scenario = benchmark("1").scenario;
    expect(scenario.clients).toHaveLength(CONCURRENCY_CLIENTS);
    for (const client of scenario.clients) {
      expect(client.steps).toHaveLength(READ_FANOUT_STATEMENTS);
      expect(client.steps.every((step) => "sql" in step && step.sql.startsWith("SELECT v, payload"))).toBe(true);
    }
  });

  test("reader under a bulk write: one writer's transaction and a Signal, readers looping on it", () => {
    const scenario = benchmark("2").scenario;
    const writer = scenario.clients[0];
    expect(writer?.steps.map((step) => isTransactionStep(step))).toEqual([true, false]);
    expect(writer?.steps.map((step) => isSignalStep(step))).toEqual([false, true]);
    for (const reader of scenario.clients.slice(1)) {
      expect(reader.steps.map((step) => isUntilSignalStep(step))).toEqual([true]);
    }
  });

  test("short queries beside a long one: the long one is a full scan with a string comparison", () => {
    const scenario = benchmark("3").scenario;
    const long = scenario.clients[0]?.steps[0];
    expect(long).toBeDefined();
    expect(long && "sql" in long ? long.sql : "").toContain("payload ~ ");
    expect(long && "sql" in long ? long.sql : "").toContain("count(*)");
  });

  // SQLite has no `~` and its GLOB gives up on the first character, so the same scan would finish in
  // milliseconds and the row would be short queries beside a short one. The CTE spends the time the
  // Benchmark needs the long Client to spend, and the Detail reports what it actually took.
  test("short queries beside a long one: SQLite spends the same time in a recursive CTE", () => {
    const long = sqliteBenchmark("3").scenario.clients[0]?.steps[0];
    const sql = long && "sql" in long ? long.sql : "";
    expect(sql).toContain("WITH RECURSIVE spin(i, h)");
    expect(sql).toContain("count(*)");
    expect(sql).not.toContain("payload ~ ");
  });

  // Disjoint means disjoint: two Clients that shared a key would be the same-row Benchmark under
  // another name, and the row would measure contention it claims not to have.
  test("writers on disjoint rows: each Client updates only keys in its own quarter of the table", () => {
    const scenario = benchmark("4").scenario;
    const size = Math.floor(CONCURRENCY_ROWS / CONCURRENCY_CLIENTS);
    scenario.clients.forEach((client, index) => {
      expect(client.steps).toHaveLength(WRITE_TRANSACTIONS);
      for (const step of client.steps) {
        expect(isTransactionStep(step)).toBe(true);
        const sql = isTransactionStep(step) ? (step.transaction[0] ?? "") : "";
        const key = Number(/WHERE k = (\d+)/.exec(sql)?.[1] ?? "0");
        expect(key).toBeGreaterThanOrEqual(index * size + 1);
        expect(key).toBeLessThanOrEqual((index + 1) * size);
      }
    });
  });

  test("writers on the same row: one row, a lock timeout per Session, and 55P03 tolerated", () => {
    const scenario = benchmark("5").scenario;
    expect(scenario.setup).toEqual([`SET lock_timeout = '${LOCK_TIMEOUT}'`]);
    expect(scenario.tolerate).toEqual([LOCK_TIMEOUT_SQLSTATE]);
    for (const client of scenario.clients) {
      expect(client.steps).toHaveLength(WRITE_TRANSACTIONS);
      expect(client.steps[0]).toEqual({ transaction: ["UPDATE concurrency_contended SET v = v + 1 WHERE id = 1"] });
    }
  });

  // The same wait and the same tolerated outcome, in SQLite's spelling: `busy_timeout` takes
  // milliseconds and gives up with SQLITE_BUSY. The UPDATE itself is dialect-neutral and unchanged.
  test("writers on the same row: SQLite waits with busy_timeout and tolerates SQLITE_BUSY", () => {
    const scenario = sqliteBenchmark("5").scenario;
    expect(scenario.setup).toEqual([`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`]);
    expect(scenario.tolerate).toEqual([SQLITE_BUSY_CODE]);
    expect(scenario.clients[0]?.steps[0]).toEqual({
      transaction: ["UPDATE concurrency_contended SET v = v + 1 WHERE id = 1"],
    });
  });
});

describe("the key sequence", () => {
  // Every Engine has to be asked the same questions in the same order, or the columns compare
  // nothing. The seed is fixed, so building the Suite twice builds the same statements.
  test("is deterministic: two builds produce byte-identical Scenarios", () => {
    expect(JSON.stringify(buildConcurrencyBenchmarks(CONCURRENCY_CLIENTS).map((entry) => entry.scenario))).toBe(
      JSON.stringify(buildConcurrencyBenchmarks(CONCURRENCY_CLIENTS).map((entry) => entry.scenario)),
    );
  });

  // Both dialects draw from the same seed in the same order, so the two spellings read and update
  // exactly the same rows. A column whose keys differed would be answering another question.
  test("is the same in both dialects: only the SQL that has to differ does", () => {
    const dialects: readonly SqlDialect[] = ["postgres", "sqlite"];
    const keysOf = (dialect: SqlDialect): readonly string[] =>
      buildConcurrencyBenchmarks(CONCURRENCY_CLIENTS, dialect)
        .flatMap((entry) => entry.scenario.clients)
        .flatMap((client) => client.steps)
        .flatMap((step) =>
          Array.from(String("sql" in step ? step.sql : "").matchAll(/WHERE k = (\d+)/g), (m) => m[1] ?? ""),
        )
        .filter((key) => key !== "");
    const [postgres, sqlite] = dialects.map(keysOf);
    expect(postgres?.length).toBeGreaterThan(0);
    expect(sqlite).toEqual(postgres ?? []);
  });

  test("is not a constant: the keys really do vary", () => {
    const keys = new Set(
      benchmark("1")
        .scenario.clients[0]?.steps.map((step) => ("sql" in step ? step.sql : ""))
        .filter((sql) => sql !== ""),
    );
    expect(keys.size).toBeGreaterThan(READ_FANOUT_STATEMENTS / 2);
  });

  test("stays inside the table it reads from", () => {
    const random = createRandom();
    for (let draw = 0; draw < 1000; draw += 1) {
      const value = random.nextInt(1, CONCURRENCY_ROWS);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(CONCURRENCY_ROWS);
    }
  });
});
