/**
 * The five Concurrency Benchmarks: what each Client does, and which number the cell carries.
 *
 * Every Scenario here is built once, from a fixed seed, and handed byte-identically to every Engine
 * that can run it (`./random`). What differs between columns is therefore the database and nothing
 * else — not the keys, not the order, not the statement count.
 *
 * Each Benchmark's headline is the one number that answers the question it asks, and everything else
 * it measured goes into the Detail beneath the row: a p95 with no statement count behind it is not a
 * result anyone can check.
 *
 * **Two dialects, one Scenario.** Every Engine runs this Suite, and one of them speaks SQLite, so the
 * Scenarios are built per dialect exactly as the other Suites' untimed setups are. Three things
 * differ and nothing else does: the dataset's DDL, the per-Session lock wait (`SET lock_timeout`
 * against `PRAGMA busy_timeout`, and `55P03` against `SQLITE_BUSY`) and the long query of the third
 * Benchmark, which has no `~` operator to be spelled with. The keys, the Client structure and the
 * statement counts come out of the same draws in the same order, so the two spellings ask the same
 * questions.
 */

import type { Measurement, SqlDialect } from "../../engines/contract";
import type { ConcurrentScenario, ScenarioClient, ScenarioStep } from "../../engines/scenario";
import type { ScenarioReport } from "../../engines/scenario";
import type { ScenarioBenchmark } from "../types";
import { createRandom } from "./random";
import {
  clientAt,
  clientsExcept,
  describeSpread,
  latenciesOf,
  maximum,
  percentile,
  sqlstateCount,
  statementsPerSecond,
  totalSamples,
} from "./statistics";

/** How many Clients a Run has, unless `?concurrencyClients=N` says otherwise. */
export const CONCURRENCY_CLIENTS = 4;

/** Rows in the indexed table the untimed setup builds. */
export const CONCURRENCY_ROWS = 100_000;

/** Point SELECTs per Client in the read fan-out Benchmark. */
export const READ_FANOUT_STATEMENTS = 500;

/** Rows the bulk writer inserts in one transaction — the Speedtest's Test 2, inside a Scenario. */
export const BULK_INSERT_ROWS = 25_000;

/** Short transactions per Client in the two writer Benchmarks. */
export const WRITE_TRANSACTIONS = 200;

/**
 * How long a Client waits for the contended row before giving up.
 *
 * Without it the same-row Benchmark could only ever report "everybody waited"; with it a Client that
 * cannot make progress says so with SQLSTATE 55P03, which the Scenario tolerates and the Detail
 * counts. Two seconds is far above the time a short transaction on one row should ever need.
 */
export const LOCK_TIMEOUT = "2s";

/** The SQLSTATE a Client reports when `lock_timeout` fires. */
export const LOCK_TIMEOUT_SQLSTATE = "55P03";

/** The same wait, in SQLite's spelling: `PRAGMA busy_timeout` takes milliseconds. */
export const BUSY_TIMEOUT_MS = 2_000;

/**
 * The result code a SQLite Client reports when its `busy_timeout` gives up: `SQLITE_BUSY`.
 *
 * The SQLite twin of `LOCK_TIMEOUT_SQLSTATE`, and tolerated for the same reason: on an Engine where
 * two writers really can meet, "everybody waited" is not a result and this is.
 */
export const SQLITE_BUSY_CODE = "5";

/**
 * Steps in the SQLite dialect's long query.
 *
 * SQLite has no `~` operator and no `pg_sleep`, and its `GLOB` over the same 100 000 payloads
 * finishes in a few milliseconds — three orders of magnitude short of what this Benchmark needs to
 * contrast against. So the SQLite spelling of "one long query" is a recursive CTE doing arithmetic,
 * sized to land in the same few-hundred-millisecond band as the Postgres full scan. It is CPU inside
 * the Engine either way; only what the CPU is spent on differs, and the Detail reports the time it
 * actually took rather than a time this constant claims.
 */
export const SQLITE_LONG_QUERY_STEPS = 400_000;

const ROWS_TABLE = "concurrency_rows";
const CONTENDED_TABLE = "concurrency_contended";
const BULK_TABLE = "concurrency_bulk";

/** The 100 `x` a payload is padded with, so both dialects pad to the same width the same way. */
const PAYLOAD_PADDING = "x".repeat(100);

/**
 * The untimed setup: one indexed table of 100 000 rows, and one row every Client will fight over.
 *
 * `payload` is 100 bytes and different in every row, so the full scan in the third Benchmark really
 * has to look at all of it.
 */
