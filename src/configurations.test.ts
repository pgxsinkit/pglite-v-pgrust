import { describe, expect, test } from "bun:test";

import {
  BASELINE_CONFIGURATION_DIALECT,
  BASELINE_CONFIGURATION_ID,
  BASELINE_CONFIGURATION_LABEL,
  CONFIGURATIONS,
  findConfiguration,
} from "./configurations";
import { applyModSql } from "./engines/contract";

describe("phase-1 Configurations", () => {
  test("are the four memory Configurations, in column order", () => {
    expect(CONFIGURATIONS.map((config) => config.id)).toEqual([
      "pglite-memory",
      "pglite-memory-unlogged",
      "pgrust-memory",
      "wasqlite-memory",
    ]);
    expect(CONFIGURATIONS.every((config) => config.dataDir === "")).toBe(true);
  });

  test("label every column the way its header reads", () => {
    expect(CONFIGURATIONS.map((config) => config.label)).toEqual([
      "PGlite Memory",
      "PGlite Memory (unlogged)",
      "pgrust Memory",
      "wa-sqlite Memory",
    ]);
  });

  test("take their ratios against PGlite Memory", () => {
    expect(BASELINE_CONFIGURATION_ID).toBe("pglite-memory");
    expect(BASELINE_CONFIGURATION_LABEL).toBe("PGlite Memory");
    expect(BASELINE_CONFIGURATION_DIALECT).toBe("postgres");
    expect(findConfiguration(BASELINE_CONFIGURATION_ID)?.engine).toBe("pglite");
  });

  test("give the pgrust column its own Engine", () => {
    expect(findConfiguration("pgrust-memory")?.engine).toBe("pgrust");
  });

  test("give the Reference Engine one column, and never the Baseline", () => {
    const reference = findConfiguration("wasqlite-memory");
    expect(reference?.engine).toBe("wasqlite");
    expect(reference?.id).not.toBe(BASELINE_CONFIGURATION_ID);
    expect(CONFIGURATIONS.filter((config) => config.engine === "wasqlite")).toHaveLength(1);
  });

  test("leave the unlogged rewrite to PGlite: SQLite has no unlogged tables", () => {
    expect(findConfiguration("wasqlite-memory")?.modSql).toBeUndefined();
    expect(findConfiguration("pgrust-memory")?.modSql).toBeUndefined();
  });

  test("rewrite CREATE TABLE for the unlogged Configuration exactly as PGlite does", () => {
    const unlogged = findConfiguration("pglite-memory-unlogged");
    expect(unlogged).toBeDefined();
    if (unlogged === undefined) {
      return;
    }
    expect(applyModSql(unlogged, "CREATE TABLE a (x int); CREATE TABLE b (y int);")).toBe(
      "CREATE UNLOGGED TABLE a (x int); CREATE UNLOGGED TABLE b (y int);",
    );
    expect(applyModSql(unlogged, "SELECT 1;")).toBe("SELECT 1;");
  });

  test("leave SQL untouched for Configurations without a rewrite", () => {
    const baseline = findConfiguration(BASELINE_CONFIGURATION_ID);
    expect(baseline).toBeDefined();
    if (baseline === undefined) {
      return;
    }
    expect(applyModSql(baseline, "CREATE TABLE a (x int);")).toBe("CREATE TABLE a (x int);");
  });
});
