// Based on wa-sqlite's benchmarks.
// Copyright 2021 Roy T. Hashimoto. All Rights Reserved.
// Modified by the PGLite authors.
// Ported by pglite-v-pgrust.

/**
 * The Prepared Suite's rows, kept free of the `?raw` SQL imports so the shape of the Suite is
 * unit-testable outside a bundler (as the Speedtest's `benchmarks.ts` is).
 *
 * Each row is one of the Speedtest's statement-heavy scripts with its one repeated statement turned
 * into a **shape**: the statement with its literals replaced by `$1`, `$2`, `$3`, prepared once, then
 * executed once per statement with the Speedtest's own values. The timed text is the script's
 * `EXECUTE`s (inside the script's own `BEGIN`/`COMMIT` where it has them), generated from the
 * Speedtest's file and committed beside this module as `prepared<N>.sql`; `prepared.test.ts` turns
 * every `EXECUTE` back into the Speedtest's statement and checks it byte for byte.
 *
 * What the timed text cannot carry goes in the row's untimed setup, each part as its own query text:
 * the tables and indexes the Speedtest's script created before its loop (a `PREPARE` needs its
 * table to exist), or that a Speedtest row this Suite does not run left behind (row 6's two indexes,
 * before row 7), and then the `PREPARE` alone. Alone, because PostgreSQL keeps a prepared
 * statement's whole message as its source text and copies it into every `EXECUTE`'s portal: a
 * `PREPARE` inside the 25 000-statement text would make each `EXECUTE` copy that text
 * (`docs/results/2026-09-25-prepared-statements.md` §8). After the row, `DEALLOCATE`.
 */

import { SPEEDTEST_BENCHMARK_LABELS } from "../speedtest/benchmarks";

/** The Speedtest rows this Suite prepares, in the Speedtest's order: its statement-heavy scripts. */
export const PREPARED_BENCHMARK_IDS = ["1", "2", "3", "7", "8", "9", "10"] as const;

export type PreparedBenchmarkId = (typeof PREPARED_BENCHMARK_IDS)[number];

/** One row's prepared statement, and the state it needs before it can be prepared and run. */
export interface PreparedShape {
  /** The statement's name: in the `PREPARE`, in every `EXECUTE` and in the `DEALLOCATE`. */
  readonly name: string;
  /** Its parameter types, in order: the types of the columns the Speedtest's literals stand for. */
  readonly parameterTypes: readonly string[];
  /** The Speedtest's statement with its literals replaced by `$1`, `$2`, … and no semicolon. */
  readonly statement: string;
  /**
   * The DDL the row needs before its `PREPARE`, byte for byte as the Speedtest spells it; null for a
   * row whose tables already exist in the state the rows before it leave.
   */
  readonly state: string | null;
}

export const PREPARED_SHAPES: Readonly<Record<PreparedBenchmarkId, PreparedShape>> = {
  // benchmark1.sql creates t1 in its own text, before its 1000 INSERTs.
  "1": {
    name: "p1",
    parameterTypes: ["integer", "integer", "varchar"],
    statement: "INSERT INTO t1 VALUES($1, $2, $3)",
    state: "CREATE TABLE t1(a INTEGER, b INTEGER, c VARCHAR(100));\n",
  },
  // benchmark2.sql creates t2 inside its transaction, before its 25 000 INSERTs.
  "2": {
    name: "p2",
    parameterTypes: ["integer", "integer", "varchar"],
    statement: "INSERT INTO t2 VALUES($1, $2, $3)",
    state: "CREATE TABLE t2(a INTEGER, b INTEGER, c VARCHAR(100));\n",
  },
  // benchmark3.sql creates t3 and its index on c inside its transaction, before its 25 000 INSERTs.
  "3": {
    name: "p3",
    parameterTypes: ["integer", "integer", "varchar"],
    statement: "INSERT INTO t3 VALUES($1, $2, $3)",
    state: "CREATE TABLE t3(a INTEGER, b INTEGER, c VARCHAR(100));\nCREATE INDEX i3 ON t3(c);\n",
  },
  // By row 7 the Speedtest has run row 6, benchmark6.sql, which indexes t2 on a and on b; this is
  // that script's text. Built after row 2's rows are in, as in the Speedtest, so the indexes and the
  // statistics CREATE INDEX leaves are the ones the Speedtest's row 7 plans with.
  "7": {
    name: "p7",
    parameterTypes: ["integer", "integer"],
    statement: "SELECT count(*), avg(b) FROM t2 WHERE b>=$1 AND b<$2",
    state: "CREATE INDEX i2a ON t2(a);\nCREATE INDEX i2b ON t2(b);\n",
  },
  "8": {
    name: "p8",
    parameterTypes: ["integer", "integer"],
    statement: "UPDATE t1 SET b=b*2 WHERE a>=$1 AND a<$2",
    state: null,
  },
  "9": {
    name: "p9",
    parameterTypes: ["integer", "integer"],
    statement: "UPDATE t2 SET b=$1 WHERE a=$2",
    state: null,
  },
  "10": {
    name: "p10",
    parameterTypes: ["varchar", "integer"],
    statement: "UPDATE t2 SET c=$1 WHERE a=$2",
    state: null,
  },
};

/** The Speedtest's label with ` (prepared)` after it, so every row still starts `Test <N>: `. */
export const PREPARED_BENCHMARK_LABELS: Readonly<Record<PreparedBenchmarkId, string>> = Object.fromEntries(
  PREPARED_BENCHMARK_IDS.map((id) => [id, `${SPEEDTEST_BENCHMARK_LABELS[id]} (prepared)`]),
) as Record<PreparedBenchmarkId, string>;

/** The row's `PREPARE`, sent untimed as a text of its own just before the row's timed text. */
export function prepareText(shape: PreparedShape): string {
  return `PREPARE ${shape.name}(${shape.parameterTypes.join(", ")}) AS ${shape.statement};\n`;
}

/** The row's `DEALLOCATE`, sent untimed after it. */
export function deallocateText(shape: PreparedShape): string {
  return `DEALLOCATE ${shape.name};\n`;
}

/** Every untimed text the row sends before its timed one, in order: its state, then its `PREPARE`. */
export function preparedSetupTexts(id: PreparedBenchmarkId): readonly string[] {
  const shape = PREPARED_SHAPES[id];
  return shape.state === null ? [prepareText(shape)] : [shape.state, prepareText(shape)];
}

/** Every untimed text the row sends after its timed one. */
export function preparedTeardownTexts(id: PreparedBenchmarkId): readonly string[] {
  return [deallocateText(PREPARED_SHAPES[id])];
}

/** The file each row's timed text (its `EXECUTE`s) is read from, relative to this directory. */
export function preparedSqlFileName(id: PreparedBenchmarkId): string {
  return `prepared${id}.sql`;
}

/** Why the Suite is not run on a SQLite Engine: the column's header note, and its longer reason. */
export const PREPARED_SQLITE_NOTE = "not run: SQLite has no PREPARE or EXECUTE";

export const PREPARED_SQLITE_REASON =
  "The Prepared Suite times PREPARE and EXECUTE statements, which SQLite does not have in any " +
  "spelling; it runs on the Postgres Engines only";
