import { describe, expect, test } from "bun:test";

import { benchmarkSql } from "../types";
import { buildRttBenchmarks, RTT_SUITE } from "./index";
import {
  RTT_BENCHMARK_LABELS,
  RTT_INITIAL_SETUP_POSTGRES,
  RTT_INITIAL_SETUP_SQLITE,
  RTT_ITERATIONS,
  RTT_STATEMENTS,
  rttInitialSetupFor,
} from "./statements";

describe("RTT Suite definition", () => {
  test("has twelve statements", () => {
    expect(RTT_STATEMENTS).toHaveLength(12);
    expect(RTT_BENCHMARK_LABELS).toHaveLength(12);
  });

  test("reproduces PGlite's statements byte for byte", () => {
    expect(RTT_STATEMENTS[0]).toBe("INSERT INTO t1 (a) VALUES (1);");
    expect(RTT_STATEMENTS[1]).toBe("SELECT * FROM t1 WHERE id = 333;");
    expect(RTT_STATEMENTS[2]).toBe("UPDATE t1 SET a = 2 WHERE id = 666;");
    expect(RTT_STATEMENTS[3]).toBe("DELETE FROM t1 WHERE id IN (SELECT id FROM t1 LIMIT 1);");
    expect(RTT_STATEMENTS[5]).toBe("SELECT * FROM t2 WHERE id IN (SELECT id FROM t2 LIMIT 1);");
    expect(RTT_STATEMENTS[7]).toBe("DELETE FROM t2 WHERE id IN (SELECT id FROM t2 LIMIT 1);");
  });

  test("uses 1kb payloads for statements 5-8 and 10kb payloads for statements 9-12", () => {
    expect(RTT_STATEMENTS[4]).toBe(`INSERT INTO t2 (a) VALUES ('${"a".repeat(1000)}');`);
    expect(RTT_STATEMENTS[6]).toBe(`UPDATE t2 SET a = '${"a".repeat(1000)}' WHERE id = 1;`);
    expect(RTT_STATEMENTS[8]).toBe(`INSERT INTO t2 (a) VALUES ('${"a".repeat(10000)}');`);
    expect(RTT_STATEMENTS[10]).toBe(`UPDATE t2 SET a = '${"a".repeat(10000)}' WHERE id = 1;`);
  });

  test("reproduces PGlite's initial setup byte for byte, in both dialects", () => {
    expect(RTT_INITIAL_SETUP_POSTGRES).toBe(
      "\n  CREATE TABLE t1 (id SERIAL PRIMARY KEY NOT NULL, a INTEGER);\n  CREATE TABLE t2 (id SERIAL PRIMARY KEY NOT NULL, a TEXT);\n",
    );
    expect(RTT_INITIAL_SETUP_SQLITE).toBe(
      "\n  CREATE TABLE t1 (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, a INTEGER);\n  CREATE TABLE t2 (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, a TEXT);\n",
    );
  });

  test("hands each dialect its own setup, and nothing else", () => {
    expect(rttInitialSetupFor("postgres")).toBe(RTT_INITIAL_SETUP_POSTGRES);
    expect(rttInitialSetupFor("sqlite")).toBe(RTT_INITIAL_SETUP_SQLITE);
    expect(RTT_INITIAL_SETUP_SQLITE).not.toBe(RTT_INITIAL_SETUP_POSTGRES);
  });

  test("keeps the twelve timed statements shared between the dialects", () => {
    // The dialect knob is the setup and nothing more: no Benchmark is rewritten for SQLite.
    expect(RTT_SUITE.benchmarks.map(benchmarkSql)).toEqual([...RTT_STATEMENTS]);
  });

  test("runs 100 iterations per Benchmark and reports a trimmed mean", () => {
    expect(RTT_ITERATIONS).toBe(100);
    expect(RTT_SUITE.iterations).toBe(100);
    expect(RTT_SUITE.aggregation).toBe("trimmed-mean");
  });

  test("builds twelve Benchmarks with PGlite's labels, numbered from one", () => {
    const benchmarks = buildRttBenchmarks();
    expect(benchmarks).toHaveLength(12);
    expect(benchmarks.map((benchmark) => benchmark.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
    ]);
    expect(benchmarks[0]?.label).toBe("Test 1: insert small row");
    expect(benchmarks[11]?.label).toBe("Test 12: delete 10kb row");
    expect(benchmarks.map(benchmarkSql)).toEqual([...RTT_STATEMENTS]);
  });

  test("runs its setup untimed rather than offering an editable preamble", () => {
    expect(RTT_SUITE.editableSetup).toBe(false);
    expect(RTT_SUITE.initialSetupFor("postgres")).toBe(RTT_INITIAL_SETUP_POSTGRES);
    expect(RTT_SUITE.initialSetupFor("sqlite")).toBe(RTT_INITIAL_SETUP_SQLITE);
  });
});
