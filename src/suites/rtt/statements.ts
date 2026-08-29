// Based on wa-sqlite's benchmarks.
// Copyright 2021 Roy T. Hashimoto. All Rights Reserved.
// Modified by the PGLite authors.
// Ported by pglite-v-pgrust.

/**
 * The RTT Suite's SQL, byte-identical to PGlite's `rtt.js` — including the `'a'.repeat(...)` payload
 * constructions, which are reproduced rather than inlined so the sizes stay legible.
 */

/** Run untimed on a freshly opened Engine before the first Benchmark. */
export const RTT_INITIAL_SETUP = `
  CREATE TABLE t1 (id SERIAL PRIMARY KEY NOT NULL, a INTEGER);
  CREATE TABLE t2 (id SERIAL PRIMARY KEY NOT NULL, a TEXT);
`;

/** The twelve single-statement CRUD queries, in PGlite's order. */
export const RTT_STATEMENTS: readonly string[] = [
  `INSERT INTO t1 (a) VALUES (1);`,
  `SELECT * FROM t1 WHERE id = 333;`,
  `UPDATE t1 SET a = 2 WHERE id = 666;`,
  `DELETE FROM t1 WHERE id IN (SELECT id FROM t1 LIMIT 1);`,
  `INSERT INTO t2 (a) VALUES ('${"a".repeat(1000)}');`,
  `SELECT * FROM t2 WHERE id IN (SELECT id FROM t2 LIMIT 1);`,
  `UPDATE t2 SET a = '${"a".repeat(1000)}' WHERE id = 1;`,
  `DELETE FROM t2 WHERE id IN (SELECT id FROM t2 LIMIT 1);`,
  `INSERT INTO t2 (a) VALUES ('${"a".repeat(10000)}');`,
  `SELECT * FROM t2 WHERE id IN (SELECT id FROM t2 LIMIT 1);`,
  `UPDATE t2 SET a = '${"a".repeat(10000)}' WHERE id = 1;`,
  `DELETE FROM t2 WHERE id IN (SELECT id FROM t2 LIMIT 1);`,
];

/** The human-readable descriptions PGlite's RTT page uses for each statement. */
export const RTT_BENCHMARK_LABELS: readonly string[] = [
  "Test 1: insert small row",
  "Test 2: select small row",
  "Test 3: update small row",
  "Test 4: delete small row",
  "Test 5: insert 1kb row",
  "Test 6: select 1kb row",
  "Test 7: update 1kb row",
  "Test 8: delete 1kb row",
  "Test 9: insert 10kb row",
  "Test 10: select 10kb row",
  "Test 11: update 10kb row",
  "Test 12: delete 10kb row",
];

/** Executions per Benchmark, per PGlite's `rtt.js`. */
export const RTT_ITERATIONS = 100;
