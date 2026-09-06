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
 */

import type { Measurement } from "../../engines/contract";
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

const ROWS_TABLE = "concurrency_rows";
const CONTENDED_TABLE = "concurrency_contended";
const BULK_TABLE = "concurrency_bulk";

/**
 * The untimed setup: one indexed table of 100 000 rows, and one row every Client will fight over.
 *
 * `payload` is 100 bytes and different in every row, so the full scan in the third Benchmark really
 * has to look at all of it. The Postgres spelling is the only one there is: the one SQLite Engine
 * here cannot run this Suite at all (it has no second session and no way to interleave), so a
 * dialect variant would be SQL nothing would ever execute.
 */
export const CONCURRENCY_SETUP_SQL = [
  `CREATE TABLE ${ROWS_TABLE} (k INTEGER PRIMARY KEY, v INTEGER NOT NULL, payload TEXT NOT NULL);`,
  `INSERT INTO ${ROWS_TABLE} SELECT g, g, rpad(md5(g::text), 100, 'x') FROM generate_series(1, ${CONCURRENCY_ROWS}) AS g;`,
  `CREATE INDEX ${ROWS_TABLE}_v ON ${ROWS_TABLE} (v);`,
  `CREATE TABLE ${CONTENDED_TABLE} (id INTEGER PRIMARY KEY, v INTEGER NOT NULL);`,
  `INSERT INTO ${CONTENDED_TABLE} VALUES (1, 0);`,
  `ANALYZE ${ROWS_TABLE};`,
].join("\n");

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

function shortBesideLongScenario(clients: number, random: ReturnType<typeof createRandom>): ConcurrentScenario {
  const long: ScenarioClient = { steps: [{ sql: LONG_SCAN_SQL }, { signal: SIGNAL_LONG_QUERY }] };
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

function sameRowWritersScenario(clients: number): ConcurrentScenario {
  return {
    id: "writers-same-row",
    // Per Session, and therefore once on an Engine that has one Session: PGlite's single backend is
    // told exactly once, which is what a `SET` means where there is one place to run SQL.
    setup: [`SET lock_timeout = '${LOCK_TIMEOUT}'`],
    tolerate: [LOCK_TIMEOUT_SQLSTATE],
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
      [`lock timeouts (${LOCK_TIMEOUT_SQLSTATE})`]: sqlstateCount(report.clients, LOCK_TIMEOUT_SQLSTATE),
      ...perClient,
      "total wall ms": report.totalMs,
    },
  };
}

/**
 * The five Benchmarks, built for `clients` Clients.
 *
 * One `createRandom()` for all of them, drawn in this order: the keys are a property of the Suite
 * rather than of a Benchmark, and re-seeding per Benchmark would only make two rows read the same
 * rows.
 */
export function buildConcurrencyBenchmarks(clients: number): readonly ScenarioBenchmark[] {
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
      label: "Test 3: Short queries beside a long one — short p95 during a full scan",
      scenario: shortBesideLongScenario(clients, random),
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
      scenario: sameRowWritersScenario(clients),
      summarize: sameRowWritersSummary,
    },
  ];
}