export const CONCURRENCY_SETUP_SQL = [
  `CREATE TABLE ${ROWS_TABLE} (k INTEGER PRIMARY KEY, v INTEGER NOT NULL, payload TEXT NOT NULL);`,
  `INSERT INTO ${ROWS_TABLE} SELECT g, g, rpad(md5(g::text), 100, 'x') FROM generate_series(1, ${CONCURRENCY_ROWS}) AS g;`,
  `CREATE INDEX ${ROWS_TABLE}_v ON ${ROWS_TABLE} (v);`,
  `CREATE TABLE ${CONTENDED_TABLE} (id INTEGER PRIMARY KEY, v INTEGER NOT NULL);`,
  `INSERT INTO ${CONTENDED_TABLE} VALUES (1, 0);`,
  `ANALYZE ${ROWS_TABLE};`,
].join("\n");

/**
 * The same dataset for a SQLite Engine: the same two tables, the same 100 000 rows, the same
 * 100-byte payload that differs in every row and never contains the patterns anything searches for.
 *
 * Three substitutions and no more. `generate_series` is a recursive CTE, because wa-sqlite's build
 * does not carry the series extension; `md5(g::text)` is `hex(x)`, because SQLite has no `md5` and
 * what the payload owes this Suite is width and distinctness rather than a digest; and `rpad` is
 * `substr(… || 'xxx…', 1, 100)`, which is the same padding written the way SQLite spells it.
 */
export const CONCURRENCY_SETUP_SQL_SQLITE = [
  `CREATE TABLE ${ROWS_TABLE} (k INTEGER PRIMARY KEY, v INTEGER NOT NULL, payload TEXT NOT NULL);`,
  `INSERT INTO ${ROWS_TABLE} (k, v, payload) WITH RECURSIVE g(x) AS (` +
    `SELECT 1 UNION ALL SELECT x + 1 FROM g WHERE x < ${CONCURRENCY_ROWS}` +
    `) SELECT x, x, substr(hex(x) || '${PAYLOAD_PADDING}', 1, 100) FROM g;`,
  `CREATE INDEX ${ROWS_TABLE}_v ON ${ROWS_TABLE} (v);`,
  `CREATE TABLE ${CONTENDED_TABLE} (id INTEGER PRIMARY KEY, v INTEGER NOT NULL);`,
  `INSERT INTO ${CONTENDED_TABLE} VALUES (1, 0);`,
  `ANALYZE ${ROWS_TABLE};`,
].join("\n");

/** The untimed setup in the dialect the Engine under Run speaks. */
export function concurrencySetupFor(dialect: SqlDialect): string {
  return dialect === "sqlite" ? CONCURRENCY_SETUP_SQL_SQLITE : CONCURRENCY_SETUP_SQL;
}

/** One indexed point SELECT that has to visit the heap, so it is a row read rather than an index scan. */
function pointSelect(key: number): string {
  return `SELECT v, payload FROM ${ROWS_TABLE} WHERE k = ${key}`;
}

/** One short transaction's worth of work: bump one row's counter. */
function bumpRow(key: number): string {
  return `UPDATE ${ROWS_TABLE} SET v = v + 1 WHERE k = ${key}`;
}

/**
 * A full scan with a string comparison, over every row of the table.
 *
 * Two regular expressions, neither of which can match anything: every one of the 100 000 payloads is
 * examined to the end, twice, which is what puts this query in the hundreds of milliseconds — three
 * orders of magnitude above the point SELECTs running beside it, which is the contrast the Benchmark
 * exists to measure.
 */
const LONG_SCAN_SQL =
  `SELECT count(*) FROM ${ROWS_TABLE} ` + `WHERE payload ~ 'zq[0-9a-f]{4}zq' OR payload ~ 'qz[0-9a-f]{4}qz'`;

/**
 * The SQLite dialect's long query: arithmetic in a recursive CTE, and deliberately not a scan.
 *
 * SQLite's `GLOB` gives up on the first character of a pattern that starts with `z`, so the same
 * full scan finishes in single-digit milliseconds there and the Benchmark would be short queries
 * beside a short one. A recursive CTE spends the same kind of time — CPU inside the Engine, on this
 * connection, with nothing else able to run until it is done — for as long as it is asked to, which
 * is what this Benchmark needs the long Client to do. `count(*)` over a predicate that matches
 * nothing keeps the result shape identical to the Postgres spelling: one row, one number.
 */
const SQLITE_LONG_QUERY_SQL =
  `WITH RECURSIVE spin(i, h) AS (SELECT 1, 0 UNION ALL ` +
  `SELECT i + 1, (h * 31 + i) % 1000003 FROM spin WHERE i < ${SQLITE_LONG_QUERY_STEPS}) ` +
  `SELECT count(*) FROM spin WHERE h < 0`;

/** The one long query, in the dialect the Engine under Run speaks. */
function longQuerySql(dialect: SqlDialect): string {
  return dialect === "sqlite" ? SQLITE_LONG_QUERY_SQL : LONG_SCAN_SQL;
}

