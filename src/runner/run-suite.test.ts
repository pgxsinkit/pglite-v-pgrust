import { describe, expect, test } from "bun:test";

import { findConfiguration } from "../configurations";
import type { Configuration } from "../engines/contract";
import { configurationDialect } from "../engines/contract";
import { RTT_SUITE } from "../suites/rtt";
import { RTT_INITIAL_SETUP_POSTGRES, RTT_STATEMENTS } from "../suites/rtt/statements";
import type { Suite } from "../suites/types";
import { planRun } from "./run-suite";

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
      expect(planFor(RTT_SUITE, id).benchmarks.map((benchmark) => benchmark.sql)).toEqual([...RTT_STATEMENTS]);
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
      expect(plan.benchmarks.map((benchmark) => benchmark.sql)).toEqual([...RTT_STATEMENTS]);
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
    expect(plan.benchmarks[0]?.sql).toBe("CREATE UNLOGGED TABLE t (a int);\nINSERT INTO t VALUES (1);");
  });

  test("leaves an unrewritten Configuration's preamble byte-identical", () => {
    const plan = planRun(EDITABLE_SETUP_SUITE, configuration("pglite-memory"), "CREATE TABLE warmup (a int);");
    expect(plan.setupSql).toBe("CREATE TABLE warmup (a int);");
  });
});