/** The Speedtest's Test 2, as one Client's transaction: a fresh table and 25 000 INSERTs in it. */
function bulkWriteStatements(random: () => number): readonly string[] {
  const inserts: string[] = [];
  for (let row = 1; row <= BULK_INSERT_ROWS; row += 1) {
    const value = Math.floor(random() * 500_000);
    inserts.push(`INSERT INTO ${BULK_TABLE} VALUES (${row}, ${value}, '${value} bulk row');`);
  }
  return [
    `DROP TABLE IF EXISTS ${BULK_TABLE}`,
    `CREATE TABLE ${BULK_TABLE} (k INTEGER PRIMARY KEY, v INTEGER NOT NULL, payload TEXT NOT NULL)`,
    inserts.join("\n"),
  ];
}

const SIGNAL_BULK_WRITE = "bulk-write-done";
const SIGNAL_LONG_QUERY = "long-query-done";

/** Client `index` of `clients`, reading its own share of the key space. */
function keyRange(index: number, clients: number): { readonly first: number; readonly last: number } {
  const size = Math.floor(CONCURRENCY_ROWS / clients);
  return { first: index * size + 1, last: (index + 1) * size };
}

function readFanOutScenario(clients: number, random: ReturnType<typeof createRandom>): ConcurrentScenario {
  return {
    id: "read-fan-out",
    clients: Array.from({ length: clients }, (): ScenarioClient => ({
      steps: Array.from({ length: READ_FANOUT_STATEMENTS }, (): ScenarioStep => ({
        sql: pointSelect(random.nextInt(1, CONCURRENCY_ROWS)),
      })),
    })),
  };
}

function readerUnderBulkWriteScenario(clients: number, random: ReturnType<typeof createRandom>): ConcurrentScenario {
  const writer: ScenarioClient = {
    steps: [{ transaction: bulkWriteStatements(() => random.next()) }, { signal: SIGNAL_BULK_WRITE }],
  };
  const readers = Array.from({ length: Math.max(0, clients - 1) }, (): ScenarioClient => ({
    steps: [{ untilSignal: SIGNAL_BULK_WRITE, sql: pointSelect(random.nextInt(1, CONCURRENCY_ROWS)) }],
  }));
  return { id: "reader-under-bulk-write", clients: [writer, ...readers] };
}

function shortBesideLongScenario(
  clients: number,
  random: ReturnType<typeof createRandom>,
  dialect: SqlDialect,
): ConcurrentScenario {
  const long: ScenarioClient = { steps: [{ sql: longQuerySql(dialect) }, { signal: SIGNAL_LONG_QUERY }] };
  const short = Array.from({ length: Math.max(0, clients - 1) }, (): ScenarioClient => ({
    steps: [{ untilSignal: SIGNAL_LONG_QUERY, sql: pointSelect(random.nextInt(1, CONCURRENCY_ROWS)) }],
  }));
  return { id: "short-beside-long", clients: [long, ...short] };
}

function disjointWritersScenario(clients: number, random: ReturnType<typeof createRandom>): ConcurrentScenario {
  return {
    id: "writers-disjoint",
    clients: Array.from({ length: clients }, (_unused, index): ScenarioClient => {
      const range = keyRange(index, clients);
      return {
        steps: Array.from({ length: WRITE_TRANSACTIONS }, (): ScenarioStep => ({
          transaction: [bumpRow(random.nextInt(range.first, range.last))],
        })),
      };
    }),
  };
}

function sameRowWritersScenario(clients: number, dialect: SqlDialect): ConcurrentScenario {
  const sqlite = dialect === "sqlite";
  return {
    id: "writers-same-row",
    // Per Session, and therefore once on an Engine that has one Session: a single backend is told
    // exactly once, which is what a `SET` means where there is one place to run SQL.
    setup: [sqlite ? `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}` : `SET lock_timeout = '${LOCK_TIMEOUT}'`],
    tolerate: [sqlite ? SQLITE_BUSY_CODE : LOCK_TIMEOUT_SQLSTATE],
    clients: Array.from({ length: clients }, (): ScenarioClient => ({
      steps: Array.from({ length: WRITE_TRANSACTIONS }, (): ScenarioStep => ({
        transaction: [`UPDATE ${CONTENDED_TABLE} SET v = v + 1 WHERE id = 1`],
      })),
    })),
  };
}

/** A Detail line's per-Client entries, keyed so the Markdown export reads as a sentence. */
function perClientSpread(report: ScenarioReport): Record<string, string> {
  const detail: Record<string, string> = {};
  for (const client of report.clients) {
    detail[`client ${client.client} p50/p95/max ms`] = describeSpread(client.samples.map((s) => s.elapsedMs));
  }
  return detail;
}

function readFanOutSummary(report: ScenarioReport): Measurement {
  const statements = totalSamples(report.clients);
  return {
    // The whole point of the row: how long it takes N Clients to get through N x 500 point reads.
    elapsedMs: report.totalMs,
    detail: {
      statements,
      "statements/s": statementsPerSecond(statements, report.totalMs),
      ...perClientSpread(report),
    },
  };
}

function readerUnderBulkWriteSummary(report: ScenarioReport): Measurement {
  const readers = clientsExcept(report, [0]);
  const latencies = latenciesOf(readers);
  const writer = clientAt(report, 0);
  return {
    // What a reader felt while somebody else wrote 25 000 rows in one transaction.
    elapsedMs: percentile(latencies, 0.95),
    detail: {
      "writer total ms": writer?.totalMs ?? Number.NaN,
      "reader max ms": maximum(latencies),
      "reader statements": latencies.length,
    },
  };
}

function shortBesideLongSummary(report: ScenarioReport): Measurement {
  const short = clientsExcept(report, [0]);
  const latencies = latenciesOf(short);
  const long = clientAt(report, 0);
  return {
    elapsedMs: percentile(latencies, 0.95),
    detail: {
      "long query ms": long?.samples[0]?.elapsedMs ?? Number.NaN,
      "short max ms": maximum(latencies),
      "short statements": latencies.length,
    },
  };
}

function disjointWritersSummary(report: ScenarioReport): Measurement {
  const transactions = totalSamples(report.clients);
  const perClient: Record<string, number> = {};
  for (const client of report.clients) {
    perClient[`client ${client.client} p95 ms`] = percentile(
      client.samples.map((sample) => sample.elapsedMs),
      0.95,
    );
  }
  return {
    // A rate, not a time: this row asks how much work N Clients get through, and higher is better.
    elapsedMs: statementsPerSecond(transactions, report.totalMs),
    detail: { ...perClient, "total wall ms": report.totalMs, transactions },
  };
}

function sameRowWritersSummary(report: ScenarioReport): Measurement {
  const perClient: Record<string, number> = {};
  for (const client of report.clients) {
    perClient[`client ${client.client} total ms`] = client.totalMs;
  }
  return {
    elapsedMs: percentile(latenciesOf(report.clients), 0.95),
    detail: {
      // Both dialects' spellings of the same outcome, added together: a column reports whichever of
      // them its Engine can raise, and neither is a number the other could be confused with.
      [`lock timeouts (${LOCK_TIMEOUT_SQLSTATE} / SQLITE_BUSY)`]:
        sqlstateCount(report.clients, LOCK_TIMEOUT_SQLSTATE) + sqlstateCount(report.clients, SQLITE_BUSY_CODE),
      ...perClient,
      "total wall ms": report.totalMs,
    },
  };
}

/**
 * The five Benchmarks, built for `clients` Clients in one dialect.
 *
 * One `createRandom()` for all of them, drawn in this order: the keys are a property of the Suite
 * rather than of a Benchmark, and re-seeding per Benchmark would only make two rows read the same
 * rows. The draws do not depend on the dialect either, so the SQLite spelling reads and updates
 * exactly the keys the Postgres one does.
 */
export function buildConcurrencyBenchmarks(
  clients: number,
  dialect: SqlDialect = "postgres",
): readonly ScenarioBenchmark[] {
  const random = createRandom();
  return [
    {
      id: "1",
      label: `Test 1: Read fan-out — ${clients} clients x ${READ_FANOUT_STATEMENTS} point SELECTs, total wall`,
      scenario: readFanOutScenario(clients, random),
      summarize: readFanOutSummary,
    },
    {
      id: "2",
      label: `Test 2: Reader under a bulk write — reader p95 while ${BULK_INSERT_ROWS} rows are inserted`,
      scenario: readerUnderBulkWriteScenario(clients, random),
      summarize: readerUnderBulkWriteSummary,
    },
    {
      id: "3",
      // Not "during a full scan": that is what the long query is in Postgres, and the SQLite dialect
      // spends the same time in a recursive CTE instead. The row's question is the same either way.
      label: "Test 3: Short queries beside a long one — short p95 during one long query",
      scenario: shortBesideLongScenario(clients, random, dialect),
      summarize: shortBesideLongSummary,
    },
    {
      id: "4",
      label: `Test 4: Writers on disjoint rows — transactions/s (higher is better)`,
      scenario: disjointWritersScenario(clients, random),
      summarize: disjointWritersSummary,
    },
    {
      id: "5",
      label: `Test 5: Writers on the same row — p95 of ${WRITE_TRANSACTIONS} short transactions each`,
      scenario: sameRowWritersScenario(clients, dialect),
      summarize: sameRowWritersSummary,
    },
  ];
}
